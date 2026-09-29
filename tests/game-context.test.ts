import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { currentGame, gameContext } from '../src/game-context.ts';

const NOW = Date.parse('2026-09-30T21:10:00+08:00');
let cursor = 0;
function ev(source: string, type: string, text: string, ts = '2026-09-30T21:09:00+08:00'): EventEnvelope {
  cursor += 1;
  return { cursor, source, type, text, ts, origin: 'external' };
}

describe('game 字段', () => {
  it('我的世界：从近期事件读出时段、生命、饥饿、维度、生物群系、天气、今天死了几次、当前目标与附近的怪', () => {
    const events = [
      ev('minecraft', 'minecraft.world.snapshot',
        '[Minecraft] 我在河流，脚下是沙子，站在格 (3, 62, 9)，主世界。我站着没动，面朝北。\n现在是上午。\n'
        + '状态很好（生命 20/20），不饿（饥饿 19/20）。\n目标:#1 讨伐末影龙[类型:战斗;里程碑:0/4]', '2026-09-30T21:00:00+08:00'),
      ev('minecraft', 'minecraft.event', '[Minecraft] 你死了(今天第 2 次)。服务端记的死因:yushu drowned(淹死)。', '2026-09-30T21:05:00+08:00'),
      ev('minecraft', 'minecraft.event', '[Minecraft] 夜幕降临了,敌对生物会开始出现。', '2026-09-30T21:08:00+08:00'),
      ev('minecraft', 'minecraft.event', '[Minecraft] 我在掉血!少了 3 点,现在 6/20,溺尸就在 3 格外。'),
      ev('minecraft', 'minecraft.event', '[Minecraft] 苦力怕在北边 12 格。'),
      ev('bilibili', 'bilibili.danmaku', '[弹幕|阿木] 快跑'),
    ];
    const game = gameContext(events, NOW);
    expect(game).toEqual({
      id: 'minecraft',
      state: {
        time_of_day: 'night',
        health: 6,
        food: 19,
        dimension: 'overworld',
        weather: 'clear',
        deaths_today: 2,
        biome: '河流',
        goal: '讨伐末影龙',
      },
      keywords: ['夜晚', '河流', '苦力怕', '溺尸'],
    });
  });

  it('杀戮尖塔：最近一份完整状态里的幕、层、生命、金币、界面与敌人', () => {
    const events = [
      ev('sts-1', 'sts-1.state', '[StS 0123456789ab · 战斗 · 可操作]\n第1幕 · 第6层 · 生命 55/72 · 金币 120\n遗物：蛇之戒指：战斗开始时额外抽 2 张牌。\n敌人：\n敌0 地精大块头 · 80/82生命 · 0格挡 · 攻击 14×1'),
      ev('sts-1', 'sts-1.decision', '[StS] 战斗仍等待操作；沿用上一份状态 0123456789ab。'),
    ];
    expect(gameContext(events, NOW)).toEqual({
      id: 'sts',
      state: { screen: '战斗', act: 1, floor: 6, hp: 55, max_hp: 72, gold: 120, character: '静默猎手' },
      keywords: ['战斗', '静默猎手', '地精大块头'],
    });
  });

  it('只知道在玩什么时只发 id；十分钟没有游戏事件就不发', () => {
    expect(gameContext([ev('oni', 'oni.connected', '[缺氧] 已连接')], NOW)).toEqual({ id: 'oni' });
    expect(gameContext([ev('minecraft', 'minecraft.event', '[Minecraft] 醒了。', '2026-09-30T20:30:00+08:00')], NOW)).toBeNull();
    expect(gameContext([ev('bilibili', 'bilibili.danmaku', '[弹幕|阿木] 晚上好')], NOW)).toBeNull();
  });

  it('最近的游戏事件决定当前游戏；事件窗口里没有目标行时用同步跟踪到的目标', () => {
    const events = [
      ev('sts-1', 'sts-1.state', '[StS 0123456789ab · 地图 · 可操作]\n第1幕 · 第2层 · 生命 70/80 · 金币 99'),
      ev('minecraft', 'minecraft.event', '[Minecraft] 天亮了。'),
    ];
    expect(currentGame(events, NOW)).toBe('minecraft');
    expect(gameContext(events, NOW, { minecraftGoals: [{ slot: 1, text: '种一片小麦' }] })).toMatchObject({
      id: 'minecraft',
      state: { time_of_day: 'day', goal: '种一片小麦' },
    });
  });
});
