import { describe, expect, it, vi } from 'vitest';
import type {
  DeferredEventSpec,
  EventEnvelope,
  EventStoreReader,
  TriggerMode,
  WorldHost,
} from 'cortico/core/types.ts';
import { WAVEMEMORY_DEFAULTS } from '../src/config.ts';
import { WaveMemoryBridge, type FetchLike } from '../src/bridge.ts';
import { WaveMemoryWorld } from '../src/world.ts';
import { hashQuery, recallQueryText } from '../src/recall-query.ts';

type DeferredPush = {
  spec: Pick<DeferredEventSpec, 'type' | 'senderKey' | 'meta' | 'tags' | 'render'> & { origin?: string };
  opts?: { trigger?: TriggerMode };
};

class FakeStore implements EventStoreReader {
  events: EventEnvelope[] = [];
  get(cursor: number) { return this.events.find((e) => e.cursor === cursor); }
  latestCursor() { return this.events.at(-1)?.cursor ?? 0; }
  range(q: { origin?: string; limit?: number }) {
    let matched = this.events.filter((e) => q.origin === undefined || e.origin === q.origin);
    if (q.limit !== undefined && matched.length > q.limit) matched = matched.slice(matched.length - q.limit);
    return matched;
  }
  around() { return []; }
  grep() { return []; }
}

class FakeHost implements WorldHost {
  deferred: DeferredPush[] = [];
  store = new FakeStore();
  pushDeferred(spec: DeferredPush['spec'], opts?: { trigger?: TriggerMode }): void {
    this.deferred.push({ spec, opts });
  }
  async pushEvent(e: Omit<EventEnvelope, 'cursor'>): Promise<EventEnvelope> {
    const full = { ...e, cursor: this.store.events.length + 1 } as EventEnvelope;
    this.store.events.push(full);
    return full;
  }
  async drainPendingEvents() { return []; }
  blob() { return null; }
  modelFacts = { model: () => 'test', accepts: () => false, contextWindow: () => 128000 };
  log = {
    child() { return this; },
    info() {}, warn() {}, error() {}, debug() {}, trace() {}, emit() {},
  } as unknown as WorldHost['log'];
  reportUsage(): void {}
}

function ext(partial: Partial<EventEnvelope> & { text: string }): EventEnvelope {
  return {
    cursor: 0,
    type: 'bilibili.danmaku',
    ts: '2026-09-16T10:00:00+08:00',
    source: 'bilibili',
    origin: 'external',
    ...partial,
  };
}

function mockFetch(handler: (url: string, body?: unknown) => unknown): FetchLike {
  return async (url, init) => {
    const parsed = init?.body ? JSON.parse(init.body) : undefined;
    const data = handler(url, parsed);
    return {
      ok: true,
      status: 200,
      json: async () => data,
      text: async () => JSON.stringify(data),
    };
  };
}

describe('recallQueryText', () => {
  it('从末尾取外部事件，排除自己注入的块', () => {
    const store = new FakeStore();
    store.events = [
      ext({ cursor: 1, text: '旧弹幕' }),
      ext({ cursor: 2, source: 'wavememory', origin: 'internal', text: '[相关记忆] 不该被检索' }),
      ext({ cursor: 3, text: '台风好好笑', senderKey: 'bili:123', meta: { uname: '嘉录' } }),
    ];
    const { text, speaker } = recallQueryText(store);
    expect(text).toContain('台风好好笑');
    expect(text).not.toContain('不该被检索');
    expect(speaker).toEqual({ id: 'bili:123', name: '嘉录' });
  });

  it('没有外部事件时返回空', () => {
    const store = new FakeStore();
    expect(recallQueryText(store).text).toBe('');
  });
});

