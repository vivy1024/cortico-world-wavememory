import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DeferredRendered,
  EventEnvelope,
  OutputTap,
  ToolDef,
  World,
  WorldConsoleDecl,
  WorldHost,
} from 'cortico/core/types.ts';
import {
  DEFAULT_TERMINAL_SESSION_ID,
  WAVEMEMORY_CONFIG_GROUP,
  WAVEMEMORY_TOKEN_SECRET,
  type WaveMemoryConfigSection,
  type WaveMemoryTier,
} from './config.ts';
import {
  WaveMemoryBridge,
  type FetchLike,
  type GameContextPayload,
  type RuntimeScopePayload,
  type RuntimeToolInfo,
} from './bridge.ts';
import { gameContext } from './game-context.ts';
import {
  hashQuery,
  latestDialogue,
  recallQueryFromEvents,
  recentEvents,
  type DialogueChannel,
  type DialogueSpeaker,
} from './recall-query.ts';
import { liveScope, qqScope, terminalScope } from './sessions.ts';
import { CallLedger, captureTap } from './speech.ts';
import { ObservationSync } from './sync.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const SAFETY_SLOT_RE = /\{\{\s*wavememory\.safetyPrompt\b/;

const RENDER_BUDGET_MS = 2500;
const FRESH_MS = 90_000;
const STALE_MS = 90_000;
const ARM_STALE_MS = 60_000;
/** 工具不带 conversation 时，最近一句对话在这么久以内才沿用它的会话，否则记在直播间。 */
const TOOL_CHANNEL_MAX_AGE_MS = 10 * 60_000;
/** 启动时往回找这么多条事件，看 vtuber World 在不在（决定要不要挂输出旁路）。 */
const VTUBER_SCAN_WINDOW = 2000;

interface CacheEntry {
  key: string;
  /** 这块记忆是关于谁、在哪条会话的；过期兜底时必须一致 */
  owner: string;
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
  /** 同步游标、口播记录、安全提示缓存的存放目录（WorldContext.dataDir）；缺省时不开写入同步 */
  dataDir?: string;
  /** start 时向 9876 拉取工具清单与 Bot 会话前缀（包入口设为 true；直接构造默认关闭） */
  discoverTools?: boolean;
  /** 读部署密钥（WorldContext.secret）；Runtime 令牌优先从 WAVEMEMORY_RUNTIME_TOKEN 取 */
  secret?: (name: string) => string;
  /** 部署目录（WorldContext.botDir）：判断部署覆盖的环境提示词里有没有安全提示占位符 */
  botDir?: string;
  /** bot 代码包目录（WorldContext.packageDir） */
  packageDir?: string;
  /** 时钟（测试用） */
  now?: () => number;
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

const CONVERSATION_PARAM = {
  type: 'string',
  description:
    '可选：记在哪个会话。live=直播间，terminal=终端，group:<群号> / private:<QQ号>=QQ 群或私聊；'
    + '不填则用当前这句对话所在的会话（十分钟内没人说话时记在直播间）',
};

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

function readSecret(secret: ((name: string) => string) | undefined, name: string): string {
  if (!secret) return '';
  try {
    return String(secret(name) ?? '').trim();
  } catch {
    return '';
  }
}

export type TokenOrigin = 'secret' | 'config' | 'none';

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
  private calls: CallLedger | null = null;
  private tap: OutputTap | null = null;
  private vtuberSeen = false;
  /** WaveMemory 最近一次给的身份安全提示（落盘，重启后第一次拼前缀就能用） */
  private safetyPrompt = '';
  /** 最近一次拼前缀时实际放进环境提示词的安全提示；与 safetyPrompt 不同就随注入块补上 */
  private prefixSafety: string | null = null;

