#!/usr/bin/env node
/**
 * M0 acceptance runner.
 *
 *   node scripts/verify-m0.mjs            # static + smoke + CLI round-trip + tests
 *   node scripts/verify-m0.mjs --e2e      # also load the extension in a real browser
 *
 * Prints a PASS/FAIL table and exits non-zero if anything fails, so CI can use it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const withE2e = process.argv.includes('--e2e');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail ?? '' });
  } catch (err) {
    results.push({ name, ok: false, detail: String((err && err.message) || err).split('\n')[0] });
  }
}
function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
    ...opts,
  });
}
const isWin = process.platform === 'win32';
const NODE = process.execPath;
// Run tool entry points directly: .cmd shims need a shell on Windows, and
// shell:true breaks argument quoting for temp paths.
const TSC = path.join(root, 'node_modules/typescript/bin/tsc');
const VITEST = path.join(root, 'node_modules/vitest/vitest.mjs');
const TSX = path.join(root, 'node_modules/tsx/dist/cli.mjs');
const cli = (args) => run(NODE, [TSX, 'packages/cli/src/cli.ts', ...args]);

// ---------------------------------------------------------------------------
check('core + extension build', () => {
  run(NODE, [TSC, '-p', 'packages/core/tsconfig.json']);
  run(NODE, ['scripts/build-extension.mjs']);
  const vendor = path.join(root, 'packages/extension/vendor/lattice-core/index.js');
  if (!existsSync(vendor)) throw new Error('vendor/lattice-core/index.js missing');
  return `${(readFileSync(vendor).length / 1024).toFixed(0)} KiB bundle`;
});

check('unit tests', () => {
  const out = run(NODE, [VITEST, 'run', '--reporter=dot']);
  const m = out.match(/Tests\s+(\d+) passed/);
  if (!m) throw new Error('could not parse vitest output');
  return `${m[1]} passed`;
});

check('extension files present', () => {
  const required = [
    'manifest.json',
    'background.js',
    'newtab/newtab.html',
    'newtab/newtab.js',
    'newtab/newtab.css',
    'worker/worker.js',
    'worker/service.js',
    'worker/db.js',
    'data/sample-pack.json',
  ];
  const missing = required.filter((f) => !existsSync(path.join(root, 'packages/extension', f)));
  if (missing.length > 0) throw new Error('missing: ' + missing.join(', '));
  return `${required.length} files`;
});

check('manifest is MV3 and allows wasm', () => {
  const m = JSON.parse(readFileSync(path.join(root, 'packages/extension/manifest.json'), 'utf8'));
  if (m.manifest_version !== 3) throw new Error('manifest_version must be 3');
  if (!m.chrome_url_overrides?.newtab) throw new Error('newtab override missing');
  const csp = m.content_security_policy?.extension_pages ?? '';
  if (!csp.includes('wasm-unsafe-eval')) throw new Error("CSP must allow 'wasm-unsafe-eval'");
  if (!m.cross_origin_embedder_policy) throw new Error('COEP missing (needed for OPFS SAB)');
  return `v${m.version}, ${m.permissions.join('+')}`;
});

check('no remote code / no dangerous eval in extension', () => {
  const files = ['newtab/newtab.js', 'worker/worker.js', 'worker/service.js', 'worker/db.js', 'worker/persist.js', 'background.js'];
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(path.join(root, 'packages/extension', f), 'utf8');
    if (/\beval\s*\(/.test(src)) offenders.push(`${f}: eval`);
    if (/new Function\s*\(/.test(src)) offenders.push(`${f}: new Function`);
    if (/innerHTML|insertAdjacentHTML/.test(src)) offenders.push(`${f}: HTML injection sink`);
    if (/https?:\/\//.test(src.replace(/\/\/.*$/gm, ''))) offenders.push(`${f}: remote URL`);
  }
  if (offenders.length > 0) throw new Error(offenders.join('; '));
  return 'clean';
});

check('worker data-layer smoke test', () => {
  const out = run(process.execPath, ['packages/extension/test/worker-smoke.mjs']);
  const m = out.match(/SMOKE OK.*?digest ([0-9a-f]+)/);
  if (!m) throw new Error('smoke test did not report OK');
  return `digest ${m[1]}`;
});

check('extension bundle exports the extraction API', () => {
  const out = run(NODE, [
    '--input-type=module',
    '-e',
    "import('./packages/extension/vendor/lattice-core/index.js').then(m => { " +
      "const need = ['normalizeSource','extractCandidate','resolveIdentity','buildMergePlan','planToEvents','assertChain','prerequisiteEdges']; " +
      "const missing = need.filter(k => typeof m[k] !== 'function'); " +
      "if (missing.length) { console.error('missing: ' + missing.join(',')); process.exit(1); } " +
      "console.log('ok'); })",
  ]);
  if (!out.includes('ok')) throw new Error('bundle missing exports');
  return '7 exports';
});

check('CLI round-trip: import -> replay -> export -> replay', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lattice-verify-'));
  try {
    const pack = path.join(dir, 'pack.json');
    const events = path.join(dir, 'events.jsonl');
    const exported = path.join(dir, 'exported.jsonl');
    cli(['sample', '--out', pack]);
    cli(['import', '--pack', pack, '--out', events]);
    const before = JSON.parse(run(NODE, [TSX, 'packages/cli/src/cli.ts', 'replay', '--in', events, '--json']));
    cli(['export', '--in', events, '--out', exported]);
    const after = JSON.parse(run(NODE, [TSX, 'packages/cli/src/cli.ts', 'replay', '--in', exported, '--json']));
    if (!before.digest || before.digest !== after.digest) {
      throw new Error(`digest mismatch: ${before.digest} vs ${after.digest}`);
    }
    // export must be idempotent
    const again = path.join(dir, 'exported2.jsonl');
    cli(['export', '--in', exported, '--out', again]);
    if (readFileSync(exported).compare(readFileSync(again)) !== 0) throw new Error('export is not idempotent');
    return `digest ${before.digest}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('chain events survive replay + doctor', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lattice-chain-'));
  try {
    const eventsPath = path.join(dir, 'chain.jsonl');
    const build = [
      "import { assertChain, assertProposition, createEventFactory, exportJsonl } from '@lattice/core';",
      "import { writeFileSync } from 'node:fs';",
      "let n = 0; const newId = () => 'e' + String(++n).padStart(3, '0');",
      "const f = createEventFactory({ deviceId: 'verify', newId, now: () => new Date('2026-11-24T00:00:00.000Z') });",
      "const a = assertProposition(f, newId, { statement: '前提 A。' });",
      "const b = assertProposition(f, newId, { statement: '前提 B。' });",
      "const c = assertProposition(f, newId, { statement: '结论 C。' });",
      "const k = assertChain(f, newId, { premiseIds: [a.propositionId, b.propositionId], conclusionId: c.propositionId, strength: 0.7 });",
      "writeFileSync(process.argv[1], exportJsonl([a.event, b.event, c.event, k.event]));",
    ].join('\n');
    run(NODE, ['--input-type=module', '-e', build, eventsPath]);
    const report = JSON.parse(run(NODE, [TSX, 'packages/cli/src/cli.ts', 'replay', '--in', eventsPath, '--json']));
    if (report.chainCount !== 1) throw new Error(`chainCount=${report.chainCount}`);
    if (report.prerequisiteEdgeCount !== 2) throw new Error(`prereqEdges=${report.prerequisiteEdgeCount}`);
    const doc = run(NODE, [TSX, 'packages/cli/src/cli.ts', 'doctor', '--in', eventsPath, '--json']);
    if (!JSON.parse(doc).ok) throw new Error('doctor reported problems');
    return `chain=1, prereq=2`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('background capture orchestration', () => {
  const out = run(process.execPath, ['packages/extension/test/background-smoke.mjs']);
  if (!out.includes('BACKGROUND SMOKE OK')) throw new Error('background smoke did not report OK');
  return '7 cases';
});

check('feed policy smoke test', () => {
  const out = run(process.execPath, ['packages/extension/test/feed-smoke.mjs']);
  if (!out.includes('FEED SMOKE OK')) throw new Error('feed smoke did not report OK');
  const m = out.match(/digest ([0-9a-f]+)/);
  return m ? `digest ${m[1]}` : 'ok';
});

check('extraction capture smoke test', () => {
  const out = run(process.execPath, ['packages/extension/test/capture-smoke.mjs']);
  if (!out.includes('CAPTURE SMOKE OK')) throw new Error('capture smoke did not report OK');
  const m = out.match(/digest ([0-9a-f]+)/);
  return m ? `digest ${m[1]}` : 'ok';
});

if (withE2e) {
  check('real MV3 browser E2E', () => {
    const out = run(process.execPath, ['packages/extension/test/extension-e2e.mjs'], { timeout: 240_000 });
    const storage = out.match(/diag:\s*(.+)/)?.[1]?.trim();
    if (!out.includes('E2E OK')) throw new Error('E2E did not report OK');
    return storage ?? 'ok';
  });
}

// ---------------------------------------------------------------------------
const pad = Math.max(...results.map((r) => r.name.length));
console.log('\nM1a acceptance\n' + '─'.repeat(pad + 24));
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(pad)}  ${r.detail}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log('─'.repeat(pad + 24));
console.log(failed === 0 ? `ALL ${results.length} CHECKS PASSED` : `${failed} of ${results.length} CHECKS FAILED`);
if (!withE2e) console.log('(run with --e2e to also load the extension in a real browser)');
process.exit(failed === 0 ? 0 : 1);
