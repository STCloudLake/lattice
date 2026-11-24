/**
 * Lattice M0 newtab page.
 *
 * Owns the UI only. Every database read/write goes through a tiny RPC to
 * ../worker/worker.js, because the OPFS SQLite VFS only runs inside a Web Worker.
 * Plain JS, no framework, no external assets, keyboard first.
 *
 * M2c adds declared interests + autonomous curriculum preparation: the page
 * decides *when* to generate (once per domain per day, never twice at once) and
 * the worker owns the event log and the model call.
 */

import {
  CURRICULUM_STATE_KEY,
  levelLabel,
  loadCurriculumState,
  localDayKey,
  markGeneratedForDay,
  normalizeLevel,
  planNextGeneration,
  saveCurriculumState,
} from './curriculum-guard.js';
// Shared push-layer contract (classic script, imported for its side effect):
// keys, billboard snapshot shape, interruption budget, exposure queue. The
// sidebar/background load the same file as a classic script, so there is exactly
// one definition of "what counts as an interruption".
import '../shared/billboard.js';

const PushShared = globalThis.LatticeBillboard;
const DEFAULT_INTERRUPT_SETTINGS = PushShared
  ? PushShared.normalizeInterruptSettings(null)
  : {
      dailyLimit: 1,
      quietStart: '23:00',
      quietEnd: '08:00',
      sidebar: true,
      notifications: false,
      sites: { bilibili: true, youtube: true },
    };

const SAMPLE_PACK_URL = new URL('../data/sample-pack.json', import.meta.url);
const RPC_REQUEST = 'lattice-rpc';
const RPC_RESULT = 'lattice-rpc-result';
const RPC_TIMEOUT_MS = 30000;
/** Long operations need more than the default RPC timeout. */
const RPC_TIMEOUTS = {
  extractPreview: 150000,
  providerTest: 75000,
  commitExtraction: 60000,
  // One curriculum batch is one model call, same order of magnitude as extraction.
  generateCurriculum: 150000,
  seedCurriculum: 60000,
};
/** How many propositions one autonomous curriculum batch asks for. */
const CURRICULUM_BATCH = 6;

/** One storage key holds the whole provider config — and nothing else holds the key. */
const PROVIDER_STORAGE_KEY = 'latticeProvider';
const PENDING_CAPTURE_KEY = 'latticePendingCapture';
const CAPTURE_SETTINGS_KEY = 'latticeCaptureSettings';
/** Push-layer settings (page-owned, like the capture settings). */
const FEED_SETTINGS_KEY = 'latticeFeedSettings';
const FEED_DOSE_CHOICES = [3, 5, 10];
const DEFAULT_FEED_DOSE = 3;
/** 今日推送 is the default surface; 复习队列 is the optional second one. */
const SURFACES = ['feed', 'queue'];

// Model names are NOT hardcoded per vendor: they change (DeepSeek renamed
// deepseek-chat to deepseek-flash). The UI can pull the real list from /models.
const PROVIDER_PRESETS = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
  local: { baseUrl: 'http://127.0.0.1:11434/v1', model: '' },
  custom: { baseUrl: '', model: '' },
};

const PROVIDER_PRESET_VALUES = Object.keys(PROVIDER_PRESETS);

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const els = {
  counterReview: $('counter-review'),
  counterNew: $('counter-new'),
  counterTotal: $('counter-total'),
  btnSettings: $('btn-settings'),
  tabFeed: $('tab-feed'),
  tabReview: $('tab-review'),
  tabReviewCount: $('tab-review-count'),

  viewLoading: $('view-loading'),
  viewEmpty: $('view-empty'),
  viewFeed: $('view-feed'),
  viewCard: $('view-card'),
  viewDone: $('view-done'),
  viewFatal: $('view-fatal'),

  feedCard: $('feed-card'),
  feedLoading: $('feed-loading'),
  feedDone: $('feed-done'),
  feedDoneDetail: $('feed-done-detail'),
  feedDomain: $('feed-domain'),
  feedReason: $('feed-reason'),
  feedDifficulty: $('feed-difficulty'),
  feedStatement: $('feed-statement'),
  feedCue: $('feed-cue'),
  feedMeta: $('feed-meta'),
  feedSource: $('feed-source'),
  feedProgress: $('feed-progress'),
  feedHint: $('feed-hint'),
  btnFeedKnow: $('btn-feed-know'),
  btnFeedSkip: $('btn-feed-skip'),
  btnFeedQuiz: $('btn-feed-quiz'),
  btnFeedReview: $('btn-feed-review'),
  btnFeedCapture: $('btn-feed-capture'),

  btnSample: $('btn-sample'),
  btnSeed: $('btn-seed'),
  btnCaptureTop: $('btn-capture-top'),
  captureAutoCommit: $('capture-auto-commit'),
  btnCaptureEmpty: $('btn-capture-empty'),
  btnImportPackFile: $('btn-import-pack-file'),
  btnPastePack: $('btn-paste-pack'),

  cardMeta: $('card-meta'),
  cardFront: $('card-front'),
  cardAnswer: $('card-answer'),
  cardBack: $('card-back'),
  actionsFront: $('actions-front'),
  actionsGrade: $('actions-grade'),
  actionsQuiz: $('actions-quiz'),
  btnReveal: $('btn-reveal'),

  doneTitle: $('done-title'),
  doneDetail: $('done-detail'),
  btnDoneExport: $('btn-done-export'),
  btnDoneRefresh: $('btn-done-refresh'),
  btnDoneFeed: $('btn-done-feed'),

  fatalDetail: $('fatal-detail'),
  btnRetry: $('btn-retry'),
  btnFatalDiagnostics: $('btn-fatal-diagnostics'),

  btnExport: $('btn-export'),
  btnImport: $('btn-import'),
  btnDiagnostics: $('btn-diagnostics'),
  btnClear: $('btn-clear'),
  btnCapture: $('btn-capture'),

  filePack: $('file-pack'),
  fileJsonl: $('file-jsonl'),

  dialogPack: $('dialog-pack'),
  packText: $('pack-text'),
  packError: $('pack-error'),
  btnPackCancel: $('btn-pack-cancel'),
  btnPackSubmit: $('btn-pack-submit'),

  dialogImport: $('dialog-import'),
  btnPickJsonl: $('btn-pick-jsonl'),
  jsonlFileName: $('jsonl-file-name'),
  importError: $('import-error'),
  btnJsonlCancel: $('btn-jsonl-cancel'),
  btnJsonlSubmit: $('btn-jsonl-submit'),

  dialogDiagnostics: $('dialog-diagnostics'),
  diagText: $('diag-text'),
  btnDiagRefresh: $('btn-diag-refresh'),
  btnDiagCopy: $('btn-diag-copy'),
  btnDiagClose: $('btn-diag-close'),

  dialogSettings: $('dialog-settings'),
  setStorage: $('set-storage'),
  setDevice: $('set-device'),
  setSeq: $('set-seq'),
  setDigest: $('set-digest'),
  interruptQuietStart: $('interrupt-quiet-start'),
  interruptQuietEnd: $('interrupt-quiet-end'),
  interruptSidebar: $('interrupt-sidebar'),
  interruptSiteBilibili: $('interrupt-site-bilibili'),
  interruptSiteYoutube: $('interrupt-site-youtube'),
  interruptNotifications: $('interrupt-notifications'),
  interruptAmbient: $('interrupt-ambient'),
  interruptInject: $('interrupt-inject'),
  interruptSearchJump: $('interrupt-search-jump'),
  interruptStatus: $('interrupt-status'),
  btnSettingsClose: $('btn-settings-close'),

  // 兴趣领域: declared interests are events in the C ledger, this section is a view.
  interestList: $('interest-list'),
  interestDomain: $('interest-domain'),
  interestLevel: $('interest-level'),
  btnInterestAdd: $('btn-interest-add'),
  interestStatus: $('interest-status'),

  providerPreset: $('provider-preset'),
  providerBaseUrl: $('provider-base-url'),
  providerModel: $('provider-model'),
  providerKey: $('provider-key'),
  providerStatus: $('provider-status'),
  providerError: $('provider-error'),
  btnProviderModels: $('btn-provider-models'),
  providerModelList: $('provider-model-list'),
  providerDisableThinking: $('provider-disable-thinking'),
  btnProviderTest: $('btn-provider-test'),
  btnProviderSave: $('btn-provider-save'),

  dialogCapture: $('dialog-capture'),
  captureProvider: $('capture-provider'),
  captureTitle: $('capture-title'),
  captureText: $('capture-text'),
  captureStatus: $('capture-status'),
  captureError: $('capture-error'),
  captureCoverage: $('capture-coverage'),
  captureCoverageText: $('capture-coverage-text'),
  btnCaptureReextract: $('btn-capture-reextract'),
  capturePreview: $('capture-preview'),
  capturePreviewTitle: $('capture-preview-title'),
  captureProps: $('capture-props'),
  capturePropsCount: $('capture-props-count'),
  captureChains: $('capture-chains'),
  captureChainsCount: $('capture-chains-count'),
  captureNoChains: $('capture-no-chains'),
  captureDropped: $('capture-dropped'),
  captureDroppedSummary: $('capture-dropped-summary'),
  captureDroppedList: $('capture-dropped-list'),
  btnCaptureCancel: $('btn-capture-cancel'),
  btnCaptureExtract: $('btn-capture-extract'),
  btnCaptureConfirm: $('btn-capture-confirm'),

  dialogClear: $('dialog-clear'),
  clearConfirm: $('clear-confirm'),
  clearError: $('clear-error'),
  btnClearCancel: $('btn-clear-cancel'),
  btnClearConfirm: $('btn-clear-confirm'),

  toast: $('toast'),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  mode: 'review', // 'review' | 'quiz'
  modeBeforeQuiz: 'review',
  captureSourceKind: 'paste',
  captureSourceUri: '',
  captureSettings: { autoCommit: true },
  feedSettings: { dose: DEFAULT_FEED_DOSE },
  // M2b: interruption budget settings (sidebar + notifications share one limit).
  interruptSettings: DEFAULT_INTERRUPT_SETTINGS,
  interruptState: null,
  silentCapture: false,
  payload: null,
  card: null,
  cardShownAt: 0,
  cardOrigin: 'queue', // 'queue' | 'feed'
  revealed: false,
  busy: false,
  fatal: false,
  surface: 'feed', // 'feed' (今日推送) | 'queue' (复习队列)
  view: 'loading',
  feed: {
    items: [],
    interests: [],
    today: '',
    shown: new Set(), // `${day}|${propositionId}` already logged in this page
    busy: false,
  },
  // M2c: declared interests and the autonomous-preparation guard. The persisted
  // once-per-day map is chrome.storage.local.latticeCurriculumState; `attempted`
  // only stops a loop inside this page session.
  curriculum: {
    busy: false,
    attempted: new Set(),
    dayState: {},
    needs: [],
    interests: [],
    emptyChecked: false,
  },
  answered: new Set(), // queue keys answered in this page session (quiz mode needs it)
  /** M2c: `?focus=<propositionId>` from an ambient/inline "感兴趣" click. */
  focusPropositionId: '',
  focusConsumed: false,
  diagnostics: null,
  provider: null, // {preset, baseUrl, model, apiKey} from chrome.storage.local
  capture: null, // preview state; holds ONLY the JSON plan + display rows
  captureBusy: false,
  captureForce: false, // true when the user chose "仍然重新抽取"
};