  constructor(private readonly opts: WaveMemoryWorldOptions) {
    this.bridge = opts.bridge ?? new WaveMemoryBridge(opts.cfg.endpoint, fetch as FetchLike, () => this.token().token);
    this.safetyPrompt = this.loadSafetyPrompt();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private budgetMs(): number {
    return this.opts.renderBudgetMs ?? RENDER_BUDGET_MS;
  }

  private botId(): string {
    return this.opts.cfg.botId || 'yushu';
  }

  private liveSessionId(): string {
    return this.opts.cfg.sessionId || '';
  }

  private terminalSessionId(): string {
    return this.opts.cfg.terminalSessionId || DEFAULT_TERMINAL_SESSION_ID;
  }

  /** Runtime 令牌：部署密钥 WAVEMEMORY_RUNTIME_TOKEN 优先，其次 config.json 里的旧写法。 */
  token(): { token: string; origin: TokenOrigin } {
    const fromSecret = readSecret(this.opts.secret, WAVEMEMORY_TOKEN_SECRET);
    if (fromSecret) return { token: fromSecret, origin: 'secret' };
    const fromConfig = String(this.opts.cfg.authToken ?? '').trim();
    if (fromConfig) return { token: fromConfig, origin: 'config' };
    return { token: '', origin: 'none' };
  }

  private warnToken(host: WorldHost): void {
    const { origin } = this.token();
    if (origin === 'config') {
      host.log.warn(
        '[wavememory] Runtime 令牌写在 config.json 明文里（worlds.wavememory.authToken）；'
        + `建议写进部署 .env 的 ${WAVEMEMORY_TOKEN_SECRET} 并清空这一项`,
      );
    } else if (origin === 'none') {
      host.log.warn(`[wavememory] 没有配置 Runtime 令牌（部署 .env 的 ${WAVEMEMORY_TOKEN_SECRET}），WaveMemory 会拒绝请求`);
    }
  }

  /**
   * 一句对话所在会话的作用域（与 sync.ts 写入同一套划分）：弹幕→直播间，终端→终端会话，
   * QQ→规范前缀的群/私聊。发言人只在群聊里带；私聊的主体就是对方。QQ 前缀未知时返回 null。
   */
  scopeFor(channel: DialogueChannel | null, speaker: DialogueSpeaker = {}): RuntimeScopePayload | null {
    if (!channel || channel.kind === 'live') return liveScope(this.botId(), this.liveSessionId(), speaker.id);
    if (channel.kind === 'terminal') return terminalScope(this.botId(), this.terminalSessionId());
    return qqScope(this.botId(), this.sessionPrefix, channel.conv, channel.id, speaker.id);
  }

  /** 工具默认会话：最近一句对话所在的会话；十分钟内没人说话就是直播间。 */
  private defaultToolScope(): RuntimeScopePayload | null {
    const host = this.host;
    const line = host
      ? latestDialogue(recentEvents(host.store), { now: this.now(), maxAgeMs: TOOL_CHANNEL_MAX_AGE_MS })
      : null;
    return this.scopeFor(line?.channel ?? null);
  }

  /** 工具的 conversation 参数：live / terminal / group:<群号> / private:<QQ号>。 */
  private conversationScope(conversation: string): RuntimeScopePayload | null {
    const text = conversation.trim();
    if (/^(live|直播间?)$/i.test(text)) return this.scopeFor({ kind: 'live' });
    if (/^(terminal|终端)$/i.test(text)) return this.scopeFor({ kind: 'terminal' });
    const match = /^(group|private):(\d+)$/i.exec(text);
    if (!match) return null;
    return this.scopeFor({ kind: 'qq', conv: match[1].toLowerCase() as 'group' | 'private', id: match[2] });
  }

  /** 旧工具按名字或号码指定主体；只改群聊作用域（私聊的主体始终是对方）。 */
  private withSubject(scope: RuntimeScopePayload, who?: string): RuntimeScopePayload {
    const id = String(who ?? '').trim();
    if (!id || scope.visibility !== 'group' || !scope.session) return scope;
    const local = id.split(':').at(-1) || id;
    return { ...scope, subject_principal_id: `${scope.session.platform_id}:user:${local}` };
  }

  private toolScope(args: Record<string, unknown>): { scope: RuntimeScopePayload | null; conversation: string } {
    const conversation = String(args.conversation ?? '').trim();
    return { scope: conversation ? this.conversationScope(conversation) : this.defaultToolScope(), conversation };
  }

  // ─── 环境提示词与身份安全提示 ───────────────────────────────────────────────

  private safetyFile(): string | null {
    return this.opts.dataDir ? join(this.opts.dataDir, 'wavememory-prompt.json') : null;
  }

  private loadSafetyPrompt(): string {
    const file = this.safetyFile();
    if (!file) return '';
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { safetyPrompt?: unknown };
      return typeof saved.safetyPrompt === 'string' ? saved.safetyPrompt : '';
    } catch {
      return '';
    }
  }

