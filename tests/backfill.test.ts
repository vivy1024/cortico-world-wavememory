import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { WaveMemoryBridge, type FetchLike, type ObservationEventItem } from '../src/bridge.ts';
import { CallLedger } from '../src/speech.ts';
import { ObservationSync, SYNC_CURSOR_FILE } from '../src/sync.ts';
import {
  loadDeployment,
  parseArgs,
  parseSince,
  readEventStore,
  runBackfill,
  type BackfillOptions,
} from '../scripts/backfill-game-events.ts';
import { FakeStore, recordingFetch } from './helpers.ts';

const LIVE = 'bilibili:group:24292304';
const RUN_A = 'r-20260916-100000-aaaa';
const RUN_B = 'r-20260917-085900-bbbb';
const A = (hms: string) => `2026-09-16T${hms}+08:00`;
const B = (hms: string) => `2026-09-17T${hms}+08:00`;
const SCRIPT = '【挥手】大家好，我去下界啦';

const snapshot = (goalLine: string) =>
  `[Minecraft] 我在平原，脚下是草方块，站在格 (1, 70, 2)，主世界。我站着没动，面朝北。\n${goalLine}`;
const sts = (screen: string, body: string) => `[StS 0123456789ab · ${screen} · 可操作]\n${body}`;

type Draft = Omit<EventEnvelope, 'cursor' | 'origin'> & { origin?: EventEnvelope['origin'] };
const mc = (ts: string, type: string, text: string): Draft => ({ ts, source: 'minecraft', type, text, senderKey: 'minecraft' });

/** 第一天：我的世界（死亡、立下与完成目标、进下界两次）、弹幕、口播、我的世界里自己发的聊天。 */
const DAY_ONE: Draft[] = [
  mc(A('10:00:00'), 'minecraft.world.snapshot', snapshot('目标:0 条(5 格全空,用 mc_goal 挂)')),
  { ts: A('10:00:05'), source: 'bilibili', type: 'bilibili.danmaku', text: '[弹幕|嘉录] 主播加油', senderKey: '9', meta: { uid: 9, uname: '嘉录', body: '主播加油' } },
  mc(A('10:01:00'), 'minecraft.event', '[Minecraft] 你死了(今天第 1 次)。服务端记的死因:yushu was slain by Zombie(被打死)。死亡点在 [主世界] (1, 64, 2)。会回重生点 [主世界] (0, 64, 0) 重生,离死亡点 2 格。掉的东西留在死亡点,5 分钟后消失。'),
  mc(A('10:02:00'), 'minecraft.world.snapshot', snapshot('目标:#1 砍树做工具[类型:建造;里程碑:0/2]')),
  { ts: A('10:02:10'), source: 'vtuber', origin: 'internal', type: 'vtuber.playback.finished', text: '[本地播放终态] call_v1: completed。', meta: { playback: { callId: 'call_v1', state: 'completed' } } },
  mc(A('10:03:00'), 'minecraft.event', '[Minecraft] 从主世界进入了下界。'),
  mc(A('10:03:30'), 'minecraft.chat', '[MC] yushu: 我到下界啦'),
  mc(A('10:04:00'), 'minecraft.world.snapshot', snapshot('目标:0 条(5 格全空,用 mc_goal 挂)')),
  mc(A('10:04:30'), 'minecraft.event', '[Minecraft] 从主世界进入了下界。'),
];

