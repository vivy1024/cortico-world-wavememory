import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DeferredRendered,
  ToolDef,
  World,
  WorldConsoleDecl,
  WorldHost,
} from 'cortico/core/types.ts';
import { WAVEMEMORY_CONFIG_GROUP, type WaveMemoryConfigSection, type WaveMemoryTier } from './config.ts';
import { WaveMemoryBridge, type RuntimeScopePayload, type RuntimeToolInfo } from './bridge.ts';
import { hashQuery, recallQueryText } from './recall-query.ts';
import { ObservationSync } from './sync.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

const RENDER_BUDGET_MS = 2500;
const FRESH_MS = 90_000;
const STALE_MS = 90_000;
const ARM_STALE_MS = 60_000;

interface CacheEntry {
  key: string;
  block: string;
  at: number;
}

interface Inflight {
  key: string;
  promise: Promise<string | null>;
}

export interface WaveMemoryWorldOptions {
  cfg: WaveMemoryConfigSection;
  timezone: string;
  bridge?: WaveMemoryBridge;
  renderBudgetMs?: number;
  /** 同步游标存放目录（WorldContext.dataDir）；缺省时不开写入同步 */
  dataDir?: string;
  /** start 时向 9876 拉取工具清单与 Bot 会话前缀（包入口设为 true；直接构造默认关闭） */
  discoverTools?: boolean;
}

/**
 * WaveMemory 工具注册表里的工具在 Cortico 这边的名字：沿用环境提示词里已有的 4 个名字，
 * 其余把 `wave_memory_` 换成 `wave_`。书设检索走专用接口，不重复暴露。
 */
const TOOL_ALIASES: Record<string, string> = {
  wave_memory_search: 'wave_recall_memory',
  wave_memory_person_search: 'wave_query_person',
  wave_memory_propose_fact: 'wave_propose_fact',
  wave_memory_note_episode: 'wave_note_episode',
};
const SKIPPED_REMOTE_TOOLS = new Set(['wave_memory_book_lore_search']);
const CAPABILITY_REFRESH_MS = 5 * 60_000;

