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

export interface InjectRequest {
  text: string;
  speaker?: InjectSpeaker;
  uid?: string;
  tier?: WaveMemoryTier;
  limit?: number;
  orchestrate?: boolean;
  scope?: RuntimeScopePayload;
}

export interface InjectResponse {
  ok: boolean;
  block?: string;
  chars?: number;
  tier?: string;
  elapsed_ms?: number;
  error?: string;
  channels?: Record<string, { status?: string; items?: number }>;
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
  event_id: string;
  content: string;
  sender_id?: string;
  sender_name?: string;
  timestamp?: number;
  scope?: RuntimeScopePayload;
}

export interface ObservationsBatchRequest {
  batch_id?: string;
  events: ObservationEventItem[];
}

export interface ObservationsBatchResponse {
  ok: boolean;
  batch_id?: string;
  receipts?: Array<{
    event_id: string;
    status: 'accepted' | 'rejected';
    delivery_state?: string;
    error?: string;
  }>;
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

export class WaveMemoryBridge {
  constructor(
    private readonly endpoint: string,
    private readonly fetchImpl: FetchLike = fetch as FetchLike,
    private readonly authToken: string = 'yushu-dev-token',
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${this.authToken}`,
      ...extra,
    };
  }

  async capabilities(timeoutMs = 3000): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    const url = `${this.endpoint.replace(/\/$/, '')}/api/runtime/v1/capabilities`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, { method: 'GET', headers: this.headers(), signal: ctrl.signal });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = await res.json();
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
      const data = (await res.json()) as ObservationsBatchResponse;
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
          tier: req.tier ?? 'light',
          limit: req.limit ?? 5,
          orchestrate: req.orchestrate ?? false,
          scope: req.scope,
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
