import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { WAVEMEMORY_DEFAULTS, type WaveMemoryConfigSection } from '../src/config.ts';
import { WaveMemoryBridge, type FetchLike } from '../src/bridge.ts';
import { WaveMemoryWorld } from '../src/world.ts';
import { hashQuery, recallQueryText } from '../src/recall-query.ts';
import { FakeHost, FakeStore, recordingFetch } from './helpers.ts';

const TS = '2026-09-30T21:00:00+08:00';
const NOW = Date.parse('2026-09-30T21:00:30+08:00');
const SAFETY = '<identity_safety_system>\n测试用身份安全规则\n</identity_safety_system>';

function cfg(patch: Partial<WaveMemoryConfigSection> = {}): WaveMemoryConfigSection {
  return { ...WAVEMEMORY_DEFAULTS(), ...patch };
}

function danmaku(store: FakeStore, body: string, uid = 10000001, uname = '阿木', ts = TS): EventEnvelope {
  return store.push({ type: 'bilibili.danmaku', source: 'bilibili', ts, text: `[弹幕|${uname}] ${body}`, senderKey: uid > 0 ? String(uid) : undefined, meta: { uid, uname, body } });
}

function terminal(store: FakeStore, body: string, ts = TS): EventEnvelope {
  return store.push({ type: 'terminal.message', source: 'terminal', origin: 'internal', ts, text: `[21:00] 控制台: ${body}`, senderKey: '控制台', meta: { from: '控制台', body } });
}

