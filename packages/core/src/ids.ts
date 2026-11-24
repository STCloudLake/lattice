import type { Id } from './types.js';

const CHARS = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32 (no i, l, o, u)

/**
 * Monotonic-ish ULID-like id: 10 chars of timestamp (ms, base32) + 4 chars
 * counter + 6 chars randomness. Lexicographic order follows time, which keeps
 * logs diff-friendly and makes debugging easier than raw UUIDs.
 */
export function createIdFactory(opts: {
  /** Injectable for deterministic tests. */
  now?: () => number;
  random?: () => Uint8Array;
  randomLength?: number;
} = {}): () => Id {
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? (() => {
    const buf = new Uint8Array(16);
    globalThis.crypto.getRandomValues(buf);
    return buf;
  });
  let counter = 0;

  return function newId(): Id {
    const ts = now();
    let t = ts;
    const time: string[] = [];
    for (let i = 0; i < 10; i++) {
      time.unshift(CHARS[t % 32]!);
      t = Math.floor(t / 32);
    }
    counter = (counter + 1) % 65536;
    const c = counter.toString(32).padStart(4, '0');

    const bytes = random();
    const wanted = opts.randomLength ?? 6;
    let rand = '';
    for (let i = 0; i < wanted; i++) {
      rand += CHARS[(bytes[i % bytes.length] ?? 0) % 32]!;
    }
    return time.join('') + c + rand;
  };
}

/** FNV-1a 64-bit, hex. Deterministic across runtimes (no crypto needed). */
export function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Canonical JSON: object keys sorted recursively, so digests are stable. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}