let pendingJsonlText = '';
/** Monotonic token so a stale feed response can never overwrite a newer one. */
let feedRequestToken = 0;

// ---------------------------------------------------------------------------
// RPC client
// ---------------------------------------------------------------------------

let worker = null;
let nextRpcId = 0;
const pendingRpc = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../worker/worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.type !== RPC_RESULT) return;
    const entry = pendingRpc.get(message.id);
    if (!entry) return;
    pendingRpc.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else {
      const error = new Error(message.error || '工作线程返回错误');
      if (Array.isArray(message.issues)) error.issues = message.issues;
      entry.reject(error);
    }
  });
  worker.addEventListener('error', (event) => {
    console.error('[Lattice] worker error', event);
    rejectAllPending('工作线程出错，请点「重试」');
    fail(event && event.message ? `工作线程出错：${event.message}` : '工作线程出错');
  });
  worker.addEventListener('messageerror', (event) => {
    console.error('[Lattice] worker messageerror', event);
  });
  return worker;
}

function rejectAllPending(reason) {
  for (const entry of pendingRpc.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pendingRpc.clear();
}

function rpc(op, args = {}, timeoutMs = RPC_TIMEOUTS[op] ?? RPC_TIMEOUT_MS) {
  const activeWorker = ensureWorker();
  const id = (nextRpcId += 1);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRpc.delete(id);
      reject(new Error(`操作超时：${op}`));
    }, timeoutMs);
    pendingRpc.set(id, { resolve, reject, timer });
    activeWorker.postMessage({ type: RPC_REQUEST, id, op, args });
  });
}

// ---------------------------------------------------------------------------
// Provider config (BYOK)
//
// The API key lives only in chrome.storage.local under PROVIDER_STORAGE_KEY.
// It is sent to the worker per request (in memory) and is never written to
// SQLite, the event log, diagnostics text or exports.
// ---------------------------------------------------------------------------

function storageArea() {
  return globalThis.chrome?.storage?.local ?? null;
}

function sanitizeProviderConfig(value) {
  if (!value || typeof value !== 'object') return null;
  const preset = PROVIDER_PRESET_VALUES.includes(value.preset) ? value.preset : 'custom';
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey : '';
  const disableThinking = value.disableThinking !== false;
  if (!baseUrl && !model && !apiKey) return null;
  return { preset, baseUrl, model, apiKey, disableThinking };
}

async function loadCaptureSettings() {
  const area = storageArea();
  if (!area) return;
  try {
    const got = (await area.get(CAPTURE_SETTINGS_KEY)) ?? {};
    const value = got[CAPTURE_SETTINGS_KEY];
    if (value && typeof value === 'object') {
      state.captureSettings.autoCommit = value.autoCommit !== false;
    }
  } catch {
    /* defaults are fine; settings must never block boot */
  }
}

async function persistCaptureSettings() {
  const area = storageArea();
  if (!area) return;
  try {
    await area.set({ [CAPTURE_SETTINGS_KEY]: state.captureSettings });
  } catch {
    toast('保存设置失败');
  }
}

function onCaptureAutoCommitChange() {
  state.captureSettings.autoCommit = els.captureAutoCommit.checked;
  void persistCaptureSettings();
  toast(
    state.captureSettings.autoCommit
      ? '已开启自动入库：捕获后直接写入，只提示结果'
      : '已关闭自动入库：每次捕获都会先展示预览',
  );
}

// ---------------------------------------------------------------------------
// Push settings (每日剂量). Lives in chrome.storage.local; the worker only ever
// receives the resulting `dose` per feed call, so the policy stays in core.
// ---------------------------------------------------------------------------

function normalizeDose(value) {
  const dose = Math.round(Number(value));
  return FEED_DOSE_CHOICES.includes(dose) ? dose : DEFAULT_FEED_DOSE;
}

async function loadFeedSettings() {
  const area = storageArea();
  if (!area) return;
  try {
    const got = (await area.get(FEED_SETTINGS_KEY)) ?? {};
    const value = got[FEED_SETTINGS_KEY];
    if (value && typeof value === 'object') state.feedSettings.dose = normalizeDose(value.dose);
  } catch {
    /* defaults are fine; settings must never block boot */
  }
}

async function persistFeedSettings() {
  const area = storageArea();
  if (!area) return;
  try {
    await area.set({ [FEED_SETTINGS_KEY]: { dose: state.feedSettings.dose } });
  } catch {
    toast('保存设置失败');
  }
}

function onFeedDoseChange(dose) {
  const next = normalizeDose(dose);
  if (next === state.feedSettings.dose) return;
  state.feedSettings.dose = next;
  void persistFeedSettings();
  toast(`每日剂量已设为 ${next} 条`);
  if (state.surface === 'feed' && state.payload && !state.payload.empty) {
    void refreshFeedAndPaint();
  }
}

// ---------------------------------------------------------------------------
// Interruptions (M2b)
//
// The page owns the settings form; the sidebar content script and the background
// worker read the same chrome.storage.local keys, so there is exactly one budget
// for sidebar + system notifications. This page is also the only context that can
// reach the feed worker, so it publishes the `latticeBillboard` snapshot those
// surfaces render from and drains their queued exposures on boot.
// ---------------------------------------------------------------------------

function interruptFormState() {
  const checkedLimit = document.querySelector('input[name="interrupt-limit"]:checked');
  const base = state.interruptSettings;
  return PushShared.normalizeInterruptSettings({
    dailyLimit: checkedLimit ? Number(checkedLimit.value) : base.dailyLimit,
    quietStart: els.interruptQuietStart ? els.interruptQuietStart.value : base.quietStart,
    quietEnd: els.interruptQuietEnd ? els.interruptQuietEnd.value : base.quietEnd,
    sidebar: els.interruptSidebar ? els.interruptSidebar.checked : base.sidebar,
    notifications: els.interruptNotifications ? els.interruptNotifications.checked : base.notifications,
    ambient: els.interruptAmbient ? els.interruptAmbient.checked : base.ambient,
    injectComments: els.interruptInject ? els.interruptInject.checked : base.injectComments,
    searchJump: els.interruptSearchJump ? els.interruptSearchJump.checked : base.searchJump,
    sites: {
      bilibili: els.interruptSiteBilibili ? els.interruptSiteBilibili.checked : base.sites.bilibili,
      youtube: els.interruptSiteYoutube ? els.interruptSiteYoutube.checked : base.sites.youtube,
    },
  });
}

function paintInterruptStatus() {
  if (!els.interruptStatus) return;
  const settings = state.interruptSettings;
  const quiet = settings.quietStart === settings.quietEnd ? '未启用' : `${settings.quietStart}–${settings.quietEnd}`;
  els.interruptStatus.textContent = `每日打扰上限 ${settings.dailyLimit} 次 · 安静时段 ${quiet} · 侧栏 ${
    settings.sidebar ? '开' : '关'
  } · 通知 ${settings.notifications ? '开' : '关'} · 环境 ${settings.ambient ? '开' : '关'}`;
  els.interruptStatus.hidden = false;
}

function fillInterruptForm() {
  const settings = state.interruptSettings;
  for (const radio of document.querySelectorAll('input[name="interrupt-limit"]')) {
    radio.checked = Number(radio.value) === settings.dailyLimit;
  }
  if (els.interruptQuietStart) els.interruptQuietStart.value = settings.quietStart;
  if (els.interruptQuietEnd) els.interruptQuietEnd.value = settings.quietEnd;
  if (els.interruptSidebar) els.interruptSidebar.checked = settings.sidebar;
  if (els.interruptSiteBilibili) els.interruptSiteBilibili.checked = settings.sites.bilibili;
  if (els.interruptSiteYoutube) els.interruptSiteYoutube.checked = settings.sites.youtube;
  if (els.interruptNotifications) els.interruptNotifications.checked = settings.notifications;
  if (els.interruptAmbient) els.interruptAmbient.checked = settings.ambient;
  if (els.interruptInject) els.interruptInject.checked = settings.injectComments;
  if (els.interruptSearchJump) els.interruptSearchJump.checked = settings.searchJump;
  paintInterruptStatus();
}

async function loadInterruptSettings() {
  const area = storageArea();
  if (!area || !PushShared) return;
  try {
    state.interruptSettings = PushShared.normalizeInterruptSettings(
      await PushShared.readKey(area, PushShared.KEYS.interruptSettings, null),
    );
  } catch {
    /* defaults are fine; settings must never block boot */
  }
}

async function persistInterruptSettings() {
  const area = storageArea();
  if (!area || !PushShared) return;
  const saved = await PushShared.writeKey(area, PushShared.KEYS.interruptSettings, state.interruptSettings);
  if (!saved) toast('保存设置失败');
}

function onInterruptSettingsChanged() {
  state.interruptSettings = interruptFormState();
  void persistInterruptSettings();
  paintInterruptStatus();
  toast('打扰设置已保存');
}

function pushDay() {
  return PushShared ? PushShared.dayOf(new Date()) : new Date().toISOString().slice(0, 10);
}

/** Publishes the current feed for the sidebar/notifications to render from. */
function publishBillboard(feed) {
  const area = storageArea();
  if (!area || !PushShared) return;
  const items = (Array.isArray(feed.items) ? feed.items : [])
    .map((item) =>
      PushShared.normalizeSnapshotItem({
        propositionId: item.propositionId,
        cueId: item.cueId,
        statement: item.statement,
        domain: item.domain,
        reason: item.reason,
        name: item.name,
        tier: item.tier,
        cognitive: item.cognitive,
        mastery: item.mastery && typeof item.mastery === 'object' ? item.mastery.mean : item.mastery,
        retrievability: item.retrievability,
        score: item.score,
      }),
    )
    .filter(Boolean);
  const snapshot = {
    day: feed.todayDate || pushDay(),
    dose: feed.dose ?? state.feedSettings.dose,
    refreshedAt: new Date().toISOString(),
    items,
  };
  void PushShared.writeKey(area, PushShared.KEYS.billboard, snapshot);
}

/**
 * Drains sidebar/notification exposures into the event log. The queue records
 * carry their own ids and the worker's insert is INSERT OR IGNORE, so a crash
 * between append and cleanup cannot double-count attention.
 */
async function drainPendingExposureQueue() {
  const area = storageArea();
  if (!area || !PushShared) return null;
  const queue = await PushShared.readExposureQueue(area).catch(() => []);
  if (!Array.isArray(queue) || queue.length === 0) return null;
  try {
    const result = await rpc('drainExposures', { exposures: queue, dose: state.feedSettings.dose });
    const drained = new Set(queue.map((entry) => entry.id));
    const current = await PushShared.readExposureQueue(area).catch(() => []);
    await PushShared.writeKey(
      area,
      PushShared.KEYS.exposureQueue,
      current.filter((entry) => !drained.has(entry.id)),
    );
    return result;
  } catch (err) {
    console.error('[Lattice] 曝光队列入库失败', err);
    return null;
  }
}

async function drainAndRefreshOnVisible() {
  const result = await drainPendingExposureQueue();
  if (!result) return;
  await refresh().catch(() => {});
  if (state.surface === 'feed' && state.payload && !state.payload.empty) {
    state.feed.items = [];
    void refreshFeedAndPaint();
  }
}

