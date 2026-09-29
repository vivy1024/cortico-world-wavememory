import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { GameTracker, emptyGameState, parseMinecraftGoals, parseStsSnapshot, restoreGameState } from '../src/games.ts';
import { CallLedger } from '../src/speech.ts';

let cursor = 0;
function ev(source: string, type: string, text: string, ts = '2026-09-30T21:00:00+08:00'): EventEnvelope {
  cursor += 1;
  return { cursor, source, type, text, ts, origin: 'external' };
}
const mc = (text: string, ts?: string) => ev('minecraft', 'minecraft.event', `[Minecraft] ${text}`, ts);
const snapshot = (goalLine: string, ts?: string) =>
  ev('minecraft', 'minecraft.world.snapshot', `[Minecraft] 我在平原，脚下是草方块，站在格 (1, 70, 2)，主世界。我站着没动，面朝北。\n${goalLine}`, ts);

describe('我的世界：只挑有意义的事件', () => {
  it('死亡写成一句带死因与死亡点的经历', () => {
    const tracker = new GameTracker();
    const out = tracker.map(mc(
      '你死了(今天第 3 次)。服务端记的死因:yushu was slain by Drowned(被打死)。'
      + '死亡点在 [主世界] (12, 62, -40),离「河边小屋」6 格。会回重生点 [主世界] (10, 64, -30) 重生,离死亡点 10 格。掉的东西留在死亡点,5 分钟后消失。',
    ));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      game: 'minecraft',
      event_type: 'death',
      content: '[我的世界] 今天第 3 次死亡：被打死（yushu was slain by Drowned），死在主世界 (12, 62, -40)，离「河边小屋」6 格',
    });
    expect(out[0].event_id).toMatch(/^cortico:\d+$/);
    expect(out[0].timestamp).toBe(Date.parse('2026-09-30T21:00:00+08:00') / 1000);
  });

  it('没抓到死因时照样记', () => {
    const [death] = new GameTracker().map(mc('你死了(今天第 1 次)。会在出生点重生。掉的东西留在死亡点,5 分钟后消失。'));
    expect(death.content).toBe('[我的世界] 今天第 1 次死亡：死因没看清');
  });

  it('进入下界/末地、Boss 战、驯服、稀有物品各记一次；回主世界不记', () => {
    const tracker = new GameTracker();
    const all = [
      mc('从主世界进入了下界。'),
      mc('从下界进入了主世界。'),
      mc('从主世界进入了下界。'),
      mc('出现了 Boss 血条:末影龙。'),
      mc('末影龙 血量剩 50%。'),
      mc('末影龙 血量剩 25%。'),
      mc('末影龙 的血条消失了(打完了或脱离)。'),
      mc('驯服了狼!'),
      ev('minecraft', 'minecraft.world', '[Minecraft] 往北走了 12 格,现在在 (1, 64, 2);包里多了 钻石×2(共 2)、圆石×3(共 40)'),
      ev('minecraft', 'minecraft.world', '[Minecraft] 包里多了 钻石×1(共 3)'),
    ].flatMap((e) => tracker.map(e));
    expect(all.map((d) => [d.event_type, d.content])).toEqual([
      ['discovery', '[我的世界] 从主世界进入了下界'],
      ['discovery', '[我的世界] 遇上了 Boss：末影龙'],
      ['milestone', '[我的世界] 与 末影龙 的 Boss 战结束：血条消失，最后一次看到它还剩 25%'],
      ['milestone', '[我的世界] 驯服了狼'],
      ['discovery', '[我的世界] 拿到了钻石×2'],
    ]);
  });

  it('不刷屏：走路、背包零碎、怪物进出、濒死、任务回执、服务器消息都不写', () => {
    const tracker = new GameTracker();
    const noise = [
      mc('有只僵尸打过来了,我抄家伙还手!(生命 20/20,手边没趁手的家伙)'),
      mc('僵尸走远了。'),
      mc('濒死!生命只剩 5/20。'),
      mc('夜幕降临了,敌对生物会开始出现。'),
      mc('升到 5 级了。'),
      mc('Steve was slain by Zombie'),
      ev('minecraft', 'minecraft.world', '[Minecraft] 往东走了 20 格,现在在 (21, 64, 2);走进了河流'),
      ev('minecraft', 'minecraft.world', '[Minecraft] 包里多了 圆石×5(共 7)'),
      ev('minecraft', 'minecraft.task', '[执行器] [21:00:01→21:00:05 共 4s] 任务#3完成: {"skill":"goto","at":[1,64,2]}: 到了 (1, 64, 2)'),
      ev('minecraft', 'minecraft.chat', '[MC] Server: Set own game mode to Survival Mode'),
    ];
    expect(noise.flatMap((e) => tracker.map(e))).toEqual([]);
  });

  it('当天去重跨日重置', () => {
    const tracker = new GameTracker();
    expect(tracker.map(mc('从主世界进入了末地。', '2026-09-30T23:00:00+08:00'))).toHaveLength(1);
    expect(tracker.map(mc('从主世界进入了末地。', '2026-09-30T23:30:00+08:00'))).toHaveLength(0);
    expect(tracker.map(mc('从主世界进入了末地。', '2026-10-01T09:00:00+08:00'))).toHaveLength(1);
  });

  it('目标：第一次见到目标行只作基线；新出现的是立下目标；下过 mc_goal done 的消失才算完成', () => {
    const t0 = Date.parse('2026-09-30T21:00:00+08:00');
    const ledger = new CallLedger({ now: () => t0 + 60_000 });
    const tracker = new GameTracker(undefined, { calls: ledger });
    expect(tracker.map(snapshot('目标:#1 砍树做工具[类型:建造;里程碑:0/2;下一步:砍树]', '2026-09-30T21:00:00+08:00'))).toEqual([]);

    const added = tracker.map(snapshot('目标:#1 砍树做工具[类型:建造;里程碑:1/2] · #2 猎羊做床[里程碑:0/3]', '2026-09-30T21:00:20+08:00'));
    expect(added.map((d) => d.content)).toEqual(['[我的世界] 立下目标：猎羊做床']);
    expect(added[0]).toMatchObject({ event_type: 'goal' });

    // #1 做完（下过 done），#2 撤掉（drop）：只有 #1 算完成。
    ledger.record({ callId: 'c1', tool: 'mc_goal', at: t0 + 30_000, goal: { op: 'done', slot: 1 } });
    ledger.record({ callId: 'c2', tool: 'mc_goal', at: t0 + 31_000, goal: { op: 'drop', slot: 2 } });
    const closed = tracker.map(snapshot('目标:0 条(5 格全空,用 mc_goal 挂)', '2026-09-30T21:00:40+08:00'));
    expect(closed.map((d) => d.content)).toEqual(['[我的世界] 完成了目标：砍树做工具']);

    // 同一天重新挂上同一条目标不重复记。
    expect(tracker.map(snapshot('目标:#1 猎羊做床[里程碑:0/3]', '2026-09-30T21:01:00+08:00'))).toEqual([]);
  });

  it('重启清空暂态目标表（没有 done 指令）不算完成', () => {
    const tracker = new GameTracker(undefined, { calls: new CallLedger() });
    tracker.map(snapshot('目标:#1 讨伐末影龙[里程碑:0/4]'));
    expect(tracker.map(snapshot('目标:0 条(5 格全空,用 mc_goal 挂)'))).toEqual([]);
  });

  it('parseMinecraftGoals：没有目标行返回 null', () => {
    expect(parseMinecraftGoals('[Minecraft] 包里变的：圆石×9')).toBeNull();
    expect(parseMinecraftGoals('[Minecraft] 目标:#2 挖到钻石(蓝图 house:待装载) · #3 建农田[里程碑:0/1]'))
      .toEqual([{ slot: 2, text: '挖到钻石(蓝图 house:待装载)' }, { slot: 3, text: '建农田' }]);
  });
});

