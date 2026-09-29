import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CallLedger, captureOf, captureTap, spokenText } from '../src/speech.ts';

describe('spokenText：只留观众听得到的字', () => {
  it('去掉【】动作块、<> 行内标签、[] 语气词与 <<impression>> 标记', () => {
    const script = '【挥手,微笑】<看向屏幕>各位晚上好！[laughing]今天先去挖铁<<impression: 阿木 很热心>>，[breath]走起～';
    expect(spokenText(script)).toBe('各位晚上好！今天先去挖铁，走起～');
  });

  it('全角尖括号、表外方括号、多余空白也去掉；正文里的「3<5」不误删', () => {
    expect(spokenText('＜惊讶＞哇 [自造标签]  真的\n假的')).toBe('哇 真的 假的');
    expect(spokenText('血量 3<5 了，快跑')).toBe('血量 3<5 了，快跑');
  });

  it('只有标签时为空串', () => {
    expect(spokenText('【鞠躬】<看向屏幕>[sigh]')).toBe('');
  });
});

describe('captureOf：值得记的工具调用', () => {
  it('vtuber_act 记台本，mc_goal 记 done/drop 与槽位，其他工具与坏参数不记', () => {
    expect(captureOf({ name: 'vtuber_act', call_id: 'c1', arguments: '{"script":"<点头>好"}' }, 1000))
      .toEqual({ callId: 'c1', tool: 'vtuber_act', at: 1000, script: '<点头>好' });
    expect(captureOf({ name: 'mc_goal', call_id: 'c2', arguments: '{"done":2}' }, 5))
      .toEqual({ callId: 'c2', tool: 'mc_goal', at: 5, goal: { op: 'done', slot: 2 } });
    expect(captureOf({ name: 'mc_goal', call_id: 'c3', arguments: '{"add":{"text":"盖房子"}}' }, 5)).toBeNull();
    expect(captureOf({ name: 'mc_do', call_id: 'c4', arguments: '{"steps":[]}' }, 5)).toBeNull();
    expect(captureOf({ name: 'vtuber_act', call_id: 'c5', arguments: '{"script":' }, 5)).toBeNull();
    expect(captureOf({ name: 'vtuber_act', call_id: '', arguments: '{"script":"x"}' }, 5)).toBeNull();
  });
});

describe('CallLedger 与输出旁路', () => {
  it('只在调用完整闭合时记一笔；落盘后重启能读回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-calls-'));
    const file = join(dir, 'calls.json');
    let now = 1_000_000;
    const ledger = new CallLedger({ file, now: () => now });
    const tap = captureTap(ledger, () => now);
    const item = { type: 'function_call', name: 'vtuber_act', call_id: 'call_1', arguments: '{"script":"开播啦"}' };
    tap.onEvent({ type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } } as never);
    tap.onEvent({ type: 'response.output_item.done', sequence_number: 2, output_index: 0, item: { ...item, status: 'incomplete' } } as never);
    expect(ledger.size).toBe(0);
    tap.onEvent({ type: 'response.output_item.done', sequence_number: 3, output_index: 0, item: { ...item, status: 'completed' } } as never);
    expect(ledger.get('call_1')?.script).toBe('开播啦');
    expect(tap.externalizes?.({ type: 'response.output_item.added' } as never)).toBe(false);

    now += 1000;
    const reloaded = new CallLedger({ file, now: () => now });
    expect(reloaded.get('call_1')).toMatchObject({ script: '开播啦', at: 1_000_000 });
  });

  it('按保质期与上限淘汰，goalOps 按时间窗取指令', () => {
    const now = 10 * 60 * 60_000;
    const ledger = new CallLedger({ now: () => now, ttlMs: 60 * 60_000, max: 16 });
    ledger.record({ callId: 'old', tool: 'mc_goal', at: now - 2 * 60 * 60_000, goal: { op: 'done', slot: 1 } });
    ledger.record({ callId: 'g1', tool: 'mc_goal', at: now - 1000, goal: { op: 'drop', slot: 1 } });
    ledger.record({ callId: 'g2', tool: 'mc_goal', at: now, goal: { op: 'done', slot: 2 } });
    expect(ledger.get('old')).toBeUndefined();
    expect(ledger.goalOps(now - 5000, now).map((c) => c.callId)).toEqual(['g1', 'g2']);
    for (let i = 0; i < 40; i++) ledger.record({ callId: `s${i}`, tool: 'vtuber_act', at: now, script: 'x' });
    expect(ledger.size).toBe(16);
    expect(ledger.get('s39')).toBeDefined();
  });
});
