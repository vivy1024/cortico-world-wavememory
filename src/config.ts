import type { WorldSection } from 'cortico/world.ts';
import type { ConfigGroup } from 'cortico/core/types.ts';

export type WaveMemoryTier = 'full' | 'light' | 'minimal';

/** 部署 .env 里的 Runtime 令牌名，与 WaveMemory 服务端读取的环境变量同名。 */
export const WAVEMEMORY_TOKEN_SECRET = 'WAVEMEMORY_RUNTIME_TOKEN';

/**
 * 控制台（World `console`）对话默认记在这条私聊会话下；与写入同一条线。
 * 注意：`terminal:private:operator` 是历史会话 id，部署配置与既有记忆线都绑定这个字面量，
 * 不要跟着 World 改名迁移。
 */
export const DEFAULT_TERMINAL_SESSION_ID = 'terminal:private:operator';

export type TokenOrigin = 'secret' | 'config' | 'none';

/**
 * Runtime 令牌：部署密钥 WAVEMEMORY_RUNTIME_TOKEN 优先，其次 config.json 里的旧写法 authToken。
 * World 与补录脚本共用这条规则；secret 读不出（抛错）按没有处理。
 */
export function runtimeToken(
  cfg: { authToken?: string },
  secret?: (name: string) => string,
): { token: string; origin: TokenOrigin } {
  let fromSecret = '';
  if (secret) {
    try {
      fromSecret = String(secret(WAVEMEMORY_TOKEN_SECRET) ?? '').trim();
    } catch {
      fromSecret = '';
    }
  }
  if (fromSecret) return { token: fromSecret, origin: 'secret' };
  const fromConfig = String(cfg.authToken ?? '').trim();
  if (fromConfig) return { token: fromConfig, origin: 'config' };
  return { token: '', origin: 'none' };
}

export interface WaveMemoryConfigSection extends WorldSection {
  /** 9876 AstrBot 认知核心服务地址（统一暴露 /api/runtime/v1 与记忆准备，彻底替代 8030） */
  endpoint: string;
  /**
   * 访问 Runtime API 的 Bearer Token（旧写法，兼容保留）。
   * 优先读部署 .env 的 WAVEMEMORY_RUNTIME_TOKEN；这里的明文只在 .env 没有时使用，并在启动时警告一次。
   */
  authToken?: string;
  /** 默认 RuntimeScope 的 bot_id */
  botId: string;
  /** 直播间会话 session_id，如 bilibili:group:24292304；弹幕、口播和游戏经历都记在这里 */
  sessionId: string;
  /** 控制台对话的会话 session_id，默认 terminal:private:operator（历史会话 id，不要迁移）；可改成主人的 QQ 私聊会话 */
  terminalSessionId?: string;
  /** 注入分层：full / light / minimal（首轮总是 full，之后按这里；默认每轮 full） */
  tier: WaveMemoryTier;
  /** 把 QQ 消息、弹幕、控制台对话、自己说的话和游戏经历同步写入 WaveMemory */
  sync: boolean;
  /** 同步间隔（毫秒） */
  syncIntervalMs: number;
  /** 自动注入块总长上限（字符，默认 1500；0 不封顶） */
  maxBlockChars?: number;
}

export const WAVEMEMORY_DEFAULTS = (): WaveMemoryConfigSection => ({
  enabled: false,
  endpoint: 'http://127.0.0.1:9876',
  authToken: '',
  botId: 'yushu',
  sessionId: 'bilibili:group:24292304',
  terminalSessionId: DEFAULT_TERMINAL_SESSION_ID,
  tier: 'full',
  sync: true,
  syncIntervalMs: 15000,
});

export const WAVEMEMORY_CONFIG_GROUP: ConfigGroup = {
  id: 'wavememory',
  owner: 'world:wavememory',
  schema: {
    type: 'object',
    title: 'WaveMemory 记忆与书设注入',
    description:
      '生成前自动注入 live 库记忆与原著书设（persona / soul_state / 关系 / 语义召回 / 知识图谱）。'
      + '直连 AstrBot 进程 9876 核心服务。',
    properties: {
      'worlds.wavememory.enabled': {
        type: 'boolean',
        title: '启用 WaveMemory 注入',
        'x-hot': true,
      },
      'worlds.wavememory.endpoint': {
        type: 'string',
        title: 'WaveMemory 服务地址（默认 http://127.0.0.1:9876）',
      },
      'worlds.wavememory.authToken': {
        type: 'string',
        title: 'Runtime 鉴权 Token（旧写法）',
        description: '建议留空，把令牌写进部署 .env 的 WAVEMEMORY_RUNTIME_TOKEN；两处都有时以 .env 为准。',
      },
      'worlds.wavememory.botId': {
        type: 'string',
        title: 'Bot id（默认 yushu）',
      },
      'worlds.wavememory.sessionId': {
        type: 'string',
        title: '直播间会话 session_id',
      },
      'worlds.wavememory.terminalSessionId': {
        type: 'string',
        title: '控制台对话会话 session_id（默认历史值 terminal:private:operator）',
      },
      'worlds.wavememory.tier': {
        type: 'string',
        title: '注入分层（full / light / minimal，默认 full）',
      },
      'worlds.wavememory.sync': {
        type: 'boolean',
        title: '把对话、自己说的话和游戏经历写入 WaveMemory',
        description: '9876 离线时暂停并记住位置，恢复后补写；与 AstrBot 同时收到的 QQ 消息按消息号去重。',
      },
      'worlds.wavememory.syncIntervalMs': {
        type: 'number',
        title: '同步间隔（毫秒，默认 15000）',
      },
      'worlds.wavememory.maxBlockChars': {
        type: 'number',
        title: '自动注入块总长上限（字符，默认 1500；0 不封顶）',
        description: '超出时先从最长的记忆段尾部（相关度最低的行）逐行削，不截半行。',
      },
    },
  },
};
