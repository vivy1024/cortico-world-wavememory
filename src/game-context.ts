/**
 * `/context/prepare` 的 game 字段：她此刻在玩哪个游戏、游戏里是什么情形。
 *
 * - 当前游戏看最近的游戏事件来自哪个 World（minecraft / sts-1 / oni）；最近一条也已经是
 *   ACTIVE_MS 之前的事，就当她没在玩，不发 game。
 * - state / keywords 从近期事件正文里能读出多少算多少，读不出的就不带；什么都读不出只发 id。
 */
import type { EventEnvelope } from 'cortico/core/types.ts';
import type { GameContextPayload } from './bridge.ts';
import { GAME_OF_SOURCE, parseMinecraftGoals, parseStsSnapshot, stsCharacterOf, type GameId, type McGoal } from './games.ts';

/** 最近一条游戏事件离现在超过这么久，就当她没在玩。 */
export const GAME_ACTIVE_MS = 10 * 60_000;
/** 关键词里的怪只看这么近的事件。 */
const MOB_WINDOW_MS = 2 * 60_000;
const MAX_KEYWORDS = 8;

const TIME_OF_DAY: Record<string, string> = {
  清晨: 'dawn', 黎明前: 'dawn', 上午: 'day', 正午前后: 'day', 下午: 'day', 黄昏: 'dusk', 深夜: 'night', 后半夜: 'night',
};
const TIME_WORD: Record<string, string> = { dawn: '清晨', day: '白天', dusk: '黄昏', night: '夜晚' };
const DIMENSIONS: Record<string, string> = { 主世界: 'overworld', 下界: 'nether', 末地: 'end' };

/** 我的世界 World 播报里会出现的敌对生物中文名（长名在前，避免「僵尸猪灵」先命中「僵尸」）。 */
const HOSTILE_MOBS = [
  '僵尸猪灵', '僵尸村民', '凋灵骷髅', '远古守卫者', '猪灵蛮兵', '洞穴蜘蛛', '末影龙', '末影人', '苦力怕',
  '僵尸', '骷髅', '蜘蛛', '溺尸', '女巫', '烈焰人', '恶魂', '猪灵', '凋灵', '幻翼', '守卫者', '掠夺者',
  '卫道士', '唤魔者', '劫掠兽', '史莱姆', '岩浆怪', '蠹虫', '尸壳', '流浪者', '疣猪兽', '潜影贝', '监守者',
  '沼骸', '旋风人', '恼鬼',
];

function tsMillis(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function pushKeyword(keywords: string[], word: string | undefined | null): void {
  const w = String(word ?? '').trim();
  if (w && w.length <= 12 && !keywords.includes(w) && keywords.length < MAX_KEYWORDS) keywords.push(w);
}

/** 最近在玩的游戏；没有或太久没动静时返回 null。events 按游标升序。 */
export function currentGame(events: readonly EventEnvelope[], now: number): GameId | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const game = GAME_OF_SOURCE[events[i].source];
    if (!game) continue;
    return now - tsMillis(events[i].ts) <= GAME_ACTIVE_MS ? game : null;
  }
  return null;
}

