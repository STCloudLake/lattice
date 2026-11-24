#!/usr/bin/env -S tsx
/**
 * Lattice CLI entry point (M0 developer surface).
 *
 * - `replay` re-derives every projection from the event log and prints a digest.
 * - `eval` reports calibration (Brier / ECE / buckets) of the schedule model.
 * - `import` / `export` move proposition packs and canonical JSONL logs.
 * - `doctor` validates a log line by line.
 * - `sample` writes a tiny demo pack.
 *
 * Argument parsing is hand-rolled on purpose: the CLI has no runtime
 * dependencies beyond @lattice/core. Exit codes: 0 ok, 1 usage, 2 data error.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runDoctor } from './commands/doctor.js';
import { runEval } from './commands/eval.js';
import { runExport } from './commands/export.js';
import { runImport } from './commands/import.js';
import { runReplay } from './commands/replay.js';
import { runSample } from './commands/sample.js';
import { CliError, EXIT_OK, EXIT_USAGE } from './errors.js';
import { DEFAULT_EVENTS_FILE } from './fileio.js';

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

export interface CommandOptions {
  /** Value of `--<flag>`; flags with defaults always resolve. Throws if missing. */
  value(flag: string): string;
  /** True for boolean switches, or for value flags that were supplied. */
  has(flag: string): boolean;
}

interface FlagSpec {
  name: string;
  takesValue: boolean;
  desc: string;
}

interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  flags: FlagSpec[];
  /** Value flags that must be supplied on the command line. */
  required: string[];
  /** Value flags with defaults applied before `run` is called. */
  defaults: Record<string, string>;
  examples: string[];
  run(opts: CommandOptions, io: CliIO): number;
}

const IN_FLAG: FlagSpec = {
  name: 'in',
  takesValue: true,
  desc: `输入事件日志（默认 ${DEFAULT_EVENTS_FILE}）`,
};
const JSON_FLAG: FlagSpec = { name: 'json', takesValue: false, desc: '输出机器可读 JSON' };
const OUT_FLAG: FlagSpec = { name: 'out', takesValue: true, desc: '输出文件路径' };

const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'replay',
    summary: '从事件日志重放投影（命题/卡片/复习/到期/新学 + digest）',
    usage: 'lattice replay --in <events.jsonl> [--json] [--at <iso>]',
    flags: [IN_FLAG, JSON_FLAG, { name: 'at', takesValue: true, desc: '以指定 ISO 时间点计算到期与 R（默认现在）' }],
    required: [],
    defaults: { in: DEFAULT_EVENTS_FILE },
    examples: [
      'lattice replay --in events.jsonl',
      'lattice replay --in events.jsonl --json',
      'lattice replay --in events.jsonl --at 2026-12-01T00:00:00.000Z',
    ],
    run: runReplay,
  },
  {
    name: 'eval',
    summary: '校准报告（Brier / ECE / 分桶）',
    usage: 'lattice eval --in <events.jsonl> [--json]',
    flags: [IN_FLAG, JSON_FLAG],
    required: [],
    defaults: { in: DEFAULT_EVENTS_FILE },
    examples: ['lattice eval --in events.jsonl', 'lattice eval --in events.jsonl --json'],
    run: runEval,
  },
  {
    name: 'import',
    summary: '把命题包（JSON）导入为事件日志',
    usage: 'lattice import --pack <pack.json> --out <events.jsonl> [--append]',
    flags: [
      { name: 'pack', takesValue: true, desc: '命题包 JSON（format: 1）' },
      OUT_FLAG,
      { name: 'append', takesValue: false, desc: '追加到已有输出文件末尾' },
    ],
    required: ['pack', 'out'],
    defaults: {},
    examples: [
      'lattice sample --out pack.json',
      'lattice import --pack pack.json --out events.jsonl',
      'lattice import --pack pack.json --out events.jsonl --append',
    ],
    run: runImport,
  },
  {
    name: 'export',
    summary: '规范化事件日志（去重、排序、稳定格式；幂等）',
    usage: 'lattice export --in <events.jsonl> --out <events.jsonl>',
    flags: [IN_FLAG, OUT_FLAG],
    required: ['out'],
    defaults: { in: DEFAULT_EVENTS_FILE },
    examples: [
      'lattice export --in events.jsonl --out events.canonical.jsonl',
      'lattice export --in events.jsonl --out events.jsonl',
    ],
    run: runExport,
  },
  {
    name: 'doctor',
    summary: '体检事件日志（逐行校验、重复 id、孤立事件、seq 单调）',
    usage: 'lattice doctor --in <events.jsonl> [--json]',
    flags: [IN_FLAG, JSON_FLAG],
    required: [],
    defaults: { in: DEFAULT_EVENTS_FILE },
    examples: ['lattice doctor --in events.jsonl', 'lattice doctor --in events.jsonl --json'],
    run: runDoctor,
  },
  {
    name: 'sample',
    summary: '写出一个演示用命题包',
    usage: 'lattice sample --out <pack.json>',
    flags: [OUT_FLAG],
    required: ['out'],
    defaults: {},
    examples: ['lattice sample --out pack.json'],
    run: runSample,
  },
];

interface ParsedArgs {
  values: Map<string, string>;
  switches: Set<string>;
  help: boolean;
}

