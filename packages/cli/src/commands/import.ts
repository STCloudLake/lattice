import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  createEventFactory,
  createIdFactory,
  packToEvents,
  parsePropositionPack,
  type Id,
  type LatticeEvent,
  type PropositionPack,
} from '@lattice/core';
import type { CliIO, CommandOptions } from '../cli.js';
import { CliError, EXIT_DATA, EXIT_OK, EXIT_USAGE } from '../errors.js';
import {
  absolutePath,
  appendEventFile,
  createStepClock,
  describeErrors,
  readTextFile,
  writeEventFile,
} from '../fileio.js';

export interface ImportBuildOptions {
  deviceId: string;
  clock: () => Date;
  /** 0 means the first event gets seq 1 (per-device sequence starts at 1). */
  startSeq?: number;
}

export interface PackEvents {
  events: LatticeEvent[];
  propositionIds: Id[];
  cueCount: number;
}

/** Fresh per-invocation device identity: `cli-<8 hex chars>`. */
export function makeDeviceId(): string {
  return `cli-${randomBytes(4).toString('hex')}`;
}

/**
 * Turns a proposition pack into events through core's command helpers only
 * (assertProposition / assertCue via packToEvents). Never hand-builds payloads.
 */
export function buildEventsFromPack(pack: PropositionPack, options: ImportBuildOptions): PackEvents {
  const newId = createIdFactory();
  const factory = createEventFactory({
    deviceId: options.deviceId,
    newId,
    now: options.clock,
    startSeq: options.startSeq ?? 0,
  });
  const { events, propositionIds } = packToEvents(pack, factory, newId);
  const cueCount = pack.propositions.reduce((sum, entry) => sum + entry.cues.length, 0);
  return { events, propositionIds, cueCount };
}

export function runImport(opts: CommandOptions, io: CliIO): number {
  const packPath = absolutePath(opts.value('pack'));
  const outPath = absolutePath(opts.value('out'));
  const append = opts.has('append');

  const { text } = readTextFile(packPath, '命题包');
  const parsed = parsePropositionPack(text);
  if (!parsed.pack || parsed.errors.length > 0) {
    const detail = parsed.errors.length > 0 ? '\n' + describeErrors(parsed.errors, 20).join('\n') : '';
    throw new CliError(
      EXIT_DATA,
      `命题包格式错误：${packPath}${detail}`,
      '格式参考 lattice sample 写出的示例包（format: 1）。',
    );
  }
  const pack = parsed.pack;
  if (pack.propositions.length === 0) {
    throw new CliError(EXIT_DATA, `命题包里没有任何命题：${packPath}`);
  }

  if (!append && existsSync(outPath)) {
    throw new CliError(
      EXIT_USAGE,
      `输出文件已存在：${outPath}`,
      '加 --append 追加到末尾，或先删除该文件。',
    );
  }

  const deviceId = makeDeviceId();
  const built = buildEventsFromPack(pack, { deviceId, clock: createStepClock() });
  if (append) appendEventFile(outPath, built.events);
  else writeEventFile(outPath, built.events);

  io.out(
    [
      `已导入 ${pack.propositions.length} 条命题、${built.cueCount} 张卡片`,
      `  事件数   ${built.events.length}`,
      `  设备     ${deviceId}`,
      `  输出     ${outPath}${append ? '（追加）' : ''}`,
    ].join('\n') + '\n',
  );
  return EXIT_OK;
}
