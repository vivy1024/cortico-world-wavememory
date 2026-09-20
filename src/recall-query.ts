import { createHash } from 'node:crypto';
import type { EventEnvelope, EventStoreReader } from 'cortico/core/types.ts';

const OWN_SOURCE = 'wavememory';

export function hashQuery(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** 人类观众/对话者来源白名单；纯游戏机器事件（minecraft、oni 等）不参与外部记忆检索 */
const DIALOGUE_SOURCES = new Set(['bilibili', 'terminal', 'qq']);

export function speakerFromEvents(events: EventEnvelope[]): { id?: string; name?: string } {
  const last = [...events].reverse().find((e) => DIALOGUE_SOURCES.has(e.source) && (e.senderKey || e.meta));
  if (!last) return {};
  const name = typeof last.meta?.uname === 'string'
    ? last.meta.uname.trim()
    : typeof last.meta?.sender_name === 'string'
      ? last.meta.sender_name.trim()
      : '';
  const id = last.senderKey?.trim() || '';
  return {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
  };
}

/**
 * 投递时刻读取「本轮该围绕什么检索」。
 * 仅当有真实人类对话（B站弹幕、终端输入、QQ消息）时提取检索词，
 * 彻底过滤游戏机器事件（minecraft、oni），防止游戏状态误召回无关历史闲聊。
 */
export function recallQueryText(store: EventStoreReader, limit = 8): { text: string; speaker: { id?: string; name?: string } } {
  const events = store.range({ origin: 'external', limit });
  const usable = events.filter(
    (e) =>
      DIALOGUE_SOURCES.has(e.source)
      && e.contextDelivery !== 'archive-only'
      && typeof e.text === 'string'
      && e.text.trim().length > 0,
  );
  if (usable.length === 0) return { text: '', speaker: {} };
  const recent = usable.slice(-3);
  return {
    text: recent.map((e) => e.text.trim()).join('\n').slice(0, 500),
    speaker: speakerFromEvents(recent),
  };
}
