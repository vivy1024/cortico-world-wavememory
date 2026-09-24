import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EventEnvelope, EventStoreReader } from 'cortico/core/types.ts';
import { WaveMemoryBridge, type FetchLike } from '../src/bridge.ts';
import { ObservationSync, qqBody, toObservation } from '../src/sync.ts';
import { WaveMemoryWorld, cortiToolName } from '../src/world.ts';
import { WAVEMEMORY_DEFAULTS } from '../src/config.ts';

class Store implements EventStoreReader {
  constructor(public events: EventEnvelope[]) {}
  get(cursor: number) { return this.events.find((e) => e.cursor === cursor); }
  latestCursor() { return this.events.at(-1)?.cursor ?? 0; }
  range(q: { fromCursor?: number; toCursor?: number }) {
    return this.events.filter((e) => (q.fromCursor ?? 0) <= e.cursor && e.cursor <= (q.toCursor ?? Infinity));
  }
  around() { return []; }
  grep() { return []; }
}

function env(cursor: number, partial: Partial<EventEnvelope>): EventEnvelope {
  return { cursor, type: 'qq.message', ts: '2026-09-25T01:00:00+08:00', source: 'qq', origin: 'external', text: '', ...partial };
}

const opts = { botId: 'yushu', sessionPrefix: '羽书', liveSessionId: 'bilibili:group:24292304' };

describe('toObservation', () => {
  it('QQ 群消息用规范前缀和原始消息号', () => {
    const obs = toObservation(env(5, {
      text: '#88 [群 粉丝群 01:00] 阿一: 今晚播尖塔吗',
      meta: { message_id: 88, user_id: 123, sender_name: '阿一', conv: { kind: 'group', id: 150727649 } },
    }), opts);
    expect(obs).toMatchObject({
      event_id: '88',
      kind: 'message',
      content: '今晚播尖塔吗',
      sender_id: '123',
      scope: {
        bot_id: 'yushu',
        visibility: 'group',
        session: { id: '羽书:group:150727649', platform_id: '羽书', conversation_id: '150727649' },
        subject_principal_id: '羽书:user:123',
      },
    });
  });

  it('自己说的话记为 self；私聊主体是对方', () => {
    const obs = toObservation(env(6, {
      type: 'qq.self',
      text: '#90 [私聊 阿一 01:01] 你: 播的播的',
      meta: { message_id: 90, user_id: 2500447291, conv: { kind: 'private', id: 123 } },
    }), opts);
    expect(obs).toMatchObject({ kind: 'self', content: '播的播的', scope: { visibility: 'private', subject_principal_id: '羽书:user:123' } });
  });

  it('弹幕用直播间会话和事件游标做消息号；缺前缀时跳过 QQ', () => {
    const danmaku = toObservation(env(7, { type: 'bilibili.danmaku', text: '[弹幕|嘉录] 666', meta: { uid: 9, uname: '嘉录', body: '666' } }), opts);
    expect(danmaku).toMatchObject({ event_id: 'cortico:7', kind: 'danmaku', scope: { session: { id: 'bilibili:group:24292304' }, subject_principal_id: 'bilibili:user:9' } });
    const noPrefix = toObservation(env(8, { text: 'x', meta: { message_id: 1, conv: { kind: 'group', id: 1 } } }), { ...opts, sessionPrefix: '' });
    expect(noPrefix).toBeNull();
    expect(toObservation(env(9, { type: 'qq.watch', text: 'x' }), opts)).toBeNull();
  });

  it('qqBody 兜底解析', () => {
    expect(qqBody('[群 x 01:00] 某人: 你好: 世界', '')).toBe('你好: 世界');
  });
});

