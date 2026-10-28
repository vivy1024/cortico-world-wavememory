/**
 * 注入块的客户端整形（不改 WaveMemory 服务端）：
 *
 * 1. 剥掉服务端每轮都拼在块头的 `[世界观书设：…]` 常驻书设——羽书的书设由 Cortico 的
 *    CONSTITUTION 常驻前缀负责，一件事只写一处；
 * 2. 剔除她自己说过的旧话（给了 selfNames 时），避免把旧台词、说错的机制原样召回给她复读；
 * 3. 总长封顶：先从最长的记忆段尾部逐行削，仍超才从块尾整段丢，不截半行。
 *
 * 不按会话过滤：直播间与 QQ 群的记忆按 WaveMemory 的跨群设置原样共用。
 * 识别不了格式时原样保留——宁可多给，也不能把有用的记忆误删。
 */

const LORE_HEAD_RE = /^\[世界观书设[:：]/;
const EXACT_LOCATION_RE = /^\[原词命中\](?:\[群 [^\]]+\])?\s*/;
const OWN_REPLY_TAG = '[你的历史回复]';
const SECTION_TAGS = ['wave_memory', 'exact_memory'] as const;

export interface BlockFilterOptions {
  /** 块总长上限（字符）；0 或负数不封顶。 */
  maxChars: number;
  /**
   * 她自己的名字（如「羽书」）。给了就剔除她自己说过的旧话：`<wave_memory>` 里带
   * `[你的历史回复]` 的行，以及 `<exact_memory>` 里发言人是她自己的行。
   * 她的话已在会话与交接笔记里；召回回来只会让她复读旧台词（包括说错的机制）。
   */
  selfNames?: readonly string[];
}

export interface BlockFilterResult {
  text: string;
  /** 剔除的她自己的旧话行数 */
  droppedLines: number;
  /** 是否剥掉了常驻书设段 */
  droppedLore: boolean;
  /** 因总长封顶削掉的记忆行数 */
  trimmedLines: number;
  /** 因总长封顶整段丢掉的段落数 */
  truncatedParagraphs: number;
}

/** 块按空行分段（服务端各通道之间用空行分隔）。 */
function paragraphs(block: string): string[] {
  return block.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

function isOwnLine(line: string, selfNames: readonly string[]): boolean {
  if (selfNames.length === 0) return false;
  if (line.includes(OWN_REPLY_TAG)) return true;
  const exact = EXACT_LOCATION_RE.exec(line);
  if (!exact) return false;
  // `[原词命中][群 x] 发言人(MM-DD HH:MM): 正文`
  const rest = line.slice(exact[0].length);
  const at = rest.search(/\(\d{2}-\d{2} \d{2}:\d{2}\)/);
  if (at < 0) return false;
  return selfNames.includes(rest.slice(0, at).trim());
}

/** 过滤 `<tag>…</tag>` 段内她自己的行；返回过滤后的段（空段返回 null）与丢掉的行数。 */
function filterSection(paragraph: string, selfNames: readonly string[]): { text: string | null; dropped: number } {
  for (const tag of SECTION_TAGS) {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    if (!paragraph.startsWith(open) || !paragraph.endsWith(close)) continue;
    const body = paragraph.slice(open.length, paragraph.length - close.length).split('\n').filter((l) => l.trim());
    const kept = body.filter((line) => !isOwnLine(line.trim(), selfNames));
    const dropped = body.length - kept.length;
    if (kept.length === 0) return { text: null, dropped };
    return { text: [open, ...kept, close].join('\n'), dropped };
  }
  return { text: paragraph, dropped: 0 };
}

export function filterInjectionBlock(block: string, opts: BlockFilterOptions): BlockFilterResult {
  const selfNames = opts.selfNames ?? [];
  let droppedLines = 0;
  let droppedLore = false;
  const kept: string[] = [];
  for (const paragraph of paragraphs(block)) {
    if (LORE_HEAD_RE.test(paragraph)) {
      droppedLore = true;
      continue;
    }
    const { text, dropped } = filterSection(paragraph, selfNames);
    droppedLines += dropped;
    if (text) kept.push(text);
  }

  let truncatedParagraphs = 0;
  let trimmedLines = 0;
  if (opts.maxChars > 0) {
    // 先从最长的记忆段尾部一行行削（段内按相关度降序，尾部最不相关）；人物印象、事实这些
    // 短段排在块尾，按段落从尾部丢会先丢掉最有用的东西，所以只作最后手段。
    while (kept.join('\n\n').length > opts.maxChars) {
      const target = longestSection(kept);
      if (target < 0) break;
      const lines = kept[target].split('\n');
      lines.splice(lines.length - 2, 1);
      trimmedLines++;
      if (lines.length <= 2) {
        kept.splice(target, 1);
        truncatedParagraphs++;
      } else {
        kept[target] = lines.join('\n');
      }
    }
    while (kept.length > 1 && kept.join('\n\n').length > opts.maxChars) {
      kept.pop();
      truncatedParagraphs++;
    }
  }
  return { text: kept.join('\n\n'), droppedLines, droppedLore, trimmedLines, truncatedParagraphs };
}

/** 最长的、至少还有一行正文的记忆段下标；没有返回 -1。 */
function longestSection(kept: string[]): number {
  let best = -1;
  for (const [i, p] of kept.entries()) {
    const isSection = SECTION_TAGS.some((tag) => p.startsWith(`<${tag}>`) && p.endsWith(`</${tag}>`));
    if (!isSection || p.split('\n').length < 3) continue;
    if (best < 0 || p.length > kept[best].length) best = i;
  }
  return best;
}
