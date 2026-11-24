import {
  buildFeed,
  masterySummary,
  replay,
  retrievability,
  type FeedReason,
  type LearnerState,
} from '@lattice/core';
import type { CliIO, CommandOptions } from '../cli.js';
import { CliError, EXIT_OK, EXIT_USAGE } from '../errors.js';
import { absolutePath, readEventFile } from '../fileio.js';
import { kvLines, pct, renderTable } from '../ui.js';

const REASON_LABEL: Record<FeedReason, string> = {
  due: '到期复习',
  frontier: '前沿新学',
  foundation: '基础命题',
};

interface FeedRow {
  propositionId: string;
  statement: string;
  kind: 'review' | 'new';
  reason: FeedReason;
  domain: string | null;
  mastery: number;
  retrievability: number | null;
  score: number;
}

function normalizeAt(raw: string | undefined): string {
  if (raw === undefined) return new Date().toISOString();
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new CliError(EXIT_USAGE, `--at 不是合法时间：${raw}`, '示例：--at 2026-11-24T00:00:00.000Z');
  }
  return new Date(parsed).toISOString();
}

function buildRows(state: LearnerState, at: string, dose: number): FeedRow[] {
  const items = buildFeed(state, { now: at, dose });
  return items.map((item) => {
    const proposition = state.propositions[item.propositionId];
    const schedule = state.schedule[item.propositionId];
    const mastery = state.mastery[item.propositionId] ?? {
      propositionId: item.propositionId,
      alpha: 2,
      beta: 2,
      evidenceCount: 0,
      updatedAt: at,
    };
    return {
      propositionId: item.propositionId,
      statement: proposition?.statement ?? item.propositionId,
      kind: item.kind,
      reason: item.reason,
      domain: item.domain ?? proposition?.domain ?? null,
      mastery: masterySummary(mastery).mean,
      retrievability: schedule && schedule.reviewCount > 0 ? retrievability(schedule, at) : null,
      score: item.score,
    };
  });
}

export function runFeed(opts: CommandOptions, io: CliIO): number {
  const inPath = absolutePath(opts.value('in'));
  const at = normalizeAt(opts.has('at') ? opts.value('at') : undefined);
  const doseRaw = Number(opts.value('dose'));
  const dose = Number.isFinite(doseRaw) && doseRaw >= 1 ? Math.floor(doseRaw) : 3;

  const read = readEventFile(inPath);
  const state = replay(read.events);
  const rows = buildRows(state, at, dose);

  if (opts.has('json')) {
    io.out(
      JSON.stringify(
        {
          command: 'feed',
          in: inPath,
          at,
          dose,
          domains: Object.values(state.interests)
            .sort((a, b) => b.weight - a.weight)
            .map((interest) => ({ name: interest.name, weight: interest.weight, captures: interest.captureCount })),
          items: rows,
          parseErrors: read.errors.length,
        },
        null,
        2,
      ) + '\n',
    );
    return EXIT_OK;
  }

  const domainLine =
    Object.values(state.interests)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 4)
      .map((interest) => `${interest.name}×${interest.captureCount}`)
      .join(' · ') || '（还没有捕获过内容）';

  const lines: string[] = ['今日推送'];
  lines.push(
    ...kvLines([
      ['输入文件', inPath],
      ['时间点', at],
      ['剂量', String(dose)],
      ['兴趣领域', domainLine],
      ['已曝光 (今日去重)', String(Object.keys(state.exposures).length)],
    ]),
  );

  lines.push('');
  if (rows.length === 0) {
    lines.push('  今天没有可推送的内容：前置还没满足，或今日剂量已用完。');
    lines.push('  试试：lattice replay --in 日志 查看卡在哪个前置命题上。');
  } else {
    lines.push(
      ...renderTable(
        [
          { title: '命题', width: 34 },
          { title: '原因', width: 10 },
          { title: '领域', width: 10 },
          { title: '掌握', width: 7 },
          { title: 'R', width: 7 },
          { title: '分数', width: 6 },
        ],
        rows.map((row) => [
          row.statement,
          REASON_LABEL[row.reason],
          row.domain ?? '—',
          pct(row.mastery),
          row.retrievability === null ? '—' : pct(row.retrievability),
          row.score.toFixed(2),
        ]),
        6,
      ),
    );
  }
  io.out(lines.join('\n') + '\n');
  return EXIT_OK;
}