export function cortiToolName(remote: string): string {
  return TOOL_ALIASES[remote] ?? remote.replace(/^wave_memory_/, 'wave_');
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export class WaveMemoryWorld implements World {
  readonly id = 'wavememory';
  private host: WorldHost | null = null;
  private armed = false;
  private armedAt = 0;
  private firstTurn = true;
  private cache: CacheEntry | null = null;
  private inflight: Inflight | null = null;
  private readonly bridge: WaveMemoryBridge;
  private remoteTools: RuntimeToolInfo[] = [];
  private sessionPrefix = '';
  private capabilitiesAt = 0;
  private sync: ObservationSync | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: WaveMemoryWorldOptions) {
    this.bridge = opts.bridge ?? new WaveMemoryBridge(opts.cfg.endpoint, fetch as any, opts.cfg.authToken || 'yushu-dev-token');
  }

  private budgetMs(): number {
    return this.opts.renderBudgetMs ?? RENDER_BUDGET_MS;
  }

  private getScopePayload(speakerId?: string): RuntimeScopePayload {
    const botId = this.opts.cfg.botId || 'yushu';
    const rawSessionId = this.opts.cfg.sessionId || '羽书:group:150727649';
    let platformId = 'qq';
    let kind = 'group';
    let conversationId = '150727649';

    if (rawSessionId.includes(':')) {
      const parts = rawSessionId.split(':');
      if (parts.length >= 3) {
        platformId = parts[0];
        kind = parts[1];
        conversationId = parts.slice(2).join(':');
      }
    }

    return {
      bot_id: botId,
      visibility: 'group',
      session: {
        id: `${platformId}:${kind}:${conversationId}`,
        platform_id: platformId,
        kind,
        conversation_id: conversationId,
      },
      subject_principal_id: speakerId ? `${platformId}:user:${speakerId}` : undefined,
    };
  }

  envPromptVars(): Record<string, string> {
    return {
      'wavememory.endpoint': this.opts.cfg.endpoint,
    };
  }

  console(): WorldConsoleDecl {
    return {
      config: [WAVEMEMORY_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.wavememory.envPrompt',
          title: 'WaveMemory · 环境提示词',
          description: '说明自动注入与主动检索工具的使用边界。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [{ name: 'wavememory.endpoint', description: '当前注入桥地址。' }],
        },
      ],
    };
  }

  /** 按 QQ 会话地址（group:123 / private:456）拼作用域；前缀取 WaveMemory 返回的 Bot 规范会话前缀。 */
  private conversationScope(conversation: string, speakerId?: string): RuntimeScopePayload | null {
    const match = /^(group|private):(\d+)$/i.exec(conversation.trim());
    if (!match || !this.sessionPrefix) return null;
    const kind = match[1].toLowerCase() as 'group' | 'private';
    const prefix = this.sessionPrefix;
    const subject = kind === 'private' ? match[2] : speakerId;
    return {
      bot_id: this.opts.cfg.botId || 'yushu',
      visibility: kind,
      session: { id: `${prefix}:${kind}:${match[2]}`, platform_id: prefix, kind, conversation_id: match[2] },
      subject_principal_id: subject ? `${prefix}:user:${subject}` : undefined,
    };
  }

  /** WaveMemory 工具注册表的工具，经 /tools/<name> 调用与 AstrBot 同一个实例。 */
  private remoteToolDefs(): ToolDef[] {
    return this.remoteTools
      .filter((tool) => tool.enabled && !SKIPPED_REMOTE_TOOLS.has(tool.name))
      .map((tool): ToolDef => {
        const params = { ...(tool.parameters ?? {}) } as { type?: string; properties?: Record<string, unknown>; required?: string[] };
        const properties = {
          ...(params.properties ?? {}),
          conversation: {
            type: 'string',
            description: '可选：QQ 会话地址 group:<群号> 或 private:<QQ号>；不填则记在直播间会话下',
          },
        };
        return {
          name: cortiToolName(tool.name),
          description: tool.description,
          tags: [tool.writes ? 'write' : 'read'],
          parameters: { ...params, type: 'object', properties },
          handler: async (args) => {
            const { conversation, ...rest } = args as Record<string, unknown>;
            const convText = String(conversation ?? '').trim();
            const scope = convText ? this.conversationScope(convText) : this.getScopePayload();
            if (!scope) return `WaveMemory：会话地址 ${convText} 无效，或还没拿到 Bot 会话前缀`;
            const res = await this.bridge.invokeTool(tool.name, { scope, arguments: rest }, 8000);
            if (!res.ok) return `WaveMemory ${tool.name} 失败: ${res.error?.message ?? 'unknown'}`;
            return res.result ?? '';
          },
        };
      });
  }

  /** 拉取 Bot 会话前缀与工具清单；9876 离线时保留上次结果，工具回落到内置实现。 */
  async refreshCapabilities(force = false): Promise<boolean> {
    if (!force && Date.now() - this.capabilitiesAt < CAPABILITY_REFRESH_MS && this.remoteTools.length) return true;
    const res = await this.bridge.capabilities(3000, this.opts.cfg.botId || 'yushu');
    if (!res.ok || !res.data?.ok) return false;
    this.capabilitiesAt = Date.now();
    this.remoteTools = res.data.tools ?? [];
    this.sessionPrefix = res.data.bot?.session_prefix ?? '';
    return true;
  }

  tools(): ToolDef[] {
    const remote = this.remoteToolDefs();
    const remoteNames = new Set(remote.map((tool) => tool.name));
    return [...this.staticTools().filter((tool) => !remoteNames.has(tool.name)), ...remote];
  }

  private staticTools(): ToolDef[] {
    return [
      {
        name: 'wave_book_lore_search',
        description: '从《没钱修什么仙》全量 1.7 万条原著设定、人物、战术与 GraphRAG 知识库中检索详细背景设定。',
        tags: ['read'],
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '要检索的书设主题、人物名或设定名词' },
            mode: { type: 'string', enum: ['hybrid', 'semantic', 'keyword'], description: '检索模式，默认 hybrid' },
            top_k: { type: 'integer', description: '返回条数，默认 5 条' },
          },
          required: ['query'],
        },
        handler: async (args) => {
          const res = await this.bridge.searchBookLore({
            query: String(args.query ?? ''),
            mode: (args.mode as 'hybrid' | 'semantic' | 'keyword') || 'hybrid',
            top_k: typeof args.top_k === 'number' ? args.top_k : 5,
          }, 4000);
          if (!res.ok || !res.data) {
            return `书设检索失败: ${res.error?.message ?? 'unknown'}`;
          }
          if (!res.data.items || res.data.items.length === 0) {
            return '(无命中书设设定)';
          }
          return res.data.items.map((it, idx) => `[${idx + 1}] ${it.title}：${it.content}`).join('\n\n');
        },
      },
      {
        name: 'wave_book_lore_graph',
        description: '在《没钱修什么仙》原著知识图谱中查看指定实体的人际关系、宗门归属或法宝关联。',
        tags: ['read'],
        parameters: {
          type: 'object',
          properties: {
            entity_name: { type: 'string', description: '实体完整名称（如：磁极神君、张羽）' },
            depth: { type: 'integer', description: '遍历深度（1 或 2，默认 1）' },
          },
          required: ['entity_name'],
        },
        handler: async (args) => {
          const res = await this.bridge.graphBookLore({
            entity_name: String(args.entity_name ?? ''),
            depth: typeof args.depth === 'number' ? args.depth : 1,
          }, 4000);
          if (!res.ok || !res.data) {
            return `图谱遍历失败: ${res.error?.message ?? 'unknown'}`;
          }
          if (!res.data.entity) {
            return '(未找到该实体关联)';
          }
          const rels = res.data.relations.map((r) => `- ${r.source} 与 ${r.target}: ${r.description} (权重 ${r.weight})`).join('\n');
          return `【实体】${res.data.entity.title} (${res.data.entity.type})\n${res.data.entity.description}\n【关系网】\n${rels || '(暂无关系边)'}`;
        },
      },
      {
        name: 'wave_recall_memory',
        description: '从羽书的 28 万条历史记忆库中进行全文检索，回忆过往群聊事件、名场面、梗或约定。',
        tags: ['read'],
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '要回忆的关键词或话题' },
            speaker: { type: 'string', description: '可选的指定发言人姓名或ID' },
            limit: { type: 'integer', description: '返回条数，默认 5 条' },
          },
          required: ['query'],
        },
        handler: async (args) => {
          const speaker = String(args.speaker ?? '').trim();
          const res = await this.bridge.inject({
            text: String(args.query ?? ''),
            speaker: speaker ? { name: speaker } : {},
            tier: 'minimal',
            limit: typeof args.limit === 'number' ? args.limit : 5,
            orchestrate: false,
            scope: this.getScopePayload(speaker),
          }, 8000);
          if (!res.ok) return `WaveMemory 检索失败: ${res.error ?? 'unknown'}`;
          return res.block || '(无命中)';
        },
      },
      {
        name: 'wave_query_person',
        description: '查询某个群友或观众的人物档案、活跃度、别名以及历史印象画像。',
        tags: ['read'],
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: '用户昵称、QQ号或 bili:UID' },
          },
          required: ['target'],
        },
        handler: async (args) => {
          const target = String(args.target ?? '').trim();
          const res = await this.bridge.inject({
            text: target,
            speaker: { name: target, id: target },
            tier: 'minimal',
            limit: 3,
            orchestrate: false,
            scope: this.getScopePayload(target),
          }, 8000);
          if (!res.ok) return `WaveMemory 人物查询失败: ${res.error ?? 'unknown'}`;
          return res.block || '(无档案)';
        },
      },
      {
        name: 'wave_propose_fact',
        description: '当直播间观众透露了重要的个人现实事实或稳定偏好时，向 WaveMemory 提审三元组记忆（处于待审核状态，待审期间仅作为当前观众的自述依据）。',
        tags: ['act'],
        parameters: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: '事实主体（如用户昵称或 canonical ID，不可捏造）' },
            predicate: { type: 'string', description: '属性或关系动词（如：偏好、居住地、职业）' },
            object: { type: 'string', description: '事实客体或属性值' },
            source_quote: { type: 'string', description: '观众本人的发言原话引用' },
          },
          required: ['subject', 'predicate', 'object'],
        },
        handler: async (args) => {
          const subject = String(args.subject ?? '').trim();
          const res = await this.bridge.executeCommand({
            command: 'propose_fact',
            scope: this.getScopePayload(subject),
            arguments: {
              subject,
              predicate: String(args.predicate ?? '').trim(),
              object: String(args.object ?? '').trim(),
              source_quote: String(args.source_quote ?? '').trim(),
            },
          }, 4000);
          if (!res.ok || !res.data) {
            return `事实提审失败: ${res.error?.message ?? 'unknown'}`;
          }
          return `【已提审】${args.subject} 的事实 [${args.predicate}: ${args.object}] 已提交（状态: ${res.data.domain_state}，引用状态: ${res.data.evidence_status}）。`;
        },
      },
      {
        name: 'wave_note_episode',
        description: '记录直播中羽书与观众达成的重要约定、里程碑经历或关键阶段性成果。',
        tags: ['act'],
        parameters: {
          type: 'object',
          properties: {
            trigger_text: { type: 'string', description: '引发该经历的起因或观众提议' },
            outcome: { type: 'string', description: '经历的结果、履约情况或阶段终态' },
            episode_type: { type: 'string', description: '经历类别，如 live_milestone / agreement / achievement' },
          },
          required: ['trigger_text', 'outcome'],
        },
        handler: async (args) => {
          const res = await this.bridge.executeCommand({
            command: 'note_episode',
            scope: this.getScopePayload('yushu'),
            arguments: {
              trigger_text: String(args.trigger_text ?? '').trim(),
              outcome: String(args.outcome ?? '').trim(),
              episode_type: String(args.episode_type ?? 'live_milestone').trim(),
            },
          }, 4000);
          if (!res.ok || !res.data) {
            return `经历记录失败: ${res.error?.message ?? 'unknown'}`;
          }
          return `【已记录经历】经历编号 ${res.data.entity.id} 已持久化归档（状态: ${res.data.domain_state}）。`;
        },
      },
    ];
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.firstTurn = true;
    this.arm();
    if (this.opts.discoverTools) void this.refreshCapabilities(true).catch(() => false);
    this.startSync(host);
  }

  async stop(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.sync = null;
    this.host = null;
    this.armed = false;
    this.inflight = null;
    this.cache = null;
  }

  private startSync(host: WorldHost): void {
    const cfg = this.opts.cfg;
    if (!cfg.sync || !this.opts.dataDir) return;
    this.sync = new ObservationSync({
      bridge: this.bridge,
      botId: cfg.botId || 'yushu',
      sessionPrefix: () => this.sessionPrefix,
      liveSessionId: cfg.sessionId || '',
      cursorFile: join(this.opts.dataDir, 'wavememory-sync.json'),
      log: host.log,
    });
    const interval = Math.max(3000, Number(cfg.syncIntervalMs) || 15000);
    this.syncTimer = setInterval(() => void this.syncOnce(), interval);
    this.syncTimer.unref?.();
  }

  /** 同步一批观察；QQ 事件需要先拿到 Bot 会话前缀。 */
  async syncOnce(): Promise<void> {
    const host = this.host;
    if (!host || !this.sync) return;
    if (!this.sessionPrefix) await this.refreshCapabilities(true).catch(() => false);
    else void this.refreshCapabilities().catch(() => false);
    const result = await this.sync.tick(host.store).catch((err) => {
      host.log.warn(`[wavememory] 同步失败: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (result?.error) host.log.warn(`[wavememory] 同步暂停在 #${result.cursor}: ${result.error}`);
  }

  onTurnEnded(): void {
    this.arm();
  }

  onHandoffEnded(): void {
    this.firstTurn = true;
    this.arm();
  }

  get isArmed(): boolean {
    return this.armed;
  }

  private currentTier(): WaveMemoryTier {
    if (this.firstTurn) return 'full';
    return this.opts.cfg.tier || 'light';
  }

  private arm(): void {
    if (!this.host) return;
    const now = Date.now();
    if (this.armed && now - this.armedAt < ARM_STALE_MS) return;
    this.armed = true;
    this.armedAt = now;
    this.host.pushDeferred(
      {
        type: 'wavememory.context',
        origin: 'internal',
        tags: ['snapshot'],
        render: () => this.render(),
      },
      { trigger: 'piggyback' },
    );
  }

  private async render(): Promise<DeferredRendered | null> {
    this.armed = false;
    const host = this.host;
    if (!host) return null;
    const { text, speaker } = recallQueryText(host.store);
    if (!text) return null;

    // 缓存键必须包含发言人身份，严格杜绝不同观众之间串缓存
    const speakerKey = speaker?.id ? `${speaker.id}:${speaker.name ?? ''}` : 'anon';
    const key = `${hashQuery(text)}#${speakerKey}`;

    if (this.cache && this.cache.key === key && Date.now() - this.cache.at < FRESH_MS) {
      this.firstTurn = false;
      return this.cache.block;
    }

    const pending = this.inflight?.key === key
      ? this.inflight.promise
      : this.startFetch(key, text, speaker);

    try {
      const block = await withTimeout(pending, this.budgetMs());
      if (block) {
        this.cache = { key, block, at: Date.now() };
        this.firstTurn = false;
        return block;
      }
      return this.staleOrNull(speakerKey);
    } catch {
      return this.staleOrNull(speakerKey);
    }
  }

  // stale 缓存回退：在同会话或超时情况下提供兜底，若提供了 expectedSpeaker 则必须匹配发言人
  private staleOrNull(expectedSpeaker?: string): string | null {
    if (!this.cache || Date.now() - this.cache.at >= STALE_MS) {
      return null;
    }
    // 如果指定了发言人，且当前缓存的发言人与指定的不一致，严禁回退（防止将 A 观众的记忆塞给 B 观众）
    if (expectedSpeaker && !this.cache.key.endsWith(`#${expectedSpeaker}`)) {
      return null;
    }
    return this.cache.block;
  }

  private startFetch(key: string, text: string, speaker: { id?: string; name?: string }): Promise<string | null> {
    const promise = this.bridge.inject({
      text,
      speaker,
      uid: speaker?.id,
      tier: this.currentTier(),
      orchestrate: false,
      scope: this.getScopePayload(speaker?.id),
    }, this.budgetMs()).then((res) => {
      if (this.inflight?.key === key) this.inflight = null;
      if (!res.ok || !res.block) return null;
      return res.block;
    }).catch(() => {
      if (this.inflight?.key === key) this.inflight = null;
      return null;
    });
    this.inflight = { key, promise };
    return promise;
  }
}
