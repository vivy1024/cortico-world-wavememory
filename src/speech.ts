/**
 * 羽书在直播里真正说出口的话，以及同步要用到的几类工具调用。
 *
 * 事件库里没有完整台本：vtuber World 只记播放终态（`vtuber.playback.finished`，
 * meta.playback = { callId, state: completed | interrupted | failed }）和被打断时已播出的部分
 * （`vtuber.act.outcome`，meta.outcomes[].script）。台本本身是 `vtuber_act` 的工具参数，
 * 只出现在主 session 的输出流里。这里经 World 的输出旁路（outputTap）按 call_id 记下台本，
 * 同步时与播放终态对上号：播完的写整段，被打断的写已播出部分，失败的不写。
 *
 * `mc_goal` 的 done / drop 也在这里记：目标表只在世界快照里出现，快照看不出一条目标是
 * 做完了还是撤掉了，要靠她当时下的指令区分。
 *
 * 记录落在 dataDir，重启后仍能与重启前开演、重启后才同步到的播放终态对上。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OutputTap } from 'cortico/core/types.ts';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';

export const SPEECH_TOOL = 'vtuber_act';
export const GOAL_TOOL = 'mc_goal';

/**
 * 台本里观众听不到的部分全部去掉：【】动作块、<> 行内标签（含全角）、<<impression:…>> 印象标记、
 * [] 语气词（表内的是笑声/换气等非语言发声，表外的 vtuber 解析器本就静默剥离）。
 * 行内标签的长度与不跨行限制跟 vtuber 解析器一致，正文里的「3<5」不会被误删。
 */
export function spokenText(script: string): string {
  if (!script) return '';
  return script
    .replace(/<<[\s\S]*?>>/g, '')
    .replace(/【[^】【]*】/g, '')
    .replace(/<[^>\n]{0,32}>/g, '')
    .replace(/＜[^＞\n]{0,32}＞/g, '')
    .replace(/\[[^\]\n]{0,32}\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface CapturedCall {
  callId: string;
  tool: string;
  /** 调用在输出流里闭合的时刻（毫秒） */
  at: number;
  /** vtuber_act 的原始台本 */
  script?: string;
  /** mc_goal 的 done / drop 与槽位号 */
  goal?: { op: 'done' | 'drop'; slot: number };
}

export interface CallLedgerOptions {
  /** 落盘位置；缺省只在内存里 */
  file?: string;
  max?: number;
  ttlMs?: number;
  now?: () => number;
  log?: { warn(msg: string): void };
}

const DEFAULT_MAX = 400;
const DEFAULT_TTL_MS = 12 * 60 * 60_000;

function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** 一次已闭合的工具调用里值得记的部分；不关心的工具或参数不完整时返回 null。 */
export function captureOf(item: { name?: string; call_id?: string; arguments?: string }, at: number): CapturedCall | null {
  const callId = String(item.call_id ?? '').trim();
  if (!callId) return null;
  const args = parseArgs(item.arguments);
  if (!args) return null;
  if (item.name === SPEECH_TOOL) {
    const script = typeof args.script === 'string' ? args.script : '';
    return script.trim() ? { callId, tool: SPEECH_TOOL, at, script } : null;
  }
  if (item.name === GOAL_TOOL) {
    for (const op of ['done', 'drop'] as const) {
      const slot = args[op];
      if (typeof slot === 'number' && Number.isInteger(slot) && slot > 0) return { callId, tool: GOAL_TOOL, at, goal: { op, slot } };
    }
  }
  return null;
}

/** 按 call_id 记下的工具调用；有上限、有保质期，落盘在 dataDir。 */
export class CallLedger {
  private readonly calls = new Map<string, CapturedCall>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: CallLedgerOptions = {}) {
    this.max = Math.max(16, opts.max ?? DEFAULT_MAX);
    this.ttlMs = Math.max(60_000, opts.ttlMs ?? DEFAULT_TTL_MS);
    this.now = opts.now ?? Date.now;
    this.load();
  }

  get size(): number {
    return this.calls.size;
  }

  record(call: CapturedCall): void {
    this.calls.delete(call.callId);
    this.calls.set(call.callId, call);
    this.prune();
    this.save();
  }

  get(callId: string | null | undefined): CapturedCall | undefined {
    return callId ? this.calls.get(callId) : undefined;
  }

  /** [from, to] 毫秒区间里下达的 mc_goal done / drop，按时间先后。 */
  goalOps(from: number, to: number): CapturedCall[] {
    return [...this.calls.values()]
      .filter((call) => call.goal && call.at >= from && call.at <= to)
      .sort((a, b) => a.at - b.at);
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, call] of this.calls) {
      if (call.at < cutoff) this.calls.delete(id);
    }
    while (this.calls.size > this.max) {
      const oldest = this.calls.keys().next().value;
      if (oldest === undefined) break;
      this.calls.delete(oldest);
    }
  }

  private load(): void {
    const file = this.opts.file;
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { calls?: CapturedCall[] };
      for (const call of saved.calls ?? []) {
        if (call && typeof call.callId === 'string' && typeof call.at === 'number') this.calls.set(call.callId, call);
      }
      this.prune();
    } catch {
      // 第一次运行或文件损坏：从空开始。
    }
  }

  private save(): void {
    const file = this.opts.file;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ calls: [...this.calls.values()] }));
      renameSync(tmp, file);
    } catch (err) {
      this.opts.log?.warn(`[wavememory] 口播记录写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * 主 session 输出流的旁路接收器：只在工具调用完整闭合（status=completed）时记一笔。
 * 不产生对外输出，externalizes 恒为 false，不影响主循环的抢占判断。
 */
export function captureTap(ledger: CallLedger, now: () => number = Date.now): OutputTap {
  return {
    onEvent: (event: StreamEvent) => {
      if (event.type !== 'response.output_item.done') return;
      const item = event.item as { type?: string; status?: string; name?: string; call_id?: string; arguments?: string } | null;
      if (!item || item.type !== 'function_call' || item.status !== 'completed') return;
      const call = captureOf(item, now());
      if (call) ledger.record(call);
    },
    externalizes: () => false,
  };
}