function minecraftContext(events: readonly EventEnvelope[], now: number, goals: readonly McGoal[] | null): GameContextPayload {
  const state: Record<string, string | number> = {};
  const keywords: string[] = [];
  const mobs: string[] = [];
  let biome: string | undefined;
  let lastDay = '';
  let windowGoals: McGoal[] | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.source !== 'minecraft') continue;
    const text = String(e.text ?? '');
    const day = e.ts.slice(0, 10);
    lastDay ||= day;
    const set = (key: string, value: string | number | undefined | null): void => {
      if (value !== undefined && value !== null && value !== '' && !(key in state)) state[key] = value;
    };
    const clock = /现在是(清晨|上午|正午前后|下午|黄昏|深夜|后半夜|黎明前)/.exec(text);
    if (clock) {
      set('time_of_day', TIME_OF_DAY[clock[1]]);
      if (!('weather' in state) && e.type === 'minecraft.world.snapshot') set('weather', /，在下雨/.test(text) ? 'rain' : 'clear');
    }
    if (/夜幕降临了/.test(text)) set('time_of_day', 'night');
    if (/\[Minecraft\] 天亮了/.test(text)) set('time_of_day', 'day');
    const health = /(?:生命(?:只剩)?\s*|现在\s*)(\d{1,2})\/20/.exec(text);
    if (health) set('health', Number(health[1]));
    const food = /饥饿 (\d{1,2})\/20/.exec(text);
    if (food) set('food', Number(food[1]));
    const dim = /(?:，|进入了)(主世界|下界|末地)。/.exec(text);
    if (dim) set('dimension', DIMENSIONS[dim[1]]);
    if (/打雷了/.test(text)) set('weather', 'thunder');
    else if (/开始下雨了/.test(text)) set('weather', 'rain');
    else if (/雨停了|雷停了/.test(text)) set('weather', 'clear');
    const where = /我在([^，,;。\s]{1,8})，脚下是/.exec(text) ?? /走进了([^，,;。\s]{1,8})/.exec(text);
    if (where && !where[1].includes('地方')) biome ??= where[1];
    const death = /你死了\(今天第 (\d+) 次\)/.exec(text);
    if (death && day === lastDay) set('deaths_today', Number(death[1]));
    if (windowGoals === null && e.type === 'minecraft.world.snapshot') windowGoals = parseMinecraftGoals(text);
    if (now - tsMillis(e.ts) <= MOB_WINDOW_MS && (e.type === 'minecraft.event' || e.type === 'minecraft.task')) {
      for (const mob of HOSTILE_MOBS) {
        if (text.includes(mob) && !mobs.includes(mob) && !mobs.some((m) => m.includes(mob))) mobs.push(mob);
      }
    }
  }
  if (biome) state.biome = biome;
  const goal = (windowGoals ?? goals)?.[0]?.text;
  if (goal) state.goal = goal.slice(0, 30);
  pushKeyword(keywords, TIME_WORD[String(state.time_of_day ?? '')]);
  if (state.dimension === 'nether') pushKeyword(keywords, '下界');
  if (state.dimension === 'end') pushKeyword(keywords, '末地');
  pushKeyword(keywords, biome);
  if (state.weather === 'rain') pushKeyword(keywords, '下雨');
  if (state.weather === 'thunder') pushKeyword(keywords, '雷暴');
  for (const mob of mobs) pushKeyword(keywords, mob);
  return { id: 'minecraft', ...(Object.keys(state).length ? { state } : {}), ...(keywords.length ? { keywords } : {}) };
}

function stsContext(events: readonly EventEnvelope[], character: string | null): GameContextPayload {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.source !== 'sts-1') continue;
    const facts = parseStsSnapshot(String(e.text ?? ''));
    if (!facts) continue;
    const state: Record<string, string | number> = { screen: facts.screen };
    if (facts.act !== null) state.act = facts.act;
    if (facts.floor !== null) state.floor = facts.floor;
    if (facts.hp !== null) state.hp = facts.hp;
    if (facts.maxHp !== null) state.max_hp = facts.maxHp;
    if (facts.gold !== null) state.gold = facts.gold;
    const who = character ?? stsCharacterOf(facts.relics);
    if (who) state.character = who;
    if (facts.boss) state.boss = facts.boss;
    const keywords: string[] = [];
    pushKeyword(keywords, facts.screen);
    pushKeyword(keywords, who);
    for (const enemy of facts.enemies) pushKeyword(keywords, enemy);
    pushKeyword(keywords, facts.boss);
    return { id: 'sts', state, ...(keywords.length ? { keywords } : {}) };
  }
  return { id: 'sts' };
}

export interface GameContextHints {
  /** 同步跟踪到的我的世界目标表（事件窗口里没有目标行时用它） */
  minecraftGoals?: readonly McGoal[] | null;
  /** 同步跟踪到的杀戮尖塔角色 */
  stsCharacter?: string | null;
}

/** 组装 game 字段；没在玩游戏返回 null。 */
export function gameContext(events: readonly EventEnvelope[], now: number, hints: GameContextHints = {}): GameContextPayload | null {
  const game = currentGame(events, now);
  if (game === 'minecraft') return minecraftContext(events, now, hints.minecraftGoals ?? null);
  if (game === 'sts') return stsContext(events, hints.stsCharacter ?? null);
  if (game === 'oni') return { id: 'oni' };
  return null;
}
