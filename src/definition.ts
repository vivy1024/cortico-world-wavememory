import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { WAVEMEMORY_DEFAULTS, type WaveMemoryConfigSection } from './config.ts';
import { wavememoryToolDecls, WaveMemoryWorld } from './world.ts';

export const WAVEMEMORY: WorldDefinition<WaveMemoryConfigSection> = {
  id: 'wavememory',
  label: 'WaveMemory',
  defaults: () => ({ ...WAVEMEMORY_DEFAULTS() }),
  create: (ctx) => new WaveMemoryWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    dataDir: ctx.dataDir,
    discoverTools: true,
    secret: (name) => ctx.secret(name),
    botDir: ctx.botDir,
    packageDir: ctx.packageDir,
  }),
  describe: {
    tools: describeTools(wavememoryToolDecls(), {
      wave_book_lore_search: {
        zh: '检索《没钱修什么仙》的原著设定、人物、战术与 GraphRAG 知识库。',
        en: 'Searches the source novel for lore, characters, tactics and GraphRAG knowledge.',
      },
      wave_book_lore_graph: {
        zh: '查看原著知识图谱里某个实体的人际关系、宗门归属与法宝关联。',
        en: "Shows an entity's relationships, sect affiliation and artifact links in the novel knowledge graph.",
      },
      wave_recall_memory: {
        zh: '全文检索历史记忆，回忆群聊事件、名场面、梗或约定。',
        en: 'Full-text search over past memories for events, highlights, memes or agreements.',
      },
      wave_query_person: {
        zh: '查询群友或观众的人物档案、活跃度、别名与历史印象。',
        en: "Looks up a viewer's profile, activity, aliases and accumulated impressions.",
      },
      wave_propose_fact: {
        zh: '把观众透露的重要个人事实或稳定偏好提审为三元组记忆。',
        en: 'Submits an important personal fact or stable preference as a reviewed triple.',
      },
      wave_note_episode: {
        zh: '记录与观众达成的重要约定、里程碑或阶段性成果。',
        en: 'Records an agreement, milestone or completed stage with the audience.',
      },
      wave_meme_lookup: {
        zh: '查梗百科，解读弹幕或群聊里的梗、黑话与抽象话。',
        en: 'Looks up a meme in the meme encyclopedia to interpret slang and abstract jokes.',
      },
      wave_game_knowledge: {
        zh: '查游戏攻略、机制常识与自己以前玩出来的经验。',
        en: "Looks up game guides, mechanics and the bot's own past gameplay experience.",
      },
      wave_affinity: {
        zh: '查询 Bot 与观众或群友的社交关系、好感度档位与历史交情。',
        en: "Looks up the bot's social relation, affinity tier and history with a viewer.",
      },
    }),
    events: [],
  },
};
