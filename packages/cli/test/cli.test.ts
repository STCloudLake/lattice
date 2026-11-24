import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertChain,
  assertCue,
  assertProposition,
  createEventFactory,
  createIdFactory,
  exportJsonl,
  parseJsonl,
  rateReview,
  replay,
  stateDigest,
  type LatticeEvent,
} from '@lattice/core';
import { buildReplayReport } from '../src/commands/replay.js';
import { runCli, type CliIO } from '../src/cli.js';
import { diagnoseLog } from '../src/commands/doctor.js';
import { createStepClock } from '../src/fileio.js';

interface Capture {
  io: CliIO;
  out: string[];
  err: string[];
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, out, err };
}

function stdout(c: Capture): string {
  return c.out.join('');
}

const createdDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-cli-'));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function writeSamplePack(dir: string): Promise<{ packPath: string; cueCount: number; propositionCount: number }> {
  const packPath = join(dir, 'pack.json');
  expect(await runCli(['sample', '--out', packPath], capture().io)).toBe(0);
  const pack = JSON.parse(readFileSync(packPath, 'utf8')) as {
    propositions: { cues: unknown[] }[];
  };
  const cueCount = pack.propositions.reduce((sum, entry) => sum + entry.cues.length, 0);
  return { packPath, cueCount, propositionCount: pack.propositions.length };
}

