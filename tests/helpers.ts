import type {
  DeferredEventSpec,
  EventEnvelope,
  EventRangeQuery,
  EventStoreReader,
  TriggerMode,
  WorldHost,
} from 'cortico/core/types.ts';
import type { FetchLike } from '../src/bridge.ts';

/** 事件库替身：按 EventRangeQuery 的语义（含端点、limit 从尾部取）过滤。 */
export class FakeStore implements EventStoreReader {
  constructor(public events: EventEnvelope[] = []) {}
  get(cursor: number) { return this.events.find((e) => e.cursor === cursor); }
  latestCursor() { return this.events.at(-1)?.cursor ?? 0; }
  range(q: EventRangeQuery) {
    let matched = this.events.filter((e) =>
      (q.fromCursor === undefined || e.cursor >= q.fromCursor)
      && (q.toCursor === undefined || e.cursor <= q.toCursor)
      && (q.origin === undefined || e.origin === q.origin)
      && (q.source === undefined || e.source === q.source)
      && (q.senderKey === undefined || e.senderKey === q.senderKey));
    if (q.limit !== undefined && matched.length > q.limit) matched = matched.slice(matched.length - q.limit);
    return matched;
  }
  around() { return []; }
  grep() { return []; }
  push(partial: Partial<EventEnvelope> & { type: string; source: string }): EventEnvelope {
    const env: EventEnvelope = {
      cursor: this.latestCursor() + 1,
      ts: '2026-09-30T20:00:00+08:00',
      origin: 'external',
      text: '',
      ...partial,
    };
    this.events.push(env);
    return env;
  }
}

export type DeferredPush = {
  spec: Pick<DeferredEventSpec, 'type' | 'senderKey' | 'meta' | 'tags' | 'render'> & { origin?: string };
  opts?: { trigger?: TriggerMode };
};

export class FakeHost implements WorldHost {
  deferred: DeferredPush[] = [];
  warnings: string[] = [];
  store = new FakeStore();
  pushDeferred(spec: DeferredPush['spec'], opts?: { trigger?: TriggerMode }): void {
    this.deferred.push({ spec, opts });
  }
  async pushEvent(e: Omit<EventEnvelope, 'cursor'>): Promise<EventEnvelope> {
    const full = { ...e, cursor: this.store.latestCursor() + 1 } as EventEnvelope;
    this.store.events.push(full);
    return full;
  }
  async drainPendingEvents() { return []; }
  blob() { return null; }
  modelFacts = { model: () => 'test', accepts: () => false, contextWindow: () => 128000 };
  log = (() => {
    const warnings = this.warnings;
    const log = {
      child() { return log; },
      info() {}, error() {}, debug() {}, trace() {}, emit() {},
      warn(msg: string) { warnings.push(String(msg)); },
    };
    return log as unknown as WorldHost['log'];
  })();
  reportUsage(): void {}
}

/** fetch 替身：记下每次请求的 url、请求头和 JSON 体。 */
export function recordingFetch(
  handler: (url: string, body: any) => unknown,
  seen: Array<{ url: string; headers: Record<string, string>; body: any }> = [],
): FetchLike {
  return async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    seen.push({ url, headers: init?.headers ?? {}, body });
    const value = handler(url, body);
    if (value instanceof Error) throw value;
    return { ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) };
  };
}
