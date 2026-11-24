/**
 * Lattice M0 service: the single writer of the event log inside the extension.
 *
 * Rules this file follows (see docs/design §5 and the M0 scope):
 *   - The event log is the only source of truth; the four ledgers are rebuilt by
 *     `replay()` after every write (M0 data is small; correctness > incremental).
 *   - Every write is ONE transaction: insert events + bump meta.seq + COMMIT.
 *   - Nothing here touches DOM, chrome.*, sqlite-wasm or OPFS: the caller injects
 *     a database wrapper (worker/db.js) and optionally a fallback persistence
 *     object (worker/persist.js). That makes the whole service testable in Node
 *     against an in-memory SQLite database.
 */

import {
  activePropositions,
  answerQuiz,
  buildQueue,
  calibrate,
  createEventFactory,
  createIdFactory,
  dueItems,
  emptyMastery,
  exportJsonl as exportEventsJsonl,
  formatReport,
  masterySummary,
  newItems,
  packToEvents,
  parseJsonl,
  parsePropositionPack,
  rateReview,
  replay,
  retrievability,
  samplesFromState,
  stateDigest,
} from '../vendor/lattice-core/index.js';
import { normalizeStatement } from './util.js';

/** How many new propositions a single queue may introduce. */
const NEW_PER_QUEUE = 20;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    subject_id TEXT,
    payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS events_order ON events(occurred_at, device_id, seq)`,
];

const INSERT_EVENT_SQL = `INSERT OR IGNORE INTO events
  (id, device_id, seq, occurred_at, recorded_at, actor, type, subject_id, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const UPSERT_META_SQL = `INSERT INTO meta(key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

const SELECT_EVENTS_SQL = `SELECT id, device_id, seq, occurred_at, recorded_at, actor, type, subject_id, payload
  FROM events ORDER BY occurred_at, device_id, seq`;

function parsePayload(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function rowToEvent(row) {
  const event = {
    id: row.id,
    deviceId: row.device_id,
    seq: Number(row.seq),
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    actor: row.actor,
    type: row.type,
    payload: parsePayload(row.payload),
  };
  if (typeof row.subject_id === 'string') event.subjectId = row.subject_id;
  return event;
}

export class LatticeService {
  #db;
  #mode;
  #storageDetail;
  #persistence;
  #clock;
  #newId;
  #uuid;
  #deviceId = '';
  #seq = 0;
  #events = null;
  #state = null;
  #seedErrors = [];
  #openErrors = [];

  /**
   * @param {object} options
   * @param {object} options.db wrapped DB (see worker/db.js)
   * @param {'opfs'|'fallback'} options.mode
   * @param {'opfs'|'opfs-sahpool'|'memory'} [options.storageDetail]
   * @param {{load: Function, save: Function, mark: Function, flush: Function}|null} [options.persistence]
   * @param {{now: () => Date}} [options.clock]
   * @param {() => string} [options.idFactory]
   * @param {() => string} [options.uuid]
   * @param {string[]} [options.openErrors]
   */
  constructor(options) {
    this.#db = options.db;
    this.#mode = options.mode;
    this.#storageDetail = options.storageDetail ?? options.mode;
    this.#persistence = options.persistence ?? null;
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#newId = options.idFactory ?? createIdFactory();
    this.#uuid = options.uuid ?? (() => globalThis.crypto.randomUUID());
    this.#openErrors = Array.isArray(options.openErrors) ? options.openErrors.slice(0, 6) : [];
  }

  /**
   * @param {object} options same as the constructor, plus `seed`.
   *   seed = {deviceId?, seq?, jsonl?} loaded from chrome.storage.local in
   *   fallback mode (see worker/persist.js).
   */
  static async open(options) {
    const service = new LatticeService(options);
    await service.#init(options.seed ?? null);
    return service;
  }

  async #init(seed) {
    for (const sql of SCHEMA) this.#db.exec(sql);

    if (seed) {
      const jsonl = typeof seed.jsonl === 'string' ? seed.jsonl : '';
      const parsed = parseJsonl(jsonl);
      this.#seedErrors = parsed.errors.slice(0, 5);
      if (parsed.events.length > 0) this.#insertRaw(parsed.events);
    }

    const storedDeviceId = this.#getMeta('deviceId');
    const seedDeviceId = seed && typeof seed.deviceId === 'string' && seed.deviceId.length > 0 ? seed.deviceId : null;
    this.#deviceId = storedDeviceId ?? seedDeviceId ?? this.#uuid();
    if (storedDeviceId === null) this.#setMeta('deviceId', this.#deviceId);

    const storedSeq = Number(this.#getMeta('seq') ?? 0) || 0;
    const ownMaxSeq =
      Number(
        this.#db.value('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events WHERE device_id = ?', [this.#deviceId]),
      ) || 0;
    const seedSeq = seed && Number.isFinite(Number(seed.seq)) ? Number(seed.seq) : 0;
    this.#seq = Math.max(storedSeq, ownMaxSeq, seedSeq);
    this.#setMeta('seq', String(this.#seq));

    this.#invalidate();
    this.#ensureState(); // fail fast if the database cannot be read
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Full render payload for the newtab UI. */
  state() {
    return this.render();
  }

  initPayload() {
    const render = this.render();
    return {
      deviceId: this.#deviceId,
      storage: this.#mode,
      storageDetail: this.#storageDetail,
      persisted: Boolean(this.#persistence),
      counts: render.counts,
      digest: render.digest,
      dueCount: render.counts.due,
      newCount: render.counts.new,
      empty: render.empty,
      lastSeq: this.#seq,
      seedErrors: this.#seedErrors,
      openErrors: this.#openErrors,
    };
  }

  render() {
    const state = this.#ensureState();
    const nowIso = this.#clock.now().toISOString();
    const active = activePropositions(state);
    const due = dueItems(state, nowIso);
    const fresh = newItems(state, 100000);
    const queueItems = buildQueue(state, nowIso, { newLimit: NEW_PER_QUEUE });
    const report = calibrate(samplesFromState(state));

    return {
      schemaVersion: 1,
      generatedAt: nowIso,
      deviceId: this.#deviceId,
      storage: this.#mode,
      storageDetail: this.#storageDetail,
      persisted: Boolean(this.#persistence),
      lastSeq: this.#seq,
      digest: stateDigest(state),
      empty: active.length === 0,
      counts: {
        propositions: active.length,
        cues: Object.keys(state.cues).length,
        reviews: state.reviews.length,
        due: due.length,
        new: fresh.length,
        events: this.#eventCount(),
      },
      calibration: {
        n: report.n,
        brier: report.brier,
        baselineBrier: report.baselineBrier,
        ece: report.ece,
        beatsBaseline: report.beatsBaseline,
      },
      queue: queueItems.map((item) => this.#queueView(state, item, nowIso)),
    };
  }

  diagnostics() {
    const state = this.#ensureState();
    const render = this.render();
    const report = calibrate(samplesFromState(state));
    return {
      schemaVersion: 1,
      storage: this.#mode,
      storageDetail: this.#storageDetail,
      persisted: Boolean(this.#persistence),
      deviceId: this.#deviceId,
      lastSeq: this.#seq,
      digest: render.digest,
      counts: render.counts,
      eventCount: this.#eventCount(),
      calibration: report,
      reportText: formatReport(report),
      openErrors: this.#openErrors,
      seedErrors: this.#seedErrors,
    };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Imports a proposition pack (M0's hand-writable format, parsed by the core).
   * Entries whose statement already exists are skipped: M0 has no identity merge,
   * and silently duplicating every card on a second import would be worse.
   */
  importPack(text) {
    const { pack, errors } = parsePropositionPack(String(text ?? ''));
    if (!pack) return { addedPropositions: 0, addedCues: 0, skipped: 0, errors };

    const state = this.#ensureState();
    const existing = new Set(activePropositions(state).map((p) => normalizeStatement(p.statement)));
    const fresh = pack.propositions.filter((entry) => !existing.has(normalizeStatement(entry.statement)));
    const skipped = pack.propositions.length - fresh.length;
    if (fresh.length === 0) {
      return { addedPropositions: 0, addedCues: 0, skipped, errors: [] };
    }

    const factory = this.#newFactory();
    const built = packToEvents(
      { format: 1, propositions: fresh },
      factory,
      this.#newId,
      { at: this.#clock.now().toISOString() },
    );
    this.#seq = factory.seq;
    this.#append(built.events);
    const addedCues = built.events.filter((event) => event.type === 'cue.asserted').length;
    return { addedPropositions: fresh.length, addedCues, skipped, errors: [] };
  }

  /** One four-button self-rating: writes `review.rated` (S ledger + M evidence). */
  grade(input) {
    const propositionId = String(input?.propositionId ?? '');
    const cueId = String(input?.cueId ?? '');
    const grade = Number(input?.grade);
    if (!propositionId) throw new Error('缺少 propositionId');
    if (!cueId) throw new Error('缺少 cueId');
    if (!(grade === 1 || grade === 2 || grade === 3 || grade === 4)) throw new Error('评级必须是 1–4');
    const state = this.#ensureState();
    if (!state.propositions[propositionId]) throw new Error('命题不存在，可能已被清空');

    const factory = this.#newFactory();
    const event = rateReview(factory, { propositionId, cueId, grade });
    this.#seq = factory.seq;
    this.#append([event]);
    return this.render();
  }

  /** One self-graded quiz answer: writes `quiz.answered` (M ledger only). */
  quiz(input) {
    const propositionId = String(input?.propositionId ?? '');
    const cueId = String(input?.cueId ?? '');
    if (!propositionId) throw new Error('缺少 propositionId');
    if (typeof input?.correct !== 'boolean') throw new Error('缺少 correct');
    const state = this.#ensureState();
    if (!state.propositions[propositionId]) throw new Error('命题不存在，可能已被清空');

    const latencyMs = Number(input?.latencyMs);
    const factory = this.#newFactory();
    const event = answerQuiz(factory, {
      propositionId,
      ...(cueId ? { cueId } : {}),
      correct: input.correct,
      ...(Number.isFinite(latencyMs) && latencyMs >= 0 ? { latencyMs: Math.round(latencyMs) } : {}),
    });
    this.#seq = factory.seq;
    this.#append([event]);
    return this.render();
  }

  exportJsonl() {
    const events = this.#ensureEvents();
    return { text: exportEventsJsonl(events), events: events.length };
  }

  /** Appends every valid event from a JSONL log; duplicate ids are ignored. */
  importJsonl(text) {
    const { events, errors } = parseJsonl(String(text ?? ''));
    if (events.length === 0) return { added: 0, errors };

    const before = this.#eventCount();
    this.#insertRaw(events);
    const added = this.#eventCount() - before;

    const ownMaxSeq =
      Number(
        this.#db.value('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events WHERE device_id = ?', [this.#deviceId]),
      ) || 0;
    if (ownMaxSeq > this.#seq) {
      this.#seq = ownMaxSeq;
      this.#setMeta('seq', String(this.#seq));
    }
    this.#invalidate();
    this.#markPersist();
    return { added, errors };
  }

  /** Hard delete of the whole log, keeping the device id. */
  async clear() {
    this.#db.exec('BEGIN');
    try {
      this.#db.exec('DELETE FROM events');
      this.#db.exec("DELETE FROM meta WHERE key <> 'deviceId'");
      this.#db.exec('COMMIT');
    } catch (err) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    this.#seq = 0;
    this.#invalidate();
    if (this.#persistence) await this.#persistence.save(this.#snapshot());
    return this.initPayload();
  }

  /** Flushes the debounced chrome.storage JSONL mirror (called on pagehide). */
  async flush() {
    if (this.#persistence) await this.#persistence.flush();
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #queueView(state, item, nowIso) {
    const proposition = state.propositions[item.propositionId];
    const cue = state.cues[item.cueId];
    const mastery = state.mastery[item.propositionId] ?? emptyMastery(item.propositionId, nowIso);
    const summary = masterySummary(mastery);
    const schedule = state.schedule[item.propositionId];
    return {
      propositionId: item.propositionId,
      cueId: item.cueId,
      kind: item.kind,
      front: cue?.front ?? proposition?.statement ?? '',
      back: cue?.back ?? '',
      statement: proposition?.statement ?? '',
      domain: proposition?.domain,
      dueAt: item.dueAt ?? null,
      mastery: { mean: summary.mean, low: summary.low, high: summary.high, strength: summary.strength },
      retrievability: schedule ? retrievability(schedule, nowIso) : 0,
      reviewCount: schedule?.reviewCount ?? 0,
      stage: schedule?.stage ?? 'new',
    };
  }

  #newFactory() {
    return createEventFactory({
      deviceId: this.#deviceId,
      newId: this.#newId,
      startSeq: this.#seq,
      now: () => this.#clock.now(),
    });
  }

  /** One transaction: events first, then meta.seq, then COMMIT. */
  #append(events) {
    if (events.length === 0) return;
    this.#db.exec('BEGIN');
    try {
      for (const event of events) this.#insertEvent(event);
      this.#setMeta('seq', String(this.#seq));
      this.#db.exec('COMMIT');
    } catch (err) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    this.#invalidate();
    this.#markPersist();
  }

  #insertRaw(events) {
    if (events.length === 0) return;
    this.#db.exec('BEGIN');
    try {
      for (const event of events) this.#insertEvent(event);
      this.#db.exec('COMMIT');
    } catch (err) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    this.#invalidate();
  }

  #insertEvent(event) {
    this.#db.run(INSERT_EVENT_SQL, [
      String(event.id),
      String(event.deviceId),
      Number(event.seq) || 0,
      String(event.occurredAt),
      String(event.recordedAt),
      String(event.actor),
      String(event.type),
      event.subjectId === undefined ? null : String(event.subjectId),
      JSON.stringify(event.payload ?? {}),
    ]);
  }

  #getMeta(key) {
    const row = this.#db.get('SELECT value FROM meta WHERE key = ?', [key]);
    return row && typeof row.value === 'string' ? row.value : null;
  }

  #setMeta(key, value) {
    this.#db.run(UPSERT_META_SQL, [key, value]);
  }

  #eventCount() {
    return Number(this.#db.value('SELECT COUNT(*) AS n FROM events')) || 0;
  }

  #ensureEvents() {
    if (this.#events === null) {
      this.#events = this.#db.all(SELECT_EVENTS_SQL).map(rowToEvent);
    }
    return this.#events;
  }

  #ensureState() {
    if (this.#state === null) {
      this.#state = replay(this.#ensureEvents());
    }
    return this.#state;
  }

  #invalidate() {
    this.#events = null;
    this.#state = null;
  }

  #snapshot() {
    return {
      deviceId: this.#deviceId,
      seq: this.#seq,
      jsonl: exportEventsJsonl(this.#ensureEvents()),
    };
  }

  #markPersist() {
    if (this.#persistence) this.#persistence.mark(() => this.#snapshot());
  }
}

/** Factory used by worker/worker.js and the Node smoke test. */
export async function openService(options) {
  return LatticeService.open(options);
}