describe('lattice cli', () => {
  it('import: a 3-proposition pack becomes propositions + cues and replays to a digest', async () => {
    const dir = tempDir();
    const { packPath, cueCount, propositionCount } = await writeSamplePack(dir);
    expect(propositionCount).toBe(3);

    const eventsPath = join(dir, 'events.jsonl');
    const importCap = capture();
    expect(await runCli(['import', '--pack', packPath, '--out', eventsPath], importCap.io)).toBe(0);
    expect(stdout(importCap)).toContain('已导入');

    const parsed = parseJsonl(readFileSync(eventsPath, 'utf8'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.events.filter((event) => event.type === 'proposition.asserted')).toHaveLength(3);
    expect(parsed.events.filter((event) => event.type === 'cue.asserted')).toHaveLength(cueCount);
    expect(parsed.events).toHaveLength(3 + cueCount);

    const deviceIds = new Set(parsed.events.map((event) => event.deviceId));
    expect(deviceIds.size).toBe(1);
    expect([...deviceIds][0]).toMatch(/^cli-[0-9a-z]{8}$/);
    expect(Math.min(...parsed.events.map((event) => event.seq))).toBe(1);
    expect(new Set(parsed.events.map((event) => event.id)).size).toBe(parsed.events.length);

    const replayCap = capture();
    expect(await runCli(['replay', '--in', eventsPath, '--json'], replayCap.io)).toBe(0);
    const report = JSON.parse(stdout(replayCap)) as {
      digest: string;
      propositionCount: number;
      cueCount: number;
      newCount: number;
      eventCount: number;
    };
    expect(report.eventCount).toBe(parsed.events.length);
    expect(report.propositionCount).toBe(3);
    expect(report.cueCount).toBe(cueCount);
    expect(report.newCount).toBe(3);
    expect(report.digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('round-trip: the exported log replays to the same digest as the pre-export events', async () => {
    const dir = tempDir();
    const { packPath } = await writeSamplePack(dir);
    const eventsPath = join(dir, 'events.jsonl');
    const exportedPath = join(dir, 'exported.jsonl');

    expect(await runCli(['import', '--pack', packPath, '--out', eventsPath], capture().io)).toBe(0);

    // Add reviews through core's command helpers so the projection is non-trivial.
    const imported = parseJsonl(readFileSync(eventsPath, 'utf8')).events;
    const cueByProposition = new Map<string, string>();
    for (const event of imported) {
      if (event.type !== 'cue.asserted') continue;
      const propositionId = event.payload['propositionId'];
      if (typeof propositionId === 'string' && typeof event.subjectId === 'string') {
        cueByProposition.set(propositionId, event.subjectId);
      }
    }
    expect(cueByProposition.size).toBe(3);

    const factory = createEventFactory({
      deviceId: 'review-device',
      newId: createIdFactory(),
      now: createStepClock(),
    });
    const reviewEvents = [...cueByProposition.entries()].flatMap(([propositionId, cueId]) => [
      rateReview(factory, { propositionId, cueId, grade: 3 }),
      rateReview(factory, { propositionId, cueId, grade: 4 }),
    ]);
    appendFileSync(eventsPath, exportJsonl(reviewEvents), 'utf8');

    // Reference value: the projection digest of the event array *before* export.
    const preExport = parseJsonl(readFileSync(eventsPath, 'utf8')).events;
    expect(preExport.length).toBeGreaterThan(imported.length);
    const referenceDigest = stateDigest(replay(preExport));

    expect(await runCli(['export', '--in', eventsPath, '--out', exportedPath], capture().io)).toBe(0);

    const exported = parseJsonl(readFileSync(exportedPath, 'utf8')).events;
    expect(exported).toHaveLength(preExport.length);
    expect(stateDigest(replay(exported))).toBe(referenceDigest);

    const replayCap = capture();
    expect(await runCli(['replay', '--in', exportedPath, '--json'], replayCap.io)).toBe(0);
    const report = JSON.parse(stdout(replayCap)) as { digest: string; reviewCount: number };
    expect(report.digest).toBe(referenceDigest);
    expect(report.reviewCount).toBe(reviewEvents.length);
  });

  it('export is idempotent: exporting an exported file is byte-identical', async () => {
    const dir = tempDir();
    const { packPath } = await writeSamplePack(dir);
    const eventsPath = join(dir, 'events.jsonl');
    const firstPath = join(dir, 'first.jsonl');
    const secondPath = join(dir, 'second.jsonl');

    expect(await runCli(['import', '--pack', packPath, '--out', eventsPath], capture().io)).toBe(0);

    // Duplicate two lines: export must dedupe them away.
    const lines = readFileSync(eventsPath, 'utf8').trimEnd().split('\n');
    appendFileSync(eventsPath, lines[0]! + '\n' + lines[0]! + '\n', 'utf8');

    const firstCap = capture();
    expect(await runCli(['export', '--in', eventsPath, '--out', firstPath], firstCap.io)).toBe(0);
    expect(stdout(firstCap)).toContain('去重 2 条');

    expect(await runCli(['export', '--in', firstPath, '--out', secondPath], capture().io)).toBe(0);
    expect(readFileSync(secondPath)).toEqual(readFileSync(firstPath));
  });

  it('doctor flags malformed lines and structural problems (pure diagnosis)', async () => {
    const base = {
      occurredAt: '2026-11-01T00:00:00.000Z',
      recordedAt: '2026-11-01T00:00:00.000Z',
      actor: 'human' as const,
    };
    const proposition: LatticeEvent = {
      ...base,
      id: 'evt-prop',
      deviceId: 'dev-a',
      seq: 1,
      type: 'proposition.asserted',
      subjectId: 'prop-1',
      payload: { statement: 'A' },
    };
    const cue: LatticeEvent = {
      ...base,
      id: 'evt-cue',
      deviceId: 'dev-a',
      seq: 2,
      type: 'cue.asserted',
      subjectId: 'cue-1',
      payload: { propositionId: 'prop-1', front: 'f', back: 'b' },
    };
    const review: LatticeEvent = {
      ...base,
      id: 'evt-review',
      deviceId: 'dev-a',
      seq: 3,
      type: 'review.rated',
      subjectId: 'prop-1',
      payload: { cueId: 'cue-1', grade: 3 },
    };
    const duplicateId: LatticeEvent = { ...proposition, seq: 6 };
    const orphanCue: LatticeEvent = {
      ...base,
      id: 'evt-orphan-cue',
      deviceId: 'dev-b',
      seq: 1,
      type: 'cue.asserted',
      subjectId: 'cue-x',
      payload: { propositionId: 'missing-prop', front: 'f', back: 'b' },
    };
    const orphanReview: LatticeEvent = {
      ...base,
      id: 'evt-orphan-review',
      deviceId: 'dev-b',
      seq: 2,
      type: 'review.rated',
      subjectId: 'missing-prop',
      payload: { cueId: 'cue-x', grade: 2 },
    };
    const badSchema = { ...proposition, id: 'evt-bad-schema', seq: 7, type: 'nonsense' };
    const jumpAhead: LatticeEvent = { ...proposition, id: 'evt-seq-9', seq: 9 };
    const goesBackwards: LatticeEvent = { ...proposition, id: 'evt-seq-4', seq: 4 };

    const lines = [
      JSON.stringify(proposition),
      JSON.stringify(cue),
      JSON.stringify(review),
      JSON.stringify(duplicateId),
      JSON.stringify(orphanCue),
      JSON.stringify(orphanReview),
      JSON.stringify(badSchema),
      JSON.stringify(jumpAhead),
      JSON.stringify(goesBackwards),
      '{not json',
    ];
    const text = lines.join('\n') + '\n';
    const report = diagnoseLog(text, 'bad.jsonl');

    expect(report.ok).toBe(false);
    expect(report.eventCount).toBe(8);
    expect(report.problems.invalidJson).toHaveLength(1);
    expect(report.problems.schemaErrors).toHaveLength(1);
    expect(report.problems.duplicateIds).toHaveLength(1);
    expect(report.problems.duplicateIds[0]!.id).toBe('evt-prop');
    expect(report.problems.orphanCues).toHaveLength(1);
    expect(report.problems.orphanReviews).toHaveLength(1);
    expect(report.problems.nonMonotonicSeq).toHaveLength(1);
    expect(report.problems.nonMonotonicSeq[0]!.seq).toBe(4);
    expect(report.problemCount).toBe(6);

    // Clean log: no problems.
    const clean = diagnoseLog(exportJsonl([proposition, cue, review]), 'clean.jsonl');
    expect(clean.ok).toBe(true);
    expect(clean.problemCount).toBe(0);
    expect(clean.eventCount).toBe(3);

    // The command exits 2 when the log is broken.
    const dir = tempDir();
    const badPath = join(dir, 'bad.jsonl');
    writeFileSync(badPath, text, 'utf8');
    const cap = capture();
    expect(await runCli(['doctor', '--in', badPath], cap.io)).toBe(2);
    expect(stdout(cap)).toContain('JSON 解析错误');
  });

  it('eval reports n > 0 with a finite Brier once there are second reviews', async () => {
    const dir = tempDir();
    const eventsPath = join(dir, 'events.jsonl');

    let tick = Date.parse('2026-11-01T00:00:00.000Z');
    const advanceDays = (days: number): void => {
      tick += days * 86_400_000;
    };
    const clock = (): Date => new Date(tick);
    const newId = createIdFactory();
    const factory = createEventFactory({ deviceId: 'eval-device', newId, now: clock, startSeq: 0 });

    const events: LatticeEvent[] = [];
    for (const label of ['A', 'B']) {
      const { propositionId, event: propositionEvent } = assertProposition(factory, newId, { statement: label });
      events.push(propositionEvent);
      const { cueId, event: cueEvent } = assertCue(factory, newId, {
        propositionId,
        front: label,
        back: label,
      });
      events.push(cueEvent);
      advanceDays(1);
      events.push(rateReview(factory, { propositionId, cueId, grade: 3 })); // first review: no prediction
      advanceDays(3);
      events.push(rateReview(factory, { propositionId, cueId, grade: 3 })); // second review: rBefore > 0
      advanceDays(1);
    }
    writeFileSync(eventsPath, exportJsonl(events), 'utf8');

    const cap = capture();
    expect(await runCli(['eval', '--in', eventsPath, '--json'], cap.io)).toBe(0);
    const report = JSON.parse(stdout(cap)) as { n: number; brier: number; ece: number; buckets: unknown[] };
    expect(report.n).toBeGreaterThan(0);
    expect(Number.isFinite(report.brier)).toBe(true);
    expect(Number.isFinite(report.ece)).toBe(true);
    expect(report.buckets.length).toBeGreaterThan(0);
  });

  it('eval exits 2 and says so when there are no scoreable samples', async () => {
    const dir = tempDir();
    const { packPath } = await writeSamplePack(dir);
    const eventsPath = join(dir, 'events.jsonl');
    expect(await runCli(['import', '--pack', packPath, '--out', eventsPath], capture().io)).toBe(0);

    const cap = capture();
    expect(await runCli(['eval', '--in', eventsPath], cap.io)).toBe(2);
    expect(stdout(cap)).toContain('样本数: 0');
    expect(cap.err.join('')).toContain('样本数 0');
  });

  it('usage errors exit 1; --help exits 0; import refuses to overwrite without --append', async () => {
    expect(await runCli(['--help'], capture().io)).toBe(0);
    expect(await runCli(['nope'], capture().io)).toBe(1);
    expect(await runCli(['import', '--out', 'events.jsonl'], capture().io)).toBe(1);
    expect(await runCli(['replay', '--bogus'], capture().io)).toBe(1);

    const dir = tempDir();
    const { packPath } = await writeSamplePack(dir);
    const eventsPath = join(dir, 'events.jsonl');
    expect(await runCli(['import', '--pack', packPath, '--out', eventsPath], capture().io)).toBe(0);

    const refused = capture();
    expect(await runCli(['import', '--pack', packPath, '--out', eventsPath], refused.io)).toBe(1);
    expect(refused.err.join('')).toContain('已存在');

    // --append is allowed, and replays as a superset.
    expect(await runCli(['import', '--pack', packPath, '--out', eventsPath, '--append'], capture().io)).toBe(0);
    const replayed = capture();
    expect(await runCli(['replay', '--in', eventsPath, '--json'], replayed.io)).toBe(0);
    const report = JSON.parse(stdout(replayed)) as { propositionCount: number; eventCount: number };
    expect(report.propositionCount).toBe(6);
    expect(report.eventCount).toBe(18);
  });
});


describe('reasoning chains in the CLI', () => {
  function chainLog() {
    let n = 0;
    const newId = () => 'e' + String(++n).padStart(3, '0');
    const factory = createEventFactory({
      deviceId: 'chain-test',
      newId,
      now: () => new Date('2026-11-24T00:00:00.000Z'),
    });
    const a = assertProposition(factory, newId, { statement: '前提 A 成立。' });
    const b = assertProposition(factory, newId, { statement: '前提 B 成立。' });
    const c = assertProposition(factory, newId, { statement: '所以结论 C 成立。' });
    const chain = assertChain(factory, newId, {
      premiseIds: [a.propositionId, b.propositionId],
      conclusionId: c.propositionId,
      strength: 0.7,
    });
    return [a.event, b.event, c.event, chain.event];
  }

  it('reports chain and prerequisite counts on replay', () => {
    const events = chainLog();
    const report = buildReplayReport(replay(events), {
      inPath: 'inline',
      at: '2026-11-24T00:00:00.000Z',
      eventCount: events.length,
      parseErrors: 0,
    });
    expect(report.chainCount).toBe(1);
    expect(report.prerequisiteEdgeCount).toBe(2);
    expect(report.propositionCount).toBe(3);
  });

  it('accepts a well-formed chain in doctor', () => {
    const report = diagnoseLog(exportJsonl(chainLog()), 'inline');
    expect(report.ok).toBe(true);
    expect(report.problems.orphanChains).toHaveLength(0);
  });

  it('flags a chain that points at a missing proposition', () => {
    const events = chainLog();
    const broken = events.map((event) =>
      event.type === 'chain.asserted'
        ? { ...event, payload: { ...event.payload, conclusion: 'missing-id' } }
        : event,
    );
    const report = diagnoseLog(exportJsonl(broken), 'inline');
    expect(report.ok).toBe(false);
    expect(report.problems.orphanChains).toHaveLength(1);
    expect(report.problems.orphanChains[0]?.missing).toContain('missing-id');
  });
});
