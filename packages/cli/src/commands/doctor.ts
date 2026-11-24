import { validateEvent, type LatticeEvent } from '@lattice/core';
import type { CliIO, CommandOptions } from '../cli.js';
import { EXIT_DATA, EXIT_OK } from '../errors.js';
import { absolutePath, readTextFile } from '../fileio.js';
import { displayWidth, kvLines, padRight } from '../ui.js';

export interface LineProblem {
  line: number;
  message: string;
}

export interface SchemaProblem {
  line: number;
  errors: string[];
}

export interface DuplicateIdProblem {
  id: string;
  lines: number[];
}

export interface OrphanCueProblem {
  line: number;
  cueId: string;
  propositionId: string;
}

export interface OrphanReviewProblem {
  line: number;
  eventId: string;
  propositionId: string;
}

export interface SequenceProblem {
  line: number;
  deviceId: string;
  seq: number;
  previousSeq: number;
}

export interface DoctorProblems {
  invalidJson: LineProblem[];
  schemaErrors: SchemaProblem[];
  duplicateIds: DuplicateIdProblem[];
  orphanCues: OrphanCueProblem[];
  orphanReviews: OrphanReviewProblem[];
  nonMonotonicSeq: SequenceProblem[];
}

export interface DoctorReport {
  in: string;
  ok: boolean;
  lineCount: number;
  eventCount: number;
  devices: Record<string, number>;
  problems: DoctorProblems;
  problemCount: number;
}

function emptyProblems(): DoctorProblems {
  return {
    invalidJson: [],
    schemaErrors: [],
    duplicateIds: [],
    orphanCues: [],
    orphanReviews: [],
    nonMonotonicSeq: [],
  };
}

/** Proposition id carried by an asserted proposition (subjectId, then payload.id). */
function assertedPropositionId(event: LatticeEvent): string | undefined {
  if (typeof event.subjectId === 'string' && event.subjectId.length > 0) return event.subjectId;
  const fromPayload = event.payload['id'];
  return typeof fromPayload === 'string' && fromPayload.length > 0 ? fromPayload : undefined;
}

/** Proposition referenced by a cue/review payload. */
function referencedPropositionId(event: LatticeEvent): string | undefined {
  const fromPayload = event.payload['propositionId'];
  return typeof fromPayload === 'string' && fromPayload.length > 0 ? fromPayload : undefined;
}

/**
 * Validates a raw JSONL log line by line.
 *
 * Detects: invalid JSON, schema errors (core `validateEvent`), duplicate event
 * ids, cue/review events pointing at propositions that are not in the log, and
 * per-device `seq` that is not strictly increasing in file order.
 *
 * Pure function over text so the checks are unit-testable without a process.
 */
export function diagnoseLog(text: string, source: string): DoctorReport {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const problems = emptyProblems();
  const parsedEvents: { event: LatticeEvent; line: number }[] = [];
  const idLines = new Map<string, number[]>();

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line.length === 0) return;
    const lineNo = index + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      problems.invalidJson.push({ line: lineNo, message: (err as Error).message });
      return;
    }

    const errors = validateEvent(parsed);
    if (errors.length > 0) {
      problems.schemaErrors.push({ line: lineNo, errors });
      return;
    }

    const event = parsed as LatticeEvent;
    parsedEvents.push({ event, line: lineNo });
    const seenAt = idLines.get(event.id) ?? [];
    seenAt.push(lineNo);
    idLines.set(event.id, seenAt);
  });

  const propositionIds = new Set<string>();
  for (const { event } of parsedEvents) {
    if (event.type !== 'proposition.asserted') continue;
    const id = assertedPropositionId(event);
    if (id) propositionIds.add(id);
  }

  for (const [id, seenAt] of idLines) {
    if (seenAt.length > 1) problems.duplicateIds.push({ id, lines: seenAt });
  }

  const lastSeq = new Map<string, number>();
  const devices: Record<string, number> = {};
  for (const { event, line } of parsedEvents) {
    devices[event.deviceId] = (devices[event.deviceId] ?? 0) + 1;

    const previous = lastSeq.get(event.deviceId);
    if (previous !== undefined && event.seq <= previous) {
      problems.nonMonotonicSeq.push({
        line,
        deviceId: event.deviceId,
        seq: event.seq,
        previousSeq: previous,
      });
    }
    lastSeq.set(event.deviceId, previous === undefined ? event.seq : Math.max(previous, event.seq));

    if (event.type === 'cue.asserted') {
      const propositionId = referencedPropositionId(event);
      if (propositionId && !propositionIds.has(propositionId)) {
        problems.orphanCues.push({
          line,
          cueId: event.subjectId ?? event.id,
          propositionId,
        });
      }
    }

    if (event.type === 'review.rated') {
      const propositionId = referencedPropositionId(event) ?? event.subjectId;
      if (propositionId && !propositionIds.has(propositionId)) {
        problems.orphanReviews.push({ line, eventId: event.id, propositionId });
      }
    }
  }

  const problemCount =
    problems.invalidJson.length +
    problems.schemaErrors.length +
    problems.duplicateIds.length +
    problems.orphanCues.length +
    problems.orphanReviews.length +
    problems.nonMonotonicSeq.length;

  return {
    in: source,
    ok: problemCount === 0,
    lineCount: lines.length,
    eventCount: parsedEvents.length,
    devices,
    problems,
    problemCount,
  };
}

