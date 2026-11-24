/*
 * Lattice M0 background service worker (classic script, no imports).
 *
 * Deliberately almost empty: M0 has no alarms, no network, no content scripts.
 * The event log is written by the newtab page's module worker *before* anything
 * is rendered, so MV3 service-worker recycling cannot lose user actions.
 *
 * "Open newtab on first install" is intentionally not implemented: Chrome does
 * not reliably let an extension take over the current tab at install time, and
 * the next new tab already opens Lattice via chrome_url_overrides.
 */

self.addEventListener('install', () => {
  console.info('[Lattice] background installed (M0 no-op)');
});

self.addEventListener('activate', () => {
  console.info('[Lattice] background active (M0 no-op)');
});
