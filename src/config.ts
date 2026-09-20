import type { WorldSection } from 'cortico/world.ts';
import type { ConfigGroup } from 'cortico/core/types.ts';

export type WaveMemoryTier = 'full' | 'light' | 'minimal';

export interface WaveMemoryConfigSection extends WorldSection {
  /** 8030 注入桥 HTTP 地址（不是 8799 备份库 MCP） */
  endpoint: string;
  /** 默认 RuntimeScope 的 bot_id */
  botId: string;
  /** 默认 RuntimeScope 的 session_id，如 羽书:group:150727649 */
  sessionId: string;
  /** 默认注入分层：light 实测 ~540ms，full 含 FTS ~2.4s */
  tier: WaveMemoryTier;
}

export const WAVEMEMORY_DEFAULTS = (): WaveMemoryConfigSection => ({
  enabled: false,
  endpoint: 'http://127.0.0.1:8030',
  botId: 'yushu',
  sessionId: '羽书:group:150727649',
  tier: 'light',
});

export const WAVEMEMORY_CONFIG_GROUP: ConfigGroup = {
  id: 'wavememory',
  owner: 'world:wavememory',
  schema: {
    type: 'object',
    title: 'WaveMemory 记忆注入',
    description:
      '生成前自动注入 live 库记忆（persona / soul_state / 关系 / 语义召回）。'
      + '后端是 8030 注入桥，直连 WaveMemory 插件 9876 live 库，不是 8799 备份 MCP。',
    properties: {
      'worlds.wavememory.enabled': {
        type: 'boolean',
        title: '启用 WaveMemory 注入',
        'x-hot': true,
      },
      'worlds.wavememory.endpoint': {
        type: 'string',
        title: '注入桥地址（默认 http://127.0.0.1:8030）',
      },
      'worlds.wavememory.botId': {
        type: 'string',
        title: 'Bot id（默认 yushu）',
      },
      'worlds.wavememory.sessionId': {
        type: 'string',
        title: '默认群 session_id',
      },
      'worlds.wavememory.tier': {
        type: 'string',
        title: '注入分层（light / full / minimal）',
      },
    },
  },
};