describe('WaveMemoryWorld', () => {
  it('start 入队 piggyback + origin internal', async () => {
    const host = new FakeHost();
    const world = new WaveMemoryWorld({ cfg: WAVEMEMORY_DEFAULTS(), timezone: 'Asia/Shanghai' });
    await world.start(host);
    expect(host.deferred).toHaveLength(1);
    expect(host.deferred[0].opts?.trigger).toBe('piggyback');
    expect(host.deferred[0].spec.origin).toBe('internal');
    expect(host.deferred[0].spec.type).toBe('wavememory.context');
    expect(host.deferred[0].spec.tags).toEqual(['snapshot']);
  });

  it('ARM_STALE 内不重复入队；onTurnEnded 在 render 清标志后可再 arm', async () => {
    const host = new FakeHost();
    const world = new WaveMemoryWorld({ cfg: WAVEMEMORY_DEFAULTS(), timezone: 'Asia/Shanghai' });
    await world.start(host);
    world.onTurnEnded();
    expect(host.deferred).toHaveLength(1);
    await host.deferred[0].spec.render();
    expect(world.isArmed).toBe(false);
    world.onTurnEnded();
    expect(host.deferred).toHaveLength(2);
  });

  it('render 读投递时刻的外部事件并注入桥返回的 block', async () => {
    const calls: unknown[] = [];
    const bridge = new WaveMemoryBridge('http://127.0.0.1:8030', mockFetch((_url, body) => {
      calls.push(body);
      return { ok: true, block: '[相关记忆]\n- 台风轨迹真有意思', chars: 20 };
    }));
    const host = new FakeHost();
    const world = new WaveMemoryWorld({
      cfg: WAVEMEMORY_DEFAULTS(),
      timezone: 'Asia/Shanghai',
      bridge,
    });
    await world.start(host);
    host.store.events.push(ext({
      cursor: 1,
      text: '羽书你昨天说的那个台风的事还挺好笑的',
      senderKey: 'bili:9',
      meta: { uname: '嘉录' },
    }));
    const out = await host.deferred[0].spec.render();
    expect(out).toBe('[相关记忆]\n- 台风轨迹真有意思');
    expect(calls[0]).toMatchObject({
      text: '羽书你昨天说的那个台风的事还挺好笑的',
      speaker: { id: 'bili:9', name: '嘉录' },
      tier: 'full',
    });
  });

  it('无外部事件时 render 返回 null，不打桥', async () => {
    const spy = vi.fn();
    const bridge = new WaveMemoryBridge('http://127.0.0.1:8030', mockFetch(() => {
      spy();
      return { ok: true, block: '不该出现' };
    }));
    const host = new FakeHost();
    const world = new WaveMemoryWorld({ cfg: WAVEMEMORY_DEFAULTS(), timezone: 'Asia/Shanghai', bridge });
    await world.start(host);
    expect(await host.deferred[0].spec.render()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('同 key 二次 render 走新鲜缓存，不重复打桥', async () => {
    let hits = 0;
    const bridge = new WaveMemoryBridge('http://127.0.0.1:8030', mockFetch(() => {
      hits += 1;
      return { ok: true, block: 'cached-block' };
    }));
    const host = new FakeHost();
    const world = new WaveMemoryWorld({ cfg: WAVEMEMORY_DEFAULTS(), timezone: 'Asia/Shanghai', bridge });
    await world.start(host);
    host.store.events.push(ext({ cursor: 1, text: '同一句' }));
    expect(await host.deferred[0].spec.render()).toBe('cached-block');
    world.onTurnEnded();
    expect(await host.deferred[1].spec.render()).toBe('cached-block');
    expect(hits).toBe(1);
  });

  it('超时回落 stale 缓存', async () => {
    let n = 0;
    const bridge = new WaveMemoryBridge('http://127.0.0.1:8030', async () => {
      n += 1;
      if (n === 1) {
        return {
          ok: true, status: 200,
          json: async () => ({ ok: true, block: 'stale-ok' }),
          text: async () => '',
        };
      }
      await new Promise((r) => setTimeout(r, 80));
      throw new Error('slow');
    });
    const host = new FakeHost();
    const world = new WaveMemoryWorld({
      cfg: WAVEMEMORY_DEFAULTS(),
      timezone: 'Asia/Shanghai',
      bridge,
      renderBudgetMs: 40,
    });
    await world.start(host);
    host.store.events.push(ext({ cursor: 1, text: '第一句' }));
    expect(await host.deferred[0].spec.render()).toBe('stale-ok');
    world.onTurnEnded();
    host.store.events.push(ext({ cursor: 2, text: '完全不同的第二句' }));
    // 新 key 超时 → 回落上一轮 stale
    expect(await host.deferred[1].spec.render()).toBe('stale-ok');
  });
});

describe('hashQuery', () => {
  it('相同文本相同哈希', () => {
    expect(hashQuery('台风')).toBe(hashQuery('台风'));
    expect(hashQuery('台风')).not.toBe(hashQuery('游戏'));
  });
});