  private noteSafetyPrompt(text: string): void {
    const prompt = text.trim();
    if (!prompt || prompt === this.safetyPrompt) return;
    this.safetyPrompt = prompt;
    const file = this.safetyFile();
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify({ safetyPrompt: prompt, at: new Date(this.now()).toISOString() }));
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      this.host?.log.warn(`[wavememory] 安全提示缓存写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 环境提示词此刻读哪份模板（部署覆盖 → 代码包覆盖 → 本扩展自带），与 Cortico 的查找顺序一致。 */
  private templateHasSafetySlot(): boolean {
    const candidates = [this.opts.botDir, this.opts.packageDir]
      .filter((dir): dir is string => !!dir)
      .map((dir) => join(dir, 'worlds', this.id, 'ENV_PROMPT.md'));
    const path = candidates.find((file) => existsSync(file)) ?? ENV_PROMPT_FILE;
    try {
      return SAFETY_SLOT_RE.test(readFileSync(path, 'utf8'));
    } catch {
      return false;
    }
  }

  /**
   * 身份安全提示是固定全文（与 AstrBot 路径加在系统提示词开头的同一段），放进本 World 的
   * 环境提示词：它在系统前缀里，前缀缓存不被打穿。每次拼前缀（含交接）时重新取值。
   */
  envPromptVars(): Record<string, string> {
    const safety = this.safetyPrompt;
    this.prefixSafety = this.templateHasSafetySlot() ? safety : '';
    return {
      'wavememory.endpoint': this.opts.cfg.endpoint,
      'wavememory.safetyPrompt': safety,
    };
  }

  /** 前缀里还没有这段安全提示（第一次运行、或部署覆盖的模板没有占位符）时，随注入块补上。 */
  private withSafety(block: string | null): string | null {
    const safety = this.safetyPrompt;
    if (!safety || this.prefixSafety === safety) return block;
    return block ? `${safety}\n\n${block}` : safety;
  }

  console(): WorldConsoleDecl {
    return {
      config: [WAVEMEMORY_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.wavememory.envPrompt',
          title: 'WaveMemory · 环境提示词',
          description: '说明自动注入与主动检索工具的使用边界；开头是 WaveMemory 提供的身份安全规则。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'wavememory.endpoint', description: '当前注入桥地址。' },
            {
              name: 'wavememory.safetyPrompt',
              description: 'WaveMemory 返回的身份安全规则全文（与 AstrBot 路径同一段）；第一次拿到之前为空，期间随注入块补上。',
              multiline: true,
            },
          ],
        },
      ],
    };
  }

  // ─── 工具 ──────────────────────────────────────────────────────────────────

  /** WaveMemory 工具注册表的工具，经 /tools/<name> 调用与 AstrBot 同一个实例。 */
  private remoteToolDefs(): ToolDef[] {
    return this.remoteTools
      .filter((tool) => tool.enabled && !SKIPPED_REMOTE_TOOLS.has(tool.name))
      .map((tool): ToolDef => {
        const params = { ...(tool.parameters ?? {}) } as { type?: string; properties?: Record<string, unknown>; required?: string[] };
        const properties = { ...(params.properties ?? {}), conversation: CONVERSATION_PARAM };
        return {
          name: cortiToolName(tool.name),
          description: tool.description,
          tags: [tool.writes ? 'write' : 'read'],
          parameters: { ...params, type: 'object', properties },
          handler: async (args) => {
            const { conversation: _conversation, ...rest } = args as Record<string, unknown>;
            const { scope, conversation } = this.toolScope(args as Record<string, unknown>);
            if (!scope) return `WaveMemory：会话地址 ${conversation || '(当前对话)'} 无效，或还没拿到 Bot 会话前缀`;
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
    const res = await this.bridge.capabilities(3000, this.botId());
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
    const invalidScope = (conversation: string): string =>
      `WaveMemory：会话地址 ${conversation || '(当前对话)'} 无效，或还没拿到 Bot 会话前缀`;
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
            conversation: CONVERSATION_PARAM,
          },
          required: ['query'],
        },
        handler: async (args) => {
          const { scope, conversation } = this.toolScope(args);
          if (!scope) return invalidScope(conversation);
          const speaker = String(args.speaker ?? '').trim();
          const res = await this.bridge.inject({
            text: String(args.query ?? ''),
            speaker: speaker ? { name: speaker } : {},
            tier: 'minimal',
            limit: typeof args.limit === 'number' ? args.limit : 5,
            orchestrate: false,
            scope,
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
            conversation: CONVERSATION_PARAM,
          },
          required: ['target'],
        },
        handler: async (args) => {
          const { scope, conversation } = this.toolScope(args);
          if (!scope) return invalidScope(conversation);
          const target = String(args.target ?? '').trim();
          const res = await this.bridge.inject({
            text: target,
            speaker: { name: target, id: target },
            tier: 'minimal',
            limit: 3,
            orchestrate: false,
            scope: this.withSubject(scope, target),
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
            conversation: CONVERSATION_PARAM,
          },
          required: ['subject', 'predicate', 'object'],
        },
        handler: async (args) => {
          const { scope, conversation } = this.toolScope(args);
          if (!scope) return invalidScope(conversation);
          const subject = String(args.subject ?? '').trim();
          const res = await this.bridge.executeCommand({
            command: 'propose_fact',
            scope: this.withSubject(scope, subject),
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
            conversation: CONVERSATION_PARAM,
          },
          required: ['trigger_text', 'outcome'],
        },
        handler: async (args) => {
          const { scope, conversation } = this.toolScope(args);
          if (!scope) return invalidScope(conversation);
          const res = await this.bridge.executeCommand({
            command: 'note_episode',
            scope,
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

  // ─── 生命周期与同步 ──────────────────────────────────────────────────────────

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.firstTurn = true;
    this.warnToken(host);
    this.vtuberSeen = recentEvents(host.store, VTUBER_SCAN_WINDOW).some((e) => e.source === 'vtuber');
    this.arm();
    if (this.opts.discoverTools) void this.refreshCapabilities(true).catch(() => false);
    this.startSync(host);
  }

  async stop(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.sync = null;
    this.calls = null;
    this.tap = null;
    this.host = null;
    this.armed = false;
    this.inflight = null;
    this.cache = null;
  }

  /**
   * 输出旁路：记下 vtuber_act 的台本与 mc_goal 的指令，同步时和播放终态、目标表对上号。
   * 只在开了写入同步、并且这个部署确实有 vtuber World（事件库里见过它）时才挂——
   * 没有别的 World 挂旁路时，挂上会让主 session 改走流式输出，不该由记忆扩展顺手改掉。
   */
  outputTap(): OutputTap | undefined {
    if (!this.calls || !this.vtuberSeen) return undefined;
    this.tap ??= captureTap(this.calls, () => this.now());
    return this.tap;
  }

  private startSync(host: WorldHost): void {
    const cfg = this.opts.cfg;
    if (!cfg.sync || !this.opts.dataDir) return;
    this.calls = new CallLedger({ file: join(this.opts.dataDir, 'wavememory-calls.json'), now: () => this.now(), log: host.log });
    this.sync = new ObservationSync({
      bridge: this.bridge,
      botId: this.botId(),
      sessionPrefix: () => this.sessionPrefix,
      liveSessionId: this.liveSessionId(),
      terminalSessionId: this.terminalSessionId(),
      calls: this.calls,
      cursorFile: join(this.opts.dataDir, 'wavememory-sync.json'),
      onSource: (source) => {
        if (source === 'vtuber') this.vtuberSeen = true;
      },
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

  /** 首轮 full；之后按配置，默认每轮 full（light 档不含书设与示例对话）。 */
  private currentTier(): WaveMemoryTier {
    if (this.firstTurn) return 'full';
    const tier = this.opts.cfg.tier;
    return tier === 'light' || tier === 'minimal' ? tier : 'full';
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

  /** 当前在玩的游戏（/context/prepare 的 game 字段）；没在玩返回 null。 */
  private currentGame(events: readonly EventEnvelope[]): GameContextPayload | null {
    const tracked = this.sync?.gameState();
    return gameContext(events, this.now(), {
      minecraftGoals: tracked?.mc.goals ?? null,
      stsCharacter: tracked?.sts.character ?? null,
    });
  }

  private async render(): Promise<DeferredRendered | null> {
    this.armed = false;
    const host = this.host;
    if (!host) return null;
    const events = recentEvents(host.store);
    const { text, speaker, channel } = recallQueryFromEvents(events);
    if (!text) return null;
    const scope = this.scopeFor(channel, speaker);
    if (!scope) {
      // QQ 会话前缀还没拿到：这一轮不注入（不能拼成别的会话），顺手去拉。
      if (channel?.kind === 'qq') void this.refreshCapabilities(true).catch(() => false);
      return null;
    }
    const game = this.currentGame(events);

    // 缓存键包含会话与发言人身份，严格杜绝不同观众、不同会话之间串缓存。
    const owner = `${scope.session?.id ?? ''}|${scope.subject_principal_id ?? ''}|${speaker.name ?? ''}`;
    const gameKey = game ? `${game.id}:${[...(game.keywords ?? [])].sort().join(',')}` : '';
    const key = `${hashQuery(text)}#${owner}#${gameKey}`;

    if (this.cache && this.cache.key === key && Date.now() - this.cache.at < FRESH_MS) {
      this.firstTurn = false;
      return this.withSafety(this.cache.block);
    }

    const pending = this.inflight?.key === key
      ? this.inflight.promise
      : this.startFetch(key, text, speaker, scope, game);

    try {
      const block = await withTimeout(pending, this.budgetMs());
      if (block) {
        this.cache = { key, owner, block, at: Date.now() };
        this.firstTurn = false;
        return this.withSafety(block);
      }
      return this.withSafety(this.staleOrNull(owner));
    } catch {
      return this.withSafety(this.staleOrNull(owner));
    }
  }

  /** stale 缓存回退：只在同一会话、同一发言人时兜底（防止把 A 观众的记忆塞给 B 观众）。 */
  private staleOrNull(owner: string): string | null {
    if (!this.cache || Date.now() - this.cache.at >= STALE_MS) return null;
    return this.cache.owner === owner ? this.cache.block : null;
  }

  private startFetch(
    key: string,
    text: string,
    speaker: DialogueSpeaker,
    scope: RuntimeScopePayload,
    game: GameContextPayload | null,
  ): Promise<string | null> {
    const promise = this.bridge.inject({
      text,
      speaker,
      uid: speaker.id,
      tier: this.currentTier(),
      orchestrate: false,
      scope,
      ...(game ? { game } : {}),
    }, this.budgetMs()).then((res) => {
      if (this.inflight?.key === key) this.inflight = null;
      if (res.ok && typeof res.safety_prompt === 'string') this.noteSafetyPrompt(res.safety_prompt);
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
