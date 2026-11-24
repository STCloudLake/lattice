/*
 * Lattice background service worker (classic script, no imports).
 *
 * Three jobs, all one-click or timer-driven:
 *   1. toolbar icon click       -> capture the page's main content
 *   2. right-click selection    -> capture only the selected text
 *   3. M2b interruption billboard -> a ~90 minute alarm may raise ONE system
 *      notification per day from the cached `latticeBillboard` snapshot, when
 *      the shared interruption budget and quiet hours allow it.
 *
 * The SQLite event log lives in the newtab's dedicated Worker, so this file
 * never opens the DB: it reads the snapshot + settings from chrome.storage.local
 * and appends attention records to `latticePendingExposures`, which the newtab
 * drains on boot. Capture text is still extracted by content/page-extract.js
 * injected with chrome.scripting (activeTab) and confirmed by the page.
 */

// Shared policy/keys. Loaded as a classic script so content scripts, this
// worker and the newtab page cannot drift apart.
if (typeof importScripts === 'function') {
  try {
    importScripts('shared/billboard.js');
  } catch (error) {
    console.error('[Lattice] 共享推送脚本载入失败', error);
  }
}
const PushShared = globalThis.LatticeBillboard;

/** Shown in 诊断 so a stale service worker is visible instead of silent. */
const BUILD = 'm2c-ambient-1';

const MENU_SELECTION = 'lattice-capture-selection';
const PENDING_KEY = 'latticePendingCapture';
const NEWTAB_URL = 'newtab/newtab.html?capture=1';
const MAX_FALLBACK_CHARS = 12000;

/** One reminder every 90 minutes; the budget and settings decide if it fires. */
const NOTIFY_ALARM = 'lattice-notify';
const NOTIFY_PERIOD_MINUTES = 90;
const NOTIFY_PREFIX = 'lattice-notify-';
/** Solid brand tile as a data URL (notifications require an icon). */
const NOTIFY_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAUUlEQVR4nO3PQQ3AIADAQBzNERbw/9reKChh1+QEdAxJW8+a78kM1AzUDNQM1AzUDNQM1AzUDNQM1AzUDNQM1AzUDNQM1AzUDNQM1O4fkH7WB20UYXXpOpdqAAAAAElFTkSuQmCC';

// ---------------------------------------------------------------------------
// Install / startup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: '存入 Lattice（选中文字）',
      contexts: ['selection'],
    });
  });
  ensureNotifyAlarm();
});

if (chrome.runtime.onStartup && typeof chrome.runtime.onStartup.addListener === 'function') {
  chrome.runtime.onStartup.addListener(() => ensureNotifyAlarm());
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info && info.menuItemId === MENU_SELECTION) void captureInto(tab, { selectionOnly: true });
});

chrome.action.onClicked.addListener((tab) => {
  void captureInto(tab, { selectionOnly: false });
});

/** Creates (or refreshes) the periodic reminder. Alarms persist across restarts. */
function ensureNotifyAlarm() {
  if (!chrome.alarms || typeof chrome.alarms.create !== 'function') return false;
  try {
    chrome.alarms.create(NOTIFY_ALARM, {
      delayInMinutes: NOTIFY_PERIOD_MINUTES,
      periodInMinutes: NOTIFY_PERIOD_MINUTES,
    });
    return true;
  } catch (error) {
    console.error('[Lattice] 无法创建通知提醒', error);
    return false;
  }
}

if (chrome.alarms && typeof chrome.alarms.onAlarm.addListener === 'function') {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === NOTIFY_ALARM) void maybeNotify(new Date());
  });
}

// ---------------------------------------------------------------------------
// Messaging (health check + content-script "open Lattice")
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  if (message.type === 'lattice-ping') {
    sendResponse({ ok: true, build: BUILD });
    return true;
  }
  if (message.type === 'lattice-open-newtab') {
    const focus = typeof message.focus === 'string' && message.focus.length > 0 ? message.focus : '';
    void openNewtab(focus ? `?focus=${encodeURIComponent(focus)}` : '');
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'lattice-open-search') {
    // M2c: "感兴趣" jumps to the platform's own search; content scripts must
    // never navigate the current tab, so the background opens the new tab.
    const platform = message.platform === 'youtube' ? 'youtube' : message.platform === 'bilibili' ? 'bilibili' : '';
    const query = typeof message.query === 'string' ? message.query.trim().slice(0, 120) : '';
    const url = platform && query && PushShared ? PushShared.searchUrl(platform, query) : '';
    if (!url) {
      sendResponse({ ok: false, error: '无法生成站内搜索地址' });
      return true;
    }
    void openUrl(url);
    sendResponse({ ok: true, url });
    return true;
  }
  return false;
});

