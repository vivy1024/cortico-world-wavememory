/**
 * 一次性补录历史游戏经历：实时同步开始之前的游戏事件（我的世界、杀戮尖塔、缺氧），按实时同步
 * 同一套翻译写进 WaveMemory 的直播间会话。
 *
 *   node --experimental-transform-types scripts/backfill-game-events.ts --deployment <部署目录> --dry-run
 *   pnpm backfill:games -- --deployment <部署目录> [--dry-run] [--since 2026-09-16] [--until-cursor N] [--batch 50]
 *
 * - 只读：部署 config.json、.env、同步游标文件，data/runs 下的 index.jsonl、events.jsonl、toolcalls.jsonl。
 *   不写部署目录里的任何文件。Cortico 的 JsonlEventStore 是写入端（构造时就给当前 run 建目录），
 *   这里不用它，按 run 顺序自己只读解析。
 * - 翻译：全新状态的 GameTracker 从事件库开头按游标顺序喂事件，经 sync.ts 的 gameObservations()
 *   转成 game_event——与实时同步同一段代码，同一段事件得到同样的条目与 event_id。目标「完成」要看她
 *   当时下没下过 mc_goal done：实时路径经输出旁路记进 CallLedger，这里从工具调用流水（toolcalls.jsonl）
 *   按时间回放进同样的 CallLedger。只收游戏经历，不补消息、弹幕、口播。
 * - 范围：从事件库开头到上限。--since 只筛出这之后的经历；跟踪器仍从头喂起，边界处的当天去重、
 *   目标基线与整段重放一致。上限缺省取同步游标文件的 gamesFrom（实时同步开始同步游戏经历的位置）；
 *   只同步对话的旧版文件取它的 cursor（新版会从那里开始）；文件不存在时取事件库最新位置。
 * - 提交：与实时同步同一个 WaveMemoryBridge.submitObservations（POST /api/runtime/v1/observations/batch）；
 *   bot、直播间会话、地址与令牌按扩展同样的规则读部署配置（令牌 .env 优先）。每批失败重试 2 次；
 *   WaveMemory 按 event_id 去重，重复跑不会重复入库。
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { WaveMemoryBridge, type FetchLike, type ObservationEventItem, type ObservationsBatchResponse } from '../src/bridge.ts';
import {
  DEFAULT_TERMINAL_SESSION_ID,
  WAVEMEMORY_DEFAULTS,
  WAVEMEMORY_TOKEN_SECRET,
  runtimeToken,
  type TokenOrigin,
  type WaveMemoryConfigSection,
} from '../src/config.ts';
import { GAME_LABELS, GOAL_OP_SLACK_MS, GameTracker, type GameEventDraft, type GameId } from '../src/games.ts';
import { liveScope } from '../src/sessions.ts';
import { CallLedger, captureOf, type CapturedCall } from '../src/speech.ts';
import { SYNC_CURSOR_FILE, gameObservations, type MapContext } from '../src/sync.ts';

/** 与 cortico/core/run.ts 相同的 run id 规则（自带时间戳，字典序即时间序）。 */
const RUN_ID = /^r-\d{8}-\d{6}-[0-9a-f]{4}$/;
const INDEX_FILE = 'index.jsonl';
const EVENTS_FILE = 'events.jsonl';
const TOOL_CALLS_FILE = 'toolcalls.jsonl';
const DEFAULT_BATCH = 50;
/** WaveMemory /observations/batch 每批上限 */
const MAX_BATCH = 500;
const RETRIES = 2;
const SUBMIT_TIMEOUT_MS = 15_000;
const SAMPLE_COUNT = 10;
const EVENT_TYPES: ReadonlyArray<GameEventDraft['event_type']> = ['death', 'goal', 'discovery', 'milestone', 'choice', 'crisis'];

