import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { exportJsonl, parseJsonl, type LatticeEvent } from '@lattice/core';
import { CliError, EXIT_DATA } from './errors.js';

/** Every command defaults `--in` to this, relative to the working directory. */
export const DEFAULT_EVENTS_FILE = './events.jsonl';

export const MAX_REPORTED_ERRORS = 5;

export function absolutePath(filePath: string): string {
  return resolve(filePath);
}

export function ensureParentDir(absPath: string): void {
  const dir = dirname(absPath);
  if (dir.length > 0 && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export interface TextFileRead {
  path: string;
  text: string;
}

export function readTextFile(filePath: string, what: string): TextFileRead {
  const abs = absolutePath(filePath);
  try {
    return { path: abs, text: readFileSync(abs, 'utf8') };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new CliError(
        EXIT_DATA,
        `${what}不存在：${abs}`,
        '先用 lattice sample 生成演示命题包，或检查传入的路径。',
      );
    }
    throw new CliError(EXIT_DATA, `读取${what}失败：${abs}`, (err as Error).message);
  }
}

export interface EventFileRead {
  path: string;
  events: LatticeEvent[];
  errors: string[];
}

/** Reads and parses a JSONL event log, keeping per-line errors for the caller. */
export function readEventFile(filePath: string): EventFileRead {
  const { path, text } = readTextFile(filePath, '事件日志');
  const { events, errors } = parseJsonl(text);
  return { path, events, errors };
}

/** Canonical write: deduped, sorted, one JSON object per line (core exportJsonl). */
export function writeEventFile(filePath: string, events: readonly LatticeEvent[]): string {
  const abs = absolutePath(filePath);
  ensureParentDir(abs);
  writeFileSync(abs, exportJsonl(events), 'utf8');
  return abs;
}

/** Appends canonical lines, repairing a missing trailing newline first. */
export function appendEventFile(filePath: string, events: readonly LatticeEvent[]): string {
  const abs = absolutePath(filePath);
  ensureParentDir(abs);
  const chunk = exportJsonl(events);
  if (chunk.length === 0) return abs;
  const current = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  appendFileSync(abs, prefix + chunk, 'utf8');
  return abs;
}

export function writeTextFile(filePath: string, text: string): string {
  const abs = absolutePath(filePath);
  ensureParentDir(abs);
  writeFileSync(abs, text, 'utf8');
  return abs;
}

export function countNonEmptyLines(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

/**
 * Monotonic, 1 ms-per-tick clock. "Deterministic-ish": timestamps ascend with
 * the event order instead of depending on wall-clock jitter, which keeps an
 * imported log byte-stable when ids are also fixed (tests rely on this).
 */
export function createStepClock(baseMs: number = Date.now()): () => Date {
  let tick = baseMs;
  return () => new Date(tick++);
}

export function describeErrors(errors: readonly string[], limit = MAX_REPORTED_ERRORS): string[] {
  const shown = errors.slice(0, limit).map((error) => `  - ${error}`);
  if (errors.length > limit) shown.push(`  … 还有 ${errors.length - limit} 条`);
  return shown;
}
