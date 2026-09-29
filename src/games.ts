/**
 * 把 Cortico 事件库里的游戏事件翻成羽书自己的游戏经历（WaveMemory 的 game_event）。
 *
 * 只挑有意义的：死亡、立下/完成目标、进入新维度、Boss 战、驯服、拿到稀有物品（我的世界）；
 * 开局、拿到遗物、进入新的一幕、对局胜负（杀戮尖塔）；严重警报（缺氧）。走路、挖方块、
 * 背包零碎变化、每一步任务回执都不写。
 *
 * 这些 World 的事件没有结构化 meta，全靠正文；正文格式以 Cortico 与各 World 当前源码为准
 * （minecraft/world.ts、minecraft/terrain.ts、cortico-world-sts-1 render.ts、cortico-world-oni）。
 *
 * 状态（目标表、Boss 血量、杀戮尖塔当前一局、当天去重键）随同步游标一起落盘，
 * 离线重放同一段事件得到同样的条目与同样的 event_id。
 */
import type { EventEnvelope } from 'cortico/core/types.ts';
import type { CallLedger } from './speech.ts';

export type GameId = 'minecraft' | 'sts' | 'oni';

export const GAME_LABELS: Record<GameId, string> = { minecraft: '我的世界', sts: '杀戮尖塔', oni: '缺氧' };

/** 事件来源（World id）→ 游戏标识 */
export const GAME_OF_SOURCE: Record<string, GameId> = { minecraft: 'minecraft', 'sts-1': 'sts', oni: 'oni' };

export interface GameEventDraft {
  event_id: string;
  game: GameId;
  event_type: 'death' | 'goal' | 'discovery' | 'milestone' | 'choice' | 'crisis';
  content: string;
  /** 秒 */
  timestamp: number;
}

export interface McGoal {
  slot: number;
  text: string;
}

export interface GameTrackerState {
  /** 当天去重键所属日期（事件时间戳里的本地日期） */
  day: string;
  seen: string[];
  mc: {
    /** 上一次看到的目标表；null = 还没见过目标行 */
    goals: McGoal[] | null;
    /** 上一次看到目标行的时刻（毫秒） */
    goalsAt: number;
    /** 正在打的 Boss → 最近一次看到的血量百分比 */
    bosses: Record<string, number>;
  };
  sts: {
    act: number | null;
    floor: number | null;
    relics: string[] | null;
    ended: boolean;
    character: string | null;
  };
}

export function emptyGameState(): GameTrackerState {
  return {
    day: '',
    seen: [],
    mc: { goals: null, goalsAt: 0, bosses: {} },
    sts: { act: null, floor: null, relics: null, ended: false, character: null },
  };
}

/** 读回落盘的状态；字段缺失或类型不对的一律回到初值。 */
export function restoreGameState(raw: unknown): GameTrackerState {
  const base = emptyGameState();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<GameTrackerState>;
  if (typeof r.day === 'string') base.day = r.day;
  if (Array.isArray(r.seen)) base.seen = r.seen.filter((k): k is string => typeof k === 'string');
  if (r.mc && typeof r.mc === 'object') {
    if (Array.isArray(r.mc.goals)) {
      base.mc.goals = r.mc.goals.filter((g): g is McGoal => !!g && typeof g.slot === 'number' && typeof g.text === 'string');
    }
    if (typeof r.mc.goalsAt === 'number') base.mc.goalsAt = r.mc.goalsAt;
    if (r.mc.bosses && typeof r.mc.bosses === 'object') {
      for (const [title, pct] of Object.entries(r.mc.bosses)) if (typeof pct === 'number') base.mc.bosses[title] = pct;
    }
  }
  if (r.sts && typeof r.sts === 'object') {
    const s = r.sts;
    base.sts.act = typeof s.act === 'number' ? s.act : null;
    base.sts.floor = typeof s.floor === 'number' ? s.floor : null;
    base.sts.relics = Array.isArray(s.relics) ? s.relics.filter((x): x is string => typeof x === 'string') : null;
    base.sts.ended = s.ended === true;
    base.sts.character = typeof s.character === 'string' ? s.character : null;
  }
  return base;
}