/** 清空数据 also resets the push caches owned by this page. */
async function clearPushCaches() {
  const area = storageArea();
  if (!area || !PushShared) return;
  const now = new Date();
  const day = PushShared.dayOf(now);
  try {
    await area.set({
      [PushShared.KEYS.billboard]: { day, dose: state.feedSettings.dose, refreshedAt: now.toISOString(), items: [] },
      [PushShared.KEYS.exposureQueue]: [],
      [PushShared.KEYS.shownGuard]: { day, ids: [] },
      [PushShared.KEYS.interruptState]: { day, used: 0 },
      [PushShared.KEYS.notifyDay]: null,
    });
  } catch {
    /* caches are rebuildable; never block clearing the real data */
  }
}

async function readInterruptSnapshot() {
  const area = storageArea();
  if (!area || !PushShared) return null;
  try {
    const context = await PushShared.readInterruptContext(area, new Date());
    const queue = await PushShared.readExposureQueue(area).catch(() => []);
    const optOut = await PushShared.readAmbientOptOut(area).catch(() => []);
    return { ...context, pending: queue.length, optOut };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 兴趣领域 + 自主准备内容 (M2c)
//
// Interests are events in the C ledger (the worker owns them); this module only
// renders them and decides *when* to ask for content. The one-per-domain-per-day
// rule lives in curriculum-guard.js so it is testable outside the browser.
// ---------------------------------------------------------------------------

/** Non-blocking line under the feed card ("正在为…准备内容" / "点 ⚙ 配置模型…"). */
function paintFeedHint(text, { tone = 'hint' } = {}) {
  if (!els.feedHint) return;
  els.feedHint.textContent = text || '';
  els.feedHint.hidden = !text;
  els.feedHint.classList.toggle('error', tone === 'error');
}

function setInterestStatus(message, isError = false) {
  if (!els.interestStatus) return;
  els.interestStatus.textContent = message || '';
  els.interestStatus.hidden = !message;
  els.interestStatus.classList.toggle('error', Boolean(isError));
}

/** Declared interests only: inferred ones are shown in 诊断, not editable here. */
function declaredInterests() {
  return state.curriculum.interests.filter((entry) => entry && entry.declared);
}

/** Reads needs/interests + the persisted once-per-day guard from all sources. */
async function refreshCurriculumMeta() {
  try {
    const result = await rpc('curriculumNeeds');
    state.curriculum.needs = Array.isArray(result?.needs) ? result.needs : [];
    state.curriculum.interests = Array.isArray(result?.interests) ? result.interests : [];
  } catch {
    // The list is a view; a failed read must never block the feed.
  }
  state.curriculum.dayState = await loadCurriculumState(storageArea());
}

/** 领域名 · 水平 · [移除] */
function interestRow(entry) {
  const row = document.createElement('div');
  row.className = 'interest-row';
  row.dataset.domain = entry.name;
  const name = document.createElement('span');
  name.className = 'interest-name';
  name.textContent = entry.name;
  const level = document.createElement('span');
  level.className = 'interest-level';
  level.textContent = levelLabel(entry.level);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'interest-remove';
  remove.textContent = '移除';
  remove.title = `不再主动为「${entry.name}」准备内容（捕获记录保留）`;
  remove.addEventListener('click', () => void onRemoveInterest(entry.name));
  row.append(name, document.createTextNode(' · '), level, document.createTextNode(' · '), remove);
  const count = Number(entry.captureCount) || 0;
  if (count > 0) row.title = `捕获过 ${count} 次`;
  return row;
}

function paintInterestSettings() {
  if (!els.interestList) return;
  els.interestList.replaceChildren();
  const declared = declaredInterests();
  if (declared.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'interest-empty';
    empty.textContent = '还没有声明兴趣领域。添加一个，系统会按水平准备内容并推送。';
    els.interestList.appendChild(empty);
    return;
  }
  for (const entry of declared) els.interestList.appendChild(interestRow(entry));
}

async function openInterestSettings() {
  setInterestStatus('');
  await refreshCurriculumMeta();
  paintInterestSettings();
}

/** "添加" in 设置 → 兴趣领域: one `interest.declared` event, then the feed refresh. */
async function onAddInterest() {
  const domain = els.interestDomain?.value.trim() ?? '';
  const level = normalizeLevel(els.interestLevel?.value);
  if (!domain) {
    setInterestStatus('请填写领域名称（例如：数学）', true);
    els.interestDomain?.focus();
    return;
  }
  els.btnInterestAdd.disabled = true;
  setInterestStatus(`正在声明兴趣「${domain}」…`);
  try {
    const result = await rpc('declareInterest', { domain, level });
    applyFeedResult(result?.feed);
    els.interestDomain.value = '';
    setInterestStatus(`已声明兴趣「${domain}」（${levelLabel(level)}）`);
    toast(`已声明兴趣「${domain}」· 今日推荐已更新`);
    await refreshCurriculumMeta();
    paintInterestSettings();
    await refresh();
    // A freshly declared domain has no content: prepare it right away when a
    // model is configured, otherwise show the configure-model hint.
    void maybeAutoCurriculum({ trigger: 'declare' });
  } catch (err) {
    setInterestStatus(err.message, true);
    toast(err.message);
  } finally {
    if (els.btnInterestAdd) els.btnInterestAdd.disabled = false;
  }
}

async function onRemoveInterest(domain) {
  try {
    const result = await rpc('removeInterest', { domain });
    applyFeedResult(result?.feed);
    setInterestStatus(`已移除兴趣「${domain}」（捕获记录保留）`);
    toast(`已移除兴趣「${domain}」`);
    await refreshCurriculumMeta();
    paintInterestSettings();
    await refresh();
  } catch (err) {
    setInterestStatus(err.message, true);
    toast(err.message);
  }
}

/** First run / empty state: import the bundled beginner curriculum + declarations. */
async function runSeedCurriculum() {
  // The page resolves the extension URL: chrome.runtime is reliable on an
  // extension page but not in every dedicated worker implementation, while
  // fetch(chrome-extension://…) works fine inside the worker.
  const runtime = globalThis.chrome?.runtime;
  const url = runtime && typeof runtime.getURL === 'function' ? runtime.getURL('data/seed-curriculum.json') : '';
  const result = await rpc('seedCurriculum', url ? { url } : {});
  state.feed.items = [];
  if (result && result.alreadySeeded) return result;
  const domains = Array.isArray(result.domains) && result.domains.length > 0 ? result.domains : ['计算机', '人工智能'];
  toast(`已为你准备${domains.map((domain) => `「${domain}」`).join('')}入门内容`, 6000);
  return result;
}

async function seedFromEmptyState() {
  if (els.btnSeed) els.btnSeed.disabled = true;
  try {
    await runSeedCurriculum();
    await refresh();
    await refreshCurriculumMeta();
    if (state.curriculum.interests.length > 0) paintInterestSettings();
    void maybeAutoCurriculum({ trigger: 'seed' });
  } catch (err) {
    toast(err.message);
  } finally {
    if (els.btnSeed) els.btnSeed.disabled = false;
  }
}

/**
 * The one place that starts autonomous generation. Rules (see curriculum-guard):
 * never twice at once, never loop inside a session, at most once per domain per
 * local day; without a configured model it only shows a non-blocking hint.
 */
async function maybeAutoCurriculum({ trigger = 'boot' } = {}) {
  if (state.curriculum.busy) return { action: 'none', reason: 'busy' };
  await refreshCurriculumMeta();
  const plan = planNextGeneration({
    needs: state.curriculum.needs,
    curriculumState: state.curriculum.dayState,
    day: localDayKey(),
    providerReady: providerReady(state.provider),
    busy: state.curriculum.busy,
    attempted: state.curriculum.attempted,
  });
  if (plan.action === 'none') {
    if (plan.reason === 'no-needs' || plan.reason === 'daily-limit') paintFeedHint('');
    return plan;
  }
  const need = plan.need;
  if (plan.action === 'hint') {
    paintFeedHint(`点 ⚙ 配置模型后，系统会为你主动准备「${need.domain}」的内容`);
    return plan;
  }

  state.curriculum.busy = true;
  state.curriculum.attempted.add(need.domain);
  paintFeedHint(`正在为「${need.domain}」准备${levelLabel(need.level)}内容…`);
  try {
    const result = await rpc(
      'generateCurriculum',
      {
        domain: need.domain,
        level: need.level,
        count: CURRICULUM_BATCH,
        provider: state.provider,
      },
      RPC_TIMEOUTS.generateCurriculum,
    );
    const added = Number(result?.addedPropositions) || 0;
    // Persist the once-per-domain-per-day guard only after a successful call.
    const nextDayState = markGeneratedForDay(state.curriculum.dayState, need.domain, localDayKey());
    if (await saveCurriculumState(storageArea(), nextDayState)) state.curriculum.dayState = nextDayState;
    toast(`已加入 ${added} 条 · 今日推荐已更新`, 5200);
    paintFeedHint(`已为「${need.domain}」准备 ${added} 条内容 · 今日推荐已更新`);
    await refreshCurriculumMeta();
    state.feed.items = [];
    await refresh();
    if (state.surface === 'feed') await refreshFeedAndPaint();
    return { ...plan, added };
  } catch (err) {
    // A failure may be retried later by an explicit trigger; the daily guard is
    // only written on success, so no content is silently skipped for the day.
    state.curriculum.attempted.delete(need.domain);
    paintFeedHint(`为「${need.domain}」准备内容失败：${err.message}`, { tone: 'error' });
    toast(err.message);
    return { action: 'error', need, error: err.message };
  } finally {
    state.curriculum.busy = false;
  }
}

async function loadProviderConfig() {
  const area = storageArea();
  if (!area) return;
  try {
    const got = (await area.get(PROVIDER_STORAGE_KEY)) ?? {};
    state.provider = sanitizeProviderConfig(got[PROVIDER_STORAGE_KEY]);
  } catch {
    state.provider = null; // a broken settings read must not break the newtab page
  }
}

function providerSummary(config) {
  if (!config || !config.model) return '未配置';
  return `${config.model} (${config.preset})`;
}

function providerReady(config) {
  if (!config || !config.baseUrl || !config.model) return false;
  return Boolean(config.apiKey) || isLocalBaseUrl(config.baseUrl);
}

function isLocalBaseUrl(baseUrl) {
  try {
    return LOCAL_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

function providerOrigin(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

/** True when this base URL needs a runtime host permission (custom https host). */
function needsHostPermission(baseUrl) {
  const origin = providerOrigin(baseUrl);
  if (!origin) return false;
  const url = new URL(baseUrl);
  if (LOCAL_HOSTS.has(url.hostname)) return false;
  if (url.hostname === 'api.deepseek.com' || url.hostname === 'api.openai.com') return false;
  return url.protocol === 'https:';
}

function readProviderForm() {
  return {
    preset: PROVIDER_PRESET_VALUES.includes(els.providerPreset.value) ? els.providerPreset.value : 'custom',
    baseUrl: els.providerBaseUrl.value.trim(),
    model: els.providerModel.value.trim(),
    apiKey: els.providerKey.value,
    disableThinking: els.providerDisableThinking.checked,
  };
}

/** Chinese validation message, or '' when the form is usable. */
function providerFormError(config) {
  if (!config.baseUrl) return '请填写接口地址（例如 https://api.deepseek.com）';
  let url;
  try {
    url = new URL(config.baseUrl);
  } catch {
    return '接口地址不是合法的 URL（例如 https://api.deepseek.com）';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '接口地址必须以 http:// 或 https:// 开头';
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    return '非本机接口必须使用 https://（本机可用 http://127.0.0.1 或 http://localhost）';
  }
  if (!config.model) return '请填写模型名称（例如 deepseek-flash），或点「拉取模型」';
  if (!config.apiKey && !LOCAL_HOSTS.has(url.hostname)) return '请填写 API Key（本机接口可留空）';
  return '';
}

function showProviderError(message) {
  els.providerError.textContent = message || '';
  els.providerError.hidden = !message;
}

function paintProviderStatus(text) {
  if (typeof text === 'string') {
    els.providerStatus.textContent = text;
    return;
  }
  if (state.provider && state.provider.model) {
    els.providerStatus.textContent = `当前模型: ${providerSummary(state.provider)}`;
  } else {
    els.providerStatus.textContent = '尚未配置模型';
  }
}

function fillProviderForm() {
  const config = state.provider;
  const preset = config ? config.preset : 'deepseek';
  els.providerPreset.value = preset;
  const presetDefaults = PROVIDER_PRESETS[preset] ?? PROVIDER_PRESETS.custom;
  els.providerBaseUrl.value = config ? config.baseUrl : presetDefaults.baseUrl;
  els.providerModel.value = config ? config.model : presetDefaults.model;
  els.providerKey.value = config ? config.apiKey : '';
  els.providerDisableThinking.checked = config ? config.disableThinking !== false : true;
  showProviderError('');
  paintProviderStatus();
}

function applyProviderPreset(preset) {
  const defaults = PROVIDER_PRESETS[preset];
  if (!defaults) return;
  if (preset !== 'custom') {
    els.providerBaseUrl.value = defaults.baseUrl;
    els.providerModel.value = defaults.model;
  }
  showProviderError('');
}

function onProviderPresetChange() {
  applyProviderPreset(els.providerPreset.value);
}

async function persistProvider(config) {
  const area = storageArea();
  try {
    if (area) await area.set({ [PROVIDER_STORAGE_KEY]: config });
  } catch (err) {
    showProviderError(`保存失败：${err?.message ?? err}`);
    return;
  }
  state.provider = config;
  paintProviderStatus();
  showProviderError('');
  toast('模型配置已保存');
  // Declared domains may still need content: now that a model exists, prepare
  // the smallest one in the background (once per domain per day).
  void maybeAutoCurriculum({ trigger: 'provider' });
}

/**
 * 保存 must stay inside the click gesture because chrome.permissions.request
 * only works in a user gesture — hence the request is issued synchronously.
 */
function onProviderSave() {
  const config = readProviderForm();
  const error = providerFormError(config);
  if (error) {
    showProviderError(error);
    return;
  }
  if (!needsHostPermission(config.baseUrl)) {
    void persistProvider(config);
    return;
  }
  const origin = providerOrigin(config.baseUrl);
  const permissions = globalThis.chrome?.permissions;
  if (!permissions || typeof permissions.request !== 'function') {
    showProviderError('当前环境无法申请接口访问权限，请检查浏览器是否支持可选站点权限');
    return;
  }
  // Called before any await: the user gesture is still active here.
  const granted = permissions.request({ origins: [`${origin}/*`] });
  void granted
    .then((ok) => {
      if (!ok) {
        showProviderError(`未授予访问 ${origin} 的权限，无法调用该接口。请重试并在弹窗中点击「允许」。`);
        return;
      }
      void persistProvider(config);
    })
    .catch(() => {
      showProviderError(`申请访问 ${origin} 的权限失败，请检查接口地址是否正确`);
    });
}

/**
 * Asks the endpoint for its model list and fills the datalist. Exists so a
 * renamed model is a two-click fix for the user, not a release.
 */
async function onProviderFetchModels() {
  const config = readProviderForm();
  if (!config.baseUrl) {
    showProviderError('请先填写接口地址');
    return;
  }
  els.btnProviderModels.disabled = true;
  paintProviderStatus('正在获取模型列表…');
  showProviderError('');
  try {
    const result = await rpc('listModels', { provider: config });
    const models = Array.isArray(result.models) ? result.models : [];
    els.providerModelList.replaceChildren(
      ...models.map((id) => {
        const option = document.createElement('option');
        option.value = id;
        return option;
      }),
    );
    if (models.length > 0 && !els.providerModel.value) els.providerModel.value = models[0];
    paintProviderStatus(`已获取 ${models.length} 个模型，从下拉列表中选择`);
    toast(`找到 ${models.length} 个可用模型`);
  } catch (err) {
    paintProviderStatus('获取模型失败');
    showProviderError(err?.message ?? String(err));
  } finally {
    els.btnProviderModels.disabled = false;
  }
}

async function onProviderTest() {
  const config = readProviderForm();
  const error = providerFormError(config);
  if (error) {
    showProviderError(error);
    return;
  }
  els.btnProviderTest.disabled = true;
  paintProviderStatus('正在测试连接…');
  showProviderError('');
  try {
    const result = await rpc('providerTest', { provider: config });
    const latency = Math.max(0, Math.round(Number(result.latencyMs) || 0));
    const reply = result.reply ? ` · 回复 ${result.reply}` : '';
    paintProviderStatus(`连接成功 · 延迟 ${latency}ms · 模型 ${result.model}${reply}`);
    toast('模型连接成功');
  } catch (err) {
    paintProviderStatus('连接失败');
    showProviderError(err?.message ?? String(err));
    toast(err?.message ?? '模型连接失败');
  } finally {
    els.btnProviderTest.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Boot / views
// ---------------------------------------------------------------------------

async function boot() {
  state.fatal = false;
  showView('loading');
  // M2c: ambient/inline cards can deep-link the newtab with ?focus=<propositionId>.
  try {
    const params = new URL(window.location.href).searchParams;
    state.focusPropositionId = (params.get('focus') || '').slice(0, 120);
  } catch {
    state.focusPropositionId = '';
  }
  try {
    await loadProviderConfig();
    await loadCaptureSettings();
    await loadFeedSettings();
    await loadInterruptSettings();
    const init = await rpc('init');
    if (init.storage === 'fallback') {
      const detail = init.persisted ? 'chrome.storage 持久化' : '仅内存（未检测到 chrome.storage）';
      toast(`存储回退：${detail}；原因可在「诊断」里查看`, 5600);
    }
    // First run: the learner has neither content nor interests. Import the
    // bundled beginner curriculum and declare 计算机 + 人工智能, so 今日推送 has
    // something to push before any capture and before a model is configured.
    const interestCount = Array.isArray(init.interests) ? init.interests.length : 0;
    if (init.counts.propositions === 0 && interestCount === 0) {
      try {
        await runSeedCurriculum();
      } catch (err) {
        toast(`入门内容载入失败：${err.message}`, 5600);
      }
    }
    // M2b: sidebar/notification exposures were queued while this page was away;
    // drain them BEFORE reading the feed so today's already-shown cards stay out.
    await drainPendingExposureQueue();
    await refresh();
    await consumePendingCapture();
    await refreshCurriculumMeta();
    // Needs may exist from a previous session (a declared domain that never got
    // content); prepare it now if a model is available, hint if it is not.
    void maybeAutoCurriculum({ trigger: 'boot' });
  } catch (err) {
    fail(err && err.message ? err.message : String(err));
  }
}

function fail(message) {
  state.fatal = true;
  els.fatalDetail.textContent = message;
  showView('fatal');
}

const VIEWS = {
  loading: () => els.viewLoading,
  empty: () => els.viewEmpty,
  feed: () => els.viewFeed,
  card: () => els.viewCard,
  done: () => els.viewDone,
  fatal: () => els.viewFatal,
};

function showView(name) {
  state.view = name;
  for (const key of Object.keys(VIEWS)) {
    VIEWS[key]().hidden = key !== name;
  }
}

async function refresh() {
  const payload = await rpc('state');
  state.payload = payload;
  state.answered.clear();
  paint();
}

// ---------------------------------------------------------------------------
// Rendering
//
// Two surfaces share the stage: 今日推送 (default, ad-like feed) and 复习队列
// (the M0 card flow, kept as an optional entry for deliberate practice).
// ---------------------------------------------------------------------------

function paint() {
  const payload = state.payload;
  if (!payload) return;
  updateCounters(payload);
  paintTabs();
  if (state.fatal) {
    showView('fatal');
    return;
  }
  if (payload.empty) {
    showView('empty');
    els.btnSample.focus();
    return;
  }
  if (state.surface === 'queue') {
    paintQueue(payload);
    return;
  }
  paintFeed();
}

function paintTabs() {
  if (!els.tabFeed) return;
  const due = state.payload?.counts?.due ?? 0;
  els.tabReviewCount.textContent = String(due);
  const onFeed = state.surface === 'feed';
  els.tabFeed.classList.toggle('is-active', onFeed);
  els.tabReview.classList.toggle('is-active', !onFeed);
  els.tabFeed.setAttribute('aria-selected', String(onFeed));
  els.tabReview.setAttribute('aria-selected', String(!onFeed));
}

function setSurface(surface) {
  if (!SURFACES.includes(surface) || state.surface === surface) return;
  state.surface = surface;
  paintTabs();
  if (!state.payload) return;
  if (state.payload.empty) {
    paint();
    return;
  }
  if (surface === 'queue') {
    paintQueue(state.payload);
    return;
  }
  void refreshFeedAndPaint();
}

function paintQueue(payload) {
  const queue = payload.queue.filter((item) => !state.answered.has(itemKey(item)));
  if (queue.length === 0) {
    paintDone(payload);
    return;
  }
  state.card = queue[0];
  state.cardOrigin = 'queue';
  state.cardShownAt = performance.now();
  state.revealed = false;
  showView('card');
  paintCard();
}

function paintDone(payload) {
  const remaining = payload.counts.due + payload.counts.new;
  els.doneTitle.textContent = remaining > 0 ? '本轮完成 ✓' : '今天清空了 ✓';
  els.doneDetail.textContent =
    remaining > 0
      ? `队列里还有 ${payload.counts.due} 项到期复习、${payload.counts.new} 项新学；点「刷新队列」继续。`
      : `共 ${payload.counts.propositions} 个命题 · 复习 ${payload.counts.reviews} 次 · 校验摘要 ${payload.digest}`;
  showView('done');
  els.btnDoneExport.focus();
}

// ---------------------------------------------------------------------------
// Feed (今日推送): one passive card at a time, ads-like.
//
// Showing an item logs exposure.shown exactly once per proposition per day (the
// worker enforces it across reloads; the local Set only guards re-paints). The
// three actions map to C-ledger events: 知道了 -> engaged, 不感兴趣 -> skipped,
// 考考我 -> the optional quiz flow (M ledger only).
// ---------------------------------------------------------------------------

function applyFeedResult(result) {
  const feed = result && typeof result === 'object' ? result : {};
  state.feed.items = Array.isArray(feed.items) ? feed.items : [];
  state.feed.interests = Array.isArray(feed.interests) ? feed.interests : [];
  if (typeof feed.todayDate === 'string' && feed.todayDate.length > 0) state.feed.today = feed.todayDate;
  // M2c: an ambient/inline "感兴趣" on a non-video page opens
  // newtab.html?focus=<id>. Put that item first once, so the click lands on it.
  if (state.focusPropositionId && !state.focusConsumed) {
    const target = state.focusPropositionId;
    const index = state.feed.items.findIndex((item) => item && item.propositionId === target);
    if (index > 0) {
      const [picked] = state.feed.items.splice(index, 1);
      state.feed.items.unshift(picked);
    }
    if (index >= 0) state.focusConsumed = true;
  }
  // Cache the billboard for the sidebar + ambient surfaces (M2b/M2c).
  publishBillboard(feed);
}

async function refreshFeedAndPaint() {
  const token = (feedRequestToken += 1);
  state.feed.busy = true;
  showView('feed');
  els.feedCard.hidden = true;
  els.feedDone.hidden = true;
  els.feedLoading.hidden = false;
  try {
    const result = await rpc('feed', { dose: state.feedSettings.dose });
    if (token !== feedRequestToken) return; // a newer request owns the stage
    applyFeedResult(result);
  } catch (err) {
    if (token === feedRequestToken) toast(err.message);
  } finally {
    if (token === feedRequestToken) {
      state.feed.busy = false;
      paintFeedView();
    }
  }
}

function paintFeed() {
  if (state.feed.items.length > 0) {
    paintFeedView();
    return;
  }
  void refreshFeedAndPaint();
}

function paintFeedView() {
  showView('feed');
  els.feedLoading.hidden = true;
  if (state.feed.items.length === 0) {
    paintFeedDone();
    return;
  }
  paintFeedCard(state.feed.items[0]);
}

function paintFeedCard(item) {
  els.feedCard.hidden = false;
  els.feedDone.hidden = true;
  els.feedLoading.hidden = true;
  const reasonLabel = item.reason === 'due' ? '复习' : item.reason === 'frontier' ? '前沿' : '基础';
  els.feedReason.textContent = reasonLabel;
  els.feedReason.dataset.reason = item.reason || 'foundation';
  const domain = typeof item.domain === 'string' ? item.domain : '';
  els.feedDomain.textContent = domain;
  els.feedDomain.hidden = domain.length === 0;
  // ★ tier + cognitive label (M2b difficulty contract; both fields optional).
  const difficulty = PushShared ? PushShared.describeDifficulty(item) : null;
  els.feedDifficulty.textContent = difficulty ? difficulty.text : '';
  els.feedDifficulty.hidden = !difficulty;
  els.feedDifficulty.title = difficulty && difficulty.label ? `难度 · ${difficulty.label}` : '难度';
  els.feedDifficulty.dataset.tier = item.tier ? String(item.tier) : '';
  els.feedDifficulty.dataset.cognitive = item.cognitive || '';
  els.feedStatement.textContent = item.statement || '（这条命题没有正文）';
  const cue = typeof item.cueFront === 'string' ? item.cueFront.trim() : '';
  els.feedCue.textContent = cue && cue !== item.statement ? `想一想：${cue}` : '';
  els.feedCue.hidden = els.feedCue.textContent.length === 0;
  els.feedMeta.textContent = `掌握 ${pct(item.mastery?.mean)}% · R ${pct(item.retrievability)}%`;
  els.feedSource.textContent = domain ? `来自「${domain}」` : '来自你的知识库';
  els.feedProgress.textContent = `今日剩 ${state.feed.items.length} 条 · 剂量 ${state.feedSettings.dose} 条`;
  els.btnFeedQuiz.disabled = !item.cueId;
  els.btnFeedQuiz.title = item.cueId ? '进入测验（可选，只写掌握账）' : '这个命题还没有卡片，暂时不能测验';
  els.feedCard.dataset.propositionId = item.propositionId;
  els.feedCard.dataset.reason = item.reason || '';
  els.feedCard.dataset.domain = domain;
  els.feedCard.dataset.remaining = String(state.feed.items.length);
  els.viewFeed.dataset.today = state.feed.today;
  els.btnFeedKnow.disabled = false;
  els.btnFeedSkip.disabled = false;
  logFeedShown(item);
  els.btnFeedKnow.focus();
}

function paintFeedDone() {
  els.feedCard.hidden = true;
  els.feedLoading.hidden = true;
  els.feedDone.hidden = false;
  const interests = state.feed.interests;
  els.feedDoneDetail.textContent =
    interests.length > 0
      ? `今天的小剂量已经完成。你的兴趣：${interests.map((entry) => `${entry.name}（×${entry.count}）`).join('、')}`
      : '今天没有更多可推的内容。';
  els.btnFeedReview.focus();
  // The feed is empty: declared domains may still lack content, so try once per
  // page session to prepare one (the guard prevents loops and duplicate calls).
  if (!state.curriculum.emptyChecked) {
    state.curriculum.emptyChecked = true;
    void maybeAutoCurriculum({ trigger: 'feed-empty' });
  }
}

function logFeedShown(item) {
  if (!item || typeof item.propositionId !== 'string' || item.propositionId.length === 0) return;
  const day = state.feed.today || new Date().toISOString().slice(0, 10);
  const key = `${day}|${item.propositionId}`;
  if (state.feed.shown.has(key)) return;
  state.feed.shown.add(key);
  // The worker is the source of truth (exposure.shown carries the day); this Set
  // only stops a re-paint in this page from logging the same card twice.
  rpc('exposure', { propositionId: item.propositionId, kind: 'shown', surface: 'newtab' }).catch(() => {
    state.feed.shown.delete(key); // allow a retry on the next paint
  });
}

async function feedExposure(kind) {
  if (state.feed.busy) return;
  const item = state.feed.items[0];
  if (!item) return;
  state.feed.busy = true;
  els.btnFeedKnow.disabled = true;
  els.btnFeedSkip.disabled = true;
  try {
    const result = await rpc('exposure', {
      propositionId: item.propositionId,
      kind,
      surface: 'newtab',
      dose: state.feedSettings.dose,
    });
    applyFeedResult(result.feed);
    paintFeedView();
  } catch (err) {
    toast(err.message);
  } finally {
    state.feed.busy = false;
    els.btnFeedKnow.disabled = false;
    els.btnFeedSkip.disabled = false;
  }
}

/** 考考我: optional verification, reusing the existing card flow in quiz mode. */
function startFeedQuiz() {
  const item = state.feed.items[0];
  if (!item || !item.cueId) {
    toast('这个命题还没有卡片，暂时不能测验');
    return;
  }
  state.modeBeforeQuiz = state.mode;
  state.mode = 'quiz';
  state.cardOrigin = 'feed';
  state.card = {
    propositionId: item.propositionId,
    cueId: item.cueId,
    kind: item.kind,
    front: item.cueFront || item.statement,
    back: item.cueBack || item.statement,
    statement: item.statement,
    domain: item.domain,
    dueAt: null,
    mastery: item.mastery,
    retrievability: item.retrievability,
    reviewCount: 0,
    stage: 'new',
  };
  state.revealed = false;
  state.cardShownAt = performance.now();
  showView('card');
  paintCard();
}

function updateCounters(payload) {
  els.counterReview.textContent = `复习 ${payload.counts.due}`;
  els.counterNew.textContent = `新学 ${payload.counts.new}`;
  els.counterTotal.textContent = `共 ${payload.counts.propositions} 命题`;
}

function paintCard() {
  const card = state.card;
  if (!card) return;
  const spread = Math.max(0, (card.mastery.high - card.mastery.low) / 2);
  els.cardMeta.textContent = [
    `掌握 ${pct(card.mastery.mean)}% ±${pct(spread)}%`,
    `可用 ${pct(card.retrievability)}%`,
    `复习 ${card.reviewCount} 次`,
    card.kind === 'review' ? '到期复习' : '新学',
  ].join(' · ');
  els.cardFront.textContent = card.front;
  els.cardBack.textContent = card.back;

  els.cardAnswer.hidden = !state.revealed;
  els.actionsFront.hidden = state.revealed;
  els.actionsGrade.hidden = !state.revealed || state.mode !== 'review';
  els.actionsQuiz.hidden = !state.revealed || state.mode !== 'quiz';

  if (state.revealed) els.viewCard.focus();
  else els.btnReveal.focus();
}

function pct(value) {
  const clamped = Math.max(0, Math.min(1, Number(value) || 0));
  return Math.round(clamped * 100);
}

function itemKey(item) {
  return `${item.propositionId}|${item.cueId}`;
}

// ---------------------------------------------------------------------------
// Review actions
// ---------------------------------------------------------------------------

function reveal() {
  if (state.revealed || !state.card || state.busy) return;
  state.revealed = true;
  paintCard();
}

async function submitGrade(grade) {
  if (state.busy || !state.card || state.mode !== 'review' || !state.revealed) return;
  const card = state.card;
  state.busy = true;
  try {
    const payload = await rpc('grade', { propositionId: card.propositionId, cueId: card.cueId, grade });
    state.answered.add(itemKey(card));
    state.payload = payload;
    paint();
  } catch (err) {
    toast(err.message);
  } finally {
    state.busy = false;
  }
}

async function submitQuiz(correct) {
  if (state.busy || !state.card || state.mode !== 'quiz' || !state.revealed) return;
  const card = state.card;
  const origin = state.cardOrigin;
  const latencyMs = Math.round(performance.now() - state.cardShownAt);
  state.busy = true;
  try {
    const payload = await rpc('quiz', {
      propositionId: card.propositionId,
      cueId: card.cueId,
      correct,
      latencyMs,
    });
    state.payload = payload;
    if (origin === 'feed') {
      // Optional verification from the feed is done: drop back to the passive
      // stream. The quizzed proposition is already shown today, so the refreshed
      // feed naturally moves on.
      state.card = null;
      state.cardOrigin = 'queue';
      state.mode = state.modeBeforeQuiz;
      state.feed.items = [];
      paint();
      return;
    }
    state.answered.add(itemKey(card));
    paint();
  } catch (err) {
    toast(err.message);
  } finally {
    state.busy = false;
  }
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

async function importPackText(text) {
  try {
    const result = await rpc('importPack', { text });
    if (result.errors && result.errors.length > 0) {
      els.packError.textContent = result.errors.slice(0, 4).join('\n');
      els.packError.hidden = false;
      toast(`导入失败：${result.errors[0]}`);
      return false;
    }
    if (result.addedPropositions === 0 && result.skipped === 0) {
      toast('没有可导入的命题');
      return false;
    }
    const parts = [`导入 ${result.addedPropositions} 条命题（${result.addedCues} 张卡）`];
    if (result.skipped > 0) parts.push(`跳过重复 ${result.skipped} 条`);
    toast(parts.join('，'));
    closeDialogs();
    els.packError.hidden = true;
    state.feed.items = []; // new propositions must be considered by the next feed
    await refresh();
    return true;
  } catch (err) {
    els.packError.textContent = err.message;
    els.packError.hidden = false;
    toast(err.message);
    return false;
  }
}

async function loadSamplePack() {
  try {
    const response = await fetch(SAMPLE_PACK_URL);
    if (!response.ok) throw new Error(`示例包读取失败（HTTP ${response.status}）`);
    await importPackText(await response.text());
  } catch (err) {
    toast(err.message);
  }
}

async function exportLog() {
  try {
    const result = await rpc('exportJsonl');
    if (!result.text) {
      toast('日志为空，没有可导出的内容');
      return;
    }
    downloadText(`lattice-${fileStamp()}.jsonl`, result.text);
    toast(`已导出 ${result.events} 条事件`);
  } catch (err) {
    toast(err.message);
  }
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/x-ndjson;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function fileStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function importJsonlText(text) {
  try {
    const result = await rpc('importJsonl', { text });
    const problems = result.errors && result.errors.length > 0 ? `，${result.errors.length} 行有问题` : '';
    if (result.added === 0) {
      els.importError.textContent = result.errors.slice(0, 4).join('\n') || '没有新增事件（可能全部重复或格式无效）';
      els.importError.hidden = els.importError.textContent.length === 0;
      toast('没有导入任何事件');
      return;
    }
    toast(`导入 ${result.added} 条事件${problems}`);
    closeDialogs();
    els.importError.hidden = true;
    state.feed.items = [];
    await refresh();
  } catch (err) {
    els.importError.textContent = err.message;
    els.importError.hidden = false;
    toast(err.message);
  }
}

async function readFileText(file) {
  if (!file) return '';
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'));
    reader.readAsText(file);
  });
}

// ---------------------------------------------------------------------------
// Diagnostics / settings / clear
// ---------------------------------------------------------------------------

function storageLabel(info) {
  if (!info || !info.storage) return '未知';
  return info.storage === 'opfs' ? 'OPFS' : '回退(chrome.storage)';
}

function formatDiagnostics(info, graph) {
  const counts = info.counts ?? {};
  const lines = [];
  lines.push('Lattice M2 诊断');
  lines.push(`存储: ${storageLabel(info)}`);
  if (info.storageDetail) lines.push(`  VFS: ${info.storageDetail}`);
  if (info.storage === 'fallback' && !info.persisted) {
    lines.push('  备注: 回退模式下未检测到可用的持久化通道，本次仅内存，关闭页面后丢失');
  }
  if (info.backgroundLine) lines.push(info.backgroundLine);
  lines.push(`设备 ID: ${info.deviceId}`);
  lines.push(`模型: ${providerSummary(state.provider)}`);
  if (info.feed) {
    const feed = info.feed;
    const interests =
      Array.isArray(feed.interests) && feed.interests.length > 0
        ? feed.interests.map((entry) => `${entry.name}×${entry.count}`).join('、')
        : '无';
    lines.push(
      `推送: 每日 ${feed.dose ?? state.feedSettings.dose} 条 · 今日已展示 ${feed.shownToday ?? 0} · 参与 ${
        feed.engaged ?? 0
      } · 跳过 ${feed.skipped ?? 0} · 兴趣 ${interests}`,
    );
  }
  if (info.interrupt) {
    const settings = info.interrupt.settings || state.interruptSettings;
    const used = info.interrupt.state ? Number(info.interrupt.state.used) || 0 : 0;
    const quiet = settings.quietStart === settings.quietEnd ? '未启用' : `${settings.quietStart}–${settings.quietEnd}`;
    lines.push(
      `打扰: 上限 ${settings.dailyLimit} 次 · 今日已用 ${used} · 安静 ${quiet} · 侧栏 ${
        settings.sidebar ? '开' : '关'
      } · 通知 ${settings.notifications ? '开' : '关'} · 待入库曝光 ${Number(info.interrupt.pending) || 0} 条`,
    );
    // M2c ambient surfaces. "本站" on the newtab (extension origin) is not blocked.
    const optOut = Array.isArray(info.interrupt.optOut) ? info.interrupt.optOut : [];
    const localBlocked = false;
    lines.push(
      `环境: 任意网页 ${settings.ambient ? '开' : '关'} · 评论注入 ${settings.injectComments ? '开' : '关'} · 站内跳转 ${
        settings.searchJump ? '开' : '关'
      } · 本站已屏蔽 ${localBlocked ? '是' : '否'}${optOut.length > 0 ? ` · 已屏蔽 ${optOut.length} 站` : ''}`,
    );
  }
  if (info.curriculum) {
    // M2c: the declared side (who the system is preparing for) and the work queue.
    const declaredInterests = Array.isArray(info.curriculum.interests)
      ? info.curriculum.interests.filter((entry) => entry && entry.declared)
      : [];
    const interestLine =
      declaredInterests.length > 0
        ? declaredInterests.map((entry) => `${entry.name}(${levelLabel(entry.level)})`).join('、')
        : '无';
    lines.push(`兴趣: ${interestLine}`);
    const needs = Array.isArray(info.curriculum.needs) ? info.curriculum.needs : [];
    const needLine =
      needs.length > 0
        ? needs
            .map((entry) => `${entry.domain}(${levelLabel(entry.level)}·已有 ${Number(entry.existing) || 0})`)
            .join('、')
        : '无';
    lines.push(`待生成: ${needLine}`);
  }
  if (graph) {
    lines.push(
      `图谱: 命题 ${graph.propositions} · 推理链 ${graph.chains} · 基础 ${graph.foundation} · 有前置 ${graph.withPrereq} · 已掌握 ${graph.mastered}`,
    );
  }
  lines.push(`事件序号: ${info.lastSeq}`);
  lines.push(`校验摘要: ${info.digest}`);
  lines.push(
    `统计: 命题 ${counts.propositions ?? 0} · 卡 ${counts.cues ?? 0} · 复习 ${counts.reviews ?? 0} · 到期 ${
      counts.due ?? 0
    } · 新学 ${counts.new ?? 0} · 事件 ${info.eventCount ?? counts.events ?? 0}${
      typeof info.coverageCount === 'number' ? ` · 覆盖 ${info.coverageCount} 段` : ''
    }`,
  );
  if (Array.isArray(info.openErrors) && info.openErrors.length > 0) {
    lines.push('存储回退原因:');
    for (const reason of info.openErrors) lines.push(`  - ${reason}`);
  }
  if (Array.isArray(info.seedErrors) && info.seedErrors.length > 0) {
    lines.push(`日志读取问题: ${info.seedErrors.length} 条（已跳过）`);
  }
  lines.push('');
  lines.push(info.reportText ?? '（无校准报告）');
  lines.push('');
  lines.push(`生成时间: ${new Date().toISOString()}`);
  return lines.join('\n');
}

/**
 * Asks the service worker for its build id. Returns a human line for 诊断:
 * a stale worker (or none) is reported instead of pretending everything is fine.
 */
async function backgroundHealthLine() {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime || typeof runtime.sendMessage !== 'function') return '后台: 无法检测（非扩展环境）';
  try {
    const reply = await runtime.sendMessage({ type: 'lattice-ping' });
    if (reply && reply.ok) return `后台: ${reply.build} ✓`;
    return '后台: 响应异常';
  } catch {
    return '后台: 未响应 ✗（在 edge://extensions 点「重新加载」后重试）';
  }
}

async function openDiagnostics() {
  els.diagText.textContent = '正在读取…';
  openDialog(els.dialogDiagnostics);
  try {
    const [info, graph, backgroundLine, interrupt] = await Promise.all([
      rpc('diagnostics', { dose: state.feedSettings.dose }),
      rpc('graphSummary').catch(() => null),
      backgroundHealthLine(),
      readInterruptSnapshot(),
    ]);
    state.diagnostics = info;
    if (backgroundLine) info.backgroundLine = backgroundLine;
    if (interrupt) info.interrupt = interrupt;
    els.diagText.textContent = formatDiagnostics(info, graph);
  } catch (err) {
    els.diagText.textContent = `诊断失败：${err.message}`;
  }
}

function openSettings() {
  const payload = state.payload;
  if (payload) {
    const detail = payload.storageDetail ? `（${payload.storageDetail}）` : '';
    els.setStorage.textContent = `${storageLabel(payload)}${detail}`;
    els.setDevice.textContent = payload.deviceId;
    els.setSeq.textContent = String(payload.lastSeq);
    els.setDigest.textContent = payload.digest;
  }
  els.captureAutoCommit.checked = state.captureSettings.autoCommit;
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.checked = radio.value === state.mode;
  }
  for (const radio of document.querySelectorAll('input[name="feed-dose"]')) {
    radio.checked = Number(radio.value) === state.feedSettings.dose;
  }
  fillInterruptForm();
  fillProviderForm();
  setInterestStatus('');
  openDialog(els.dialogSettings);
  // Interests are events in the worker: read them fresh every time the dialog opens.
  void openInterestSettings();
}

function setMode(mode) {
  if (mode !== 'review' && mode !== 'quiz') return;
  state.mode = mode;
  if (!state.payload || state.payload.empty) return;
  paint();
}

function openClearDialog() {
  els.clearConfirm.value = '';
  els.clearError.hidden = true;
  els.btnClearConfirm.disabled = true;
  openDialog(els.dialogClear);
  els.clearConfirm.focus();
}

async function clearAll() {
  const typed = els.clearConfirm.value.trim();
  if (typed !== 'DELETE') {
    els.clearError.textContent = '请输入 DELETE 以确认';
    els.clearError.hidden = false;
    return;
  }
  state.busy = true;
  try {
    await rpc('clear');
    closeDialogs();
    state.feed.items = [];
    state.feed.shown.clear();
    // Guard bookkeeping is page-side cache; clear it with the data it protects.
    state.curriculum = {
      busy: false,
      attempted: new Set(),
      dayState: {},
      needs: [],
      interests: [],
      emptyChecked: false,
    };
    const area = storageArea();
    if (area && typeof area.remove === 'function') {
      try {
        await area.remove(CURRICULUM_STATE_KEY);
      } catch {
        /* best effort: losing the guard only allows one extra generation */
      }
    }
    await clearPushCaches();
    paintFeedHint('');
    await refresh();
    toast('已清空全部本地数据');
  } catch (err) {
    els.clearError.textContent = err.message;
    els.clearError.hidden = false;
    toast(err.message);
  } finally {
    state.busy = false;
  }
}

// ---------------------------------------------------------------------------
// Capture: text -> model extraction -> preview -> confirmed events
//
// Nothing the model produces is committed here: the user sees/edits the plan
// and only then does the page send the (filtered) JSON plan back to the worker.
// ---------------------------------------------------------------------------

/**
 * Picks up a page capture handed over by background.js (toolbar click or the
 * selection context menu), prefills the dialog and starts extraction. The model
 * call only happens if a provider is configured; otherwise the text is kept so
 * the user can configure the model and press 抽取.
 */
async function consumePendingCapture() {
  const area = storageArea();
  if (!area) return;
  let pending = null;
  try {
    const got = (await area.get(PENDING_CAPTURE_KEY)) ?? {};
    pending = got[PENDING_CAPTURE_KEY] ?? null;
  } catch {
    return;
  }
  if (!pending) return;
  try {
    if (typeof area.remove === 'function') await area.remove(PENDING_CAPTURE_KEY);
  } catch {
    /* ignoring: the payload is consumed in this page anyway */
  }

  if (!pending.ok) {
    openCaptureDialog();
    showCaptureError(`无法捕获这个页面：${pending.reason || '未知原因'}`);
    return;
  }

  els.captureTitle.value = pending.title || '';
  els.captureText.value = pending.text || '';
  state.captureSourceKind = 'page';
  state.captureSourceUri = pending.url || '';

  if (state.provider && providerReady(state.provider)) {
    if (state.captureSettings.autoCommit) {
      // No dialog at all: progress and result are a toast, the queue refresh is
      // the visible feedback. Errors still open the dialog.
      state.silentCapture = true;
      toast(
        pending.truncated
          ? '页面正文较长，已截断；正在自动入库…'
          : pending.hasSelection
            ? '正在把选中文字自动入库…'
            : '正在抓取并自动入库…',
        6000,
      );
      await runExtraction(false);
      return;
    }
    openCaptureDialog();
    els.captureTitle.value = pending.title || '';
    els.captureText.value = pending.text || '';
    paintCaptureProviderLine();
    if (pending.truncated) toast('页面正文较长，已截断到约 12000 字', 4800);
    else toast(pending.hasSelection ? '已抓取选中文字，正在抽取…' : '已抓取页面正文，正在抽取…');
    void runExtraction(false);
    return;
  }

  openCaptureDialog();
  els.captureTitle.value = pending.title || '';
  els.captureText.value = pending.text || '';
  paintCaptureProviderLine();
  showCaptureError('正文已抓取。请先点右上角 ⚙ 配置模型，然后点「抽取」。');
}

function openCaptureDialog() {
  state.capture = null;
  state.captureForce = false;
  state.captureSourceKind = 'paste';
  state.captureSourceUri = '';
  els.captureTitle.value = '';
  els.captureText.value = '';
  els.captureStatus.hidden = true;
  els.captureError.hidden = true;
  els.captureCoverage.hidden = true;
  els.capturePreview.hidden = true;
  els.btnCaptureConfirm.disabled = true;
  setCaptureBusy(false);
  paintCaptureProviderLine();
  openDialog(els.dialogCapture);
  els.captureText.focus();
}

function paintCaptureProviderLine() {
  if (state.provider && providerReady(state.provider)) {
    els.captureProvider.textContent = `当前模型: ${providerSummary(state.provider)}（在 ⚙ 设置里修改）`;
    els.captureProvider.classList.remove('error');
  } else {
    els.captureProvider.textContent = '尚未配置模型：请先点右上角 ⚙，在「模型」里填写接口地址、模型和 API Key。';
    els.captureProvider.classList.add('error');
  }
}

function setCaptureBusy(busy) {
  state.captureBusy = busy;
  els.btnCaptureExtract.disabled = busy;
  els.btnCaptureReextract.disabled = busy;
  els.btnCaptureConfirm.disabled = busy || !state.capture;
}

function showCaptureError(message) {
  els.captureError.textContent = message || '';
  els.captureError.hidden = !message;
}

/** Chinese error text + at most 3 validation issue lines; never a stack. */
function captureErrorText(err) {
  const lines = [err && err.message ? err.message : '抽取失败'];
  const issues = err && Array.isArray(err.issues) ? err.issues.slice(0, 3) : [];
  for (const issue of issues) {
    const path = issue && typeof issue.path === 'string' ? issue.path : '';
    const text = issue && typeof issue.message === 'string' ? issue.message : String(issue);
    lines.push(`· ${[path, text].filter(Boolean).join(' ')}`);
  }
  return lines.join('\n');
}

function formatCapturedAt(iso) {
  if (!iso) return '未知时间';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未知时间';
  try {
    return date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

async function runExtraction(force = false) {
  if (state.captureBusy) return;
  const text = els.captureText.value;
  if (!text.trim()) {
    showCaptureError('请先粘贴要拆解的文本');
    return;
  }
  if (!state.provider || !providerReady(state.provider)) {
    if (state.silentCapture) openDialog(els.dialogCapture);
    showCaptureError('尚未配置模型：请点右上角 ⚙，在「模型」里填写接口地址、模型名称和 API Key。');
    return;
  }

  state.captureForce = force;
  setCaptureBusy(true);
  showCaptureError('');
  els.captureCoverage.hidden = true;
  els.capturePreview.hidden = true;
  els.captureStatus.hidden = false;
  els.captureStatus.textContent = '正在调用模型抽取…（最长约 60 秒）';
  try {
    const result = await rpc('extractPreview', {
      text,
      title: els.captureTitle.value.trim(),
      sourceKind: state.captureSourceKind || 'paste',
      sourceUri: state.captureSourceUri || undefined,
      provider: state.provider,
      force,
    });
    if (result.coverageHit) {
      state.capture = null;
      showCoverageHit(result);
      return;
    }
    state.capture = {
      source: result.source,
      plan: result.plan,
      propositions: result.propositions.map((proposition) => ({ ...proposition, checked: true })),
      chainChecks: result.plan.chains.map((chain) => (Number(chain.strength) || 0) >= 0.5),
      promptVersion: result.promptVersion,
      model: result.model,
      providerLabel: result.providerLabel,
    };
    // Lightweight by default: skip the confirmation step entirely. The toggle in
    // 设置 brings the preview back for users who want to review every capture.
    if (state.captureSettings.autoCommit) {
      // confirmExtraction refuses to run while a capture is marked busy, so hand
      // the baton over explicitly instead of returning silently.
      setCaptureBusy(false);
      await confirmExtraction();
      return;
    }
    paintPreview();
    els.capturePreview.hidden = false;
  } catch (err) {
    if (state.silentCapture) openDialog(els.dialogCapture);
    showCaptureError(captureErrorText(err));
  } finally {
    els.captureStatus.hidden = true;
    setCaptureBusy(false);
    state.silentCapture = false;
  }
}

function showCoverageHit(result) {
  els.captureStatus.hidden = true;
  els.capturePreview.hidden = true;
  els.captureCoverage.hidden = false;
  els.captureCoverageText.textContent = `这段内容已经处理过（${result.propositionCount ?? 0} 条命题，${formatCapturedAt(
    result.extractedAt,
  )}）`;
  els.btnCaptureConfirm.disabled = true;
}

function statementByRef() {
  const map = new Map();
  for (const proposition of state.capture.propositions) map.set(proposition.ref, proposition.statement);
  return map;
}

function shortStatement(statement, max = 26) {
  const text = String(statement ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function paintPreview() {
  const capture = state.capture;
  if (!capture) return;
  const domain = typeof capture.plan.domain === 'string' && capture.plan.domain.length > 0 ? ` · 领域「${capture.plan.domain}」` : '';
  els.capturePreviewTitle.textContent = `预览：${capture.propositions.length} 条命题 · ${capture.plan.chains.length} 条推理链${domain}`;
  paintProps();
  paintChains();
  paintDropped();
  els.btnCaptureConfirm.disabled = capture.propositions.every((proposition) => !proposition.checked);
}

function paintProps() {
  const capture = state.capture;
  els.captureProps.textContent = '';
  els.capturePropsCount.textContent = `（${capture.propositions.length}）`;
  capture.propositions.forEach((proposition, index) => {
    const row = document.createElement('label');
    row.className = 'preview-prop';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = proposition.checked;
    checkbox.dataset.ref = proposition.ref;
    checkbox.addEventListener('change', () => {
      proposition.checked = checkbox.checked;
      updateChainAvailability();
      els.btnCaptureConfirm.disabled = capture.propositions.every((entry) => !entry.checked);
    });

    const body = document.createElement('span');
    body.className = 'preview-prop-body';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'preview-statement';
    input.value = proposition.statement;
    input.dataset.ref = proposition.ref;
    input.setAttribute('aria-label', `命题 ${index + 1}`);
    if (proposition.existingId) {
      // Identity resolution already linked this to an existing proposition:
      // editing the text here would not change that proposition.
      input.readOnly = true;
      input.title = '这条命题已存在，本次会复用它';
    }
    input.addEventListener('input', () => {
      if (proposition.existingId) return;
      proposition.statement = input.value;
      syncPlanStatement(proposition.ref, input.value);
      paintChains();
    });
    body.appendChild(input);

    const metaBits = [];
    if (proposition.name) metaBits.push(proposition.name);
    if (proposition.quote) metaBits.push(`「${proposition.quote}」`);
    if (proposition.existingId) metaBits.push('已存在，将复用');
    else metaBits.push('新命题');
    if (metaBits.length > 0) {
      const meta = document.createElement('span');
      meta.className = 'preview-meta';
      meta.textContent = metaBits.join(' · ');
      body.appendChild(meta);
    }

    row.appendChild(checkbox);
    row.appendChild(body);
    els.captureProps.appendChild(row);
  });
}

function syncPlanStatement(ref, statement) {
  const capture = state.capture;
  if (!capture) return;
  const createEntry = capture.plan.create.find((entry) => entry.ref === ref);
  if (createEntry) createEntry.statement = statement;
  const cue = capture.plan.cues.find((entry) => entry.ref === ref);
  if (cue) cue.back = statement;
}

function paintChains() {
  const capture = state.capture;
  els.captureChains.textContent = '';
  els.captureChainsCount.textContent = `（${capture.plan.chains.length}）`;
  const statements = statementByRef();
  const rows = [];
  capture.plan.chains.forEach((chain, index) => {
    const row = document.createElement('label');
    row.className = 'preview-chain';
    row.dataset.index = String(index);
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.index = String(index);
    checkbox.checked = Boolean(capture.chainChecks[index]);
    checkbox.addEventListener('change', () => {
      capture.chainChecks[index] = checkbox.checked;
    });
    const body = document.createElement('span');
    body.className = 'preview-chain-body';
    const premiseText = chain.premiseRefs
      .map((ref) => shortStatement(statements.get(ref) ?? ref))
      .join(' + ');
    const conclusionText = shortStatement(statements.get(chain.conclusionRef) ?? chain.conclusionRef);
    const text = document.createElement('span');
    text.textContent = `前提 ${premiseText} ⟹ 结论 ${conclusionText} `;
    const strength = document.createElement('span');
    strength.className = 'strength';
    strength.textContent = `置信度 ${(Number(chain.strength) || 0).toFixed(2)}`;
    text.appendChild(strength);
    body.appendChild(text);
    row.appendChild(checkbox);
    row.appendChild(body);
    els.captureChains.appendChild(row);
    rows.push(row);
  });
  els.captureNoChains.hidden = rows.length > 0;
  updateChainAvailability();
}

function updateChainAvailability() {
  const capture = state.capture;
  if (!capture) return;
  const selected = new Set(capture.propositions.filter((proposition) => proposition.checked).map((p) => p.ref));
  for (const row of els.captureChains.querySelectorAll('.preview-chain')) {
    const index = Number(row.dataset.index);
    const chain = capture.plan.chains[index];
    if (!chain) continue;
    const refs = [...chain.premiseRefs, chain.conclusionRef];
    const available = refs.every((ref) => selected.has(ref));
    const checkbox = row.querySelector('input[type="checkbox"]');
    row.classList.toggle('unavailable', !available);
    checkbox.disabled = !available;
    checkbox.checked = available && Boolean(capture.chainChecks[index]);
  }
}

function paintDropped() {
  const capture = state.capture;
  const dropped = Array.isArray(capture.plan.dropped) ? capture.plan.dropped : [];
  if (dropped.length === 0) {
    els.captureDropped.hidden = true;
    els.captureDroppedList.textContent = '';
    return;
  }
  els.captureDropped.hidden = false;
  els.captureDroppedSummary.textContent = `查看被丢弃的 ${dropped.length} 项`;
  els.captureDroppedList.textContent = '';
  for (const entry of dropped) {
    const item = document.createElement('li');
    item.textContent = entry && entry.reason ? entry.reason : '未知原因';
    els.captureDroppedList.appendChild(item);
  }
}

function collectPlanForCommit() {
  const capture = state.capture;
  const selected = new Set(
    capture.propositions.filter((proposition) => proposition.checked).map((proposition) => proposition.ref),
  );
  const plan = {
    // The domain is the interest signal; commitExtraction turns it into
    // `interest.observed` + `proposition.domain`, so it must survive the filter.
    ...(capture.plan.domain ? { domain: capture.plan.domain } : {}),
    create: capture.plan.create.filter((entry) => selected.has(entry.ref)),
    reuse: capture.plan.reuse.filter((entry) => selected.has(entry.ref)),
    cues: capture.plan.cues.filter((entry) => selected.has(entry.ref)),
    chains: capture.plan.chains.filter(
      (chain, index) =>
        Boolean(capture.chainChecks[index]) &&
        [...chain.premiseRefs, chain.conclusionRef].every((ref) => selected.has(ref)),
    ),
    dropped: [],
  };
  return { plan, selected };
}

async function confirmExtraction() {
  const capture = state.capture;
  if (!capture || state.captureBusy) return;
  const { plan, selected } = collectPlanForCommit();
  if (selected.size === 0) {
    showCaptureError('请至少保留一条命题');
    return;
  }
  setCaptureBusy(true);
  try {
    const result = await rpc(
      'commitExtraction',
      {
        source: capture.source,
        plan,
        providerLabel: capture.providerLabel,
        model: capture.model,
        promptVersion: capture.promptVersion,
        force: state.captureForce,
      },
      RPC_TIMEOUTS.commitExtraction,
    );
    if (result.alreadyCovered) {
      toast('这段内容已入库，未重复写入');
      closeDialogs();
      await refresh();
      return;
    }
    // A capture is an interest signal first, so the toast names the domain and
    // the feed is immediately recomputed (the new domain reorders it).
    if (result.domain) {
      toast(`已加入「${result.domain}」· 今日推荐已更新`);
    } else {
      const parts = [`已入库 ${result.counts.propositions} 条命题 / ${result.counts.chains} 条推理链`];
      if (result.counts.reused > 0) parts.push(`复用已有 ${result.counts.reused} 条`);
      if (result.counts.propositions === 0 && result.counts.chains === 0) parts.push('没有新的内容');
      toast(parts.join('，'));
    }
    closeDialogs();
    state.feed.items = [];
    await refresh();
  } catch (err) {
    if (state.silentCapture) openDialog(els.dialogCapture);
    showCaptureError(captureErrorText(err));
  } finally {
    setCaptureBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Dialogs / toast / clipboard
// ---------------------------------------------------------------------------

function openDialog(dialog) {
  if (!dialog || dialog.open) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialogs() {
  for (const dialog of document.querySelectorAll('dialog[open]')) {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }
}

let toastTimer = null;

function toast(text, ms = 3600) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastTimer = null;
    els.toast.hidden = true;
  }, ms);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for pages where the async clipboard API is not permitted.
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    helper.remove();
    return ok;
  }
}

async function flushPersistence() {
  try {
    await rpc('flush');
  } catch {
    /* best effort: the debounced mirror is already scheduled in the worker */
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wire() {
  // Surfaces: 今日推送 is the default; 复习队列 stays one click away.
  els.tabFeed.addEventListener('click', () => setSurface('feed'));
  els.tabReview.addEventListener('click', () => setSurface('queue'));

  // Feed actions
  els.btnFeedKnow.addEventListener('click', () => void feedExposure('engaged'));
  els.btnFeedSkip.addEventListener('click', () => void feedExposure('skipped'));
  els.btnFeedQuiz.addEventListener('click', startFeedQuiz);
  els.btnFeedReview.addEventListener('click', () => setSurface('queue'));
  els.btnFeedCapture.addEventListener('click', openCaptureDialog);

  // Empty state
  els.btnSeed.addEventListener('click', () => void seedFromEmptyState());
  els.btnSample.addEventListener('click', () => void loadSamplePack());
  els.captureAutoCommit.addEventListener('change', onCaptureAutoCommitChange);
  els.btnCaptureTop.addEventListener('click', openCaptureDialog);
  els.btnCaptureEmpty.addEventListener('click', openCaptureDialog);
  els.btnImportPackFile.addEventListener('click', () => els.filePack.click());
  els.btnPastePack.addEventListener('click', () => {
    els.packText.value = '';
    els.packError.hidden = true;
    openDialog(els.dialogPack);
    els.packText.focus();
  });

  // Card
  els.btnReveal.addEventListener('click', reveal);
  for (const button of els.actionsGrade.querySelectorAll('button[data-grade]')) {
    button.addEventListener('click', () => void submitGrade(Number(button.dataset.grade)));
  }
  for (const button of els.actionsQuiz.querySelectorAll('button[data-correct]')) {
    button.addEventListener('click', () => void submitQuiz(button.dataset.correct === 'true'));
  }

  // Done
  els.btnDoneExport.addEventListener('click', () => void exportLog());
  els.btnDoneRefresh.addEventListener('click', () => void refresh().catch((err) => toast(err.message)));
  els.btnDoneFeed.addEventListener('click', () => setSurface('feed'));

  // Fatal
  els.btnRetry.addEventListener('click', () => {
    if (worker) worker.terminate();
    worker = null;
    rejectAllPending('正在重试');
    state.payload = null;
    state.answered.clear();
    void boot();
  });
  els.btnFatalDiagnostics.addEventListener('click', () => void openDiagnostics());

  // Footer
  els.btnCapture.addEventListener('click', openCaptureDialog);
  els.btnExport.addEventListener('click', () => void exportLog());
  els.btnImport.addEventListener('click', () => {
    pendingJsonlText = '';
    els.jsonlFileName.textContent = '未选择文件';
    els.importError.hidden = true;
    openDialog(els.dialogImport);
  });
  els.btnDiagnostics.addEventListener('click', () => void openDiagnostics());
  els.btnClear.addEventListener('click', openClearDialog);

  // Settings
  els.btnSettings.addEventListener('click', openSettings);
  els.btnSettingsClose.addEventListener('click', closeDialogs);
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener('change', () => {
      if (radio.checked) setMode(radio.value);
    });
  }
  for (const radio of document.querySelectorAll('input[name="feed-dose"]')) {
    radio.addEventListener('change', () => {
      if (radio.checked) onFeedDoseChange(radio.value);
    });
  }
  // M2b interruption settings: radio limit + quiet hours + sidebar/site/notification toggles.
  for (const radio of document.querySelectorAll('input[name="interrupt-limit"]')) {
    radio.addEventListener('change', () => {
      if (radio.checked) onInterruptSettingsChanged();
    });
  }
  for (const input of [els.interruptQuietStart, els.interruptQuietEnd]) {
    if (input) input.addEventListener('change', onInterruptSettingsChanged);
  }
  for (const input of [
    els.interruptSidebar,
    els.interruptSiteBilibili,
    els.interruptSiteYoutube,
    els.interruptNotifications,
    els.interruptAmbient,
    els.interruptInject,
    els.interruptSearchJump,
  ]) {
    if (input) input.addEventListener('change', onInterruptSettingsChanged);
  }
  els.providerPreset.addEventListener('change', onProviderPresetChange);
  els.btnProviderSave.addEventListener('click', onProviderSave);
  els.btnProviderModels.addEventListener('click', () => void onProviderFetchModels());
  els.btnProviderTest.addEventListener('click', () => void onProviderTest());

  // 兴趣领域: add form (Enter works too) + remove buttons are wired per row.
  els.btnInterestAdd.addEventListener('click', () => void onAddInterest());
  els.interestDomain.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void onAddInterest();
  });

  // Capture dialog
  els.btnCaptureCancel.addEventListener('click', closeDialogs);
  els.btnCaptureExtract.addEventListener('click', () => void runExtraction(false));
  els.btnCaptureReextract.addEventListener('click', () => void runExtraction(true));
  els.btnCaptureConfirm.addEventListener('click', () => void confirmExtraction());

  // Pack dialog
  els.btnPackCancel.addEventListener('click', closeDialogs);
  els.btnPackSubmit.addEventListener('click', () => {
    const text = els.packText.value;
    if (!text.trim()) {
      els.packError.textContent = '请先粘贴 JSON';
      els.packError.hidden = false;
      return;
    }
    void importPackText(text);
  });
  els.filePack.addEventListener('change', async () => {
    const file = els.filePack.files && els.filePack.files[0];
    els.filePack.value = '';
    if (!file) return;
    try {
      await importPackText(await readFileText(file));
    } catch (err) {
      toast(err.message);
    }
  });

  // JSONL import dialog
  els.btnJsonlCancel.addEventListener('click', closeDialogs);
  els.btnPickJsonl.addEventListener('click', () => els.fileJsonl.click());
  els.fileJsonl.addEventListener('change', async () => {
    const file = els.fileJsonl.files && els.fileJsonl.files[0];
    els.fileJsonl.value = '';
    if (!file) return;
    try {
      pendingJsonlText = await readFileText(file);
      els.jsonlFileName.textContent = `${file.name}（${pendingJsonlText.split('\n').filter((line) => line.trim()).length} 行）`;
      els.importError.hidden = true;
    } catch (err) {
      toast(err.message);
    }
  });
  els.btnJsonlSubmit.addEventListener('click', () => {
    if (!pendingJsonlText) {
      els.importError.textContent = '请先选择一个 .jsonl 文件';
      els.importError.hidden = false;
      return;
    }
    void importJsonlText(pendingJsonlText);
  });

  // Diagnostics dialog
  els.btnDiagClose.addEventListener('click', closeDialogs);
  els.btnDiagRefresh.addEventListener('click', () => void openDiagnostics());
  els.btnDiagCopy.addEventListener('click', async () => {
    const text = els.diagText.textContent ?? '';
    const ok = await copyText(text);
    toast(ok ? '诊断信息已复制' : '复制失败，请手动选择文本');
  });

  // Clear dialog
  els.btnClearCancel.addEventListener('click', closeDialogs);
  els.clearConfirm.addEventListener('input', () => {
    els.btnClearConfirm.disabled = els.clearConfirm.value.trim() !== 'DELETE';
    els.clearError.hidden = true;
  });
  els.btnClearConfirm.addEventListener('click', () => void clearAll());

  // Keyboard: Space reveals, 1-4 rate, 1-2 in quiz mode.
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (document.querySelector('dialog[open]')) return;
    const target = event.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
    }
    if (state.fatal || !state.payload || state.payload.empty || state.view !== 'card' || !state.card) return;

    if (event.key === ' ' || event.code === 'Space') {
      if (!state.revealed) {
        event.preventDefault();
        reveal();
      }
      return;
    }
    if (event.key === 'Enter' && !state.revealed) {
      event.preventDefault();
      reveal();
      return;
    }
    if (!state.revealed) return;
    const digit = Number(event.key);
    if (state.mode === 'review' && digit >= 1 && digit <= 4) {
      event.preventDefault();
      void submitGrade(digit);
    } else if (state.mode === 'quiz' && (digit === 1 || digit === 2)) {
      event.preventDefault();
      void submitQuiz(digit === 1);
    }
  });

  // Best-effort flush of the chrome.storage JSONL mirror before the tab dies.
  window.addEventListener('pagehide', () => void flushPersistence());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushPersistence();
    // Back on the newtab: sidebar/notification attention queued while we were
    // away is drained into the event log, then the feed is refreshed.
    else void drainAndRefreshOnVisible();
  });
}

wire();
void boot();
