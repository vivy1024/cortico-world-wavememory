import type { WorldSection } from 'cortico/world.ts';
import type { ConfigGroup } from 'cortico/core/types.ts';

export type WaveMemoryTier = 'full' | 'light' | 'minimal';

export interface WaveMemoryConfigSection extends WorldSection {
  /** 9876 AstrBot 认知核心服务地址（统一暴露 /api/runtime/v1 与记忆准备，彻底替代 8030） */
  endpoint: string;
  /** 访问 Runtime API 的 Bearer Token */
  authToken?: string;
  /** 默认 RuntimeScope 的 bot_id */
  botId: string;
  /** 默认 RuntimeScope 的 session_id，如 bilibili:group:24292304 或 羽书:group:150727649 */
  sessionId: string;
  /** 默认注入分层：light / full / minimal */
  tier: WaveMemoryTier;
  /** 把 QQ 消息、弹幕与自己说的话同步写入 WaveMemory（与 AstrBot 路径同一套写入流程） */
  sync: boolean;
  /** 同步间隔（毫秒） */
  syncIntervalMs: number;
}

export const WAVEMEMORY_DEFAULTS = (): WaveMemoryConfigSection => ({
  enabled: false,
  endpoint: 'http://127.0.0.1:9876',
  authToken: 'yushu-dev-token',
  botId: 'yushu',
  sessionId: 'bilibili:group:24292304',
  tier: 'light',
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
        title: 'Runtime 鉴权 Token（默认 yushu-dev-token）',
      },
      'worlds.wavememory.botId': {
        type: 'string',
        title: 'Bot id（默认 yushu）',
      },
      'worlds.wavememory.sessionId': {
        type: 'string',
        title: '默认会话 session_id',
      },
      'worlds.wavememory.tier': {
        type: 'string',
        title: '注入分层（light / full / minimal）',
      },
      'worlds.wavememory.sync': {
        type: 'boolean',
        title: '把 QQ 消息、弹幕和自己说的话写入 WaveMemory',
        description: '9876 离线时暂停并记住位置，恢复后补写；与 AstrBot 同时收到的 QQ 消息按消息号去重。',
      },
      'worlds.wavememory.syncIntervalMs': {
        type: 'number',
        title: '同步间隔（毫秒，默认 15000）',
      },
    },
  },
};