function newtabUrl(query = '') {
  return chrome.runtime.getURL('newtab/newtab.html' + query);
}

async function openNewtab(query = '') {
  try {
    await chrome.tabs.create({ url: newtabUrl(query) });
    return true;
  } catch (error) {
    console.error('[Lattice] 打开新标签页失败', error);
    return false;
  }
}

/** Opens a validated platform-search URL in a new tab. */
async function openUrl(url) {
  try {
    await chrome.tabs.create({ url });
    return true;
  } catch (error) {
    console.error('[Lattice] 打开站内搜索失败', error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Notification billboard (M2b)
//
// At most one notification per day, highest-score item from the snapshot that
// has not been shown/notified yet. Notification clicks are engagement evidence;
// a user dismissal is a skip. Both are queued for the newtab to drain.
// ---------------------------------------------------------------------------

function notificationContext() {
  const area = (chrome.storage && chrome.storage.local) || null;
  return { area, shared: PushShared };
}

function pickNotifiedRecord(record, notificationId, today) {
  if (!record || typeof record !== 'object') return null;
  if (record.day !== today) return null;
  if (record.notificationId !== notificationId) return null;
  if (typeof record.id !== 'string' || !record.id) return null;
  return record;
}

async function maybeNotify(now) {
  const at = now instanceof Date ? now : new Date();
  const { area, shared } = notificationContext();
  if (!area || !shared) return { ok: false, reason: 'unavailable' };
  if (!chrome.notifications || typeof chrome.notifications.create !== 'function') {
    return { ok: false, reason: 'no-notifications-api' };
  }
  try {
    const settings = shared.normalizeInterruptSettings(
      await shared.readKey(area, shared.KEYS.interruptSettings, null),
    );
    if (!settings.notifications) return { ok: false, reason: 'disabled' };
    if (shared.withinQuietHours(settings, at)) return { ok: false, reason: 'quiet-hours' };
    const board = await shared.readKey(area, shared.KEYS.billboard, null);
    const guard = await shared.readShownGuard(area, at);
    const notifyDay = await shared.readKey(area, shared.KEYS.notifyDay, null);
    const item = shared.pickNotificationItem(board, guard, notifyDay, at);
    if (!item) return { ok: false, reason: 'no-item' };
    const claim = await shared.claimInterrupt(area, at);
    if (!claim.ok) return { ok: false, reason: claim.reason || 'budget' };
    const today = shared.dayOf(at);
    const notificationId = `${NOTIFY_PREFIX}${today}-${item.propositionId}`;
    const created = await createNotification(notificationId, item);
    if (!created.ok) {
      await shared.releaseInterrupt(area, at); // do not charge for a failed interrupt
      return { ok: false, reason: 'create-failed' };
    }
    await shared.markShown(area, at, [item.propositionId]);
    await shared.queueExposure(area, {
      propositionId: item.propositionId,
      kind: 'shown',
      surface: 'notification',
      at: at.toISOString(),
      day: today,
    });
    await shared.writeKey(area, shared.KEYS.notifyDay, {
      day: today,
      id: item.propositionId,
      notificationId,
      state: 'sent',
      at: at.toISOString(),
    });
    return { ok: true, reason: 'sent', notificationId, propositionId: item.propositionId };
  } catch (error) {
    console.error('[Lattice] 通知投放失败', error);
    return { ok: false, reason: 'error' };
  }
}

function createNotification(notificationId, item) {
  return new Promise((resolve) => {
    if (!chrome.notifications || typeof chrome.notifications.create !== 'function') {
      resolve({ ok: false });
      return;
    }
    const domain = item.domain ? `「${item.domain}」` : '';
    const options = {
      type: 'basic',
      iconUrl: NOTIFY_ICON,
      title: `Lattice · 今日知识${domain}`,
      message: String(item.statement || '').slice(0, 180) || '今日还有一点知识可以看',
      buttons: [{ title: '知道了' }, { title: '打开 Lattice' }],
      priority: 0,
      requireInteraction: false,
    };
    try {
      chrome.notifications.create(notificationId, options, (createdId) => {
        let failed = false;
        try {
          failed = Boolean(chrome.runtime && chrome.runtime.lastError);
        } catch {
          failed = false;
        }
        resolve({ ok: !failed, id: createdId || notificationId });
      });
    } catch (error) {
      console.error('[Lattice] 无法创建系统通知', error);
      resolve({ ok: false });
    }
  });
}

function clearNotification(notificationId) {
  try {
    if (chrome.notifications && typeof chrome.notifications.clear === 'function') {
      chrome.notifications.clear(notificationId);
    }
  } catch {
    /* a stale notification id is harmless */
  }
}

async function handleNotificationInteract(notificationId) {
  const { area, shared } = notificationContext();
  if (!area || !shared || typeof notificationId !== 'string') return;
  const today = shared.dayOf(new Date());
  const record = pickNotifiedRecord(
    await shared.readKey(area, shared.KEYS.notifyDay, null),
    notificationId,
    today,
  );
  if (record && record.state === 'sent') {
    await shared.queueExposure(area, {
      propositionId: record.id,
      kind: 'engaged',
      surface: 'notification',
      at: new Date().toISOString(),
      day: today,
    });
    await shared.writeKey(area, shared.KEYS.notifyDay, { ...record, state: 'engaged' });
  }
  clearNotification(notificationId);
  await openNewtab();
}

async function handleNotificationClosed(notificationId, byUser) {
  if (!byUser) return; // programmatic clear is not a user signal
  const { area, shared } = notificationContext();
  if (!area || !shared || typeof notificationId !== 'string') return;
  const today = shared.dayOf(new Date());
  const record = pickNotifiedRecord(
    await shared.readKey(area, shared.KEYS.notifyDay, null),
    notificationId,
    today,
  );
  if (!record || record.state !== 'sent') return;
  await shared.queueExposure(area, {
    propositionId: record.id,
    kind: 'skipped',
    surface: 'notification',
    at: new Date().toISOString(),
    day: today,
  });
  await shared.writeKey(area, shared.KEYS.notifyDay, { ...record, state: 'skipped' });
}

if (chrome.notifications) {
  if (chrome.notifications.onButtonClicked && typeof chrome.notifications.onButtonClicked.addListener === 'function') {
    chrome.notifications.onButtonClicked.addListener((notificationId) => {
      void handleNotificationInteract(notificationId);
    });
  }
  if (chrome.notifications.onClicked && typeof chrome.notifications.onClicked.addListener === 'function') {
    chrome.notifications.onClicked.addListener((notificationId) => {
      void handleNotificationInteract(notificationId);
    });
  }
  if (chrome.notifications.onClosed && typeof chrome.notifications.onClosed.addListener === 'function') {
    chrome.notifications.onClosed.addListener((notificationId, byUser) => {
      void handleNotificationClosed(notificationId, byUser);
    });
  }
}

// ---------------------------------------------------------------------------
// Capture (M1b) — unchanged one-click page capture.
// ---------------------------------------------------------------------------

function reasonOf(error) {
  if (error && typeof error.message === 'string' && error.message.length > 0) return error.message;
  return String(error);
}

/**
 * Extracts content from `tab` and hands it to a fresh newtab.
 * Never throws: a failure is recorded in the pending payload so the UI can say
 * exactly why nothing happened.
 */
async function captureInto(tab, options) {
  const selectionOnly = Boolean(options && options.selectionOnly);
  const pending = {
    ok: false,
    reason: '',
    capturedAt: new Date().toISOString(),
    selectionOnly,
  };

  try {
    if (!tab || typeof tab.id !== 'number') throw new Error('没有可用的标签页');
    const url = String(tab.url || '');
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('这是浏览器内部页面，无法捕获。请打开一个普通网页再点图标。');
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/page-extract.js'],
    });

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (onlySelection) => {
        const extractor = globalThis.__latticeExtractPage;
        if (typeof extractor !== 'function') {
          return {
            title: document.title,
            url: location.href,
            text: String((document.body && document.body.innerText) || '').slice(0, 12000),
            selection: '',
            truncated: false,
            charCount: 0,
          };
        }
        return extractor({ selectionOnly: onlySelection });
      },
      args: [selectionOnly],
    });

    const result = Array.isArray(results) && results[0] ? results[0].result : null;
    if (!result || typeof result.text !== 'string' || result.text.trim().length === 0) {
      throw new Error('没有在这个页面提取到正文（可能是空白页或纯图片页面）');
    }
    if (selectionOnly && (!result.selection || result.selection.trim().length === 0)) {
      throw new Error('没有选中文字。请先选中一段文字，再右键「存入 Lattice」。');
    }

    pending.ok = true;
    pending.title = String(result.title || '');
    pending.url = String(result.url || url);
    pending.text = String(result.text).slice(0, MAX_FALLBACK_CHARS);
    pending.truncated = Boolean(result.truncated);
    pending.charCount = Number(result.charCount) || 0;
    pending.hasSelection = Boolean(result.selection);
  } catch (error) {
    pending.reason = reasonOf(error);
  }

  try {
    await chrome.storage.local.set({ [PENDING_KEY]: pending });
  } catch (error) {
    pending.ok = false;
    pending.reason = '无法保存捕获内容（浏览器存储不可用）';
  }

  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL(NEWTAB_URL) });
  } catch (error) {
    // The newtab is an override, so the user can still open one manually.
    console.error('[Lattice] 打开新标签页失败', error);
  }
}
