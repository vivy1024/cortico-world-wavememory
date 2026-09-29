import type { WaveMemoryTier } from './config.ts';

export interface RuntimeScopePayload {
  bot_id: string;
  visibility: 'group' | 'private' | 'bot_private' | 'system';
  session?: {
    id: string;
    platform_id: string;
    kind: string;
    conversation_id: string;
  };
  subject_principal_id?: string;
}

export interface CatalogScopePayload {
  catalog_id: string;
  corpus_id: string;
  version: string;
}

export interface InjectSpeaker {
  id?: string;
  name?: string;
}

/** 当前在玩的游戏（/context/prepare 的 game 字段）；服务端没有游戏知识通道时忽略。 */
export interface GameContextPayload {
  /** 小写游戏标识：minecraft / sts / oni … */
  id: string;
  /** 扁平键值：数字或短字符串 */
  state?: Record<string, string | number>;
  /** 短词列表 */
  keywords?: string[];
}

export interface InjectRequest {
  text: string;
  speaker?: InjectSpeaker;
  uid?: string;
  tier?: WaveMemoryTier;
  limit?: number;
  orchestrate?: boolean;
  scope?: RuntimeScopePayload;
  game?: GameContextPayload;
}

export interface InjectResponse {
  ok: boolean;
  block?: string;
  chars?: number;
  tier?: string;
  elapsed_ms?: number;
  error?: string;
  channels?: Record<string, { status?: string; items?: number }>;
  /** 身份安全系统提示全文（与 AstrBot 路径加在系统提示词开头的同一段）；旧服务端没有这个字段 */
  safety_prompt?: string;
}

export interface BookLoreSearchRequest {
  query: string;
  mode?: 'hybrid' | 'semantic' | 'keyword';
  resources?: ('entities' | 'communities' | 'notes')[];
  top_k?: number;
  scope?: CatalogScopePayload;
}

export interface BookLoreSearchResponse {
  ok: boolean;
  request_id?: string;
  data?: {
    items: Array<{
      id: string;
      resource: string;
      title: string;
      content: string;
      scores: { score: number; rank: number };
      provenance: Record<string, unknown>;
    }>;
    mode: string;
    degraded: boolean;
    warnings: string[];
  };
  error?: { code: string; message: string };
}

export interface BookLoreGraphRequest {
  entity_name: string;
  depth?: number;
  max_edges?: number;
  scope?: CatalogScopePayload;
}

export interface BookLoreGraphResponse {
  ok: boolean;
  request_id?: string;
  data?: {
    entity: { id: string; title: string; type: string; description: string } | null;
    relations: Array<{ id: string; source: string; target: string; description: string; weight: number }>;
  };
  error?: { code: string; message: string };
}

export interface ObservationEventItem {
  /** 平台原始消息号（QQ message_id）或 Cortico 事件游标，WaveMemory 用它去重 */
  event_id: string;
  /** message=别人说的话，danmaku=弹幕，self=Bot 自己说的话，game_event=Bot 自己的游戏经历 */
  kind?: 'message' | 'danmaku' | 'self' | 'game_event';
  content: string;
  sender_id?: string;
  sender_name?: string;
  timestamp?: number;
  group_name?: string;
  is_at_bot?: boolean;
  scope?: RuntimeScopePayload;
  /** game_event：小写游戏标识 */
  game?: string;
  /** game_event：death / goal / discovery / milestone / choice / crisis */
  event_type?: string;
}

export interface ObservationsBatchRequest {
  batch_id?: string;
  events: ObservationEventItem[];
}

export interface ObservationsBatchResponse {
  ok: boolean;
  batch_id?: string;
  accepted?: number;
  rejected?: number;
  receipts?: Array<{
    event_id: string;
    status: 'accepted' | 'rejected';
    kind?: string;
    delivery_state?: string;
    error?: string;
  }>;
  error?: { code: string; message: string };
}

/** /capabilities 里的一个工具（WaveMemory 工具注册表导出）。 */
export interface RuntimeToolInfo {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  group: string;
  writes: boolean;
  enabled: boolean;
}

export interface RuntimeCapabilities {
  ok: boolean;
  protocol_version?: string;
  tiers?: string[];
  tools?: RuntimeToolInfo[];
  bot?: { db_id: string; name: string; session_prefix: string; self_ids: string[] } | null;
}

export interface ToolInvokeResponse {
  ok: boolean;
  tool?: string;
  result?: string;
  elapsed_ms?: number;
  error?: { code: string; message: string };
}

export interface ProposeFactCommandRequest {
  command: 'propose_fact';
  operation_key?: string;
  scope: RuntimeScopePayload;
  arguments: {
    subject: string;
    predicate: string;
    object: string;
    source_quote?: string;
    source_event_ids?: string[];
  };
}

export interface NoteEpisodeCommandRequest {
  command: 'note_episode';
  operation_key?: string;
  scope: RuntimeScopePayload;
  arguments: {
    episode_type?: string;
    trigger_text: string;
    outcome?: string;
    user_id?: string;
  };
}