const sts = (body: string, screen = '战斗', type = 'sts-1.state') =>
  ev('sts-1', type, `[StS 0123456789ab · ${screen} · 可操作]\n${body}`);

describe('杀戮尖塔：开局、遗物、进幕、胜负', () => {
  it('完整一局：开局认出角色，新遗物是关键选择，进第二幕记里程碑，倒下记死亡', () => {
    const tracker = new GameTracker();
    const out = [
      sts('操作：\n1 铁甲战士 · 进阶 0', '主菜单'),
      sts('第1幕 · 第0层 · 生命 75/75 · 金币 99\n遗物：破损核心：在每场战斗开始时， 生成 1 个 闪电 充能球。\n药水：无 · 3空槽\n涅奥', '事件'),
      sts('第1幕 · 第0层 · 生命 75/75 · 金币 99\n遗物：破损核心：在每场战斗开始时， 生成 1 个 闪电 充能球。\n药水：无', '事件', 'sts-1.decision'),
      sts('第1幕 · 第3层 · 生命 60/75 · 金币 140\n遗物：破损核心：在每场战斗开始时， 生成 1 个 闪电 充能球。；钢笔尖(4)：每打出 10 张攻击牌，下一张伤害翻倍。\n敌人：\n敌0 大颚虫 · 30/40生命 · 0格挡 · 攻击 11×1'),
      sts('第2幕 · 第17层 · 生命 50/80 · 金币 200\n遗物：破损核心：在每场战斗开始时， 生成 1 个 闪电 充能球。；钢笔尖(4)：每打出 10 张攻击牌，下一张伤害翻倍。', '地图'),
      ev('sts-1', 'sts-1.decision', '[StS] 战斗仍等待操作；沿用上一份状态 0123456789ab。'),
      sts('第2幕 · 第23层 · 生命 0/80 · 金币 210\n遗物：破损核心：在每场战斗开始时。；钢笔尖(4)：每打出 10 张攻击牌。\n游戏结束 · 得分 312', '游戏结束'),
      sts('第2幕 · 第23层 · 生命 0/80 · 金币 210\n游戏结束 · 得分 312', '结算'),
    ].flatMap((e) => tracker.map(e));
    expect(out.map((d) => [d.game, d.event_type, d.content])).toEqual([
      ['sts', 'milestone', '[杀戮尖塔] 开了新的一局（故障机器人）'],
      ['sts', 'choice', '[杀戮尖塔] 第 1 幕第 3 层拿到遗物「钢笔尖」'],
      ['sts', 'milestone', '[杀戮尖塔] 打进了第 2 幕，生命 50/80'],
      ['sts', 'death', '[杀戮尖塔] 这一局（故障机器人）在第 2 幕第 23 层倒下了，得分 312'],
    ]);
  });

  it('通关胜利记里程碑；中途接上的一局只作基线', () => {
    const tracker = new GameTracker();
    expect(tracker.map(sts('第3幕 · 第40层 · 生命 60/80 · 金币 50\n遗物：燃烧之血：战斗结束时回复 6 点生命。'))).toEqual([]);
    const win = tracker.map(sts('第3幕 · 第51层 · 生命 20/80 · 金币 80\n胜利 · 得分 999', '胜利'));
    expect(win.map((d) => d.content)).toEqual(['[杀戮尖塔] 通关胜利（铁甲战士），得分 999']);
  });

  it('parseStsSnapshot 读出界面、层数、敌人与首领', () => {
    const facts = parseStsSnapshot('[StS abcdefabcdef · 战斗 · 可操作]\n第1幕 · 第5层 · 生命 70/80 · 金币 120\n遗物：无\n敌人：\n敌0 奴隶贩子（蓝衣） · 40/46生命 · 0格挡 · 攻击 12×1\n敌1 小史莱姆 · 8/8生命 · 0格挡 · 攻击 3×1\n首领：六火亡魂');
    expect(facts).toMatchObject({ screen: '战斗', act: 1, floor: 5, hp: 70, maxHp: 80, gold: 120, relics: [], enemies: ['奴隶贩子', '小史莱姆'], boss: '六火亡魂' });
    expect(parseStsSnapshot('[StS] 地图仍等待操作；沿用上一份状态 abcdefabcdef。')).toBeNull();
  });
});

describe('缺氧与状态落盘', () => {
  it('只记严重警报，同一警报当天一次', () => {
    const tracker = new GameTracker();
    const crit = ev('oni', 'oni.alert.critical', '【缺氧警报】复制人 阿布 窒息倒下了');
    expect(tracker.map(crit)).toMatchObject([{ game: 'oni', event_type: 'crisis', content: '[缺氧] 严重警报：复制人 阿布 窒息倒下了' }]);
    expect(tracker.map(ev('oni', 'oni.alert.critical', '【缺氧警报】复制人 阿布 窒息倒下了'))).toEqual([]);
    expect(tracker.map(ev('oni', 'oni.alert.warning', '【缺氧警报】食物不足'))).toEqual([]);
  });

  it('snapshot/restore 往返；坏数据回到初值', () => {
    const tracker = new GameTracker();
    tracker.map(mc('出现了 Boss 血条:凋灵。'));
    const saved = JSON.parse(JSON.stringify(tracker.snapshot()));
    expect(restoreGameState(saved)).toEqual(tracker.snapshot());
    expect(restoreGameState({ mc: { goals: 'x' }, sts: 5 })).toEqual(emptyGameState());
  });
});
