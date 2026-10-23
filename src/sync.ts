/**
 * 把 Cortico 事件库里的对话、羽书自己说出口的话和游戏经历同步进 WaveMemory。
 *
 * - 定时从事件库游标之后读新事件，按来源拼会话（见 sessions.ts）：QQ 用 WaveMemory 返回的
 *   Bot 规范会话前缀，与 AstrBot 路径是同一条记忆线；弹幕、口播、游戏经历用直播间会话；
 *   控制台对话（World `console`）用控制台会话。
 * - 别人说的话走和 AstrBot 消息钩子相同的流程（记住/忘记、黑话、纠错、好感）；羽书说的话走
 *   Bot 回复流程（事后记账、日记、自省）；游戏经历按她自己的经历入库，不走群友处理。
 * - 9876 不在线或返回错误时游标不前进，恢复后从断点补写；游标与游戏跟踪状态一起存在 dataDir。
 * - event_id：QQ 用原始消息号（与 AstrBot 同时收到时只入库一次），其余用 Cortico 事件游标，
 *   部署内唯一且重放稳定。
 * - 游标文件另记 gamesFrom：游戏经历从这个游标之后开始实时同步（第一次运行、或从只同步对话的
 *   旧版游标文件升级时定下）。更早的游戏经历由 scripts/backfill-game-events.ts 补录，以它为上限。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EventEnvelope, EventStoreReader } from 'cortico/core/types.ts';
import type { ObservationEventItem, RuntimeScopePayload, WaveMemoryBridge } from './bridge.ts';
import { DEFAULT_TERMINAL_SESSION_ID } from './config.ts';
import { GameTracker, restoreGameState, type GameEventDraft, type GameTrackerState } from './games.ts';
import { liveScope, consoleScope, consoleSenderId } from './sessions.ts';
import { spokenText, type CallLedger } from './speech.ts';

export interface SyncOptions {
  bridge: WaveMemoryBridge;
  botId: string;
  /** QQ 会话前缀（Bot Profile 的 session_prefix）；取不到时不同步 QQ 事件，避免写成另一条线 */
  sessionPrefix: () => string;
  /** 直播间会话，如 bilibili:group:24292304：弹幕、口播与游戏经历 */
  liveSessionId: string;
  /** 控制台对话的会话，默认 terminal:private:operator（历史会话 id，不要迁移） */
  terminalSessionId?: string;
  /** 输出旁路记下的工具调用（vtuber_act 台本、mc_goal 指令） */
  calls?: CallLedger | null;
  cursorFile: string;
  batchSize?: number;
  /** 同步时见到 vtuber World 的事件（用来决定要不要挂输出旁路） */
  onSource?: (source: string) => void;
  log?: { info(msg: string): void; warn(msg: string): void };
}

export interface SyncResult {
  scanned: number;
  sent: number;
  accepted: number;
  cursor: number;
  error?: string;
}

export interface MapContext {
  botId: string;
  sessionPrefix: string;
  liveSessionId: string;
  terminalSessionId?: string;
  calls?: CallLedger | null;
}

/** 同步游标文件名（在 World 的 dataDir 下）。 */
export const SYNC_CURSOR_FILE = 'wavememory-sync.json';

const QQ_TYPES = new Set(['qq.message', 'qq.self']);

interface QqConv { kind: 'group' | 'private'; id: number }

function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function tsSeconds(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : Date.now() / 1000;
}