function tsSeconds(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : Date.now() / 1000;
}

function tsMillis(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Date.now();
}

/** 事件时间戳自带部署时区偏移，前 10 位就是当地日期。 */
function localDay(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : '';
}

function stripMinecraftPrefix(text: string): string {
  return text.replace(/^\[Minecraft\]\s*/, '');
}

// ─── 我的世界 ────────────────────────────────────────────────────────────────

const DEATH_RE = /^你死了\(今天第 (\d+) 次\)。/;
const DEATH_CAUSE_RE = /服务端记的死因:([^。]+)。/;
const DEATH_POINT_RE = /死亡点在 \[([^\]]+)\] \((-?\d+), (-?\d+), (-?\d+)\)(?:,(离「[^」]+」\s*\d+\s*格))?/;
const DIMENSION_RE = /^从(.+?)进入了(.+?)。$/;
const BOSS_APPEAR_RE = /^出现了 Boss 血条:(.+?)。$/;
const BOSS_HEALTH_RE = /^(.+?) 血量剩 (\d+)%。$/;
const BOSS_GONE_RE = /^(.+?) 的血条消失了/;
const TAMED_RE = /^驯服了(.+?)!$/;
const GAINED_RE = /包里多了 (.+?)(?:,少了|;|$)/m;
const STACK_RE = /^(.+?)×(\d+)(?:\(共 (\d+)\))?$/;

/** 拿到就值得记一笔的物品（我的世界 World 的中文物品名）。 */
const NOTABLE_ITEMS = new Set([
  '钻石', '远古残骸', '下界合金锭', '末影珍珠', '烈焰棒', '末影之眼', '鞘翅', '龙蛋',
  '下界之星', '不死图腾', '信标', '三叉戟', '附魔金苹果', '潜影壳', '海洋之心',
]);

export function parseMinecraftGoals(text: string): McGoal[] | null {
  const line = stripMinecraftPrefix(text).split('\n').find((l) => l.startsWith('目标:'));
  if (line === undefined) return null;
  const body = line.slice('目标:'.length).trim();
  if (/^0 条/.test(body)) return [];
  const goals: McGoal[] = [];
  for (const part of body.split(' · ')) {
    const m = /^#(\d+) (.+?)\[/.exec(part) ?? /^#(\d+) (.+)$/.exec(part);
    if (m) goals.push({ slot: Number(m[1]), text: m[2].trim() });
  }
  return goals;
}

function deathContent(body: string): string | null {
  const death = DEATH_RE.exec(body);
  if (!death) return null;
  const causeRaw = DEATH_CAUSE_RE.exec(body)?.[1]?.trim() ?? '';
  const gloss = /\(([^()]+)\)$/.exec(causeRaw)?.[1] ?? '';
  const causeText = gloss ? causeRaw.slice(0, causeRaw.length - gloss.length - 2).trim() : causeRaw;
  const cause = causeText ? (gloss ? `${gloss}（${causeText}）` : causeText) : '死因没看清';
  const point = DEATH_POINT_RE.exec(body);
  const where = point ? `，死在${point[1]} (${point[2]}, ${point[3]}, ${point[4]})${point[5] ? `，${point[5]}` : ''}` : '';
  return `[我的世界] 今天第 ${death[1]} 次死亡：${cause}${where}`;
}

// ─── 杀戮尖塔 ────────────────────────────────────────────────────────────────

const STS_HEADER_RE = /^\[StS [0-9a-f]{6,} · ([^·\]]+?) · /;
const STS_RUN_RE = /^第(\d+)幕 · 第(\d+)层 · 生命 (\d+)\/(\d+) · 金币 (\d+)/m;
const STS_RESULT_RE = /^(胜利|游戏结束) · 得分 (\S+)$/m;
const STS_RELIC_NAME_RE = /(?:^|；)\s*([^：；]{1,12}?)(?:\(\d+\))?：/g;
/** 初始遗物 → 角色（升级后的版本不在这张表里，角色在开局时已经认出）。 */
const STARTER_RELICS: Record<string, string> = {
  燃烧之血: '铁甲战士', 蛇之戒指: '静默猎手', 破损核心: '故障机器人', 纯水: '观者',
};

