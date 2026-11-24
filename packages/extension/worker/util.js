/** Small shared helpers for the worker side. No chrome/sqlite dependency. */

/** Best-effort short error text (never a full stack, so it is safe to show in UI). */
export function errorText(err) {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof err.message === 'string' && err.message.length > 0) {
    return err.message;
  }
  try {
    return String(err);
  } catch {
    return '未知错误';
  }
}

/** Used to skip re-importing the same proposition twice (M0 has no identity merge). */
export function normalizeStatement(statement) {
  return String(statement ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
