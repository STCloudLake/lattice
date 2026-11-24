import { createDomainResolver, interestWeightAt, replay, type Interest, type LearnerState } from '@lattice/core';
import type { CliIO, CommandOptions } from '../cli.js';
import { CliError, EXIT_OK, EXIT_USAGE } from '../errors.js';
import { absolutePath, readEventFile } from '../fileio.js';
import { kvLines, renderTable } from '../ui.js';

interface DomainRow {
  canonical: string;
  declared: boolean;
  level: string;
  weight: number;
  effectiveWeight: number;
  captures: number;
  propositions: number;
  aliases: string[];
}

function normalizeAt(raw: string | undefined): string {
  if (raw === undefined) return new Date().toISOString();
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new CliError(EXIT_USAGE, `--at 不是合法时间：${raw}`, '示例：--at 2026-11-24T00:00:00.000Z');
  }
  return new Date(parsed).toISOString();
}

function buildRows(state: LearnerState, at: string): DomainRow[] {
  const resolver = createDomainResolver(state.domainAliases);
  const propositions = new Map<string, number>();
  for (const proposition of Object.values(state.propositions)) {
    if (proposition.status !== 'active' || !proposition.domain) continue;
    const key = resolver(proposition.domain).trim().toLowerCase();
    propositions.set(key, (propositions.get(key) ?? 0) + 1);
  }
  const aliasesByCanonical = new Map<string, string[]>();
  for (const rule of state.domainAliases) {
    const canonical = resolver(rule.canonical);
    const list = aliasesByCanonical.get(canonical) ?? [];
    if (!list.includes(rule.alias)) list.push(rule.alias);
    aliasesByCanonical.set(canonical, list);
  }

  return Object.values(state.interests)
    .map((interest: Interest) => {
      const key = resolver(interest.name).trim().toLowerCase();
      return {
        canonical: resolver(interest.name),
        declared: interest.declared,
        level: interest.level,
        weight: Number(interest.weight.toFixed(2)),
        effectiveWeight: Number(interestWeightAt(interest, at).toFixed(2)),
        captures: interest.captureCount,
        propositions: propositions.get(key) ?? 0,
        aliases: aliasesByCanonical.get(resolver(interest.name)) ?? [],
      };
    })
    .sort((a, b) => b.effectiveWeight - a.effectiveWeight || (a.canonical < b.canonical ? -1 : 1));
}

export function runDomains(opts: CommandOptions, io: CliIO): number {
  const inPath = absolutePath(opts.value('in'));
  const at = normalizeAt(opts.has('at') ? opts.value('at') : undefined);
  const read = readEventFile(inPath);
  const state = replay(read.events);
  const rows = buildRows(state, at);

  if (opts.has('json')) {
    io.out(
      JSON.stringify(
        {
          command: 'domains',
          in: inPath,
          at,
          domains: rows,
          aliases: state.domainAliases.map((rule) => ({ alias: rule.alias, canonical: rule.canonical })),
          parseErrors: read.errors.length,
        },
        null,
        2,
      ) + '\n',
    );
    return EXIT_OK;
  }

  const lines: string[] = ['兴趣领域'];
  lines.push(...kvLines([['输入文件', inPath], ['时间点', at]]));
  lines.push('');
  if (rows.length === 0) {
    lines.push('  还没有任何兴趣：捕获一个页面，或在扩展里声明领域。');
  } else {
    lines.push(
      ...renderTable(
        [
          { title: '规范名', width: 14 },
          { title: '来源', width: 6 },
          { title: '水平', width: 8 },
          { title: '权重', width: 7 },
          { title: '衰减后', width: 8 },
          { title: '捕获', width: 5 },
          { title: '命题', width: 5 },
        ],
        rows.map((row) => [
          row.canonical,
          row.declared ? '声明' : '推断',
          row.level,
          row.weight.toFixed(2),
          row.effectiveWeight.toFixed(2),
          String(row.captures),
          String(row.propositions),
        ]),
        7,
      ),
    );
    const total = rows.reduce((sum, row) => sum + row.propositions, 0);
    lines.push('', `  命题合计 ${total}`);
  }

  const aliases = rows.flatMap((row) => row.aliases.map((alias) => `${alias} → ${row.canonical}`));
  if (aliases.length > 0) {
    lines.push('', `  别名：${aliases.join('、')}`);
  }
  io.out(lines.join('\n') + '\n');
  return EXIT_OK;
}
