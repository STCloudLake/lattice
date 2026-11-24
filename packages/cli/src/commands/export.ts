import { dedupeAndSort } from '@lattice/core';
import type { CliIO, CommandOptions } from '../cli.js';
import { CliError, EXIT_DATA, EXIT_OK } from '../errors.js';
import { absolutePath, readEventFile, writeEventFile } from '../fileio.js';

/**
 * Canonicalizes an event log: dedupe by id, deterministic order, one compact
 * JSON object per line (core `exportJsonl`).
 *
 * Idempotent by construction: the output only contains canonical lines, so
 * exporting an exported file is byte-identical.
 */
export function runExport(opts: CommandOptions, io: CliIO): number {
  const inPath = absolutePath(opts.value('in'));
  const outPath = absolutePath(opts.value('out'));

  const read = readEventFile(inPath);
  if (read.errors.length > 0) {
    throw new CliError(
      EXIT_DATA,
      `输入日志有 ${read.errors.length} 行无效数据，已中止导出（避免静默丢数据）。`,
      `先运行 lattice doctor --in "${inPath}" 查看并修复。`,
    );
  }

  const canonical = dedupeAndSort(read.events);
  const removed = read.events.length - canonical.length;
  const writtenPath = writeEventFile(outPath, read.events);

  io.out(
    [
      `已导出 ${canonical.length} 条事件${removed > 0 ? `（去重 ${removed} 条）` : ''}`,
      `  输入   ${inPath}`,
      `  输出   ${writtenPath}`,
    ].join('\n') + '\n',
  );
  return EXIT_OK;
}