export interface StsSnapshotFacts {
  screen: string;
  act: number | null;
  floor: number | null;
  hp: number | null;
  maxHp: number | null;
  gold: number | null;
  relics: string[] | null;
  result: { victory: boolean; score: string } | null;
  enemies: string[];
  boss: string | null;
}

/** 解析一份完整的杀戮尖塔状态（`[StS <状态码> · <界面> · …]` 开头）；提醒行与回执不算。 */
export function parseStsSnapshot(text: string): StsSnapshotFacts | null {
  const header = STS_HEADER_RE.exec(text);
  if (!header) return null;
  const run = STS_RUN_RE.exec(text);
  const relicLine = text.split('\n').find((l) => l.startsWith('遗物：'));
  let relics: string[] | null = null;
  if (relicLine !== undefined) {
    const body = relicLine.slice('遗物：'.length);
    relics = [];
    if (body.trim() !== '无') {
      for (const m of body.matchAll(STS_RELIC_NAME_RE)) {
        const name = m[1].trim();
        // 描述里也会出现「……：」，只收像名字的短词。
        if (name && !/[\d\s，。！？、,.!?]/.test(name) && !relics.includes(name)) relics.push(name);
      }
    }
  }
  const result = STS_RESULT_RE.exec(text);
  const enemies = [...text.matchAll(/^敌\d+ (\S+?)(?:（[^）]*）)? · /gm)].map((m) => m[1]);
  const boss = /^首领：(\S+)/m.exec(text)?.[1] ?? null;
  const num = (v: string | undefined): number | null => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
  return {
    screen: header[1].trim(),
    act: num(run?.[1]),
    floor: num(run?.[2]),
    hp: num(run?.[3]),
    maxHp: num(run?.[4]),
    gold: num(run?.[5]),
    relics,
    result: result ? { victory: result[1] === '胜利', score: result[2] } : null,
    enemies: [...new Set(enemies)],
    boss: boss && boss !== '?' ? boss : null,
  };
}

export function stsCharacterOf(relics: readonly string[] | null): string | null {
  for (const relic of relics ?? []) if (STARTER_RELICS[relic]) return STARTER_RELICS[relic];
  return null;
}

// ─── 跟踪器 ──────────────────────────────────────────────────────────────────

export interface GameTrackerOptions {
  /** 输出旁路记下的工具调用（mc_goal done / drop）；缺省时不判断目标完成 */
  calls?: CallLedger | null;
}

/** 目标完成指令与快照之间允许的时钟误差。 */
export const GOAL_OP_SLACK_MS = 5_000;

export class GameTracker {
  private state: GameTrackerState;

  constructor(state: GameTrackerState = emptyGameState(), private readonly opts: GameTrackerOptions = {}) {
    this.state = structuredClone(state);
  }

  snapshot(): GameTrackerState {
    return structuredClone(this.state);
  }

  restore(state: GameTrackerState): void {
    this.state = structuredClone(state);
  }

  /** 一条事件翻出来的游戏经历（通常 0 条，少数 1～2 条）。 */
  map(env: EventEnvelope): GameEventDraft[] {
    const game = GAME_OF_SOURCE[env.source];
    if (!game) return [];
    this.rollDay(env.ts);
    if (game === 'minecraft') return this.minecraft(env);
    if (game === 'sts') return this.sts(env);
    return this.oni(env);
  }

  private rollDay(ts: string): void {
    const day = localDay(ts);
    if (day && day !== this.state.day) {
      this.state.day = day;
      this.state.seen = [];
    }
  }

  /** 当天第一次出现返回 true 并记下。 */
  private firstToday(key: string): boolean {
    if (this.state.seen.includes(key)) return false;
    this.state.seen.push(key);
    return true;
  }

