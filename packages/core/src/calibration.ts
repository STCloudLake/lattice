import type { LearnerState } from './types.js';

/**
 * Calibration of the availability model (H2 in the product report).
 *
 * We compare the model's predicted recall probability (rBefore) with the actual
 * outcome (grade >= 3). If the Brier score is not better than predicting the
 * base rate, the model is not adding information and the UI must say so.
 */

export interface CalibrationSample {
  /** Model-predicted recall probability, 0..1. */
  predicted: number;
  /** 1 = recalled, 0 = forgot. */
  outcome: 0 | 1;
}

export interface CalibrationBucket {
  lo: number;
  hi: number;
  n: number;
  meanPredicted: number;
  meanOutcome: number;
}

export interface CalibrationReport {
  n: number;
  /** Mean squared error of the model. */
  brier: number;
  /** Brier of always predicting the observed base rate. */
  baselineBrier: number;
  /** Expected calibration error across buckets. */
  ece: number;
  buckets: CalibrationBucket[];
  /** True when the model beats the constant baseline. */
  beatsBaseline: boolean;
}

export function calibrate(samples: readonly CalibrationSample[], bins = 10): CalibrationReport {
  const n = samples.length;
  if (n === 0) {
    return { n: 0, brier: Number.NaN, baselineBrier: Number.NaN, ece: Number.NaN, buckets: [], beatsBaseline: false };
  }
  const baseRate = samples.reduce((sum, s) => sum + s.outcome, 0) / n;

  let squaredError = 0;
  let baselineError = 0;
  for (const s of samples) {
    squaredError += (s.predicted - s.outcome) ** 2;
    baselineError += (baseRate - s.outcome) ** 2;
  }
  const brier = squaredError / n;
  const baselineBrier = baselineError / n;

  const width = 1 / bins;
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < bins; i++) {
    const lo = i * width;
    const hi = i === bins - 1 ? 1 + Number.EPSILON : (i + 1) * width;
    const inBucket = samples.filter((s) => s.predicted >= lo && s.predicted < hi);
    if (inBucket.length === 0) continue;
    buckets.push({
      lo,
      hi,
      n: inBucket.length,
      meanPredicted: inBucket.reduce((sum, s) => sum + s.predicted, 0) / inBucket.length,
      meanOutcome: inBucket.reduce((sum, s) => sum + s.outcome, 0) / inBucket.length,
    });
  }

  const ece = buckets.reduce((sum, b) => sum + (b.n / n) * Math.abs(b.meanPredicted - b.meanOutcome), 0);

  return {
    n,
    brier,
    baselineBrier,
    ece,
    buckets,
    beatsBaseline: Number.isFinite(brier) && brier < baselineBrier,
  };
}

/**
 * Samples recoverable from a replayed state. First reviews (rBefore = 0) are
 * excluded: there is no prediction to score yet.
 */
export function samplesFromState(state: LearnerState): CalibrationSample[] {
  const samples: CalibrationSample[] = [];
  for (const review of state.reviews) {
    if (!(review.rBefore > 0)) continue;
    samples.push({ predicted: review.rBefore, outcome: review.grade >= 3 ? 1 : 0 });
  }
  return samples;
}

export function formatReport(report: CalibrationReport): string {
  if (report.n === 0) {
    return [
      '校准报告',
      '  样本数: 0',
      '  结论: 还没有可评分的复习（首次复习不产生预测），至少复习几张卡再看。',
    ].join('\n');
  }
  const pct = (x: number) => (x * 100).toFixed(1) + '%';
  const lines = [
    '校准报告',
    `  样本数: ${report.n}`,
    `  Brier: ${report.brier.toFixed(4)}  (基线 ${report.baselineBrier.toFixed(4)})`,
    `  ECE:   ${report.ece.toFixed(4)}`,
    `  结论: ${report.beatsBaseline ? '优于常数基线 ✓' : '未优于基线 ✗ —— 模型暂无信息量'}`,
    '  分桶:',
  ];
  for (const b of report.buckets) {
    lines.push(
      `    ${pct(b.lo).padStart(6)}–${pct(Math.min(b.hi, 1)).padStart(6)}  n=${String(b.n).padStart(3)}  预测 ${pct(
        b.meanPredicted,
      ).padStart(6)}  实际 ${pct(b.meanOutcome).padStart(6)}`,
    );
  }
  return lines.join('\n');
}