export const USAGE = [
  '用法：node --experimental-transform-types scripts/backfill-game-events.ts --deployment <部署目录> [选项]',
  '      pnpm backfill:games -- --deployment <部署目录> [选项]',
  '',
  '  --deployment <目录>    Cortico 部署目录（含 config.json 与 data/runs）',
  '  --dry-run              只读统计并打印前几条样例，不发请求',
  '  --since <日期|时间>     只补这之后的经历：2026-09-16（部署当地日期）或 2026-09-16T20:00:00+08:00',
  '  --until-cursor <N>     上限游标（含）；缺省取同步游标文件的 gamesFrom / cursor，没有文件取事件库最新位置',
  `  --batch <N>            每批条数，1–${MAX_BATCH}，默认 ${DEFAULT_BATCH}`,
].join('\n');

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseJson(line: string): unknown {
  const text = line.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as unknown;
}

/** 事件时间戳自带部署时区偏移：前 19 位就是当地时间。 */
function when(ts: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(ts) ? ts.slice(0, 19).replace('T', ' ') : ts;
}

// ─── 参数 ────────────────────────────────────────────────────────────────────

export interface BackfillOptions {
  deployment: string;
  dryRun: boolean;
  /** --since 原文 */
  since: string | null;
  untilCursor: number | null;
  batch: number;
  help?: boolean;
}

export interface SinceFilter {
  raw: string;
  accepts(ts: string): boolean;
}

/** `2026-09-16` 按部署当地日期（事件时间戳前 10 位，与按日去重同一口径）；带时刻的按绝对时间比。 */
export function parseSince(raw: string): SinceFilter {
  const text = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(text))) {
    return { raw: text, accepts: (ts) => ts.slice(0, 10) >= text };
  }
  const ms = /^\d{4}-\d{2}-\d{2}T/.test(text) ? Date.parse(text) : Number.NaN;
  if (!Number.isFinite(ms)) throw new Error(`--since 看不懂：${raw}（写成 2026-09-16 或 2026-09-16T20:00:00+08:00）`);
  return {
    raw: text,
    accepts: (ts) => {
      const at = Date.parse(ts);
      return Number.isFinite(at) && at >= ms;
    },
  };
}

function intArg(flag: string, raw: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n < min || n > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `不小于 ${min}` : `${min}–${max}`;
    throw new Error(`${flag} 要一个${range}的整数：${raw}`);
  }
  return n;
}

export function parseArgs(argv: readonly string[]): BackfillOptions {
  const out: BackfillOptions = { deployment: '', dryRun: false, since: null, untilCursor: null, batch: DEFAULT_BATCH };
  const args = [...argv];
  while (args.length) {
    const arg = args.shift()!;
    if (arg === '--') continue; // pnpm / npm 透传参数时留下的分隔符
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = args.shift();
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} 缺少取值`);
      return next;
    };
    const noValue = (): void => {
      if (inline !== undefined) throw new Error(`${flag} 不带取值`);
    };
    switch (flag) {
      case '--deployment': out.deployment = value(); break;
      case '--dry-run': noValue(); out.dryRun = true; break;
      case '--since': out.since = parseSince(value()).raw; break;
      case '--until-cursor': out.untilCursor = intArg(flag, value(), 0); break;
      case '--batch': out.batch = intArg(flag, value(), 1, MAX_BATCH); break;
      case '--help':
      case '-h': noValue(); out.help = true; break;
      default: throw new Error(`不认识的参数：${arg}`);
    }
  }
  if (!out.help && !out.deployment.trim()) throw new Error('缺少 --deployment <部署目录>');
  return out;
}

// ─── 部署配置（与 Cortico 装配、world.ts 同样的规则） ─────────────────────────

export interface Deployment {
  dir: string;
  dataDir: string;
  runsDir: string;
  cursorFile: string;
  cfg: WaveMemoryConfigSection;
  botId: string;
  liveSessionId: string;
  terminalSessionId: string;
  endpoint: string;
  token: string;
  tokenOrigin: TokenOrigin;
}

/** 与 Cortico 的 secretReader 同规则：非空的进程环境变量优先，否则现读部署 .env（取到首个空白，不解析引号）。 */
export function deploymentSecret(dir: string, env: NodeJS.ProcessEnv = process.env): (name: string) => string {
  const file = join(dir, '.env');
  return (name) => {
    const fromEnv = env[name];
    if (fromEnv) return fromEnv;
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(\\S+)`, 'm').exec(text);
    return m ? m[1] : '';
  };
}

