/**
 * Terminal formatting helpers.
 *
 * Chinese is user-facing output, identifiers stay English. Widths are measured
 * in terminal columns so CJK labels still line up in the same table; measured
 * with the East-Asian wide-character ranges rather than `String.length`.
 */

export interface TableColumn {
  title: string;
  /** Column width in terminal columns. */
  width: number;
}

/** Width of a string in terminal columns (CJK / full-width = 2). */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    width += isWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Right-pads to `width` terminal columns (never truncates). */
export function padRight(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad <= 0 ? text : text + ' '.repeat(pad);
}

/** Truncates to `width` terminal columns, ending with an ellipsis. */
export function truncateDisplay(text: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = displayWidth(ch);
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return out + '…';
}

/** 0.8731 -> "87.3%"; non-finite -> "—". */
export function pct(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/** 0.8731 -> "0.87"; non-finite -> "—". */
export function fixed(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

/** Aligned `label  value` rows, labels right-padded to the longest label. */
export function kvLines(rows: readonly (readonly [string, string])[], indent = 2): string[] {
  const labelWidth = rows.reduce((max, row) => Math.max(max, displayWidth(row[0])), 0);
  return rows.map((row) => ' '.repeat(indent) + padRight(row[0], labelWidth) + '  ' + row[1]);
}

/** Simple aligned table: header row + body rows, all cells width-clamped. */
export function renderTable(
  columns: readonly TableColumn[],
  rows: readonly (readonly string[])[],
  indent = 4,
): string[] {
  const renderRow = (cells: readonly string[]): string => {
    const body = columns
      .map((col, i) => padRight(truncateDisplay(cells[i] ?? '', col.width), col.width))
      .join('  ');
    return ' '.repeat(indent) + body.trimEnd();
  };
  return [renderRow(columns.map((col) => col.title)), ...rows.map(renderRow)];
}