function mockFetch(handler: (url: string, body?: any) => unknown): FetchLike {
  return recordingFetch((url, body) => handler(url, body));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('recallQueryText', () => {
  it('取最近一句对话所在会话的最后几句；自己注入的块、游戏事件、归档的原始弹幕都不算', () => {
    const store = new FakeStore();
    danmaku(store, '旧弹幕');
    store.push({ type: 'wavememory.context', source: 'wavememory', origin: 'internal', text: '[相关记忆] 不该被检索' });
    store.push({ type: 'bilibili.danmaku', source: 'bilibili', contextDelivery: 'archive-only', text: '[弹幕|阿木] 台风好好笑', meta: { uid: 10000001, uname: '阿木', body: '台风好好笑' } });
    store.push({ type: 'minecraft.event', source: 'minecraft', text: '[Minecraft] 夜幕降临了,敌对生物会开始出现。' });
    danmaku(store, '台风好好笑', 10000001, '阿木');
    const { text, speaker, channel } = recallQueryText(store);
    expect(text).toBe('旧弹幕\n台风好好笑');
    expect(speaker).toEqual({ id: '10000001', name: '阿木' });
    expect(channel).toEqual({ kind: 'live' });
  });

  it('终端说话时只取终端这条线；匿名观众不带号码', () => {
    const store = new FakeStore();
    danmaku(store, '主播好', 0, '阿***');
    expect(recallQueryText(store).speaker).toEqual({ name: '阿***' });
    terminal(store, '整理一下你的记忆');
    const q = recallQueryText(store);
    expect(q).toEqual({ text: '整理一下你的记忆', speaker: { name: '控制台' }, channel: { kind: 'terminal' } });
  });

  it('没有对话时返回空', () => {
    const store = new FakeStore();
    store.push({ type: 'minecraft.event', source: 'minecraft', text: '[Minecraft] 天亮了。' });
    expect(recallQueryText(store)).toEqual({ text: '', speaker: {}, channel: null });
  });
});

describe('WaveMemoryWorld 注入', () => {
  it('start 入队 piggyback + origin internal', async () => {
    const host = new FakeHost();
    const world = new WaveMemoryWorld({ cfg: cfg(), timezone: 'Asia/Shanghai' });
    await world.start(host);
    expect(host.deferred).toHaveLength(1);
    expect(host.deferred[0].opts?.trigger).toBe('piggyback');
    expect(host.deferred[0].spec.origin).toBe('internal');
    expect(host.deferred[0].spec.type).toBe('wavememory.context');
    expect(host.deferred[0].spec.tags).toEqual(['snapshot']);
  });

  it('ARM_STALE 内不重复入队；onTurnEnded 在 render 清标志后可再 arm', async () => {
    const host = new FakeHost();
    const world = new WaveMemoryWorld({ cfg: cfg(), timezone: 'Asia/Shanghai' });
    await world.start(host);
    world.onTurnEnded();
    expect(host.deferred).toHaveLength(1);
    await host.deferred[0].spec.render();
    expect(world.isArmed).toBe(false);
    world.onTurnEnded();
    expect(host.deferred).toHaveLength(2);
  });

  it('弹幕 → 直播间会话，发言人是 bilibili:user:<uid>；在玩游戏时带 game 字段', async () => {
    const calls: any[] = [];
    const bridge = new WaveMemoryBridge('http://127.0.0.1:9876', mockFetch((_url, body) => {
      calls.push(body);
      return { ok: true, block: '[相关记忆]\n- 台风轨迹真有意思', chars: 20 };
    }));
    const host = new FakeHost();
    const world = new WaveMemoryWorld({ cfg: cfg(), timezone: 'Asia/Shanghai', bridge, now: () => NOW });
    await world.start(host);
    host.store.push({ type: 'minecraft.event', source: 'minecraft', ts: TS, text: '[Minecraft] 夜幕降临了,敌对生物会开始出现。' });
    danmaku(host.store, '羽书你昨天说的那个台风的事还挺好笑的');
    const out = await host.deferred[0].spec.render();
    expect(out).toBe('[相关记忆]\n- 台风轨迹真有意思');
    expect(calls[0]).toMatchObject({
      text: '羽书你昨天说的那个台风的事还挺好笑的',
      speaker: { id: '10000001', name: '阿木' },
      uid: '10000001',
      tier: 'full',
      scope: {
        bot_id: 'yushu',
        visibility: 'group',
        session: { id: 'bilibili:group:24292304', platform_id: 'bilibili', kind: 'group', conversation_id: '24292304' },
        subject_principal_id: 'bilibili:user:10000001',
      },
      game: { id: 'minecraft', state: { time_of_day: 'night' }, keywords: ['夜晚'] },
    });
  });

  it('终端 → 终端私聊会话；没在玩游戏就不带 game', async () => {
    const calls: any[] = [];
    const bridge = new WaveMemoryBridge('http://127.0.0.1:9876', mockFetch((_url, body) => {
      calls.push(body);
      return { ok: true, block: 'terminal-block' };
    }));
    const host = new FakeHost();
    const world = new WaveMemoryWorld({ cfg: cfg(), timezone: 'Asia/Shanghai', bridge, now: () => NOW });
    await world.start(host);
    danmaku(host.store, '主播好');
    terminal(host.store, '今晚准备去打末影龙');
    expect(await host.deferred[0].spec.render()).toBe('terminal-block');
    expect(calls[0].text).toBe('今晚准备去打末影龙');
    expect(calls[0].scope).toEqual({
      bot_id: 'yushu',
      visibility: 'private',
      session: { id: 'terminal:private:operator', platform_id: 'terminal', kind: 'private', conversation_id: 'operator' },
      subject_principal_id: 'terminal:user:operator',
    });
    expect(calls[0]).not.toHaveProperty('game');
  });

  it('QQ → 规范前缀的群会话；前缀还没拿到时这一轮不注入', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const bridge = new WaveMemoryBridge('http://127.0.0.1:9876', recordingFetch((url, body) => {
      calls.push({ url, body });
      if (url.includes('/capabilities')) return { ok: true, bot: { db_id: 'yushu', name: '羽书', session_prefix: '羽书', self_ids: [] }, tools: [] };
      return { ok: true, block: 'qq-block' };
    }));
    const host = new FakeHost();
    const world = new WaveMemoryWorld({ cfg: cfg(), timezone: 'Asia/Shanghai', bridge, now: () => NOW });
    await world.start(host);
    host.store.push({
      type: 'qq.message', source: 'qq', ts: TS, text: '#77 [群 书友群 21:00] 小七: 今天播什么',
      meta: { message_id: 77, user_id: 10000002, sender_name: '小七', conv: { kind: 'group', id: 20000001 } },
    });
    expect(await host.deferred[0].spec.render()).toBeNull();
    expect(calls.filter((c) => c.url.includes('/context/prepare'))).toHaveLength(0);
    await world.refreshCapabilities(true);
    world.onTurnEnded();
    expect(await host.deferred[1].spec.render()).toBe('qq-block');
    const prepare = calls.find((c) => c.url.includes('/context/prepare'))!;
    expect(prepare.body.scope).toMatchObject({
      visibility: 'group',
      session: { id: '羽书:group:20000001' },
      subject_principal_id: '羽书:user:10000002',
    });
  });

  it('无对话时 render 返回 null，不打桥', async () => {
    const spy = vi.fn();
    const bridge = new WaveMemoryBridge('http://127.0.0.1:8030', mockFetch(() => {
      spy();
      return { ok: true, block: '不该出现' };
    }));
    const host = new FakeHost();
    const world = new WaveMemoryWorld({ cfg: cfg(), timezone: 'Asia/Shanghai', bridge });
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
    const world = new WaveMemoryWorld({ cfg: cfg(), timezone: 'Asia/Shanghai', bridge });
    await world.start(host);
    danmaku(host.store, '同一句');
    expect(await host.deferred[0].spec.render()).toBe('cached-block');
    world.onTurnEnded();
    expect(await host.deferred[1].spec.render()).toBe('cached-block');
    expect(hits).toBe(1);
  });

  it('超时回落 stale 缓存，但只给同一个发言人', async () => {
    let n = 0;
    const bridge = new WaveMemoryBridge('http://127.0.0.1:8030', async () => {
      n += 1;
      if (n === 1) return { ok: true, status: 200, json: async () => ({ ok: true, block: 'stale-ok' }), text: async () => '' };
      await new Promise((r) => setTimeout(r, 80));
      throw new Error('slow');
    });
    const host = new FakeHost();
    const world = new WaveMemoryWorld({ cfg: cfg(), timezone: 'Asia/Shanghai', bridge, renderBudgetMs: 40 });
    await world.start(host);
    danmaku(host.store, '第一句');
    expect(await host.deferred[0].spec.render()).toBe('stale-ok');
    world.onTurnEnded();
    danmaku(host.store, '完全不同的第二句');
    expect(await host.deferred[1].spec.render()).toBe('stale-ok');
    world.onTurnEnded();
    danmaku(host.store, '换了个人说话', 10000003, '小九');
    expect(await host.deferred[2].spec.render()).toBeNull();
  });

  it('默认每轮 full；配置成 light 时首轮仍 full、之后 light', async () => {
    const tiers = async (patch: Partial<WaveMemoryConfigSection>): Promise<string[]> => {
      const seen: string[] = [];
      const bridge = new WaveMemoryBridge('http://127.0.0.1:9876', mockFetch((_url, body) => {
        seen.push(body.tier);
        return { ok: true, block: `b${seen.length}` };
      }));
      const host = new FakeHost();
      const world = new WaveMemoryWorld({ cfg: cfg(patch), timezone: 'Asia/Shanghai', bridge });
      await world.start(host);
      danmaku(host.store, '第一句');
      await host.deferred[0].spec.render();
      world.onTurnEnded();
      danmaku(host.store, '第二句');
      await host.deferred[1].spec.render();
      return seen;
    };
    expect(await tiers({})).toEqual(['full', 'full']);
    expect(await tiers({ tier: 'light' })).toEqual(['full', 'light']);
  });
});