/**
 * worlds.wavememory 叠在 WAVEMEMORY_DEFAULTS 上；数据目录是 paths.data（默认 data，相对部署目录）。
 * bot 代码包的 worlds/wavememory/config.json 覆盖层不读（羽书的代码包没有这一层）。
 */
export function loadDeployment(dir: string, env: NodeJS.ProcessEnv = process.env): Deployment {
  const root = resolve(dir);
  const cfgPath = join(root, 'config.json');
  if (!existsSync(cfgPath)) throw new Error(`不是 Cortico 部署目录（没有 config.json）：${root}`);
  let raw: { paths?: { data?: unknown }; worlds?: { wavememory?: unknown } };
  try {
    raw = (readJson(cfgPath) ?? {}) as typeof raw;
  } catch (err) {
    throw new Error(`config.json 解析失败：${msg(err)}`);
  }
  const section = raw.worlds?.wavememory;
  const cfg: WaveMemoryConfigSection = {
    ...WAVEMEMORY_DEFAULTS(),
    ...(section && typeof section === 'object' ? (section as Partial<WaveMemoryConfigSection>) : {}),
  };
  const dataPath = typeof raw.paths?.data === 'string' && raw.paths.data.trim() ? raw.paths.data : 'data';
  const dataDir = isAbsolute(dataPath) ? dataPath : resolve(root, dataPath);
  const { token, origin } = runtimeToken(cfg, deploymentSecret(root, env));
  return {
    dir: root,
    dataDir,
    runsDir: join(dataDir, 'runs'),
    cursorFile: join(dataDir, SYNC_CURSOR_FILE),
    cfg,
    // 与 world.ts 的 botId() / liveSessionId() / terminalSessionId() 同样兜底
    botId: cfg.botId || 'yushu',
    liveSessionId: cfg.sessionId || '',
    terminalSessionId: cfg.terminalSessionId || DEFAULT_TERMINAL_SESSION_ID,
    endpoint: String(cfg.endpoint ?? '').trim(),
    token,
    tokenOrigin: origin,
  };
}

// ─── 事件库与工具调用流水（只读） ──────────────────────────────────────────────

export interface StoreScan {
  runs: string[];
  /** 按 cursor 升序、去重 */
  events: EventEnvelope[];
  latest: number;
  skipped: number;
  warnings: string[];
}

/**
 * 要读的 run：index.jsonl 记下的开机顺序在前，没登记的目录按 id 补在后面。
 * 只认与 Cortico listRuns 同一命名规则的目录；登记了但目录已不在的只提示。
 */
export function listRuns(runsDir: string): { runs: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const onDisk = readdirSync(runsDir).filter((name) => RUN_ID.test(name)).sort();
  const indexed: string[] = [];
  const indexFile = join(runsDir, INDEX_FILE);
  if (existsSync(indexFile)) {
    for (const line of readFileSync(indexFile, 'utf8').split('\n')) {
      const row = parseJson(line) as { run?: unknown; startedAt?: unknown } | null;
      if (row && typeof row.run === 'string' && typeof row.startedAt === 'string' && !indexed.includes(row.run)) indexed.push(row.run);
    }
  } else {
    warnings.push(`没有 ${INDEX_FILE}，按目录名的时间顺序读 run`);
  }
  const present = new Set(onDisk);
  const gone = indexed.filter((id) => !present.has(id));
  if (gone.length) warnings.push(`${INDEX_FILE} 登记的 ${gone.length} 个 run 目录已不在：${gone.slice(0, 3).join('、')}${gone.length > 3 ? ' …' : ''}`);
  const registered = new Set(indexed);
  const runs = [...indexed.filter((id) => present.has(id)), ...onDisk.filter((id) => !registered.has(id))];
  return { runs, warnings };
}

function parseEvent(line: string): EventEnvelope | null {
  const e = parseJson(line) as EventEnvelope | null;
  return e && Number.isInteger(e.cursor) && typeof e.ts === 'string' ? e : null;
}