describe('ObservationSync', () => {
  function bridgeReturning(responses: Array<() => unknown>, seen: unknown[]): WaveMemoryBridge {
    const fetchImpl: FetchLike = async (_url, init) => {
      seen.push(init?.body ? JSON.parse(init.body) : undefined);
      const next = responses.shift();
      const value = next ? next() : { ok: true, accepted: 0 };
      if (value instanceof Error) throw value;
      return { ok: true, status: 200, json: async () => value, text: async () => '' };
    };
    return new WaveMemoryBridge('http://127.0.0.1:9876', fetchImpl, 't');
  }

  it('首次从当前位置开始，离线时游标不前进，恢复后补写', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-sync-'));
    const cursorFile = join(dir, 'cursor.json');
    const store = new Store([env(1, { type: 'qq.watch', text: 'old' })]);
    const seen: unknown[] = [];
    const bridge = bridgeReturning([() => new Error('ECONNREFUSED'), () => ({ ok: true, accepted: 1 })], seen);
    const sync = new ObservationSync({ bridge, botId: 'yushu', sessionPrefix: () => '羽书', liveSessionId: opts.liveSessionId, cursorFile });

    expect(await sync.tick(store)).toMatchObject({ scanned: 0, cursor: 1 });
    store.events.push(env(2, { text: '#5 [群 g 01:00] 甲: 记住 周五考试', meta: { message_id: 5, user_id: 1, sender_name: '甲', conv: { kind: 'group', id: 42 } } }));

    const offline = await sync.tick(store);
    expect(offline).toMatchObject({ sent: 1, cursor: 1 });
    expect(offline?.error).toContain('ECONNREFUSED');

    const back = await sync.tick(store);
    expect(back).toMatchObject({ sent: 1, accepted: 1, cursor: 2 });
    expect(JSON.parse(readFileSync(cursorFile, 'utf8')).cursor).toBe(2);
    const batch = seen[1] as { events: Array<{ event_id: string; content: string }> };
    expect(batch.events[0]).toMatchObject({ event_id: '5', content: '记住 周五考试' });

    // 重启：从文件里的游标继续
    const again = new ObservationSync({ bridge, botId: 'yushu', sessionPrefix: () => '羽书', liveSessionId: '', cursorFile });
    expect(again.loadCursor(10)).toBe(2);
  });
});

describe('远程工具', () => {
  it('从 /capabilities 拿到工具后按别名暴露并带上会话', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, body });
      const data = url.includes('/capabilities')
        ? {
            ok: true,
            bot: { db_id: 'yushu', name: '羽书', session_prefix: '羽书', self_ids: [] },
            tools: [
              { name: 'wave_memory_search', description: '搜', parameters: { type: 'object', properties: { query: { type: 'string' } } }, group: 'memory', writes: false, enabled: true },
              { name: 'wave_memory_record_social_impression', description: '印象', parameters: { type: 'object', properties: {} }, group: 'social', writes: true, enabled: true },
              { name: 'wave_memory_book_lore_search', description: '书设', parameters: {}, group: 'book_lore', writes: false, enabled: true },
            ],
          }
        : { ok: true, result: 'done' };
      return { ok: true, status: 200, json: async () => data, text: async () => '' };
    };
    const world = new WaveMemoryWorld({
      cfg: WAVEMEMORY_DEFAULTS(),
      timezone: 'Asia/Shanghai',
      bridge: new WaveMemoryBridge('http://127.0.0.1:9876', fetchImpl, 't'),
    });
    expect(await world.refreshCapabilities(true)).toBe(true);
    const names = world.tools().map((t) => t.name);
    expect(names).toContain('wave_recall_memory');
    expect(names).toContain('wave_record_social_impression');
    expect(names.filter((n) => n === 'wave_recall_memory')).toHaveLength(1);
    expect(names).toContain('wave_book_lore_search');
    expect(cortiToolName('wave_memory_note_concern')).toBe('wave_note_concern');

    const impression = world.tools().find((t) => t.name === 'wave_record_social_impression')!;
    expect(impression.tags).toEqual(['write']);
    expect(await impression.handler({ user_id: '123', conversation: 'group:42' }, {} as never)).toBe('done');
    const invoke = calls.at(-1)!;
    expect(invoke.url).toMatch(/\/tools\/wave_memory_record_social_impression$/);
    expect(invoke.body).toMatchObject({ arguments: { user_id: '123' }, scope: { session: { id: '羽书:group:42' } } });
  });
});