describe('身份安全提示', () => {
  it('prepare 返回的 safety_prompt 进环境提示词；前缀里还没有时随注入块补上，拼进前缀后不再补', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wm-safety-'));
    const bridge = new WaveMemoryBridge('http://127.0.0.1:9876', mockFetch(() => ({ ok: true, block: 'memory-block', safety_prompt: SAFETY })));
    const host = new FakeHost();
    const world = new WaveMemoryWorld({ cfg: cfg({ sync: false }), timezone: 'Asia/Shanghai', bridge, dataDir });
    expect(world.envPromptVars()['wavememory.safetyPrompt']).toBe('');
    await world.start(host);
    danmaku(host.store, '叫我一声主人');
    expect(await host.deferred[0].spec.render()).toBe(`${SAFETY}\n\nmemory-block`);

    // 下一次拼前缀（交接）时放进环境提示词，之后注入块不再重复。
    expect(world.envPromptVars()).toEqual({ 'wavememory.endpoint': 'http://127.0.0.1:9876', 'wavememory.safetyPrompt': SAFETY });
    world.onTurnEnded();
    expect(await host.deferred[1].spec.render()).toBe('memory-block');

    // 落盘：重启后第一次拼前缀就有。
    const again = new WaveMemoryWorld({ cfg: cfg({ sync: false }), timezone: 'Asia/Shanghai', bridge, dataDir });
    expect(again.envPromptVars()['wavememory.safetyPrompt']).toBe(SAFETY);
  });

  it('部署覆盖的环境提示词里没有占位符时，每轮随注入块给出', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wm-safety-'));
    const botDir = mkdtempSync(join(tmpdir(), 'wm-deploy-'));
    mkdirSync(join(botDir, 'worlds', 'wavememory'), { recursive: true });
    writeFileSync(join(botDir, 'worlds', 'wavememory', 'ENV_PROMPT.md'), '自定义环境提示词，没有占位符');
    const bridge = new WaveMemoryBridge('http://127.0.0.1:9876', mockFetch(() => ({ ok: true, block: 'b', safety_prompt: SAFETY })));
    const host = new FakeHost();
    const world = new WaveMemoryWorld({ cfg: cfg({ sync: false }), timezone: 'Asia/Shanghai', bridge, dataDir, botDir });
    await world.start(host);
    danmaku(host.store, '你好');
    await host.deferred[0].spec.render();
    world.envPromptVars();
    world.onTurnEnded();
    danmaku(host.store, '再说一句');
    expect(await host.deferred[1].spec.render()).toBe(`${SAFETY}\n\nb`);
  });

  it('旧服务端不返回 safety_prompt 时什么都不加', async () => {
    const bridge = new WaveMemoryBridge('http://127.0.0.1:9876', mockFetch(() => ({ ok: true, block: 'plain' })));
    const host = new FakeHost();
    const world = new WaveMemoryWorld({ cfg: cfg(), timezone: 'Asia/Shanghai', bridge });
    await world.start(host);
    danmaku(host.store, '你好');
    expect(await host.deferred[0].spec.render()).toBe('plain');
    expect(world.envPromptVars()['wavememory.safetyPrompt']).toBe('');
  });
});

