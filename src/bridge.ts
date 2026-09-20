import type { WaveMemoryTier } from './config.ts';

export interface InjectSpeaker {
  id?: string;
  name?: string;
}

export interface InjectRequest {
  text: string;
  speaker?: InjectSpeaker;
  tier?: WaveMemoryTier;
  limit?: number;
  orchestrate?: boolean;
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
  ) {}

  async inject(req: InjectRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<InjectResponse> {
    const url = `${this.endpoint.replace(/\/$/, '')}/inject`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          text: req.text,
          speaker: req.speaker ?? {},
          tier: req.tier ?? 'light',
          limit: req.limit ?? 5,
          orchestrate: req.orchestrate ?? false,
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
