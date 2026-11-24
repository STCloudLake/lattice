/**
 * Builds the loadable extension folder:
 *   1. bundles @lattice/core (ESM, browser target) into extension/vendor/lattice-core
 *   2. vendors the sqlite-wasm dist so the worker can import it with relative paths
 *
 * The extension itself is plain JS/HTML (no framework, no build step).
 */
import { cp, mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const coreEntry = path.join(root, 'packages/extract/src/bundle.ts');
const vendor = path.join(root, 'packages/extension/vendor');
const sqliteDist = path.join(root, 'node_modules/@sqlite.org/sqlite-wasm/dist');

const pkg = JSON.parse(await readFile(path.join(root, 'packages/core/package.json'), 'utf8'));

await rm(vendor, { recursive: true, force: true });
await mkdir(path.join(vendor, 'lattice-core'), { recursive: true });
await mkdir(path.join(vendor, 'sqlite-wasm'), { recursive: true });

const result = await build({
  entryPoints: [coreEntry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: path.join(vendor, 'lattice-core/index.js'),
  metafile: true,
  logLevel: 'warning',
});

await cp(sqliteDist, path.join(vendor, 'sqlite-wasm'), { recursive: true });

// Seed curriculum ships with the extension so a new install has something to
// push before the user captures anything (and before a model is configured).
const seedSrc = path.join(root, 'examples/seed-curriculum.json');
const seedDst = path.join(root, 'packages/extension/data/seed-curriculum.json');
await mkdir(path.dirname(seedDst), { recursive: true });
await cp(seedSrc, seedDst);

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`vendor ready: lattice-core (${(bytes / 1024).toFixed(1)} KiB, v${pkg.version}) + sqlite-wasm`);
