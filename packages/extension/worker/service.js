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
  buildFeed,
  buildMergePlan,
  buildQueue,
  calibrate,
  chainKey,
  createEventFactory,
  createIdFactory,
  dayOf,
  dueItems,
  emptyMastery,
  exposureEngaged,
  exposureOf,
  exposureShown,
  exposureSkipped,
  exportJsonl as exportEventsJsonl,
  extractCandidate,
  formatReport,
  foundationPropositions,
  interestsOf,
  masterySummary,
  newItems,
  normalizeSource,
  packToEvents,
  parseJsonl,
  parsePropositionPack,
  planToEvents,
  prerequisiteEdges,
  rateReview,
  replay,
  resolveIdentity,
  retrievability,
  samplesFromState,
  stateDigest,
} from '../vendor/lattice-core/index.js';
import {
  createLlmPort,
  listModels,
  normalizeProvider,
  providerLabel as formatProviderLabel,
  testProvider,
} from './llm.js';
import { normalizeStatement } from './util.js';

/** How many new propositions a single queue may introduce. */
const NEW_PER_QUEUE = 20;

/** Ad-like default dose when the page does not send its `latticeFeedSettings.dose`. */
const DEFAULT_FEED_DOSE = 3;
const MAX_FEED_DOSE = 50;

/** C-ledger attention events. They never touch mastery or the schedule. */
const EXPOSURE_KINDS = new Set(['shown', 'engaged', 'skipped']);

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
  // Coverage ledger: one row per normalized source text. A row means "this text
  // was already turned into propositions", so a second capture of the same text
  // is cheap and cannot duplicate the graph. Not an event: it is a cache of a
  // pure function of (text, model, promptVersion), rebuildable by re-extraction.
  `CREATE TABLE IF NOT EXISTS coverage (
    source_hash TEXT PRIMARY KEY,
    title TEXT,
    source_uri TEXT,
    source_kind TEXT,
    extracted_at TEXT,
    proposition_count INTEGER,
    chain_count INTEGER,
    model TEXT,
    prompt_version TEXT
  )`,
];

const INSERT_EVENT_SQL = `INSERT OR IGNORE INTO events
  (id, device_id, seq, occurred_at, recorded_at, actor, type, subject_id, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const UPSERT_META_SQL = `INSERT INTO meta(key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

const UPSERT_COVERAGE_SQL = `INSERT INTO coverage
  (source_hash, title, source_uri, source_kind, extracted_at, proposition_count, chain_count, model, prompt_version)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_hash) DO UPDATE SET
    title = excluded.title,
    source_uri = excluded.source_uri,
    source_kind = excluded.source_kind,
    extracted_at = excluded.extracted_at,
    proposition_count = excluded.proposition_count,
    chain_count = excluded.chain_count,
    model = excluded.model,
    prompt_version = excluded.prompt_version`;

const SELECT_COVERAGE_SQL = `SELECT source_hash, title, source_uri, source_kind, extracted_at,
    proposition_count, chain_count, model, prompt_version
  FROM coverage ORDER BY extracted_at`;

const SELECT_COVERAGE_ONE_SQL = `SELECT source_hash, title, source_uri, source_kind, extracted_at,
    proposition_count, chain_count, model, prompt_version
  FROM coverage WHERE source_hash = ?`;

const SELECT_EVENTS_SQL = `SELECT id, device_id, seq, occurred_at, recorded_at, actor, type, subject_id, payload
  FROM events ORDER BY occurred_at, device_id, seq`;

/** A proposition counts as "已掌握" when its Beta posterior mean reaches this. */
const MASTERED_MEAN = 0.6;

const SOURCE_KINDS = new Set(['page', 'pdf', 'video', 'note', 'paste', 'import', 'session']);

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sourceKindOf(value) {
  return typeof value === 'string' && SOURCE_KINDS.has(value) ? value : 'paste';
}

function isIsoDate(value) {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function stringList(value, limit = 20) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Validates the plan that comes back from the preview page. The page is allowed
 * to filter entries (unchecked propositions/chains) but not to invent shapes.
 */
function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('入库计划为空');
  const list = (value) => (Array.isArray(value) ? value : []);

  const create = list(raw.create).map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`计划中的第 ${index + 1} 条命题无效`);
    const ref = cleanText(entry.ref);
    const statement = cleanText(entry.statement);
    if (!ref || !statement) throw new Error(`计划中的第 ${index + 1} 条命题缺少 ref 或 statement`);
    const out = { ref, statement, aliases: stringList(entry.aliases) };
    const name = cleanText(entry.name);
    if (name) out.name = name;
    const quote = cleanText(entry.quote);
    if (quote) out.quote = quote;
    return out;
  });

  const reuse = list(raw.reuse).map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('计划中的复用命题无效');
    const ref = cleanText(entry.ref);
    const existingId = cleanText(entry.existingId);
    if (!ref || !existingId) throw new Error('计划中的复用命题缺少 ref 或 existingId');
    return { ref, existingId };
  });

  const cues = list(raw.cues).map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('计划中的卡片无效');
    const ref = cleanText(entry.ref);
    const front = cleanText(entry.front);
    const back = cleanText(entry.back);
    if (!ref || !front || !back) throw new Error('计划中的卡片缺少 ref / front / back');
    return { ref, front, back, kind: 'recall' };
  });

  const chains = list(raw.chains).map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('计划中的推理链无效');
    const premiseRefs = stringList(entry.premiseRefs);
    const conclusionRef = cleanText(entry.conclusionRef);
    if (premiseRefs.length === 0 || !conclusionRef) throw new Error('计划中的推理链缺少前提或结论');
    let strength = Number(entry.strength);
    if (!Number.isFinite(strength)) strength = 0.8;
    strength = Math.min(1, Math.max(0, strength));
    return { premiseRefs, conclusionRef, strength };
  });

  // The domain is the interest signal: it lands on every created proposition and
  // makes planToEvents() emit `interest.observed` even when all propositions were
  // reused. It is not a per-entry field, so it must survive the page round-trip.
  const domain = cleanText(raw.domain).slice(0, 40);
  return { ...(domain ? { domain } : {}), create, reuse, cues, chains, dropped: [] };
}