  private draft(env: EventEnvelope, suffix: string, game: GameId, eventType: GameEventDraft['event_type'], content: string): GameEventDraft {
    return {
      event_id: `cortico:${env.cursor}${suffix ? `:${suffix}` : ''}`,
      game,
      event_type: eventType,
      content,
      timestamp: tsSeconds(env.ts),
    };
  }

  private minecraft(env: EventEnvelope): GameEventDraft[] {
    const text = String(env.text ?? '');
    if (env.type === 'minecraft.world.snapshot') return this.minecraftGoals(env, text);
    if (env.type === 'minecraft.world') {
      const gained = GAINED_RE.exec(stripMinecraftPrefix(text));
      if (!gained) return [];
      const out: GameEventDraft[] = [];
      for (const stack of gained[1].split('、')) {
        const m = STACK_RE.exec(stack.trim());
        if (!m || !NOTABLE_ITEMS.has(m[1]) || !this.firstToday(`mc:item:${m[1]}`)) continue;
        out.push(this.draft(env, `item:${m[1]}`, 'minecraft', 'discovery', `[我的世界] 拿到了${m[1]}×${m[2]}`));
      }
      return out;
    }
    if (env.type !== 'minecraft.event') return [];
    const body = stripMinecraftPrefix(text);
    const death = deathContent(body);
    if (death) return [this.draft(env, '', 'minecraft', 'death', death)];

    const dim = DIMENSION_RE.exec(body);
    if (dim) {
      const to = dim[2];
      if (to === '主世界' || !this.firstToday(`mc:dim:${to}`)) return [];
      return [this.draft(env, '', 'minecraft', 'discovery', `[我的世界] 从${dim[1]}进入了${to}`)];
    }
    const boss = BOSS_APPEAR_RE.exec(body);
    if (boss) {
      const title = boss[1].trim();
      this.state.mc.bosses[title] = 100;
      if (!this.firstToday(`mc:boss:${title}`)) return [];
      return [this.draft(env, '', 'minecraft', 'discovery', `[我的世界] 遇上了 Boss：${title}`)];
    }
    const health = BOSS_HEALTH_RE.exec(body);
    if (health) {
      const title = health[1].trim();
      if (title in this.state.mc.bosses) this.state.mc.bosses[title] = Number(health[2]);
      return [];
    }
    const gone = BOSS_GONE_RE.exec(body);
    if (gone) {
      const title = gone[1].trim();
      const pct = this.state.mc.bosses[title];
      if (pct === undefined) return [];
      delete this.state.mc.bosses[title];
      return [this.draft(env, '', 'minecraft', 'milestone', `[我的世界] 与 ${title} 的 Boss 战结束：血条消失，最后一次看到它还剩 ${pct}%`)];
    }
    const tamed = TAMED_RE.exec(body);
    if (tamed) return [this.draft(env, '', 'minecraft', 'milestone', `[我的世界] 驯服了${tamed[1]}`)];
    return [];
  }

  /**
   * 目标表只在世界快照的「目标:」行里出现（表变了才有这一行）。新出现的目标 = 立下目标；
   * 消失的目标只有在这段时间里她下过 `mc_goal done` 才算完成——重启清空暂态表、撤掉目标都不算。
   * 第一次见到目标行只作基线，不写。
   */
  private minecraftGoals(env: EventEnvelope, text: string): GameEventDraft[] {
    const goals = parseMinecraftGoals(text);
    if (goals === null) return [];
    const at = tsMillis(env.ts);
    const prev = this.state.mc.goals;
    const prevAt = this.state.mc.goalsAt;
    this.state.mc.goals = goals;
    this.state.mc.goalsAt = at;
    if (prev === null) return [];
    const key = (g: McGoal): string => `${g.slot}:${g.text}`;
    const now = new Set(goals.map(key));
    const before = new Set(prev.map(key));
    const out: GameEventDraft[] = [];
    const ops = this.opts.calls?.goalOps(prevAt - GOAL_OP_SLACK_MS, at + GOAL_OP_SLACK_MS) ?? [];
    for (const goal of prev) {
      if (now.has(key(goal))) continue;
      const last = [...ops].reverse().find((op) => op.goal?.slot === goal.slot);
      if (last?.goal?.op !== 'done') continue;
      out.push(this.draft(env, `goal-done:${goal.slot}`, 'minecraft', 'goal', `[我的世界] 完成了目标：${goal.text}`));
    }
    for (const goal of goals) {
      if (before.has(key(goal)) || !this.firstToday(`mc:goal:${goal.text}`)) continue;
      out.push(this.draft(env, `goal-add:${goal.slot}`, 'minecraft', 'goal', `[我的世界] 立下目标：${goal.text}`));
    }
    return out;
  }

