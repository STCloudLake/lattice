/**
 * Lattice M0 newtab page.
 *
 * Owns the UI only. Every database read/write goes through a tiny RPC to
 * ../worker/worker.js, because the OPFS SQLite VFS only runs inside a Web Worker.
 * Plain JS, no framework, no external assets, keyboard first.
 */

const SAMPLE_PACK_URL = new URL('../data/sample-pack.json', import.meta.url);
const RPC_REQUEST = 'lattice-rpc';
const RPC_RESULT = 'lattice-rpc-result';
const RPC_TIMEOUT_MS = 30000;
/** Long operations need more than the default RPC timeout. */
const RPC_TIMEOUTS = { extractPreview: 150000, providerTest: 75000, commitExtraction: 60000 };

/** One storage key holds the whole provider config — and nothing else holds the key. */
const PROVIDER_STORAGE_KEY = 'latticeProvider';

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

  viewLoading: $('view-loading'),
  viewEmpty: $('view-empty'),
  viewCard: $('view-card'),
  viewDone: $('view-done'),
  viewFatal: $('view-fatal'),

  btnSample: $('btn-sample'),
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
  btnSettingsClose: $('btn-settings-close'),

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
  payload: null,
  card: null,
  cardShownAt: 0,
  revealed: false,
  busy: false,
  fatal: false,
  view: 'loading',
  answered: new Set(), // queue keys answered in this page session (quiz mode needs it)
  diagnostics: null,
  provider: null, // {preset, baseUrl, model, apiKey} from chrome.storage.local
  capture: null, // preview state; holds ONLY the JSON plan + display rows
  captureBusy: false,
  captureForce: false, // true when the user chose "仍然重新抽取"
};

let pendingJsonlText = '';

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
  try {
    await loadProviderConfig();
    const init = await rpc('init');
    if (init.storage === 'fallback') {
      const detail = init.persisted ? 'chrome.storage 持久化' : '仅内存（未检测到 chrome.storage）';
      toast(`存储回退：${detail}；原因可在「诊断」里查看`, 5600);
    }
    await refresh();
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
// ---------------------------------------------------------------------------

function paint() {
  const payload = state.payload;
  if (!payload) return;
  updateCounters(payload);
  if (state.fatal) {
    showView('fatal');
    return;
  }
  if (payload.empty) {
    showView('empty');
    els.btnSample.focus();
    return;
  }
  const queue = payload.queue.filter((item) => !state.answered.has(itemKey(item)));
  if (queue.length === 0) {
    paintDone(payload);
    return;
  }
  state.card = queue[0];
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
  const latencyMs = Math.round(performance.now() - state.cardShownAt);
  state.busy = true;
  try {
    const payload = await rpc('quiz', {
      propositionId: card.propositionId,
      cueId: card.cueId,
      correct,
      latencyMs,
    });
    state.answered.add(itemKey(card));
    state.payload = payload;
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
  lines.push('Lattice M0 诊断');
  lines.push(`存储: ${storageLabel(info)}`);
  if (info.storageDetail) lines.push(`  VFS: ${info.storageDetail}`);
  if (info.storage === 'fallback' && !info.persisted) {
    lines.push('  备注: 回退模式下未检测到可用的持久化通道，本次仅内存，关闭页面后丢失');
  }
  lines.push(`设备 ID: ${info.deviceId}`);
  lines.push(`模型: ${providerSummary(state.provider)}`);
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

async function openDiagnostics() {
  els.diagText.textContent = '正在读取…';
  openDialog(els.dialogDiagnostics);
  try {
    const [info, graph] = await Promise.all([
      rpc('diagnostics'),
      rpc('graphSummary').catch(() => null),
    ]);
    state.diagnostics = info;
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
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.checked = radio.value === state.mode;
  }
  fillProviderForm();
  openDialog(els.dialogSettings);
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

function openCaptureDialog() {
  state.capture = null;
  state.captureForce = false;
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
      sourceKind: 'paste',
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
    paintPreview();
    els.capturePreview.hidden = false;
  } catch (err) {
    showCaptureError(captureErrorText(err));
  } finally {
    els.captureStatus.hidden = true;
    setCaptureBusy(false);
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
  els.capturePreviewTitle.textContent = `预览：${capture.propositions.length} 条命题 · ${capture.plan.chains.length} 条推理链`;
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
    const parts = [`已入库 ${result.counts.propositions} 条命题 / ${result.counts.chains} 条推理链`];
    if (result.counts.reused > 0) parts.push(`复用已有 ${result.counts.reused} 条`);
    if (result.counts.propositions === 0 && result.counts.chains === 0) parts.push('没有新的内容');
    toast(parts.join('，'));
    closeDialogs();
    await refresh();
  } catch (err) {
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
  // Empty state
  els.btnSample.addEventListener('click', () => void loadSamplePack());
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
  els.providerPreset.addEventListener('change', onProviderPresetChange);
  els.btnProviderSave.addEventListener('click', onProviderSave);
  els.btnProviderModels.addEventListener('click', () => void onProviderFetchModels());
  els.btnProviderTest.addEventListener('click', () => void onProviderTest());

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
  });
}

wire();
void boot();