function parseArgs(tokens: readonly string[], spec: CommandSpec): ParsedArgs {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  let help = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === '--help' || token === '-h') {
      help = true;
      continue;
    }
    if (!token.startsWith('-')) {
      throw new CliError(EXIT_USAGE, `多余的参数：${token}`, `命令 ${spec.name} 只接受选项；见 lattice ${spec.name} --help`);
    }
    if (!token.startsWith('--')) {
      throw new CliError(EXIT_USAGE, `未知参数：${token}`, `见 lattice ${spec.name} --help`);
    }

    const equals = token.indexOf('=');
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);
    const flag = spec.flags.find((candidate) => candidate.name === name);
    if (!flag) {
      throw new CliError(EXIT_USAGE, `未知参数：--${name}`, `可用参数见 lattice ${spec.name} --help`);
    }

    if (flag.takesValue) {
      if (inlineValue !== undefined) {
        values.set(name, inlineValue);
        continue;
      }
      const next = tokens[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new CliError(EXIT_USAGE, `参数 --${name} 需要一个值`, `例如 --${name} <路径>`);
      }
      values.set(name, next);
      index += 1;
    } else {
      if (inlineValue !== undefined) {
        throw new CliError(EXIT_USAGE, `参数 --${name} 不接受值`);
      }
      switches.add(name);
    }
  }

  return { values, switches, help };
}

function buildCommandOptions(parsed: ParsedArgs, spec: CommandSpec): CommandOptions {
  const values = new Map<string, string>(Object.entries(spec.defaults));
  for (const [name, value] of parsed.values) values.set(name, value);
  const { switches } = parsed;
  return {
    value(flag: string): string {
      const resolved = values.get(flag);
      if (resolved === undefined) throw new CliError(EXIT_USAGE, `缺少必需参数 --${flag}`);
      return resolved;
    },
    has(flag: string): boolean {
      return switches.has(flag) || values.has(flag);
    },
  };
}

function renderCommandHelp(spec: CommandSpec): string {
  const lines = [`lattice ${spec.name} — ${spec.summary}`, '', `用法：${spec.usage}`, '', '选项：'];
  const width = spec.flags.reduce((max, flag) => Math.max(max, flag.name.length), 0);
  for (const flag of spec.flags) {
    const rendered = flag.takesValue ? `--${flag.name} <值>` : `--${flag.name}`;
    lines.push(`  ${rendered.padEnd(width + 6)}  ${flag.desc}`);
  }
  lines.push(`  ${'--help, -h'.padEnd(width + 6)}  显示本命令帮助`);
  if (spec.examples.length > 0) {
    lines.push('', '示例：');
    for (const example of spec.examples) lines.push(`  ${example}`);
  }
  return lines.join('\n') + '\n';
}

function renderHelp(): string {
  const lines = ['lattice — 可检查的学习者模型（M0 CLI）', '', '用法：lattice <命令> [选项]', '', '命令：'];
  const width = COMMANDS.reduce((max, command) => Math.max(max, command.name.length), 0);
  for (const command of COMMANDS) {
    lines.push(`  ${command.name.padEnd(width)}  ${command.summary}`);
  }
  lines.push(
    '',
    '通用选项：',
    '  --in <file>    输入事件日志（默认 ./events.jsonl）',
    '  --out <file>   输出文件路径',
    '  --pack <file>  命题包路径',
    '  --json         机器可读输出（JSON）',
    '  --at <iso>     replay 的观察时间点（默认现在）',
    '  --append       追加写入（import）',
    '  --help, -h     显示帮助（可配合任意命令）',
    '',
    '退出码：0 成功 · 1 用法错误 · 2 数据错误（doctor 发现问题 / eval 无样本）',
    '',
    '示例：',
    '  lattice sample --out pack.json',
    '  lattice import --pack pack.json --out events.jsonl',
    '  lattice replay --in events.jsonl',
    '  lattice eval --in events.jsonl',
    '  lattice doctor --in events.jsonl',
  );
  return lines.join('\n') + '\n';
}

/** Runs the CLI without touching process state; returns the exit code. */
export async function runCli(argv: readonly string[], io: CliIO): Promise<number> {
  const [name, ...rest] = argv;

  if (name === undefined) {
    io.err(renderHelp());
    return EXIT_USAGE;
  }
  if (name === '--help' || name === '-h' || name === 'help') {
    io.out(renderHelp());
    return EXIT_OK;
  }

  const spec = COMMANDS.find((command) => command.name === name);
  if (!spec) {
    io.err(`错误：未知命令「${name}」\n\n${renderHelp()}`);
    return EXIT_USAGE;
  }

  try {
    const parsed = parseArgs(rest, spec);
    if (parsed.help) {
      io.out(renderCommandHelp(spec));
      return EXIT_OK;
    }
    for (const flag of spec.required) {
      if (!parsed.values.has(flag)) {
        throw new CliError(EXIT_USAGE, `缺少必需参数 --${flag}`, `用法：${spec.usage}`);
      }
    }
    return spec.run(buildCommandOptions(parsed, spec), io);
  } catch (error) {
    if (error instanceof CliError) {
      io.err(`错误：${error.message}\n`);
      if (error.hint !== undefined) io.err(`提示：${error.hint}\n`);
      return error.code;
    }
    io.err(`内部错误：${(error as Error).message}\n`);
    return EXIT_USAGE;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const io: CliIO = {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  };
  process.exitCode = await runCli(process.argv.slice(2), io);
}

if (isEntryPoint()) {
  void main();
}
