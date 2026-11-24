import { calibrate, formatReport, replay, samplesFromState } from '@lattice/core';
import type { CliIO, CommandOptions } from '../cli.js';
import { EXIT_DATA, EXIT_OK } from '../errors.js';
import { absolutePath, readEventFile } from '../fileio.js';

/**
 * Calibration report (Brier / ECE / buckets) of the availability model.
 *
 * A log with no scoreable reviews yields n = 0; that is a data problem, so the
 * command exits 2 and says so explicitly instead of pretending the model is
 * perfect.
 */
export function runEval(opts: CommandOptions, io: CliIO): number {
  const inPath = absolutePath(opts.value('in'));
  const read = readEventFile(inPath);
  const state = replay(read.events);
  const report = calibrate(samplesFromState(state));

  if (read.errors.length > 0) {
    io.err(`警告：跳过 ${read.errors.length} 行无法解析的数据（用 lattice doctor 查看）。\n`);
  }

  if (opts.has('json')) {
    // Raw CalibrationReport; NaN (n = 0) serialises as null.
    io.out(JSON.stringify(report, null, 2) + '\n');
  } else {
    io.out(formatReport(report) + '\n');
  }

  if (report.n === 0) {
    io.err(
      '样本数 0：还没有可评分的复习（首次复习没有预测值）。\n' +
        `先复习几次再跑 eval，或确认 --in 指向包含 review.rated 的日志：${inPath}\n`,
    );
    return EXIT_DATA;
  }
  return EXIT_OK;
}
