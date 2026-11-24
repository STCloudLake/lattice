/*
 * Lattice background service worker (classic script, no imports).
 *
 * Two entries, both one click:
 *   1. toolbar icon click  -> capture the page's main content
 *   2. right-click selection -> capture only the selected text
 *
 * The page content is extracted by content/page-extract.js injected with
 * chrome.scripting (activeTab). The captured payload is parked in
 * chrome.storage.local, then a newtab is opened which picks it up, opens the
 * capture dialog, and starts extraction. Nothing is committed without the user
 * confirming the preview.
 */

/** Shown in 诊断 so a stale service worker is visible instead of silent. */
const BUILD = 'm1b-capture-1';

const MENU_SELECTION = 'lattice-capture-selection';
const PENDING_KEY = 'latticePendingCapture';
const NEWTAB_URL = 'newtab/newtab.html?capture=1';
const MAX_FALLBACK_CHARS = 12000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: '存入 Lattice（选中文字）',
      contexts: ['selection'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info && info.menuItemId === MENU_SELECTION) void captureInto(tab, { selectionOnly: true });
});

chrome.action.onClicked.addListener((tab) => {
  void captureInto(tab, { selectionOnly: false });
});

// Health check: lets the newtab page prove the *current* background script is
// running. Without it, a stale cached worker looks exactly like "the icon does
// nothing" (this happened once and cost an hour to diagnose).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'lattice-ping') {
    sendResponse({ ok: true, build: BUILD });
    return true;
  }
  return false;
});

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