/** 第二天：杀戮尖塔一整局（开局、拿遗物、倒下）、弹幕、又进一次下界。 */
const DAY_TWO: Draft[] = [
  { ts: B('09:00:00'), source: 'sts-1', type: 'sts-1.state', text: sts('主菜单', '操作：\n1 铁甲战士 · 进阶 0'), senderKey: 'sts-1' },
  { ts: B('09:00:10'), source: 'sts-1', type: 'sts-1.state', text: sts('事件', '第1幕 · 第0层 · 生命 75/75 · 金币 99\n遗物：破损核心：在每场战斗开始时， 生成 1 个 闪电 充能球。'), senderKey: 'sts-1' },
  { ts: B('09:05:00'), source: 'sts-1', type: 'sts-1.state', text: sts('战斗', '第1幕 · 第3层 · 生命 60/75 · 金币 140\n遗物：破损核心：在每场战斗开始时， 生成 1 个 闪电 充能球。；钢笔尖(4)：每打出 10 张攻击牌，下一张伤害翻倍。'), senderKey: 'sts-1' },
  { ts: B('09:05:10'), source: 'bilibili', type: 'bilibili.danmaku', text: '[弹幕|阿木] 钢笔尖好评', senderKey: '10', meta: { uid: 10, uname: '阿木', body: '钢笔尖好评' } },
  mc(B('09:06:00'), 'minecraft.event', '[Minecraft] 从主世界进入了下界。'),
  { ts: B('09:10:00'), source: 'sts-1', type: 'sts-1.decision', text: sts('游戏结束', '第1幕 · 第6层 · 生命 0/75 · 金币 120\n游戏结束 · 得分 88'), senderKey: 'sts-1' },
];

const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

/** 临时部署目录：config.json、.env、两段 run 的事件库与工具调用流水。 */
function makeFixture(): { dir: string; events: EventEnvelope[] } {
  const dir = mkdtempSync(join(tmpdir(), 'wm-backfill-'));
  const runs = join(dir, 'data', 'runs');
  const events: EventEnvelope[] = [];
  const write = (run: string, drafts: Draft[]) => {
    mkdirSync(join(runs, run), { recursive: true });
    // cursor 跨 run 全局递增：先记下本段起点，再按段内序号编号。
    const base = events.length;
    const rows = drafts.map((d, i) => ({ origin: 'external' as const, ...d, cursor: base + i + 1, run }));
    for (const row of rows) events.push(row);
    writeFileSync(join(runs, run, 'events.jsonl'), jsonl(rows));
  };
  write(RUN_A, DAY_ONE);
  write(RUN_B, DAY_TWO);
  writeFileSync(join(runs, 'index.jsonl'), jsonl([
    { run: RUN_A, startedAt: A('09:59:00'), bot: '羽书', pid: 1, gitSha: null, previousRun: null },
    { run: RUN_A, endedAt: A('10:05:00'), lastCursor: 9, complete: true, reason: 'SIGINT' },
    { run: RUN_B, startedAt: B('08:59:00'), bot: '羽书', pid: 2, gitSha: null, previousRun: RUN_A },
  ]));
  writeFileSync(join(runs, RUN_A, 'toolcalls.jsonl'), jsonl([
    { seq: 1, ts: A('10:02:08.000'), run: RUN_A, call: 'call_v1', role: 'main', tool: 'vtuber_act', mod: 'vtuber', args: { script: SCRIPT }, durMs: 5, chars: 2, receipt: 'ok' },
    { seq: 2, ts: A('10:03:40.000'), run: RUN_A, call: 'call_m1', role: 'main', tool: 'mc_do', mod: 'minecraft', args: { steps: [] }, durMs: 1, chars: 2, receipt: 'ok' },
    { seq: 3, ts: A('10:03:50.000'), run: RUN_A, call: 'call_g1', role: 'main', tool: 'mc_goal', mod: 'minecraft', args: { done: 1 }, durMs: 3, chars: 10, receipt: '#1 砍树做工具 结案' },
    // 别的 session 下的指令，输出旁路看不到（算进来的话最后一条是 drop，完成就不成立了）。
    { seq: 4, ts: A('10:03:55.000'), run: RUN_A, call: 'call_h1', role: 'helper', tool: 'mc_goal', mod: 'minecraft', args: { drop: 1 }, durMs: 3, chars: 10, receipt: '撤了' },
  ]));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    worlds: { wavememory: { enabled: true, endpoint: 'http://wm.test:9876', authToken: 'from-config', botId: 'yushu', sessionId: LIVE } },
  }, null, 2));
  writeFileSync(join(dir, '.env'), 'NUG_API_KEY=nug\nWAVEMEMORY_RUNTIME_TOKEN=from-env\n');
  return { dir, events };
}

