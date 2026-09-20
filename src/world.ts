import { fileURLToPath } from 'node:url';
import type {
  DeferredRendered,
  ToolDef,
  World,
  WorldConsoleDecl,
  WorldHost,
} from 'cortico/core/types.ts';
import { WAVEMEMORY_CONFIG_GROUP, type WaveMemoryConfigSection, type WaveMemoryTier } from './config.ts';
import { WaveMemoryBridge } from './bridge.ts';
import { hashQuery, recallQueryText } from './recall-query.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 框架 RENDER_DEADLINE_MS = 3000，本地兜底先于它触发 */
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
  /** 仅测试注入：覆盖 RENDER_BUDGET_MS */
  renderBudgetMs?: number;
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

  constructor(private readonly opts: WaveMemoryWorldOptions) {
    this.bridge = opts.bridge ?? new WaveMemoryBridge(opts.cfg.endpoint);
  }

  private budgetMs(): number {
    return this.opts.renderBudgetMs ?? RENDER_BUDGET_MS;
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

  tools(): ToolDef[] {
    return [
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
          }, 8000);
          if (!res.ok) return `WaveMemory 人物查询失败: ${res.error ?? 'unknown'}`;
          return res.block || '(无档案)';
        },
      },
    ];
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.firstTurn = true;
    this.arm();
  }

  async stop(): Promise<void> {
    this.host = null;
    this.armed = false;
    this.inflight = null;
  }

  onTurnEnded(): void {
    this.arm();
  }

  onHandoffEnded(): void {
    this.firstTurn = true;
    this.arm();
  }

  /** 测试可见：当前是否已入队 piggyback */
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
    const key = hashQuery(text);

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
      return this.staleOrNull();
    } catch {
      return this.staleOrNull();
    }
  }

  private staleOrNull(): string | null {
    if (this.cache && Date.now() - this.cache.at < STALE_MS) return this.cache.block;
    return null;
  }

  private startFetch(key: string, text: string, speaker: { id?: string; name?: string }): Promise<string | null> {
    const promise = this.bridge.inject({
      text,
      speaker,
      tier: this.currentTier(),
      orchestrate: false,
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