function modelFromLabel(label) {
  const text = cleanText(label);
  if (!text) return '';
  const cut = text.indexOf(' (');
  return cut > 0 ? text.slice(0, cut) : text;
}

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
  #fetchImpl;
  #deviceId = '';
  #seq = 0;
  #events = null;
  #state = null;
  #seedErrors = [];
  #openErrors = [];
  /** Last dose the page asked for; used when exposure() recomputes the feed. */
  #feedDose = DEFAULT_FEED_DOSE;

  /**
   * @param {object} options
   * @param {object} options.db wrapped DB (see worker/db.js)
   * @param {'opfs'|'fallback'} options.mode
   * @param {'opfs'|'opfs-sahpool'|'memory'} [options.storageDetail]
   * @param {{load: Function, save: Function, mark: Function, flush: Function}|null} [options.persistence]
   * @param {{now: () => Date}} [options.clock]
   * @param {() => string} [options.idFactory]
   * @param {() => string} [options.uuid]
   * @param {Function} [options.fetchImpl] injected fetch (Node tests)
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
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
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
      this.#seedCoverage(seed.coverageJson);
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

  /**
   * Today's push feed: a small, ad-like dose of propositions.
   *
   * Pure read. buildFeed() decides *what* to show (daily frequency cap, skip
   * fatigue, prerequisite frontier, interest ordering); this method only decorates
   * each item with the numbers the newtab needs. Nothing is written here: exposure
   * evidence is appended by exposure().
   */
  feed(input = {}) {
    const state = this.#ensureState();
    const now = this.#nowIso(input?.now);
    const dose = this.#feedDoseOf(input?.dose ?? this.#feedDose);
    this.#feedDose = dose;
    const items = buildFeed(state, { now, dose }).map((item) => this.#feedItemView(state, item, now));
    return {
      items,
      dose,
      interests: this.#interestViews(state),
      todayDate: dayOf(now),
    };
  }

  /**
   * Appends ONE C-ledger attention event (`shown` / `engaged` / `skipped`) and
   * returns the feed recomputed after it, so the page can advance without a second
   * round-trip. One transaction; `system` actor. Exposure is evidence of attention,
   * never of understanding: mastery and the FSRS schedule are untouched.
   */
  exposure(input = {}) {
    const propositionId = String(input?.propositionId ?? '').trim();
    const kind = String(input?.kind ?? '').trim();
    if (!propositionId) throw new Error('缺少 propositionId');
    if (!EXPOSURE_KINDS.has(kind)) throw new Error('曝光类型无效（应为 shown / engaged / skipped）');
    const state = this.#ensureState();
    if (!state.propositions[propositionId]) throw new Error('命题不存在，可能已被清空');

    const now = this.#nowIso(input?.now);
    const surface = cleanText(input?.surface).slice(0, 40) || 'newtab';
    const factory = this.#newFactory();
    const opts = { at: now, actor: 'system' };
    let event;
    if (kind === 'shown') {
      const reason = cleanText(input?.reason).slice(0, 20);
      event = exposureShown(
        factory,
        { propositionId, surface, ...(reason ? { reason } : {}), day: dayOf(now) },
        opts,
      );
    } else if (kind === 'engaged') {
      event = exposureEngaged(factory, { propositionId, surface }, opts);
    } else {
      event = exposureSkipped(factory, { propositionId, surface }, opts);
    }
    this.#seq = factory.seq;
    this.#append([event]);
    return { ok: true, feed: this.feed({ dose: input?.dose, now }) };
  }

  diagnostics(input = {}) {
    const state = this.#ensureState();
    const render = this.render();
    const report = calibrate(samplesFromState(state));
    const now = this.#clock.now().toISOString();
    const today = dayOf(now);
    const dose = this.#feedDoseOf(input?.dose ?? this.#feedDose);
    this.#feedDose = dose;
    let shownToday = 0;
    let engaged = 0;
    let skipped = 0;
    for (const exposure of Object.values(state.exposures)) {
      if (exposure.lastShownDay === today) shownToday += 1;
      engaged += exposure.engaged;
      skipped += exposure.skipped;
    }
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
      coverageCount: this.#coverageCount(),
      calibration: report,
      reportText: formatReport(report),
      // Push-layer facts for 诊断: the C ledger side, not learner state.
      feed: {
        dose,
        todayDate: today,
        shownToday,
        engaged,
        skipped,
        interests: this.#interestViews(state),
      },
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

  // -------------------------------------------------------------------------
  // Extraction (M1a): model text -> preview -> confirmed events
  // -------------------------------------------------------------------------

  /**
   * Runs normalize → extract → identify → deterministic merge and returns a
   * *preview plan*. Nothing is written here: the page owns the plan, the user
   * checks/edits it, and only `commitExtraction` appends events.
   *
   * A coverage hit short-circuits before any model call, unless `force` is set
   * ("仍然重新抽取"): coverage is a cache, not a lock.
   */
  async extractPreview(input = {}) {
    const source = this.#normalizeInput(input);
    const force = Boolean(input.force);

    if (!force) {
      const coverage = this.#coverageView(this.#coverageRow(source.sourceHash));
      if (coverage) {
        return {
          coverageHit: true,
          extractedAt: coverage.extractedAt,
          propositionCount: coverage.propositionCount,
          chainCount: coverage.chainCount,
          model: coverage.model,
          promptVersion: coverage.promptVersion,
          source,
        };
      }
    }

    const provider = normalizeProvider(input.provider);
    const llm = createLlmPort(provider, { fetchImpl: this.#fetchImpl });
    const extraction = await extractCandidate(source, { llm });

    const state = this.#ensureState();
    const existing = activePropositions(state).map((p) => ({
      id: p.id,
      statement: p.statement,
      aliases: p.aliases ?? [],
    }));
    const identity = await resolveIdentity(extraction.candidate, existing, { llm });
    const plan = buildMergePlan(extraction.candidate, identity, {
      existingChainKeys: this.#existingChainKeys(),
      minChainStrength: 0,
    });

    // Display-only mirror of the candidate (plain JSON: the Map from
    // resolveIdentity must never cross the worker/page boundary).
    const propositions = extraction.candidate.propositions.map((proposition) => ({
      ref: proposition.ref,
      statement: proposition.statement,
      ...(proposition.name ? { name: proposition.name } : {}),
      ...(proposition.aliases ? { aliases: proposition.aliases } : {}),
      ...(proposition.quote ? { quote: proposition.quote } : {}),
      existingId: identity.decisions.get(proposition.ref)?.existingId ?? null,
    }));

    return {
      coverageHit: false,
      source,
      plan,
      propositions,
      promptVersion: extraction.promptVersion,
      identityPromptVersion: identity.promptVersion,
      identityUnresolved: identity.unresolved,
      providerLabel: formatProviderLabel(provider),
      model: provider.model,
    };
  }

  /**
   * Appends the (filtered) preview plan as events + records coverage, in ONE
   * transaction. Idempotency has three independent guards:
   *   1. coverage row for the same sourceHash -> no-op (unless `force`);
   *   2. propositions whose statement already exists -> reused, not duplicated;
   *   3. chains already implied by existing chains -> dropped.
   * So committing the same plan twice (or re-extracting covered text) cannot
   * duplicate the graph.
   */
  commitExtraction(input = {}) {
    const sourceInput = input.source && typeof input.source === 'object' ? input.source : {};
    const source = this.#normalizeInput(sourceInput);
    const force = Boolean(input.force);

    const existingCoverage = this.#coverageView(this.#coverageRow(source.sourceHash));
    if (existingCoverage && !force) {
      return {
        committed: false,
        alreadyCovered: true,
        source,
        domain: null,
        counts: { propositions: 0, reused: 0, cues: 0, chains: 0, events: 0 },
        coverage: existingCoverage,
      };
    }

    const rawPlan = normalizePlan(input.plan);
    const state = this.#ensureState();
    const active = activePropositions(state);
    const activeIds = new Set(active.map((p) => p.id));
    const byStatement = new Map();
    for (const proposition of active) byStatement.set(normalizeStatement(proposition.statement), proposition.id);

    // Guard 2: an identical statement is the same proposition, even when the
    // model re-extracted it under a new ref (no coverage row, e.g. re-extract).
    const refToExisting = new Map();
    for (const entry of rawPlan.create) {
      const existingId = byStatement.get(normalizeStatement(entry.statement));
      if (existingId) refToExisting.set(entry.ref, existingId);
    }

    const create = rawPlan.create.filter((entry) => !refToExisting.has(entry.ref));
    const createRefs = new Set(create.map((entry) => entry.ref));
    const knownIds = new Map(); // ref -> existing id, for reuse + dedupe checks
    const reuse = [];
    for (const entry of rawPlan.reuse) {
      if (refToExisting.has(entry.ref)) continue;
      if (!activeIds.has(entry.existingId)) continue; // stale preview / cleared data
      reuse.push(entry);
      knownIds.set(entry.ref, entry.existingId);
    }
    for (const [ref, existingId] of refToExisting) {
      reuse.push({ ref, existingId });
      knownIds.set(ref, existingId);
    }

    // Cues are generated per candidate proposition; a reused one already has its
    // cue, so only newly created propositions get a new cue.
    const cues = rawPlan.cues.filter((cue) => createRefs.has(cue.ref));

    // Guard 3: drop chains that reference removed refs or already exist.
    const existingChainKeys = this.#existingChainKeys();
    const chains = rawPlan.chains.filter((chain) => {
      const refs = [...chain.premiseRefs, chain.conclusionRef];
      if (refs.some((ref) => !knownIds.has(ref) && !createRefs.has(ref))) return false;
      if (refs.every((ref) => knownIds.has(ref))) {
        const ids = refs.map((ref) => knownIds.get(ref));
        const conclusionId = ids[ids.length - 1];
        const premiseIds = ids.slice(0, -1);
        if (existingChainKeys.has(chainKey(premiseIds, conclusionId))) return false;
      }
      return true;
    });

    const plan = { ...(rawPlan.domain ? { domain: rawPlan.domain } : {}), create, reuse, cues, chains, dropped: [] };
    const providerLabel = cleanText(input.providerLabel);
    const model = cleanText(input.model) || modelFromLabel(providerLabel);
    const promptVersion = cleanText(input.promptVersion);
    const actor = model || providerLabel ? `llm:${model || providerLabel}@${promptVersion || 'unknown'}` : 'system';

    const factory = this.#newFactory();
    const built = planToEvents(plan, { factory, newId: this.#newId, source, actor });
    this.#seq = factory.seq;

    const counts = {
      propositions: built.events.filter((event) => event.type === 'proposition.asserted').length,
      reused: reuse.length,
      cues: built.events.filter((event) => event.type === 'cue.asserted').length,
      chains: built.events.filter((event) => event.type === 'chain.asserted').length,
      events: built.events.length,
    };
    const coverage = {
      sourceHash: source.sourceHash,
      title: source.title ?? null,
      sourceUri: source.sourceUri ?? null,
      sourceKind: source.sourceKind,
      extractedAt: source.capturedAt,
      propositionCount: create.length + reuse.length,
      chainCount: counts.chains,
      model: model || null,
      promptVersion: promptVersion || null,
    };

    // ONE transaction: all events + meta.seq + the coverage row.
    this.#append(built.events, () => this.#upsertCoverage(coverage));

    return {
      committed: built.events.length > 0,
      alreadyCovered: false,
      source,
      domain: plan.domain ?? null,
      counts,
      coverage: this.#coverageView(this.#coverageRow(source.sourceHash)),
    };
  }

  /** Coverage lookup by normalized hash (or by raw text, normalized here). */
  coverageCheck(input = {}) {
    let hash = cleanText(input.hash);
    if (!hash && typeof input.text === 'string') {
      try {
        hash = normalizeSource({ text: input.text }).sourceHash;
      } catch {
        hash = '';
      }
    }
    const coverage = hash ? this.#coverageView(this.#coverageRow(hash)) : null;
    return { hit: Boolean(coverage), coverage };
  }

  /** Tiny graph stats for the diagnostics dialog. */
  graphSummary() {
    const state = this.#ensureState();
    const active = activePropositions(state);
    const edges = prerequisiteEdges(state);
    const withPrereq = new Set(edges.map((edge) => edge.to)).size;
    let mastered = 0;
    for (const proposition of active) {
      const mastery = state.mastery[proposition.id];
      if (mastery && masterySummary(mastery).mean >= MASTERED_MEAN) mastered += 1;
    }
    return {
      propositions: active.length,
      chains: Object.keys(state.chains).length,
      foundation: foundationPropositions(state).length,
      withPrereq,
      mastered,
    };
  }

  /** One tiny chat completion; returns latency + model echo or a Chinese error. */
  async providerTest(input = {}) {
    const provider = normalizeProvider(input.provider);
    return testProvider(provider, { fetchImpl: this.#fetchImpl });
  }

  /** Asks the endpoint which models it serves (GET /models). */
  async listModels(input = {}) {
    return listModels(input.provider, { fetchImpl: this.#fetchImpl });
  }

  /** Hard delete of the whole log, keeping the device id. */
  async clear() {
    this.#db.exec('BEGIN');
    try {
      this.#db.exec('DELETE FROM events');
      this.#db.exec('DELETE FROM coverage');
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

  /** normalizeSource, but takes whatever the page sent and keeps dates sane. */
  #normalizeInput(input) {
    const raw = input && typeof input === 'object' ? input : {};
    const title = cleanText(raw.title);
    const sourceUri = cleanText(raw.sourceUri);
    const capturedAt = isIsoDate(raw.capturedAt) ? raw.capturedAt : undefined;
    return normalizeSource({
      text: typeof raw.text === 'string' ? raw.text : '',
      sourceKind: sourceKindOf(raw.sourceKind),
      ...(title ? { title } : {}),
      ...(sourceUri ? { sourceUri } : {}),
      ...(capturedAt ? { capturedAt } : {}),
    });
  }

  #coverageRow(hash) {
    if (!hash) return null;
    return this.#db.get(SELECT_COVERAGE_ONE_SQL, [hash]) ?? null;
  }

  #coverageView(row) {
    if (!row) return null;
    return {
      sourceHash: row.source_hash,
      title: row.title ?? null,
      sourceUri: row.source_uri ?? null,
      sourceKind: row.source_kind ?? null,
      extractedAt: row.extracted_at ?? null,
      propositionCount: Number(row.proposition_count) || 0,
      chainCount: Number(row.chain_count) || 0,
      model: row.model ?? null,
      promptVersion: row.prompt_version ?? null,
    };
  }

  #allCoverage() {
    return this.#db.all(SELECT_COVERAGE_SQL).map((row) => this.#coverageView(row));
  }

  #upsertCoverage(row) {
    this.#db.run(UPSERT_COVERAGE_SQL, [
      row.sourceHash,
      row.title,
      row.sourceUri,
      row.sourceKind,
      row.extractedAt,
      row.propositionCount,
      row.chainCount,
      row.model,
      row.promptVersion,
    ]);
  }

  /** Coverage rows travel with the JSONL mirror, so fallback mode stays idempotent. */
  #seedCoverage(coverageJson) {
    if (typeof coverageJson !== 'string' || coverageJson.trim().length === 0) return;
    let rows;
    try {
      rows = JSON.parse(coverageJson);
    } catch {
      return;
    }
    if (!Array.isArray(rows) || rows.length === 0) return;
    this.#db.exec('BEGIN');
    try {
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const sourceHash = cleanText(row.sourceHash);
        if (!sourceHash) continue;
        this.#upsertCoverage({
          sourceHash,
          title: cleanText(row.title) || null,
          sourceUri: cleanText(row.sourceUri) || null,
          sourceKind: sourceKindOf(row.sourceKind),
          extractedAt: isIsoDate(row.extractedAt) ? row.extractedAt : this.#clock.now().toISOString(),
          propositionCount: Number(row.propositionCount) || 0,
          chainCount: Number(row.chainCount) || 0,
          model: cleanText(row.model) || null,
          promptVersion: cleanText(row.promptVersion) || null,
        });
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      this.#openErrors = [...this.#openErrors, `覆盖记录读取失败：${err && err.message ? err.message : String(err)}`];
    }
  }

  #existingChainKeys() {
    const state = this.#ensureState();
    const keys = new Set();
    for (const chain of Object.values(state.chains)) keys.add(chainKey(chain.premiseIds, chain.conclusionId));
    return keys;
  }

  #coverageCount() {
    return Number(this.#db.value('SELECT COUNT(*) AS n FROM coverage')) || 0;
  }

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

  /** ISO instant for a read: caller may pin it (tests / deterministic replay). */
  #nowIso(value) {
    return isIsoDate(value) ? new Date(value).toISOString() : this.#clock.now().toISOString();
  }

  #feedDoseOf(value) {
    const dose = Math.round(Number(value));
    if (!Number.isFinite(dose) || dose <= 0) return DEFAULT_FEED_DOSE;
    return Math.min(MAX_FEED_DOSE, Math.max(1, dose));
  }

  /** Plain-JSON feed item: everything the newtab card renders, nothing internal. */
  #feedItemView(state, item, now) {
    const proposition = state.propositions[item.propositionId];
    const cue = item.cueId ? state.cues[item.cueId] : undefined;
    const mastery = state.mastery[item.propositionId] ?? emptyMastery(item.propositionId, now);
    const summary = masterySummary(mastery);
    const schedule = state.schedule[item.propositionId];
    const exposure = exposureOf(state, item.propositionId);
    const view = {
      propositionId: item.propositionId,
      kind: item.kind,
      reason: item.reason,
      score: item.score,
      statement: proposition?.statement ?? '',
      mastery: { mean: summary.mean, low: summary.low, high: summary.high },
      retrievability: schedule ? retrievability(schedule, now) : 0,
      exposure: { shown: exposure.shown, engaged: exposure.engaged, skipped: exposure.skipped },
    };
    if (item.cueId) {
      view.cueId = item.cueId;
      view.cueFront = cue?.front ?? '';
      view.cueBack = cue?.back ?? '';
    }
    if (item.domain) view.domain = item.domain;
    return view;
  }

  #interestViews(state) {
    return interestsOf(state).map((interest) => ({
      name: interest.name,
      weight: interest.weight,
      count: interest.captureCount,
    }));
  }

  #newFactory() {
    return createEventFactory({
      deviceId: this.#deviceId,
      newId: this.#newId,
      startSeq: this.#seq,
      now: () => this.#clock.now(),
    });
  }

  /**
   * ONE transaction: events, then meta.seq, then COMMIT. `extra` lets a caller
   * (commitExtraction) add its auxiliary ledger write to the same transaction.
   */
  #append(events, extra = null) {
    if (events.length === 0 && typeof extra !== 'function') return;
    this.#db.exec('BEGIN');
    try {
      for (const event of events) this.#insertEvent(event);
      if (typeof extra === 'function') extra();
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
      coverageJson: JSON.stringify(this.#allCoverage()),
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