export interface CommandResponse {
  ok: boolean;
  operation_id?: string;
  data?: {
    command: string;
    entity: { kind: string; id: string; revision: number };
    transport_state: string;
    domain_state: string;
    projection_state: string;
    evidence_status?: string;
    duplicate: boolean;
  };
  error?: { code: string; message: string };
}

export interface FetchLike {
  (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

const DEFAULT_TIMEOUT_MS = 2500;

/** 令牌：固定字符串，或每次请求现取（部署 .env 改了不用重启）。空串 = 不带 Authorization。 */
export type TokenSource = string | (() => string);

export class WaveMemoryBridge {
  constructor(
    private readonly endpoint: string,
    private readonly fetchImpl: FetchLike = fetch as FetchLike,
    private readonly authToken: TokenSource = '',
  ) {}

  private token(): string {
    const value = typeof this.authToken === 'function' ? this.authToken() : this.authToken;
    return String(value ?? '').trim();
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const token = this.token();
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    };
  }

  async capabilities(timeoutMs = 3000, botId?: string): Promise<{ ok: boolean; data?: RuntimeCapabilities; error?: string }> {
    const query = botId ? `?bot_id=${encodeURIComponent(botId)}` : '';
    const url = `${this.endpoint.replace(/\/$/, '')}/api/runtime/v1/capabilities${query}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, { method: 'GET', headers: this.headers(), signal: ctrl.signal });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = (await res.json()) as RuntimeCapabilities;
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  async searchBookLore(req: BookLoreSearchRequest, timeoutMs = 4000): Promise<BookLoreSearchResponse> {
    const url = `${this.endpoint.replace(/\/$/, '')}/api/runtime/v1/book-lore/search`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
      const data = (await res.json()) as BookLoreSearchResponse;
      return data;
    } catch (err) {
      return {
        ok: false,
        error: { code: 'network_error', message: err instanceof Error ? err.message : String(err) },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async graphBookLore(req: BookLoreGraphRequest, timeoutMs = 4000): Promise<BookLoreGraphResponse> {
    const url = `${this.endpoint.replace(/\/$/, '')}/api/runtime/v1/book-lore/graph`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
      const data = (await res.json()) as BookLoreGraphResponse;
      return data;
    } catch (err) {
      return {
        ok: false,
        error: { code: 'network_error', message: err instanceof Error ? err.message : String(err) },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async submitObservations(req: ObservationsBatchRequest, timeoutMs = 3000): Promise<ObservationsBatchResponse> {
    const url = `${this.endpoint.replace(/\/$/, '')}/api/runtime/v1/observations/batch`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
      const data = (await res.json().catch(() => null)) as ObservationsBatchResponse | null;
      if (!res.ok || !data) {
        return data ?? { ok: false, error: { code: 'http_error', message: `HTTP ${res.status}` } };
      }
      return data;
    } catch (err) {
      return {
        ok: false,
        error: { code: 'network_error', message: err instanceof Error ? err.message : String(err) },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async invokeTool(
    name: string,
    req: { scope: RuntimeScopePayload; arguments: Record<string, unknown> },
    timeoutMs = 8000,
  ): Promise<ToolInvokeResponse> {
    const url = `${this.endpoint.replace(/\/$/, '')}/api/runtime/v1/tools/${encodeURIComponent(name)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ ...req, source: 'cortico' }),
        signal: ctrl.signal,
      });
      return (await res.json()) as ToolInvokeResponse;
    } catch (err) {
      return { ok: false, error: { code: 'network_error', message: err instanceof Error ? err.message : String(err) } };
    } finally {
      clearTimeout(timer);
    }
  }

  async executeCommand(
    req: ProposeFactCommandRequest | NoteEpisodeCommandRequest,
    timeoutMs = 4000,
  ): Promise<CommandResponse> {
    const url = `${this.endpoint.replace(/\/$/, '')}/api/runtime/v1/commands`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
      const data = (await res.json()) as CommandResponse;
      return data;
    } catch (err) {
      return {
        ok: false,
        error: { code: 'network_error', message: err instanceof Error ? err.message : String(err) },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async inject(req: InjectRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<InjectResponse> {
    const url = `${this.endpoint.replace(/\/$/, '')}/api/runtime/v1/context/prepare`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          text: req.text,
          speaker: req.speaker ?? {},
          uid: req.uid,
          tier: req.tier ?? 'full',
          limit: req.limit ?? 5,
          orchestrate: req.orchestrate ?? false,
          scope: req.scope,
          ...(req.game ? { game: req.game } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      const data = (await res.json()) as InjectResponse;
      if (!data || typeof data !== 'object') return { ok: false, error: 'non-object response' };
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  async health(timeoutMs = 4000): Promise<{ ok: boolean; error?: string }> {
    const url = `${this.endpoint.replace(/\/$/, '')}/health`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, { method: 'GET', signal: ctrl.signal });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = (await res.json()) as { ok?: boolean };
      return { ok: data.ok === true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}
