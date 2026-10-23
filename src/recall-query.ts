import { createHash } from 'node:crypto';
import type { EventEnvelope, EventStoreReader } from 'cortico/core/types.ts';
import { qqBody } from './sync.ts';

export function hashQuery(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** 只在最近这么多条事件里找对话（按游标，不扫历史分片）。 */
export const RECENT_WINDOW = 500;

/**
 * 一句对话来自哪里：直播间弹幕、控制台（World `console`）、QQ 群/私聊。
 * 读取（注入、工具默认会话）与写入（sync.ts）用同一套划分。
 */
export type DialogueChannel =
  | { kind: 'live' }
  | { kind: 'console' }
  | { kind: 'qq'; conv: 'group' | 'private'; id: string };

export interface DialogueSpeaker {
  /** 平台内的用户号：B 站 uid、QQ 号；控制台操作员没有 */
  id?: string;
  name?: string;
}

export interface DialogueLine {
  cursor: number;
  ts: string;
  channel: DialogueChannel;
  body: string;
  speaker: DialogueSpeaker;
}

function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

/** 人说的话才算对话；游戏事件、快照、礼物、自己说的话都不算。 */
export function dialogueLine(e: EventEnvelope): DialogueLine | null {
  const meta = (e.meta ?? {}) as Record<string, unknown>;
  if (e.type === 'bilibili.danmaku' && e.source === 'bilibili') {
    // 原始弹幕归档一份、投递一份（meta.sourceCursors 指回归档）；只认投递给模型的那份。
    if (e.contextDelivery === 'archive-only') return null;
    const body = str(meta.body) || str(e.text).replace(/^\[弹幕\|[^\]]*\]\s*/, '');
    if (!body) return null;
    const uid = str(meta.uid);
    const name = str(meta.uname);
    return {
      cursor: e.cursor,
      ts: e.ts,
      channel: { kind: 'live' },
      body,
      speaker: { ...(uid && uid !== '0' ? { id: uid } : {}), ...(name ? { name } : {}) },
    };
  }
  if (e.type === 'console.message' && e.source === 'console') {
    const body = str(meta.body) || str(e.text).replace(/^\[[^\]]*\]\s*[^:：]{1,40}[:：]\s*/, '');
    if (!body) return null;
    const name = str(meta.from) || str(e.senderKey);
    return { cursor: e.cursor, ts: e.ts, channel: { kind: 'console' }, body, speaker: name ? { name } : {} };
  }
  if (e.type === 'qq.message' && e.source === 'qq') {
    const conv = meta.conv as { kind?: string; id?: unknown } | undefined;
    const kind = conv?.kind === 'private' ? 'private' : conv?.kind === 'group' ? 'group' : null;
    const id = str(conv?.id);
    if (!kind || !id) return null;
    const name = str(meta.sender_name);
    const body = qqBody(String(e.text ?? ''), name);
    if (!body) return null;
    const uid = str(meta.user_id);
    return {
      cursor: e.cursor,
      ts: e.ts,
      channel: { kind: 'qq', conv: kind, id },
      body,
      speaker: { ...(uid ? { id: uid } : {}), ...(name ? { name } : {}) },
    };
  }
  return null;
}

export function channelKey(channel: DialogueChannel): string {
  return channel.kind === 'qq' ? `qq:${channel.conv}:${channel.id}` : channel.kind;
}

/** 最近 RECENT_WINDOW 条事件（按游标升序）。 */
export function recentEvents(store: EventStoreReader, window = RECENT_WINDOW): EventEnvelope[] {
  const latest = store.latestCursor();
  if (latest <= 0) return [];
  return store.range({ fromCursor: Math.max(1, latest - window + 1), toCursor: latest });
}

/** 最近的一句对话；maxAgeMs 给了就只认这么近的。 */
export function latestDialogue(events: readonly EventEnvelope[], opts: { now?: number; maxAgeMs?: number } = {}): DialogueLine | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const line = dialogueLine(events[i]);
    if (!line) continue;
    if (opts.maxAgeMs !== undefined) {
      const ms = Date.parse(line.ts);
      if (Number.isFinite(ms) && (opts.now ?? Date.now()) - ms > opts.maxAgeMs) return null;
    }
    return line;
  }
  return null;
}

export interface RecallQuery {
  text: string;
  speaker: DialogueSpeaker;
  /** 触发这一轮的那句对话来自哪里；没有对话时为 null */
  channel: DialogueChannel | null;
}

/**
 * 投递时刻读取「本轮该围绕什么检索」：最近一句对话所在的那条会话里，最后几句拼起来。
 * 只看人说的话（弹幕、控制台输入、QQ 消息），游戏机器事件不参与检索，
 * 防止游戏状态误召回无关历史闲聊。
 */
export function recallQueryText(store: EventStoreReader, limit = 3): RecallQuery {
  return recallQueryFromEvents(recentEvents(store), limit);
}

/** 同 recallQueryText，事件已经读出来时直接用（events 按游标升序）。 */
export function recallQueryFromEvents(events: readonly EventEnvelope[], limit = 3): RecallQuery {
  const lines = events.map(dialogueLine).filter((line): line is DialogueLine => line !== null);
  const last = lines.at(-1);
  if (!last) return { text: '', speaker: {}, channel: null };
  const key = channelKey(last.channel);
  const recent = lines.filter((line) => channelKey(line.channel) === key).slice(-Math.max(1, limit));
  return {
    text: recent.map((line) => line.body).join('\n').slice(0, 500),
    speaker: last.speaker,
    channel: last.channel,
  };
}
