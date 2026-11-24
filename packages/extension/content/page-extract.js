/*
 * Page content extractor, injected into the active tab by background.js.
 *
 * Read-only: it clones the document, strips chrome-like regions, picks the most
 * likely main-content container and returns structured text. No network, no
 * storage, no mutation of the live page.
 *
 * Exposes: window.__latticeExtractPage({selectionOnly}) -> {
 *   title, url, text, selection, truncated, charCount
 * }
 */
(() => {
  const MAX_CHARS = 12000;
  const STRIP = [
    'script',
    'style',
    'noscript',
    'nav',
    'header',
    'footer',
    'aside',
    'form',
    'button',
    'svg',
    'canvas',
    'iframe',
    'video',
    'audio',
    '[aria-hidden="true"]',
    '[hidden]',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '[role="complementary"]',
  ].join(',');

  const BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th,figcaption,dd,dt';

  function normalize(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** Joins block-level text so paragraphs survive; falls back to raw text. */
  function structuredText(root) {
    const blocks = root.querySelectorAll(BLOCKS);
    if (blocks.length === 0) return normalize(root.textContent);
    const parts = [];
    const seen = new Set();
    for (const block of blocks) {
      const text = normalize(block.textContent);
      if (text.length === 0 || seen.has(text)) continue;
      seen.add(text);
      parts.push(text);
    }
    if (parts.length === 0) return normalize(root.textContent);
    return parts.join('\n\n');
  }

  function scoreCandidates(root) {
    const candidates = [];
    const consider = (element, weight) => {
      if (!element) return;
      const length = structuredText(element).length;
      if (length >= 200) candidates.push({ element, score: length * weight });
    };
    consider(root.querySelector('article'), 1.6);
    consider(root.querySelector('main'), 1.4);
    consider(root.querySelector('[role="main"]'), 1.3);
    consider(root.querySelector('[itemprop="articleBody"]'), 1.6);

    const byParent = new Map();
    for (const paragraph of root.querySelectorAll('p')) {
      const parent = paragraph.parentElement;
      if (!parent) continue;
      const length = normalize(paragraph.textContent).length;
      if (length < 40) continue;
      byParent.set(parent, (byParent.get(parent) || 0) + length);
    }
    for (const [element, length] of byParent) candidates.push({ element, score: length * 1.1 });

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].element;
  }

  function extractMainText() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll(STRIP).forEach((element) => element.remove());
    const container = scoreCandidates(clone);
    const text = container ? structuredText(container) : '';
    if (text.length >= 200) return text;
    return structuredText(clone);
  }

  function extract(options) {
    const settings = options && typeof options === 'object' ? options : {};
    const selection = normalize(window.getSelection ? window.getSelection().toString() : '');
    const useSelection = Boolean(settings.selectionOnly) && selection.length > 0;
    const raw = useSelection ? selection : extractMainText();
    const text = raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) : raw;
    return {
      title: normalize(document.title) || location.hostname,
      url: location.href,
      text,
      selection: selection.slice(0, MAX_CHARS),
      truncated: raw.length > MAX_CHARS,
      charCount: raw.length,
    };
  }

  window.__latticeExtractPage = extract;
})();
