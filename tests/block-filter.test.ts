import { describe, expect, it } from 'vitest';
import { filterInjectionBlock } from '../src/block-filter.ts';

// 取自 2026-10-27 对线上 /context/prepare 的 dry_run 返回（截短）
const LIVE_BLOCK = [
  '[世界观书设：羽书出自《没钱修什么仙》，下列设定作为你的灵魂底色与认知边界]',
  '- 出处与本体：你来自修真小说《没钱修什么仙》……',
  '',
  '<wave_memory>',
  '[群398291136] [其他群友历史] [记忆] 天天开心(09-30 23:57): fvvvvvvvv羽书 (relevance: 0.79)',
  '[对话者本人历史] [记忆] 齐天大圣aes(10-26 13:12): 做钻石镐挖黑曜石 (relevance: 0.70)',
  '</wave_memory>',
  '',
  '<exact_memory>',
  '[原词命中][群 24292304] 好德好仁(10-26 12:15): fw羽书 (relevance: 1.00)',
  '[原词命中][群 398291136] 森亜るるか(10-25 11:54): fw羽书版本最低了 (relevance: 1.00)',
  '</exact_memory>',
  '',
  '<known_facts>',
  '齐天大圣aes 懂地狱门浇筑',
  '</known_facts>',
  '',
  '你对这个人的印象：急性子的监工',
].join('\n');

describe('filterInjectionBlock', () => {
  it('剥常驻书设；直播间与 QQ 群的记忆行原样保留', () => {
    const out = filterInjectionBlock(LIVE_BLOCK, { maxChars: 0, selfNames: ['羽书'] });
    expect(out.droppedLore).toBe(true);
    expect(out.droppedLines).toBe(0);
    expect(out.text).not.toContain('世界观书设');
    expect(out.text).toContain('[群398291136] [其他群友历史] [记忆] 天天开心');
    expect(out.text).toContain('[原词命中][群 398291136] 森亜るるか');
    expect(out.text).toContain('[原词命中][群 24292304] 好德好仁');
    expect(out.text).toContain('<known_facts>\n齐天大圣aes 懂地狱门浇筑\n</known_facts>');
    expect(out.text).toContain('你对这个人的印象：急性子的监工');
  });

  it('剔除她自己的旧话（原词命中按发言人，语义记忆按 [你的历史回复]），名字相近的别人保留', () => {
    const block = [
      '<wave_memory>',
      '[你的历史回复] [记忆] 羽书(10-26 11:00): 一桶水就能浇出地狱门 (relevance: 0.6)',
      '[对话者本人历史] [记忆] 阿木(10-26 11:01): 那不行吧 (relevance: 0.5)',
      '</wave_memory>',
      '',
      '<exact_memory>',
      '[原词命中][群 9] 羽书(10-26 13:09): 免镐手搓黑曜石 (relevance: 1.00)',
      '[原词命中][群 9] 羽书搭子(10-26 13:10): 羽书加油 (relevance: 1.00)',
      '[原词命中] 羽书(10-26 13:11): 私聊里的旧话 (relevance: 1.00)',
      '</exact_memory>',
    ].join('\n');
    const out = filterInjectionBlock(block, { maxChars: 0, selfNames: ['羽书'] });
    expect(out.droppedLines).toBe(3);
    expect(out.text).not.toContain('一桶水');
    expect(out.text).not.toContain('免镐手搓');
    expect(out.text).not.toContain('私聊里的旧话');
    expect(out.text).toContain('阿木(10-26 11:01)');
    expect(out.text).toContain('羽书搭子(10-26 13:10)');
  });

  it('段内全是她自己的行时整段删除', () => {
    const block = '<exact_memory>\n[原词命中][群 1] 羽书(01-01 00:00): x (relevance: 1.00)\n</exact_memory>\n\n<known_facts>\nf\n</known_facts>';
    const out = filterInjectionBlock(block, { maxChars: 0, selfNames: ['羽书'] });
    expect(out.text).toBe('<known_facts>\nf\n</known_facts>');
  });

  it('封顶时先削最长记忆段的尾行，印象与事实留下', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `[原词命中][群 9] u(01-01 00:00): 第${i}条很长很长的内容 (relevance: 1.00)`);
    const block = ['<exact_memory>', ...rows, '</exact_memory>', '', '<known_facts>\nf\n</known_facts>', '', '你对这个人的印象：好人'].join('\n');
    const out = filterInjectionBlock(block, { maxChars: 600 });
    expect(out.text.length).toBeLessThanOrEqual(600);
    expect(out.trimmedLines).toBeGreaterThan(0);
    expect(out.text).toContain('第0条');
    expect(out.text).not.toContain('第29条');
    expect(out.text).toContain('你对这个人的印象：好人');
    expect(out.text).toContain('<known_facts>');
  });

  it('认不出的格式原样保留', () => {
    const out = filterInjectionBlock('随便一段话\n第二行', { maxChars: 0, selfNames: ['羽书'] });
    expect(out.text).toBe('随便一段话\n第二行');
  });
});