  private sts(env: EventEnvelope): GameEventDraft[] {
    if (env.type !== 'sts-1.state' && env.type !== 'sts-1.decision') return [];
    const facts = parseStsSnapshot(String(env.text ?? ''));
    if (!facts) return [];
    const s = this.state.sts;
    const out: GameEventDraft[] = [];
    if (facts.screen === '主菜单') {
      s.act = null;
      s.floor = null;
      s.relics = null;
      s.ended = false;
      s.character = null;
      return out;
    }
    const newRun = facts.floor !== null
      && ((facts.act === 1 && facts.floor === 0 && (s.floor === null || s.floor > 0 || s.ended))
        || (s.floor !== null && facts.floor < s.floor && facts.act !== null && s.act !== null && facts.act <= s.act));
    if (newRun) {
      const character = stsCharacterOf(facts.relics);
      s.relics = facts.relics ? [...facts.relics] : null;
      s.ended = false;
      s.character = character;
      out.push(this.draft(env, 'run', 'sts', 'milestone', `[杀戮尖塔] 开了新的一局${character ? `（${character}）` : ''}`));
    } else if (facts.relics) {
      if (s.relics === null) {
        s.relics = [...facts.relics];
        s.character ??= stsCharacterOf(facts.relics);
      } else {
        for (const relic of facts.relics) {
          if (s.relics.includes(relic)) continue;
          s.relics.push(relic);
          const where = facts.act !== null && facts.floor !== null ? `第 ${facts.act} 幕第 ${facts.floor} 层` : '';
          out.push(this.draft(env, `relic:${relic}`, 'sts', 'choice', `[杀戮尖塔] ${where}拿到遗物「${relic}」`));
        }
      }
    }
    if (!newRun && facts.act !== null && s.act !== null && facts.act > s.act && !s.ended) {
      const hp = facts.hp !== null && facts.maxHp !== null ? `，生命 ${facts.hp}/${facts.maxHp}` : '';
      out.push(this.draft(env, `act:${facts.act}`, 'sts', 'milestone', `[杀戮尖塔] 打进了第 ${facts.act} 幕${hp}`));
    }
    if (facts.act !== null) s.act = facts.act;
    if (facts.floor !== null) s.floor = facts.floor;
    if (facts.result && !s.ended) {
      s.ended = true;
      const who = s.character ? `（${s.character}）` : '';
      const where = s.act !== null && s.floor !== null ? `第 ${s.act} 幕第 ${s.floor} 层` : '';
      out.push(facts.result.victory
        ? this.draft(env, 'result', 'sts', 'milestone', `[杀戮尖塔] 通关胜利${who}，得分 ${facts.result.score}`)
        : this.draft(env, 'result', 'sts', 'death', `[杀戮尖塔] 这一局${who}在${where || '途中'}倒下了，得分 ${facts.result.score}`));
    }
    return out;
  }

  private oni(env: EventEnvelope): GameEventDraft[] {
    if (env.type !== 'oni.alert.critical') return [];
    const message = String(env.text ?? '').replace(/^【缺氧警报】\s*/, '').trim();
    if (!message || !this.firstToday(`oni:alert:${message}`)) return [];
    return [this.draft(env, '', 'oni', 'crisis', `[缺氧] 严重警报：${message.slice(0, 200)}`)];
  }
}