/**
 * 只读解析整个事件库。每个分片按 JsonlEventStore 的规则跳过坏行与乱序行；
 * cursor 跨 run 全局单调，最后按 cursor 排序去重，它才是事件唯一可靠的先后。
 */
export function readEventStore(runsDir: string): StoreScan {
  if (!existsSync(runsDir)) throw new Error(`找不到事件库：${runsDir}`);
  const { runs, warnings } = listRuns(runsDir);
  let skipped = 0;
  const all: EventEnvelope[] = [];
  for (const run of runs) {
    const file = join(runsDir, run, EVENTS_FILE);
    if (!existsSync(file)) continue;
    let last = Number.NEGATIVE_INFINITY;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = parseEvent(line);
      if (!e || e.cursor <= last) {
        skipped++;
        continue;
      }
      last = e.cursor;
      all.push(e);
    }
  }
  all.sort((a, b) => a.cursor - b.cursor);
  const events: EventEnvelope[] = [];
  for (const e of all) {
    if (events.length && events[events.length - 1].cursor === e.cursor) {
      skipped++;
      continue;
    }
    events.push(e);
  }
  if (skipped) warnings.push(`事件库里跳过 ${skipped} 行坏行、乱序行或重复游标`);
  return { runs, events, latest: events.at(-1)?.cursor ?? 0, skipped, warnings };
}

export interface CallScan {
  /** 按时间先后 */
  calls: CapturedCall[];
  goalOps: number;
  scripts: number;
  skipped: number;
}

/**
 * 工具调用流水里输出旁路会记下的调用（vtuber_act 台本、mc_goal done/drop），经 speech.ts 的
 * captureOf 取出——与实时路径同一个判断。输出旁路只挂在主 session 上。时刻用流水的 ts
 * （调用执行完那一刻，比输出旁路闭合时晚几毫秒，目标判断留有 GOAL_OP_SLACK_MS 的余量）。
 */
export function readToolCalls(runsDir: string, runs: readonly string[]): CallScan {
  const calls: CapturedCall[] = [];
  let skipped = 0;
  for (const run of runs) {
    const file = join(runsDir, run, TOOL_CALLS_FILE);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = parseJson(line) as { ts?: unknown; call?: unknown; role?: unknown; tool?: unknown; args?: unknown } | null;
      if (!row || typeof row.tool !== 'string') {
        skipped++;
        continue;
      }
      if (row.role !== undefined && row.role !== 'main') continue;
      const at = typeof row.ts === 'string' ? Date.parse(row.ts) : Number.NaN;
      if (!Number.isFinite(at)) {
        skipped++;
        continue;
      }
      const call = captureOf({
        name: row.tool,
        call_id: typeof row.call === 'string' ? row.call : '',
        arguments: row.args === undefined ? undefined : JSON.stringify(row.args),
      }, at);
      if (call) calls.push(call);
    }
  }
  calls.sort((a, b) => a.at - b.at);
  return {
    calls,
    goalOps: calls.filter((c) => c.goal).length,
    scripts: calls.filter((c) => c.script !== undefined).length,
    skipped,
  };
}

// ─── 上限 ────────────────────────────────────────────────────────────────────

export interface SyncCursorInfo {
  file: string;
  exists: boolean;
  cursor: number | null;
  gamesFrom: number | null;
  /** 文件里已有游戏跟踪状态（新版实时同步已经跑过） */
  tracksGames: boolean;
  problem?: string;
}

/** 同步游标文件；有效性判断与 ObservationSync.loadCursor 一致。 */
export function readSyncCursor(file: string): SyncCursorInfo {
  if (!existsSync(file)) return { file, exists: false, cursor: null, gamesFrom: null, tracksGames: false };
  try {
    const saved = (readJson(file) ?? {}) as { cursor?: unknown; games?: unknown; gamesFrom?: unknown };
    const cursor = typeof saved.cursor === 'number' && saved.cursor >= 0 ? saved.cursor : null;
    const gamesFrom = typeof saved.gamesFrom === 'number' && saved.gamesFrom >= 0 ? saved.gamesFrom : null;
    return {
      file,
      exists: true,
      cursor,
      gamesFrom,
      tracksGames: saved.games !== undefined,
      ...(cursor === null ? { problem: '没有有效的 cursor' } : {}),
    };
  } catch (err) {
    return { file, exists: true, cursor: null, gamesFrom: null, tracksGames: false, problem: `解析失败（${msg(err)}）` };
  }
}