/** qq World 的正文是 `#消息号 [会话 时间] 名字: 内容`，取出内容部分。 */
export function qqBody(text: string, speaker: string): string {
  const marker = `] ${speaker}: `;
  const at = speaker ? text.indexOf(marker) : -1;
  if (at >= 0) return text.slice(at + marker.length).trim();
  const generic = /^(?:#\S+ )?\[[^\]]*\] [^:：]{1,40}[:：] ?/.exec(text);
  return (generic ? text.slice(generic[0].length) : text).trim();
}

function selfItem(eventId: string, content: string, timestamp: number, scope: RuntimeScopePayload | null): ObservationEventItem | null {
  const text = content.trim();
  if (!text || !scope) return null;
  // 自己说的话不带发言人（私聊作用域的主体仍是对方）。
  return { event_id: eventId, kind: 'self', content: text, timestamp, scope };
}

/** 事件 → 一条对话/自己说的话（QQ、弹幕、控制台、我的世界聊天）；不是这几类返回 null。 */
export function toObservation(env: EventEnvelope, opts: MapContext): ObservationEventItem | null {
  const meta = (env.meta ?? {}) as Record<string, unknown>;
  if (QQ_TYPES.has(env.type)) {
    const conv = meta.conv as QqConv | undefined;
    const messageId = str(meta.message_id);
    if (!opts.sessionPrefix || !conv || !conv.kind || conv.id === undefined || !messageId) return null;
    const self = env.type === 'qq.self';
    const senderName = self ? '你' : str(meta.sender_name);
    const content = qqBody(env.text, senderName);
    if (!content) return null;
    const scope: RuntimeScopePayload = {
      bot_id: opts.botId,
      visibility: conv.kind,
      session: {
        id: `${opts.sessionPrefix}:${conv.kind}:${conv.id}`,
        platform_id: opts.sessionPrefix,
        kind: conv.kind,
        conversation_id: String(conv.id),
      },
    };
    const senderId = str(meta.user_id);
    if (conv.kind === 'private') {
      // 私聊作用域的主体始终是对方（自己发出的也是对这个人说的）。
      scope.subject_principal_id = `${opts.sessionPrefix}:user:${conv.id}`;
    } else if (!self && senderId) {
      scope.subject_principal_id = `${opts.sessionPrefix}:user:${senderId}`;
    }
    return {
      event_id: messageId,
      kind: self ? 'self' : 'message',
      content,
      sender_id: self ? undefined : senderId,
      sender_name: self ? undefined : str(meta.sender_name),
      timestamp: tsSeconds(env.ts),
      scope,
    };
  }
  if (env.type === 'bilibili.danmaku') {
    // 原始弹幕先以 archive-only 归档，再由候选处理投递一份（meta.sourceCursors 指回归档）；
    // 只写原始那份，否则同一条弹幕会被记住、计好感两次。
    if (Array.isArray(meta.sourceCursors)) return null;
    const body = str(meta.body).trim();
    const uid = str(meta.uid);
    if (!body || !uid || !opts.liveSessionId) return null;
    const scope = liveScope(opts.botId, opts.liveSessionId, uid);
    if (!scope) return null;
    return {
      // 弹幕没有平台消息号：用 Cortico 事件游标，部署内唯一且重放稳定。
      event_id: `cortico:${env.cursor}`,
      kind: 'danmaku',
      content: body,
      sender_id: uid,
      sender_name: str(meta.uname),
      timestamp: tsSeconds(env.ts),
      scope: { ...scope, subject_principal_id: `${scope.session!.platform_id}:user:${uid}` },
    };
  }
  if (env.type === 'console.message' || env.type === 'console.self') {
    const session = opts.terminalSessionId || DEFAULT_TERMINAL_SESSION_ID;
    const scope = consoleScope(opts.botId, session);
    const body = str(meta.body).trim();
    if (!scope || !body) return null;
    if (env.type === 'console.self') return selfItem(`cortico:${env.cursor}`, body, tsSeconds(env.ts), scope);
    return {
      event_id: `cortico:${env.cursor}`,
      kind: 'message',
      content: body,
      sender_id: consoleSenderId(session),
      sender_name: str(meta.from) || str(env.senderKey) || '操作员',
      timestamp: tsSeconds(env.ts),
      // 控制台里的话都是对她说的。
      is_at_bot: true,
      scope,
    };
  }
  if (env.type === 'minecraft.chat' && env.senderKey === 'minecraft') {
    // 我的世界 World 只给自己发的聊天不带发言人键（别人的是玩家名，服务器消息是 Server）。
    const m = /^\[MC\] [^:]{1,32}: ([\s\S]+)$/.exec(str(env.text));
    if (!m) return null;
    return selfItem(`cortico:${env.cursor}`, `[我的世界聊天] ${m[1].trim()}`, tsSeconds(env.ts), liveScope(opts.botId, opts.liveSessionId));
  }
  return null;
}

/**
 * 口播：vtuber_act 播完（completed）写整段台本，被打断（vtuber.act.outcome）写已播出的部分，
 * 播放失败或还没开口的不写。台本来自输出旁路按 call_id 记下的工具参数，去掉演出标签。
 * 时间用她开口（调用闭合）的时刻，和弹幕按先后交错。
 */
export function speechObservations(env: EventEnvelope, opts: MapContext): ObservationEventItem[] {
  if (env.source !== 'vtuber') return [];
  const meta = (env.meta ?? {}) as Record<string, unknown>;
  const scope = liveScope(opts.botId, opts.liveSessionId);
  if (!scope) return [];
  if (env.type === 'vtuber.playback.finished') {
    const playback = (meta.playback ?? {}) as { callId?: unknown; state?: unknown };
    if (playback.state !== 'completed') return [];
    const call = opts.calls?.get(str(playback.callId));
    if (!call?.script) return [];
    const item = selfItem(`cortico:${env.cursor}`, spokenText(call.script), call.at / 1000, scope);
    return item ? [item] : [];
  }
  if (env.type === 'vtuber.act.outcome') {
    const outcomes = Array.isArray(meta.outcomes) ? meta.outcomes as Array<Record<string, unknown>> : [];
    const out: ObservationEventItem[] = [];
    outcomes.forEach((row, index) => {
      const callId = str(row.callId);
      const at = opts.calls?.get(callId)?.at;
      const item = selfItem(
        `cortico:${env.cursor}:${callId || index}`,
        spokenText(str(row.script)),
        at !== undefined ? at / 1000 : tsSeconds(env.ts),
        scope,
      );
      if (item) out.push(item);
    });
    return out;
  }
  return [];
}

/** 游戏经历 → game_event（直播间会话，不带发言人）。 */
export function gameObservation(draft: GameEventDraft, opts: MapContext): ObservationEventItem | null {
  const scope = liveScope(opts.botId, opts.liveSessionId);
  if (!scope) return null;
  return {
    event_id: draft.event_id,
    kind: 'game_event',
    content: draft.content,
    game: draft.game,
    event_type: draft.event_type,
    timestamp: draft.timestamp,
    scope,
  };
}

/**
 * 一条事件经游戏跟踪器翻出的 game_event（跟踪状态随之推进）。实时同步与补录脚本共用：
 * 同一个跟踪器按游标顺序喂同一段事件，得到同样的条目与 event_id。
 */
export function gameObservations(tracker: GameTracker, env: EventEnvelope, opts: MapContext): ObservationEventItem[] {
  const out: ObservationEventItem[] = [];
  for (const draft of tracker.map(env)) {
    const item = gameObservation(draft, opts);
    if (item) out.push(item);
  }
  return out;
}

interface CursorFile {
  cursor?: number;
  games?: unknown;
  /** 游戏经历从这个游标之后开始实时同步 */
  gamesFrom?: number;
}

export class ObservationSync {
  private running = false;
  private cursor: number | null = null;
  /** 游戏经历从这个游标之后开始实时同步；null = 不知道（文件由不记这一项的版本写过游戏状态） */
  private gamesFrom: number | null = null;
  private readonly games: GameTracker;

  constructor(private readonly opts: SyncOptions) {
    this.games = new GameTracker(undefined, { calls: opts.calls ?? null });
  }

  /** 同步跟踪到的游戏状态（给 game 字段补目标、角色）。 */
  gameState(): GameTrackerState {
    return this.games.snapshot();
  }

  loadCursor(latest: number): number {
    if (this.cursor !== null) return this.cursor;
    try {
      const saved = JSON.parse(readFileSync(this.opts.cursorFile, 'utf8')) as CursorFile;
      if (typeof saved.cursor === 'number' && saved.cursor >= 0) {
        this.cursor = Math.min(saved.cursor, latest);
        this.games.restore(restoreGameState(saved.games));
        if (typeof saved.gamesFrom === 'number' && saved.gamesFrom >= 0) {
          this.gamesFrom = saved.gamesFrom;
        } else if (saved.games === undefined) {
          // 只同步对话的旧版游标文件：游戏经历从这里开始同步，马上记下来（补录脚本以它为上限）。
          this.gamesFrom = this.cursor;
          this.saveCursor(this.cursor);
        }
        return this.cursor;
      }
    } catch {
      // 第一次运行：从当前位置开始，不回放历史（历史消息 AstrBot 大多已经写过）。
    }
    this.cursor = latest;
    this.gamesFrom = latest;
    this.saveCursor(latest);
    return latest;
  }

  private saveCursor(cursor: number): void {
    this.cursor = cursor;
    try {
      mkdirSync(dirname(this.opts.cursorFile), { recursive: true });
      const tmp = `${this.opts.cursorFile}.tmp`;
      const gamesFrom = this.gamesFrom !== null ? { gamesFrom: this.gamesFrom } : {};
      writeFileSync(tmp, JSON.stringify({ cursor, at: new Date().toISOString(), games: this.games.snapshot(), ...gamesFrom }));
      renameSync(tmp, this.opts.cursorFile);
    } catch (err) {
      this.opts.log?.warn(`[wavememory] 同步游标写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 一批事件翻成观察；游戏跟踪状态随之推进（调用方失败时负责回滚）。 */
  private mapBatch(envs: EventEnvelope[]): ObservationEventItem[] {
    const ctx: MapContext = {
      botId: this.opts.botId,
      sessionPrefix: this.opts.sessionPrefix(),
      liveSessionId: this.opts.liveSessionId,
      terminalSessionId: this.opts.terminalSessionId,
      calls: this.opts.calls ?? null,
    };
    const items: ObservationEventItem[] = [];
    const sources = new Set<string>();
    for (const env of envs) {
      sources.add(env.source);
      const single = toObservation(env, ctx);
      if (single) items.push(single);
      items.push(...speechObservations(env, ctx));
      items.push(...gameObservations(this.games, env, ctx));
    }
    for (const source of sources) this.opts.onSource?.(source);
    return items;
  }

  /** 同步一批；返回本次扫描/发送/接受条数。进行中时直接跳过，不并发。 */
  async tick(store: EventStoreReader): Promise<SyncResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const latest = store.latestCursor();
      const from = this.loadCursor(latest);
      if (latest <= from) return { scanned: 0, sent: 0, accepted: 0, cursor: from };
      const to = Math.min(latest, from + (this.opts.batchSize ?? 200));
      const envs = store.range({ fromCursor: from + 1, toCursor: to });
      const before = this.games.snapshot();
      const events = this.mapBatch(envs);
      if (!events.length) {
        this.saveCursor(to);
        return { scanned: envs.length, sent: 0, accepted: 0, cursor: to };
      }
      const res = await this.opts.bridge.submitObservations({ batch_id: `cortico-${from + 1}-${to}`, events }, 8000);
      if (!res.ok) {
        // 网络错误或 503：游标与游戏跟踪状态都不动，下次从同一位置重放出同样的条目。
        this.games.restore(before);
        return { scanned: envs.length, sent: events.length, accepted: 0, cursor: from, error: res.error?.message ?? 'submit_failed' };
      }
      this.saveCursor(to);
      return { scanned: envs.length, sent: events.length, accepted: res.accepted ?? 0, cursor: to };
    } finally {
      this.running = false;
    }
  }
}