function detailLines(report: DoctorReport): string[] {
  const { problems } = report;
  const details: string[] = [];
  const push = (items: readonly string[]): void => {
    for (const item of items.slice(0, 5)) details.push(`      · ${item}`);
    if (items.length > 5) details.push(`      · … 还有 ${items.length - 5} 条`);
  };

  push(problems.invalidJson.map((p) => `第 ${p.line} 行：${p.message}`));
  push(problems.schemaErrors.map((p) => `第 ${p.line} 行：${p.errors.join('; ')}`));
  push(problems.duplicateIds.map((p) => `${p.id} 出现在第 ${p.lines.join(', ')} 行`));
  push(problems.orphanCues.map((p) => `第 ${p.line} 行：卡片 ${p.cueId} 指向不存在的命题 ${p.propositionId}`));
  push(problems.orphanReviews.map((p) => `第 ${p.line} 行：复习 ${p.eventId} 指向不存在的命题 ${p.propositionId}`));
  push(
    problems.nonMonotonicSeq.map(
      (p) => `第 ${p.line} 行：设备 ${p.deviceId} 的 seq=${p.seq} 不大于前值 ${p.previousSeq}`,
    ),
  );
  return details;
}

export function renderDoctorReport(report: DoctorReport): string {
  const deviceLine =
    Object.entries(report.devices)
      .map(([deviceId, count]) => `${deviceId} × ${count}`)
      .join('，') || '（无）';

  const lines: string[] = ['体检报告'];
  lines.push(
    ...kvLines([
      ['输入文件', report.in],
      ['行数', String(report.lineCount)],
      ['事件数', String(report.eventCount)],
      ['设备', deviceLine],
    ]),
  );

  const rows: readonly (readonly [string, number])[] = [
    ['JSON 解析错误', report.problems.invalidJson.length],
    ['字段校验错误', report.problems.schemaErrors.length],
    ['重复事件 id', report.problems.duplicateIds.length],
    ['孤立卡片事件', report.problems.orphanCues.length],
    ['孤立复习事件', report.problems.orphanReviews.length],
    ['seq 非单调', report.problems.nonMonotonicSeq.length],
  ];
  const labelWidth = rows.reduce((max, row) => Math.max(max, displayWidth(row[0])), 0);

  lines.push('', '  问题');
  if (report.ok) {
    lines.push('    （无）');
  } else {
    for (const [label, count] of rows) {
      lines.push(`    ${padRight(label, labelWidth)}  ${count}`);
    }
    lines.push(...detailLines(report));
  }

  lines.push('', `  结论：${report.ok ? '未发现问题。' : `发现 ${report.problemCount} 处问题，请修复后再使用。`}`);
  return lines.join('\n') + '\n';
}

export function runDoctor(opts: CommandOptions, io: CliIO): number {
  const inPath = absolutePath(opts.value('in'));
  const { text } = readTextFile(inPath, '事件日志');
  const report = diagnoseLog(text, inPath);

  if (opts.has('json')) {
    io.out(JSON.stringify(report, null, 2) + '\n');
  } else {
    io.out(renderDoctorReport(report));
  }
  return report.ok ? EXIT_OK : EXIT_DATA;
}
