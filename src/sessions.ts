/**
 * 会话划分：写入（sync.ts）与读取（注入、工具）共用。
 *
 * - 直播间：配置里的 sessionId（如 bilibili:group:24292304），visibility=group；弹幕的发言人
 *   是 bilibili:user:<uid>；羽书的口播和游戏经历也记在这里，不带发言人。
 * - 终端：Cortico 终端是操作员控制台（事件 origin=internal），默认记在
 *   terminal:private:operator 这条私聊会话；WaveMemory 的私聊作用域只读自己这条线，
 *   操作员说的话不会被直播间、QQ 群的检索带出来。
 * - QQ：WaveMemory 返回的 Bot 规范会话前缀 + group/private + 号码，与 AstrBot 路径同一条线。
 */
import type { RuntimeScopePayload } from './bridge.ts';

export interface SessionParts {
  platform: string;
  kind: 'group' | 'private';
  conv: string;
}

/** `platform:kind:conversation`；conversation 里可以再有冒号。形状不对返回 null。 */
export function splitSession(sessionId: string): SessionParts | null {
  const [platform = '', kind = '', ...rest] = String(sessionId ?? '').trim().split(':');
  const conv = rest.join(':');
  if (!platform || !conv || (kind !== 'group' && kind !== 'private')) return null;
  return { platform, kind, conv };
}

function scopeOf(botId: string, parts: SessionParts, subjectLocalId?: string): RuntimeScopePayload {
  const subject = parts.kind === 'private' ? parts.conv : subjectLocalId;
  return {
    bot_id: botId,
    visibility: parts.kind,
    session: {
      id: `${parts.platform}:${parts.kind}:${parts.conv}`,
      platform_id: parts.platform,
      kind: parts.kind,
      conversation_id: parts.conv,
    },
    ...(subject ? { subject_principal_id: `${parts.platform}:user:${subject}` } : {}),
  };
}

/** 直播间；uid 为空或 0（未登录/隐身观众）时不带发言人。 */
export function liveScope(botId: string, liveSessionId: string, uid?: string): RuntimeScopePayload | null {
  const parts = splitSession(liveSessionId);
  if (!parts) return null;
  const who = String(uid ?? '').trim();
  return scopeOf(botId, parts, who && who !== '0' ? who : undefined);
}

/** 终端会话；私聊的主体就是会话对方（默认 operator）。 */
export function terminalScope(botId: string, terminalSessionId: string): RuntimeScopePayload | null {
  const parts = splitSession(terminalSessionId);
  return parts ? scopeOf(botId, parts, parts.kind === 'private' ? undefined : 'operator') : null;
}

/** 终端里操作员的 sender_id：私聊就是会话对方，否则是 operator。 */
export function terminalSenderId(terminalSessionId: string): string {
  const parts = splitSession(terminalSessionId);
  return parts?.kind === 'private' ? parts.conv : 'operator';
}

/** QQ 会话；前缀未知时返回 null（不能拼成另一条线）。 */
export function qqScope(botId: string, prefix: string, conv: 'group' | 'private', id: string, userId?: string): RuntimeScopePayload | null {
  if (!prefix || !id) return null;
  return scopeOf(botId, { platform: prefix, kind: conv, conv: id }, conv === 'group' ? (userId || undefined) : undefined);
}