export interface UpperBound {
  upper: number;
  /** 实时同步（将要）开始同步游戏经历的位置：它之后的事件归实时同步 */
  liveStart: number;
  source: string;
  warnings: string[];
}

export function resolveUpperBound(latest: number, sync: SyncCursorInfo, untilCursor: number | null): UpperBound {
  const warnings: string[] = [];
  let liveStart: number;
  let source: string;
  if (sync.gamesFrom !== null) {
    liveStart = Math.min(sync.gamesFrom, latest);
    source = '同步游标文件的 gamesFrom（实时同步从这里之后开始同步游戏经历）';
  } else if (sync.cursor !== null) {
    liveStart = Math.min(sync.cursor, latest);
    if (sync.tracksGames) {
      source = '同步游标文件的 cursor';
      warnings.push(
        '同步游标文件已有游戏跟踪状态却没有 gamesFrom：cursor 是实时同步眼下的进度，不一定是它开始同步游戏经历的位置。'
        + '两边重叠的部分按 event_id 去重，个别依赖跟踪状态的条目（当天去重、目标基线）可能多出；知道起点就用 --until-cursor 指定',
      );
    } else {
      source = '同步游标文件的 cursor（只同步对话的旧版文件，新版扩展会从这里之后开始同步游戏经历）';
    }
  } else {
    liveStart = latest;
    if (sync.exists) {
      source = '事件库最新位置（同步游标文件无效）';
      warnings.push(`同步游标文件${sync.problem ?? '无效'}，实时同步会当作第一次运行、从事件库最新位置开始`);
    } else {
      source = '事件库最新位置（还没有同步游标文件）';
    }
  }
  if (untilCursor === null) return { upper: liveStart, liveStart, source, warnings };
  const upper = Math.min(untilCursor, latest);
  if (upper > liveStart) {
    warnings.push(
      `--until-cursor 超过了实时同步的起点 #${liveStart}：#${liveStart + 1}–#${upper} 两边都会处理，`
      + '按 event_id 去重，个别依赖跟踪状态的条目可能多出',
    );
  }
  return {
    upper,
    liveStart,
    source: untilCursor > latest ? `--until-cursor（超过事件库最新位置，按 #${latest}）` : '--until-cursor',
    warnings,
  };
}

// ─── 翻译 ────────────────────────────────────────────────────────────────────

export interface GameRecord {
  item: ObservationEventItem;
  cursor: number;
  ts: string;
}

export interface CollectOptions {
  ctx: MapContext;
  calls: readonly CapturedCall[];
  upper: number;
  since?: SinceFilter | null;
}

/**
 * 全新状态的跟踪器按游标顺序喂 [1, upper] 的事件。实时路径里，调用在她下指令那一刻就记进了
 * CallLedger，同步处理这条事件时已经在账上；这里在喂每条事件之前，先把这一刻（加目标判断的时钟
 * 余量）之前的调用按时间记进同样的 CallLedger（时钟跟着调用走，保质期与上限的淘汰也和实时一样）。
 */
export function collectGameEvents(events: readonly EventEnvelope[], opts: CollectOptions): { records: GameRecord[]; scanned: number } {
  let clock = 0;
  const ledger = new CallLedger({ now: () => clock });
  const tracker = new GameTracker(undefined, { calls: ledger });
  const ctx: MapContext = { ...opts.ctx, calls: ledger };
  const records: GameRecord[] = [];
  let next = 0;
  let scanned = 0;
  for (const env of events) {
    if (env.cursor > opts.upper) break;
    scanned++;
    const at = Date.parse(env.ts);
    const horizon = Number.isFinite(at) ? at + GOAL_OP_SLACK_MS : Number.POSITIVE_INFINITY;
    while (next < opts.calls.length && opts.calls[next].at <= horizon) {
      clock = Math.max(clock, opts.calls[next].at);
      ledger.record(opts.calls[next]);
      next++;
    }
    const items = gameObservations(tracker, env, ctx);
    if (!items.length || (opts.since && !opts.since.accepts(env.ts))) continue;
    for (const item of items) records.push({ item, cursor: env.cursor, ts: env.ts });
  }
  return { records, scanned };
}

