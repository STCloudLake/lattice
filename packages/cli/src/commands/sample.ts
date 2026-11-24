import type { PropositionPack } from '@lattice/core';
import type { CliIO, CommandOptions } from '../cli.js';
import { CliError, EXIT_OK, EXIT_USAGE } from '../errors.js';
import { writeTextFile } from '../fileio.js';

/**
 * A tiny hand-writable demo pack (3 propositions, 6 cues). Same shape as
 * examples/sample-pack.json: format 1, cues are retrieval routes, not knowledge
 * units.
 */
export const SAMPLE_PACK: PropositionPack = {
  format: 1,
  propositions: [
    {
      statement: '机会成本是你为了得到某样东西而放弃的最佳替代方案的价值。',
      name: '机会成本',
      aliases: ['opportunity cost'],
      domain: 'economics',
      cues: [
        {
          front: '什么是机会成本？',
          back: '为了得到某样东西而放弃的最佳替代方案的价值。',
          kind: 'recall',
        },
        {
          front: '你花两小时打游戏，机会成本是什么？',
          back: '这两小时本可以用于的最高价值用途，例如复习或睡觉。',
          kind: 'apply',
        },
      ],
    },
    {
      statement: '边际效用递减：每增加一单位消费，新增的满足感下降。',
      name: '边际效用递减',
      aliases: ['diminishing marginal utility'],
      domain: 'economics',
      cues: [
        {
          front: '边际效用为什么递减？',
          back: '同一需求被逐步满足后，新增一单位带来的满足感下降。',
          kind: 'recall',
        },
        {
          front: '为什么第二个包子的满足感比第一个低？',
          back: '因为边际效用递减：需求已被部分满足。',
          kind: 'apply',
        },
      ],
    },
    {
      statement: '间隔重复比集中重复更能提高长期留存。',
      name: '间隔效应',
      aliases: ['spacing effect'],
      domain: 'learning',
      cues: [
        {
          front: '为什么间隔重复比一次性背十遍更有效？',
          back: '每次回忆都发生在轻微遗忘之后，检索难度更高，记忆痕迹更强。',
          kind: 'recall',
        },
        {
          front: '考前突击和分散复习，哪种长期留存更好？',
          back: '分散复习。集中重复带来短期熟悉感，但长期留存更差。',
          kind: 'apply',
        },
      ],
    },
  ],
};

export function samplePackJson(): string {
  return JSON.stringify(SAMPLE_PACK, null, 2) + '\n';
}

export function runSample(opts: CommandOptions, io: CliIO): number {
  if (!opts.has('out')) {
    throw new CliError(EXIT_USAGE, '缺少必需参数 --out <pack.json>', '用法：lattice sample --out <pack.json>');
  }
  const outPath = writeTextFile(opts.value('out'), samplePackJson());
  const cueCount = SAMPLE_PACK.propositions.reduce((sum, entry) => sum + entry.cues.length, 0);
  io.out(
    [
      `已写出演示命题包：${outPath}`,
      `  命题 ${SAMPLE_PACK.propositions.length} 条 · 卡片 ${cueCount} 张`,
      `  下一步：lattice import --pack "${outPath}" --out events.jsonl`,
    ].join('\n') + '\n',
  );
  return EXIT_OK;
}
