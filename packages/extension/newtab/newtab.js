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
    else entry.reject(new Error(message.error || '工作线程返回错误'));
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

function rpc(op, args = {}) {
  const activeWorker = ensureWorker();
  const id = (nextRpcId += 1);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRpc.delete(id);
      reject(new Error(`操作超时：${op}`));
    }, RPC_TIMEOUT_MS);
    pendingRpc.set(id, { resolve, reject, timer });
    activeWorker.postMessage({ type: RPC_REQUEST, id, op, args });
  });
}

// ---------------------------------------------------------------------------
// Boot / views
// ---------------------------------------------------------------------------

async function boot() {
  state.fatal = false;
  showView('loading');
  try {
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

function formatDiagnostics(info) {
  const counts = info.counts ?? {};
  const lines = [];
  lines.push('Lattice M0 诊断');
  lines.push(`存储: ${storageLabel(info)}`);
  if (info.storageDetail) lines.push(`  VFS: ${info.storageDetail}`);
  if (info.storage === 'fallback' && !info.persisted) {
    lines.push('  备注: 回退模式下未检测到可用的持久化通道，本次仅内存，关闭页面后丢失');
  }
  lines.push(`设备 ID: ${info.deviceId}`);
  lines.push(`事件序号: ${info.lastSeq}`);
  lines.push(`校验摘要: ${info.digest}`);
  lines.push(
    `统计: 命题 ${counts.propositions ?? 0} · 卡 ${counts.cues ?? 0} · 复习 ${counts.reviews ?? 0} · 到期 ${
      counts.due ?? 0
    } · 新学 ${counts.new ?? 0} · 事件 ${info.eventCount ?? counts.events ?? 0}`,
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
    const info = await rpc('diagnostics');
    state.diagnostics = info;
    els.diagText.textContent = formatDiagnostics(info);
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
