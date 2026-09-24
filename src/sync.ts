/**
 * 把 Cortico 事件库里的 QQ 消息、B 站弹幕和羽书自己说的话同步进 WaveMemory。
 *
 * - 定时从事件库游标之后读新事件，按事件来源拼会话：QQ 用 WaveMemory 返回的
 *   Bot 规范会话前缀（`<前缀>:group:<群号>`），与 AstrBot 路径是同一条记忆线；
 *   弹幕用配置里的直播间会话。
 * - WaveMemory 写入的是和 AstrBot 消息钩子相同的流程（记住/忘记、黑话、纠错、好感）。
 * - 9876 不在线或返回错误时游标不前进，恢复后从断点补写；游标存在 dataDir。
 * - event_id 用 QQ 原始消息号，AstrBot 同时收到同一条消息时 WaveMemory 只入库一次。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EventEnvelope, EventStoreReader } from 'cortico/core/types.ts';
import type { ObservationEventItem, RuntimeScopePayload, WaveMemoryBridge } from './bridge.ts';

export interface SyncOptions {
  bridge: WaveMemoryBridge;
  botId: string;
  /** QQ 会话前缀（Bot Profile 的 session_prefix）；取不到时不同步 QQ 事件，避免写成另一条线 */
  sessionPrefix: () => string;
  /** 弹幕所属的直播间会话，如 bilibili:group:24292304 */
  liveSessionId: string;
  cursorFile: string;
  batchSize?: number;
  log?: { info(msg: string): void; warn(msg: string): void };
}

export interface SyncResult {
  scanned: number;
  sent: number;
  accepted: number;
  cursor: number;
  error?: string;
}

const QQ_TYPES = new Set(['qq.message', 'qq.self']);
const LIVE_TYPES = new Set(['bilibili.danmaku']);

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

function splitSession(sessionId: string): { platform: string; kind: string; conv: string } {
  const [platform = '', kind = 'group', ...rest] = sessionId.split(':');
  return { platform, kind, conv: rest.join(':') };
}

export function toObservation(env: EventEnvelope, opts: { botId: string; sessionPrefix: string; liveSessionId: string }): ObservationEventItem | null {
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
  if (LIVE_TYPES.has(env.type)) {
    const body = str(meta.body).trim();
    const uid = str(meta.uid);
    if (!body || !uid || !opts.liveSessionId) return null;
    const { platform, kind, conv } = splitSession(opts.liveSessionId);
    return {
      // 弹幕没有平台消息号：用 Cortico 事件游标，部署内唯一且重放稳定。
      event_id: `cortico:${env.cursor}`,
      kind: 'danmaku',
      content: body,
      sender_id: uid,
      sender_name: str(meta.uname),
      timestamp: tsSeconds(env.ts),
      scope: {
        bot_id: opts.botId,
        visibility: 'group',
        session: { id: opts.liveSessionId, platform_id: platform, kind, conversation_id: conv },
        subject_principal_id: `${platform}:user:${uid}`,
      },
    };
  }
  return null;
}

export class ObservationSync {
  private running = false;
  private cursor: number | null = null;

  constructor(private readonly opts: SyncOptions) {}

  loadCursor(latest: number): number {
    if (this.cursor !== null) return this.cursor;
    try {
      const saved = JSON.parse(readFileSync(this.opts.cursorFile, 'utf8')) as { cursor?: number };
      if (typeof saved.cursor === 'number' && saved.cursor >= 0) {
        this.cursor = Math.min(saved.cursor, latest);
        return this.cursor;
      }
    } catch {
      // 第一次运行：从当前位置开始，不回放历史（历史消息 AstrBot 大多已经写过）。
    }
    this.cursor = latest;
    this.saveCursor(latest);
    return latest;
  }

  private saveCursor(cursor: number): void {
    this.cursor = cursor;
    try {
      mkdirSync(dirname(this.opts.cursorFile), { recursive: true });
      writeFileSync(this.opts.cursorFile, JSON.stringify({ cursor, at: new Date().toISOString() }));
    } catch (err) {
      this.opts.log?.warn(`[wavememory] 同步游标写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
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
      const sessionPrefix = this.opts.sessionPrefix();
      const events = envs
        .map((env) => toObservation(env, { botId: this.opts.botId, sessionPrefix, liveSessionId: this.opts.liveSessionId }))
        .filter((item): item is ObservationEventItem => item !== null);
      if (!events.length) {
        this.saveCursor(to);
        return { scanned: envs.length, sent: 0, accepted: 0, cursor: to };
      }
      const res = await this.opts.bridge.submitObservations({ batch_id: `cortico-${from + 1}-${to}`, events }, 8000);
      if (!res.ok) {
        // 网络错误或 503：游标不动，下次从同一位置重试。
        return { scanned: envs.length, sent: events.length, accepted: 0, cursor: from, error: res.error?.message ?? 'submit_failed' };
      }
      this.saveCursor(to);
      return { scanned: envs.length, sent: events.length, accepted: res.accepted ?? 0, cursor: to };
    } finally {
      this.running = false;
    }
  }
}
