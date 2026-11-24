import {
  activePropositions,
  dueItems,
  masterySummary,
  newItems,
  prerequisiteEdges,
  replay,
  retrievability,
  stateDigest,
  type LearnerState,
  type ScheduleStage,
} from '@lattice/core';
import type { CliIO, CommandOptions } from '../cli.js';
import { CliError, EXIT_OK, EXIT_USAGE } from '../errors.js';
import { absolutePath, readEventFile } from '../fileio.js';
import { kvLines, pct, renderTable } from '../ui.js';

const TOP_N = 5;

const STAGE_LABELS: Record<ScheduleStage, string> = {
  new: '新',
  learning: '学习中',
  review: '复习',
  relearning: '重学',
};

const STAGE_ORDER: readonly ScheduleStage[] = ['new', 'learning', 'review', 'relearning'];

export interface ReplayMastery {
  mean: number;
  low: number;
  high: number;
  strength: number;
}

export interface ReplayTopProposition {
  id: string;
  statement: string;
  mastery: ReplayMastery;
  /** Model-predicted recall probability at the report time. */
  retrievability: number;
  stage: ScheduleStage;
  reviewCount: number;
  dueAt: string | null;
}

export interface ReplayReport {
  command: 'replay';
  in: string;
  at: string;
  eventCount: number;
  propositionCount: number;
  cueCount: number;
  chainCount: number;
  prerequisiteEdgeCount: number;
  interestCount: number;
  exposureCount: number;
  reviewCount: number;
  dueCount: number;
  newCount: number;
  stageSummary: Record<ScheduleStage, number>;
  digest: string;
  topPropositions: ReplayTopProposition[];
  parseErrors: number;
}

export interface ReplayReportInput {
  inPath: string;
  at: string;
  eventCount: number;
  parseErrors: number;
}

/**
 * Builds the replay report from an already-replayed state. Pure: same state and
 * `at` always produce the same object (guaranteed stable JSON key order).
 */
export function buildReplayReport(state: LearnerState, input: ReplayReportInput): ReplayReport {
  const propositions = activePropositions(state);

  const stageSummary: Record<ScheduleStage, number> = { new: 0, learning: 0, review: 0, relearning: 0 };
  for (const proposition of propositions) {
    const stage = state.schedule[proposition.id]?.stage ?? 'new';
    stageSummary[stage] += 1;
  }

  const topPropositions = propositions
    .map((proposition): ReplayTopProposition => {
      const schedule = state.schedule[proposition.id];
      const mastery = state.mastery[proposition.id];
      const summary = masterySummary(mastery ?? { propositionId: proposition.id, alpha: 2, beta: 2, evidenceCount: 0, updatedAt: input.at });
      return {
        id: proposition.id,
        statement: proposition.statement,
        mastery: { mean: summary.mean, low: summary.low, high: summary.high, strength: summary.strength },
        retrievability: schedule ? retrievability(schedule, input.at) : 0,
        stage: schedule?.stage ?? 'new',
        reviewCount: schedule?.reviewCount ?? 0,
        dueAt: schedule?.dueAt ?? null,
      };
    })
    .sort((a, b) => {
      if (a.mastery.mean !== b.mastery.mean) return b.mastery.mean - a.mastery.mean;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, TOP_N);

  return {
    command: 'replay',
    in: input.inPath,
    at: input.at,
    eventCount: input.eventCount,
    propositionCount: propositions.length,
    cueCount: Object.keys(state.cues).length,
    chainCount: Object.keys(state.chains).length,
    prerequisiteEdgeCount: prerequisiteEdges(state).length,
    interestCount: Object.keys(state.interests).length,
    exposureCount: Object.keys(state.exposures).length,
    reviewCount: state.reviews.length,
    dueCount: dueItems(state, input.at).length,
    newCount: newItems(state, Number.POSITIVE_INFINITY).length,
    stageSummary,
    digest: stateDigest(state),
    topPropositions,
    parseErrors: input.parseErrors,
  };
}

/** Renders the human-facing replay table (Chinese labels, aligned columns). */
export function renderReplayReport(report: ReplayReport): string {
  const stageLine = STAGE_ORDER.map((stage) => `${STAGE_LABELS[stage]} ${report.stageSummary[stage]}`).join(' · ');
  const lines: string[] = ['重放报告'];
  lines.push(
    ...kvLines([
      ['输入文件', report.in],
      ['时间点', report.at],
      ['事件数', String(report.eventCount)],
      ['命题数', String(report.propositionCount)],
      ['卡片数', String(report.cueCount)],
      ['推理链', String(report.chainCount)],
      ['先修关系', String(report.prerequisiteEdgeCount)],
      ['兴趣领域', String(report.interestCount)],
      ['已曝光', String(report.exposureCount)],
      ['复习数', String(report.reviewCount)],
      ['到期数', String(report.dueCount)],
      ['新学数', String(report.newCount)],
      ['状态摘要', stageLine],
      ['digest', report.digest],
    ]),
  );

  if (report.parseErrors > 0) {
    lines.push('', `  注意：跳过 ${report.parseErrors} 行无法解析的数据（用 lattice doctor 查看详情）。`);
  }

  lines.push('', `  掌握度前 ${report.topPropositions.length} 位`);
  if (report.topPropositions.length === 0) {
    lines.push('    （日志里还没有命题：先 lattice import 一个命题包）');
  } else {
    const rows = report.topPropositions.map((item) => [
      item.statement,
      `${pct(item.mastery.mean)} [${pct(item.mastery.low)}–${pct(item.mastery.high)}]`,
      pct(item.retrievability),
      STAGE_LABELS[item.stage],
    ]);
    lines.push(
      ...renderTable(
        [
          { title: '命题', width: 34 },
          { title: '掌握度', width: 26 },
          { title: 'R', width: 8 },
          { title: '状态', width: 8 },
        ],
        rows,
        4,
      ),
    );
  }
  return lines.join('\n') + '\n';
}

function normalizeAt(raw: string | undefined): string {
  if (raw === undefined) return new Date().toISOString();
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new CliError(EXIT_USAGE, `--at 不是合法时间：${raw}`, '示例：--at 2026-11-24T00:00:00.000Z');
  }
  return new Date(parsed).toISOString();
}

export function runReplay(opts: CommandOptions, io: CliIO): number {
  const inPath = absolutePath(opts.value('in'));
  const at = normalizeAt(opts.has('at') ? opts.value('at') : undefined);
  const read = readEventFile(inPath);
  const state = replay(read.events);
  const report = buildReplayReport(state, {
    inPath,
    at,
    eventCount: read.events.length,
    parseErrors: read.errors.length,
  });

  if (opts.has('json')) {
    if (read.errors.length > 0) {
      io.err(`警告：跳过 ${read.errors.length} 行无法解析的数据（用 lattice doctor 查看）。\n`);
    }
    io.out(JSON.stringify(report, null, 2) + '\n');
  } else {
    io.out(renderReplayReport(report));
  }
  return EXIT_OK;
}