describe('Runtime 令牌', () => {
  async function authOf(opts: { secret?: string; config?: string }): Promise<{ header: string | undefined; warnings: string[] }> {
    const seen: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    vi.stubGlobal('fetch', recordingFetch(() => ({ ok: true, tools: [], bot: null }), seen));
    const world = new WaveMemoryWorld({
      cfg: cfg({ authToken: opts.config ?? '' }),
      timezone: 'Asia/Shanghai',
      secret: (name) => (name === 'WAVEMEMORY_RUNTIME_TOKEN' ? opts.secret ?? '' : ''),
    });
    const host = new FakeHost();
    await world.start(host);
    await world.refreshCapabilities(true);
    await world.stop();
    return { header: seen.at(-1)?.headers.Authorization, warnings: host.warnings };
  }

  it('部署密钥优先于 config.json 明文，读到密钥时不警告', async () => {
    const r = await authOf({ secret: 'from-env', config: 'from-config' });
    expect(r.header).toBe('Bearer from-env');
    expect(r.warnings.filter((w) => w.includes('令牌'))).toEqual([]);
  });

  it('只有 config.json 明文时照用并警告一次；都没有时不带 Authorization 并提示', async () => {
    const plain = await authOf({ config: 'from-config' });
    expect(plain.header).toBe('Bearer from-config');
    expect(plain.warnings.filter((w) => w.includes('明文'))).toHaveLength(1);
    const none = await authOf({});
    expect(none.header).toBeUndefined();
    expect(none.warnings.some((w) => w.includes('没有配置 Runtime 令牌'))).toBe(true);
  });

  it('默认配置里不再有开发令牌', () => {
    expect(WAVEMEMORY_DEFAULTS().authToken).toBe('');
    expect(new WaveMemoryWorld({ cfg: cfg(), timezone: 'Asia/Shanghai' }).token()).toEqual({ token: '', origin: 'none' });
  });
});