// ─── 统计与提交 ──────────────────────────────────────────────────────────────

export interface GameSummary {
  game: string;
  label: string;
  count: number;
  types: Array<[string, number]>;
  first: string | null;
  last: string | null;
}

/** 按 游戏 × event_type 计数；三款游戏都列出（没有的记 0）。 */
export function summarize(records: readonly GameRecord[]): GameSummary[] {
  const games = Object.keys(GAME_LABELS) as GameId[];
  for (const r of records) if (r.item.game && !games.includes(r.item.game as GameId)) games.push(r.item.game as GameId);
  return games.map((game) => {
    const mine = records.filter((r) => r.item.game === game);
    const counts = new Map<string, number>();
    for (const r of mine) counts.set(r.item.event_type ?? '?', (counts.get(r.item.event_type ?? '?') ?? 0) + 1);
    const order = (t: string): number => {
      const i = EVENT_TYPES.indexOf(t as GameEventDraft['event_type']);
      return i < 0 ? EVENT_TYPES.length : i;
    };
    return {
      game,
      label: GAME_LABELS[game] ?? game,
      count: mine.length,
      types: [...counts.entries()].sort((a, b) => order(a[0]) - order(b[0])),
      first: mine[0]?.ts ?? null,
      last: mine.at(-1)?.ts ?? null,
    };
  });
}

function printSummary(records: readonly GameRecord[], log: (line: string) => void): void {
  log(`游戏经历 ${records.length} 条（按 游戏 × event_type）：`);
  for (const s of summarize(records)) {
    const span = s.first && s.last ? `  ${when(s.first)} → ${when(s.last)}` : '';
    log(`  ${s.label}（${s.game}）${s.count} 条${span}`);
    if (s.types.length) log(`      ${s.types.map(([t, n]) => `${t} ${n}`).join(' · ')}`);
  }
  if (records.length) log(`  时间范围 ${when(records[0].ts)} → ${when(records[records.length - 1].ts)}`);
}

export interface SubmitResult {
  batches: number;
  sent: number;
  accepted: number;
  rejected: number;
  /** 被拒原因 → 条数 */
  rejections: Record<string, number>;
  /** 中途停下的原因；全部发完为 null */
  failed: string | null;
}

export interface SubmitOptions {
  batch: number;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
  timeoutMs?: number;
}

/** 分批提交；每批失败重试 2 次（间隔 1 秒、2 秒），仍失败或整批被拒就停下，已发的不受影响。 */
export async function submitRecords(bridge: WaveMemoryBridge, records: readonly GameRecord[], opts: SubmitOptions): Promise<SubmitResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const retries = opts.retries ?? RETRIES;
  const total = Math.ceil(records.length / opts.batch);
  const result: SubmitResult = { batches: 0, sent: 0, accepted: 0, rejected: 0, rejections: {}, failed: null };
  for (let i = 0; i < total; i++) {
    const chunk = records.slice(i * opts.batch, (i + 1) * opts.batch);
    const first = chunk[0].cursor;
    const last = chunk[chunk.length - 1].cursor;
    const label = `批次 ${i + 1}/${total}  #${first}–#${last}  ${chunk.length} 条`;
    let res: ObservationsBatchResponse | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      res = await bridge.submitObservations(
        { batch_id: `cortico-backfill-${first}-${last}`, events: chunk.map((r) => r.item) },
        opts.timeoutMs ?? SUBMIT_TIMEOUT_MS,
      );
      if (res.ok) break;
      const reason = res.error?.message || res.error?.code || 'submit_failed';
      if (attempt < retries) {
        opts.log(`${label}  第 ${attempt + 1} 次失败：${reason}；${attempt + 1} 秒后重试`);
        await sleep((attempt + 1) * 1000);
      } else {
        opts.log(`${label}  第 ${attempt + 1} 次失败：${reason}；不再重试`);
        result.failed = `批次 ${i + 1}/${total}（#${first}–#${last}）重试 ${retries} 次仍失败：${reason}`;
      }
    }
    if (!res?.ok) break;
    const receipts = res.receipts ?? [];
    const accepted = typeof res.accepted === 'number' ? res.accepted : receipts.filter((r) => r.status === 'accepted').length;
    const rejected = typeof res.rejected === 'number' ? res.rejected : receipts.filter((r) => r.status === 'rejected').length;
    result.batches++;
    result.sent += chunk.length;
    result.accepted += accepted;
    result.rejected += rejected;
    const reasons: Record<string, number> = {};
    for (const r of receipts) {
      if (r.status !== 'rejected') continue;
      const key = r.error || 'unknown';
      reasons[key] = (reasons[key] ?? 0) + 1;
      result.rejections[key] = (result.rejections[key] ?? 0) + 1;
    }
    const why = Object.entries(reasons).map(([k, n]) => `${k}×${n}`).join('、');
    opts.log(`${label}  accepted ${accepted} · rejected ${rejected}${why ? `（${why}）` : ''}`);
    if (accepted === 0 && rejected >= chunk.length) {
      result.failed = `批次 ${i + 1}/${total} 整批被拒${why ? `（${why}）` : ''}，后面的不再发送`;
      break;
    }
  }
  return result;
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