const options = (dir: string, patch: Partial<BackfillOptions> = {}): BackfillOptions =>
  ({ deployment: dir, dryRun: false, since: null, untilCursor: null, batch: 50, ...patch });

const quiet = { log: () => {}, env: {} };

function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) {
        out[`${relative(root, path)}/`] = String(st.mtimeMs);
        walk(path);
      } else {
        out[relative(root, path)] = `${st.size}:${st.mtimeMs}:${readFileSync(path, 'utf8')}`;
      }
    }
  };
  walk(root);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('补录历史游戏经历', () => {
  it('只产出游戏经历；条目与 event_id 和实时同步映射同一段事件完全一致', async () => {
    const fx = makeFixture();
    const report = await runBackfill(options(fx.dir, { dryRun: true }), quiet);
    expect(report.records.every((r) => r.item.kind === 'game_event')).toBe(true);
    expect(report.records.map((r) => [r.item.event_id, r.item.game, r.item.event_type, r.item.content])).toEqual([
      ['cortico:3', 'minecraft', 'death', '[我的世界] 今天第 1 次死亡：被打死（yushu was slain by Zombie），死在主世界 (1, 64, 2)'],
      ['cortico:4:goal-add:1', 'minecraft', 'goal', '[我的世界] 立下目标：砍树做工具'],
      ['cortico:6', 'minecraft', 'discovery', '[我的世界] 从主世界进入了下界'],
      ['cortico:8:goal-done:1', 'minecraft', 'goal', '[我的世界] 完成了目标：砍树做工具'],
      ['cortico:11:run', 'sts', 'milestone', '[杀戮尖塔] 开了新的一局（故障机器人）'],
      ['cortico:12:relic:钢笔尖', 'sts', 'choice', '[杀戮尖塔] 第 1 幕第 3 层拿到遗物「钢笔尖」'],
      ['cortico:14', 'minecraft', 'discovery', '[我的世界] 从主世界进入了下界'],
      ['cortico:15:result', 'sts', 'death', '[杀戮尖塔] 这一局（故障机器人）在第 1 幕第 6 层倒下了，得分 88'],
    ]);
    expect(report.records[0].item.scope).toEqual({
      bot_id: 'yushu',
      visibility: 'group',
      session: { id: LIVE, platform_id: 'bilibili', kind: 'group', conversation_id: '24292304' },
    });

    // 实时路径：ObservationSync 从 #0 起分批映射同一段事件，CallLedger 里是输出旁路会记下的那两条调用。
    const cursorFile = join(mkdtempSync(join(tmpdir(), 'wm-live-')), SYNC_CURSOR_FILE);
    writeFileSync(cursorFile, JSON.stringify({ cursor: 0 }));
    const ledger = new CallLedger({ now: () => Date.parse(A('10:05:00')) });
    ledger.record({ callId: 'call_v1', tool: 'vtuber_act', at: Date.parse(A('10:02:08')), script: SCRIPT });
    ledger.record({ callId: 'call_g1', tool: 'mc_goal', at: Date.parse(A('10:03:50')), goal: { op: 'done', slot: 1 } });
    const sent: ObservationEventItem[] = [];
    const bridge = new WaveMemoryBridge('http://wm.test:9876', recordingFetch((_url, body) => {
      sent.push(...body.events);
      return { ok: true, accepted: body.events.length };
    }), 't');
    const sync = new ObservationSync({ bridge, botId: 'yushu', sessionPrefix: () => '羽书', liveSessionId: LIVE, calls: ledger, cursorFile, batchSize: 4 });
    const store = new FakeStore(fx.events);
    for (let i = 0; i < 10 && (await sync.tick(store))!.cursor < store.latestCursor(); i++);
    expect(JSON.parse(readFileSync(cursorFile, 'utf8')).cursor).toBe(15);

    expect(sent.filter((e) => e.kind === 'game_event')).toEqual(report.records.map((r) => r.item));
    // 同一段事件里实时同步还写了弹幕、口播与自己发的聊天，补录一条都不碰。
    expect(sent.filter((e) => e.kind !== 'game_event').map((e) => [e.kind, e.content])).toEqual([
      ['danmaku', '主播加油'],
      ['self', '大家好，我去下界啦'],
      ['self', '[我的世界聊天] 我到下界啦'],
      ['danmaku', '钢笔尖好评'],
    ]);
  });

  it('上限：gamesFrom 优先，其次旧版文件的 cursor，没有游标文件取事件库最新位置；--until-cursor 覆盖', async () => {
    const fx = makeFixture();
    const cursorFile = join(fx.dir, 'data', SYNC_CURSOR_FILE);
    const run = (patch: Partial<BackfillOptions> = {}) => runBackfill(options(fx.dir, { dryRun: true, ...patch }), quiet);
    const cursors = (r: { records: Array<{ cursor: number }> }) => r.records.map((x) => x.cursor);

    const none = await run();
    expect(none).toMatchObject({ latest: 15, upper: 15, scanned: 15 });
    expect(none.upperSource).toContain('还没有同步游标文件');
    expect(cursors(none)).toEqual([3, 4, 6, 8, 11, 12, 14, 15]);

    // v0.2.0 只同步对话：新版会从它的 cursor 之后开始同步游戏经历。
    writeFileSync(cursorFile, JSON.stringify({ cursor: 8, at: '2026-09-16T02:05:00.000Z' }));
    const legacy = await run();
    expect(legacy).toMatchObject({ upper: 8, scanned: 8 });
    expect(cursors(legacy)).toEqual([3, 4, 6, 8]);

    // 新版跑过：cursor 是眼下进度，起点看 gamesFrom。
    writeFileSync(cursorFile, JSON.stringify({ cursor: 14, games: {}, gamesFrom: 6 }));
    const started = await run();
    expect(started.upper).toBe(6);
    expect(started.upperSource).toContain('gamesFrom');
    expect(cursors(started)).toEqual([3, 4, 6]);

    writeFileSync(cursorFile, JSON.stringify({ cursor: 12, games: {} }));
    const unknown = await run();
    expect(unknown.upper).toBe(12);
    expect(unknown.warnings.some((w) => w.includes('没有 gamesFrom'))).toBe(true);

    expect(cursors(await run({ untilCursor: 4 }))).toEqual([3, 4]);
    const beyond = await run({ untilCursor: 99 });
    expect(beyond.upper).toBe(15);
    expect(beyond.warnings.some((w) => w.includes('超过了实时同步的起点 #12'))).toBe(true);
  });

  it('--since 只筛输出：跟踪器仍从头喂起，结果正好是整段重放的子集', async () => {
    const fx = makeFixture();
    const run = (patch: Partial<BackfillOptions> = {}) => runBackfill(options(fx.dir, { dryRun: true, ...patch }), quiet);
    const full = (await run()).records;

    const nextDay = await run({ since: '2026-09-17' });
    expect(nextDay.records.map((r) => r.cursor)).toEqual([11, 12, 14, 15]);
    expect(nextDay.scanned).toBe(15);

    // 从 10:04 起：目标完成要靠之前的目标表与 done 指令；同一天第二次进下界照样不记。
    const mid = await run({ since: A('10:04:00') });
    expect(mid.records[0].item.event_id).toBe('cortico:8:goal-done:1');
    expect(mid.records.map((r) => r.item)).toEqual(full.filter((r) => r.cursor >= 8).map((r) => r.item));

    expect(() => parseSince('昨天')).toThrow('--since');
  });

  it('--dry-run 不发请求，只打印统计与样例', async () => {
    const fx = makeFixture();
    const injected = vi.fn();
    const global = vi.fn();
    vi.stubGlobal('fetch', global);
    const lines: string[] = [];
    const report = await runBackfill(options(fx.dir, { dryRun: true }), {
      fetch: injected as unknown as FetchLike,
      log: (line) => lines.push(line),
      env: {},
    });
    expect(injected).not.toHaveBeenCalled();
    expect(global).not.toHaveBeenCalled();
    expect(report.submit).toBeNull();
    const out = lines.join('\n');
    expect(out).toContain('游戏经历 8 条');
    expect(out).toContain('我的世界（minecraft）5 条  2026-09-16 10:01:00 → 2026-09-17 09:06:00');
    expect(out).toContain('death 1 · goal 2 · discovery 2');
    expect(out).toContain('杀戮尖塔（sts）3 条');
    expect(out).toContain('death 1 · milestone 1 · choice 1');
    expect(out).toContain('缺氧（oni）0 条');
    expect(out).toContain('#3  2026-09-16 10:01:00  minecraft/death  [我的世界] 今天第 1 次死亡');
    expect(out).toContain('令牌取自 WAVEMEMORY_RUNTIME_TOKEN');
    expect(out).not.toContain('from-env');
    expect(out).toContain('演练结束，没有发送任何请求');
  });

  it('正式补录：与实时同步同样的请求分批提交，失败重试，令牌 .env 优先', async () => {
    const fx = makeFixture();
    const seen: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    let attempts = 0;
    const fetchImpl = recordingFetch((_url, body) => {
      attempts++;
      if (attempts === 1) return new Error('ECONNREFUSED');
      return {
        ok: true,
        batch_id: body.batch_id,
        accepted: body.events.length,
        rejected: 0,
        receipts: body.events.map((e: ObservationEventItem) => ({ event_id: e.event_id, status: 'accepted', kind: 'game_event' })),
      };
    }, seen);
    const sleeps: number[] = [];
    const lines: string[] = [];
    const report = await runBackfill(options(fx.dir, { batch: 3 }), {
      fetch: fetchImpl,
      log: (line) => lines.push(line),
      env: {},
      sleep: async (ms) => { sleeps.push(ms); },
    });

    expect(seen).toHaveLength(4); // 第一批失败 1 次，重试后 3 批
    expect(sleeps).toEqual([1000]);
    for (const req of seen) {
      expect(req.url).toBe('http://wm.test:9876/api/runtime/v1/observations/batch');
      expect(req.headers).toMatchObject({ Authorization: 'Bearer from-env', 'Content-Type': 'application/json' });
      expect(Object.keys(req.body)).toEqual(['batch_id', 'events']);
    }
    expect(seen.slice(1).map((r) => r.body.batch_id)).toEqual(['cortico-backfill-3-6', 'cortico-backfill-8-12', 'cortico-backfill-14-15']);
    expect(seen.slice(1).flatMap((r) => r.body.events)).toEqual(report.records.map((r) => r.item));
    expect(report.submit).toMatchObject({ batches: 3, sent: 8, accepted: 8, rejected: 0, failed: null });
    const out = lines.join('\n');
    expect(out).toContain('第 1 次失败：ECONNREFUSED；1 秒后重试');
    expect(out).toContain('批次 2/3  #8–#12  3 条  accepted 3 · rejected 0');
    expect(out).toContain('death 1 · goal 2 · discovery 2');
  });

  it('整批被拒、或重试 2 次仍失败就停下，不再往后发', async () => {
    const fx = makeFixture();
    const rejectAll = recordingFetch((_url, body) => ({
      ok: true,
      accepted: 0,
      rejected: body.events.length,
      receipts: body.events.map((e: ObservationEventItem) => ({ event_id: e.event_id, status: 'rejected', error: 'unknown_kind:game_event' })),
    }));
    const rejected = await runBackfill(options(fx.dir, { batch: 3 }), { ...quiet, fetch: rejectAll });
    expect(rejected.submit).toMatchObject({ batches: 1, sent: 3, accepted: 0, rejected: 3, rejections: { 'unknown_kind:game_event': 3 } });
    expect(rejected.submit?.failed).toContain('整批被拒');

    const seen: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const down = recordingFetch(() => new Error('ECONNREFUSED'), seen);
    const offline = await runBackfill(options(fx.dir, { batch: 3 }), { ...quiet, fetch: down, sleep: async () => {} });
    expect(seen).toHaveLength(3); // 第一次 + 重试 2 次
    expect(offline.submit).toMatchObject({ batches: 0, sent: 0, accepted: 0 });
    expect(offline.submit?.failed).toContain('重试 2 次仍失败：ECONNREFUSED');
  });

  it('只读：演练与正式补录都不改部署目录里的任何文件', async () => {
    const fx = makeFixture();
    writeFileSync(join(fx.dir, 'data', SYNC_CURSOR_FILE), JSON.stringify({ cursor: 15, at: '2026-09-17T01:10:00.000Z' }));
    const before = tree(fx.dir);
    await runBackfill(options(fx.dir, { dryRun: true }), quiet);
    await runBackfill(options(fx.dir), {
      ...quiet,
      fetch: recordingFetch((_url, body) => ({ ok: true, accepted: body.events.length })),
    });
    expect(tree(fx.dir)).toEqual(before);
  });

  it('令牌按扩展的规则：进程环境 > 部署 .env > config.json 的 authToken', () => {
    const fx = makeFixture();
    expect(loadDeployment(fx.dir, { WAVEMEMORY_RUNTIME_TOKEN: 'from-process' })).toMatchObject({ token: 'from-process', tokenOrigin: 'secret' });
    expect(loadDeployment(fx.dir, {})).toMatchObject({ token: 'from-env', tokenOrigin: 'secret' });
    writeFileSync(join(fx.dir, '.env'), 'NUG_API_KEY=nug\n');
    expect(loadDeployment(fx.dir, {})).toMatchObject({
      token: 'from-config',
      tokenOrigin: 'config',
      botId: 'yushu',
      liveSessionId: LIVE,
      endpoint: 'http://wm.test:9876',
      cursorFile: join(fx.dir, 'data', SYNC_CURSOR_FILE),
    });
  });

  it('事件库只读解析：分片内跳过坏行与乱序行，没登记的 run 照读，跨 run 的重复游标去重', () => {
    const runs = join(mkdtempSync(join(tmpdir(), 'wm-store-')), 'runs');
    const row = (cursor: number) => JSON.stringify({ cursor, ts: A('10:00:00'), type: 't', source: 's', origin: 'external', text: '' });
    mkdirSync(join(runs, RUN_A), { recursive: true });
    mkdirSync(join(runs, RUN_B), { recursive: true });
    writeFileSync(join(runs, 'index.jsonl'), jsonl([{ run: RUN_A, startedAt: A('09:59:00') }]));
    writeFileSync(join(runs, RUN_A, 'events.jsonl'), [row(1), row(2), '{坏行', row(2), '', row(3)].join('\r\n'));
    writeFileSync(join(runs, RUN_B, 'events.jsonl'), [row(3), row(4)].join('\n'));
    const scan = readEventStore(runs);
    expect(scan.runs).toEqual([RUN_A, RUN_B]);
    expect(scan.events.map((e) => e.cursor)).toEqual([1, 2, 3, 4]);
    expect(scan).toMatchObject({ latest: 4, skipped: 3 });
  });

  it('parseArgs：参数与取值校验', () => {
    expect(parseArgs(['--', '--deployment', 'D:/deploy', '--dry-run', '--since', '2026-09-16', '--until-cursor', '30282', '--batch=20']))
      .toEqual({ deployment: 'D:/deploy', dryRun: true, since: '2026-09-16', untilCursor: 30282, batch: 20 });
    expect(parseArgs(['--deployment', 'x'])).toEqual({ deployment: 'x', dryRun: false, since: null, untilCursor: null, batch: 50 });
    expect(parseArgs(['--help'])).toMatchObject({ help: true });
    expect(() => parseArgs([])).toThrow('--deployment');
    expect(() => parseArgs(['--deployment'])).toThrow('缺少取值');
    expect(() => parseArgs(['--deployment', 'x', '--batch', '501'])).toThrow('1–500');
    expect(() => parseArgs(['--deployment', 'x', '--until-cursor', '-1'])).toThrow('--until-cursor');
    expect(() => parseArgs(['--deployment', 'x', '--since', '昨天'])).toThrow('--since');
    expect(() => parseArgs(['--deployment', 'x', '--dry-run=false'])).toThrow('不带取值');
    expect(() => parseArgs(['--deployment', 'x', '--dryrun'])).toThrow('不认识');
  });
});