describe('工具默认会话与输出旁路', () => {
  function toolWorld(now: number) {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchImpl = recordingFetch((url, body) => {
      calls.push({ url, body });
      if (url.includes('/capabilities')) {
        return {
          ok: true,
          bot: { db_id: 'yushu', name: '羽书', session_prefix: '羽书', self_ids: [] },
          tools: [{ name: 'wave_memory_note_concern', description: '关切', parameters: { type: 'object', properties: {} }, group: 'x', writes: true, enabled: true }],
        };
      }
      return { ok: true, result: 'done' };
    });
    const host = new FakeHost();
    const world = new WaveMemoryWorld({ cfg: cfg(), timezone: 'Asia/Shanghai', bridge: new WaveMemoryBridge('http://127.0.0.1:9876', fetchImpl), now: () => now });
    return { calls, host, world };
  }

  it('不带 conversation 时用当前对话的会话；conversation=live 指定直播间；十分钟没人说话回到直播间', async () => {
    const { calls, host, world } = toolWorld(NOW);
    await world.start(host);
    await world.refreshCapabilities(true);
    const tool = world.tools().find((t) => t.name === 'wave_note_concern')!;
    expect((tool.parameters as any).properties.conversation.description).toContain('live=直播间');

    terminal(host.store, '记得明天提醒我备份');
    await tool.handler({ topic: '备份' }, {} as never);
    expect(calls.at(-1)!.body).toMatchObject({ arguments: { topic: '备份' }, scope: { session: { id: 'terminal:private:operator' } } });

    await tool.handler({ topic: '直播', conversation: 'live' }, {} as never);
    expect(calls.at(-1)!.body.scope.session.id).toBe('bilibili:group:24292304');
    expect(calls.at(-1)!.body.arguments).toEqual({ topic: '直播' });

    const later = toolWorld(NOW + 11 * 60_000);
    await later.world.start(later.host);
    await later.world.refreshCapabilities(true);
    terminal(later.host.store, '记得明天提醒我备份');
    await later.world.tools().find((t) => t.name === 'wave_note_concern')!.handler({}, {} as never);
    expect(later.calls.at(-1)!.body.scope.session.id).toBe('bilibili:group:24292304');
  });

  it('只有开了同步且见过 vtuber 事件才挂输出旁路', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wm-tap-'));
    const plain = new WaveMemoryWorld({ cfg: cfg(), timezone: 'Asia/Shanghai', dataDir });
    const host = new FakeHost();
    await plain.start(host);
    expect(plain.outputTap()).toBeUndefined();
    await plain.stop();

    const withVtuber = new FakeHost();
    withVtuber.store.push({ type: 'vtuber.status', source: 'vtuber', text: '[演出] 就绪', tags: ['snapshot'] });
    const world = new WaveMemoryWorld({ cfg: cfg(), timezone: 'Asia/Shanghai', dataDir });
    await world.start(withVtuber);
    expect(world.outputTap()).toBeDefined();
    await world.stop();

    const noSync = new WaveMemoryWorld({ cfg: cfg({ sync: false }), timezone: 'Asia/Shanghai', dataDir });
    await noSync.start(withVtuber);
    expect(noSync.outputTap()).toBeUndefined();
    await noSync.stop();
  });
});

describe('hashQuery', () => {
  it('相同文本相同哈希', () => {
    expect(hashQuery('台风')).toBe(hashQuery('台风'));
    expect(hashQuery('台风')).not.toBe(hashQuery('游戏'));
  });
});