export interface BackfillDeps {
  fetch?: FetchLike;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
}

export interface BackfillReport {
  dryRun: boolean;
  latest: number;
  upper: number;
  upperSource: string;
  since: string | null;
  scanned: number;
  goalOps: number;
  records: GameRecord[];
  warnings: string[];
  submit: SubmitResult | null;
}

function tokenNote(origin: TokenOrigin): string {
  if (origin === 'secret') return `令牌取自 ${WAVEMEMORY_TOKEN_SECRET}（进程环境或部署 .env）`;
  if (origin === 'config') return '令牌取自 config.json 的 authToken（旧写法）';
  return '没有令牌';
}

export async function runBackfill(options: BackfillOptions, deps: BackfillDeps = {}): Promise<BackfillReport> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const since = options.since ? parseSince(options.since) : null;
  const dep = loadDeployment(options.deployment, deps.env ?? process.env);
  if (!liveScope(dep.botId, dep.liveSessionId)) {
    throw new Error(`worlds.wavememory.sessionId 不是有效的直播间会话（平台:group:房间号）：${dep.liveSessionId || '(空)'}`);
  }
  const store = readEventStore(dep.runsDir);
  const sync = readSyncCursor(dep.cursorFile);
  const bound = resolveUpperBound(store.latest, sync, options.untilCursor);
  const calls = readToolCalls(dep.runsDir, store.runs);
  const ctx: MapContext = {
    botId: dep.botId,
    sessionPrefix: '',
    liveSessionId: dep.liveSessionId,
    terminalSessionId: dep.terminalSessionId,
  };
  const { records, scanned } = collectGameEvents(store.events, { ctx, calls: calls.calls, upper: bound.upper, since });

  const warnings = [...store.warnings, ...bound.warnings];
  if (calls.skipped) warnings.push(`工具调用流水里跳过 ${calls.skipped} 行坏行`);
  if (dep.cfg.enabled === false) warnings.push('worlds.wavememory.enabled 是 false：WaveMemory World 没开，实时同步不会接着写');
  else if (dep.cfg.sync === false) warnings.push('worlds.wavememory.sync 是 false：实时同步没开，上限之后的游戏经历不会有人写');
  if (dep.tokenOrigin === 'none') warnings.push(`没有 Runtime 令牌（部署 .env 的 ${WAVEMEMORY_TOKEN_SECRET} 或 config.json 的 authToken），WaveMemory 会拒绝请求`);

  const rel = (file: string): string => relative(dep.dir, file) || file;
  const first = store.events[0];
  const lastEvent = store.events.at(-1);
  const syncNote = !sync.exists
    ? '不存在'
    : sync.cursor === null
      ? sync.problem ?? '无效'
      : `cursor #${sync.cursor}${sync.gamesFrom !== null ? ` · gamesFrom #${sync.gamesFrom}` : ''}${sync.tracksGames ? '' : '（还没有游戏跟踪状态）'}`;
  log(`补录历史游戏经历${options.dryRun ? '【演练：只读统计，不发请求】' : ''}`);
  log(`部署目录  ${dep.dir}`);
  log(`事件库    ${rel(dep.runsDir)}：${store.runs.length} 个 run，${store.events.length} 条，#${first?.cursor ?? 0}–#${store.latest}${first && lastEvent ? `（${when(first.ts)} → ${when(lastEvent.ts)}）` : ''}`);
  log(`同步游标  ${rel(dep.cursorFile)}：${syncNote}`);
  log(`补录范围  #${first?.cursor ?? 0}–#${bound.upper}，上限取自${bound.source}${since ? `；只收 ${since.raw} 之后的经历（之前的事件只用来推进跟踪状态）` : ''}`);
  log(`目标指令  工具调用流水里 mc_goal done/drop ${calls.goalOps} 条（另有 vtuber_act ${calls.scripts} 条，按实时路径一样记进 CallLedger）`);
  log(`写入目标  ${dep.endpoint}/api/runtime/v1/observations/batch · bot ${dep.botId} · 会话 ${dep.liveSessionId} · ${tokenNote(dep.tokenOrigin)}`);
  for (const w of warnings) log(`注意：${w}`);
  log(`扫描 ${scanned} 条事件。`);

  const report: BackfillReport = {
    dryRun: options.dryRun,
    latest: store.latest,
    upper: bound.upper,
    upperSource: bound.source,
    since: since?.raw ?? null,
    scanned,
    goalOps: calls.goalOps,
    records,
    warnings,
    submit: null,
  };

  if (options.dryRun) {
    printSummary(records, log);
    if (records.length) {
      log(`样例（前 ${Math.min(SAMPLE_COUNT, records.length)} 条）：`);
      for (const r of records.slice(0, SAMPLE_COUNT)) {
        log(`  #${r.cursor}  ${when(r.ts)}  ${r.item.game}/${r.item.event_type}  ${r.item.content}`);
      }
      log('第一条的请求体（events[] 的一项）：');
      for (const line of JSON.stringify(records[0].item, null, 2).split('\n')) log(`  ${line}`);
      log(`正式运行会分 ${Math.ceil(records.length / options.batch)} 批（每批最多 ${options.batch} 条）提交。`);
    }
    log('演练结束，没有发送任何请求。');
    return report;
  }

  if (!records.length) {
    printSummary(records, log);
    log('没有要补录的游戏经历，没有发送请求。');
    return report;
  }
  if (!dep.endpoint) throw new Error('worlds.wavememory.endpoint 为空');
  const bridge = new WaveMemoryBridge(dep.endpoint, deps.fetch ?? (fetch as FetchLike), dep.token);
  const submit = await submitRecords(bridge, records, { batch: options.batch, log, sleep: deps.sleep });
  report.submit = submit;
  printSummary(records, log);
  const reasons = Object.entries(submit.rejections).map(([k, n]) => `${k}×${n}`).join('、');
  log(`提交 ${submit.batches} 批 ${submit.sent}/${records.length} 条：accepted ${submit.accepted} · rejected ${submit.rejected}${reasons ? `（${reasons}）` : ''}`);
  if (submit.failed) {
    log(`没有全部发完：${submit.failed}。已发的不受影响，修好后原样重跑即可（WaveMemory 按 event_id 去重）。`);
  } else {
    log('全部发完。WaveMemory 按 event_id 去重，重复跑不会重复入库（重复的也记 accepted）。');
  }
  return report;
}

async function main(argv: readonly string[]): Promise<number> {
  let options: BackfillOptions;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(msg(err));
    console.error(USAGE);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const report = await runBackfill(options);
    return report.submit?.failed ? 1 : 0;
  } catch (err) {
    console.error(`补录失败：${msg(err)}`);
    return 1;
  }
}

/** 直接运行（node / tsx）时才执行；测试里 import 不触发。 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const invoked = realpathSync(resolve(entry));
    return process.platform === 'win32' ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
