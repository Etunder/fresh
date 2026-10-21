/// <reference path="./fresh.d.ts" />

/**
 * Images in the terminal with the kitty graphics protocol's Unicode placeholders (herdr, WezTerm,
 * kitty, Ghostty): a PNG is sent once with an id, and drawn wherever text of placeholder
 * characters in the colour of that id is, so it scrolls and clips with the text around it.
 */

/** The row/column diacritics of kitty's placeholder scheme (rowcolumn-diacritics.txt). */
export const DIACRITICS = [
  0x305, 0x30D, 0x30E, 0x310, 0x312, 0x33D, 0x33E, 0x33F, 0x346, 0x34A, 0x34B, 0x34C,
  0x350, 0x351, 0x352, 0x357, 0x35B, 0x363, 0x364, 0x365, 0x366, 0x367, 0x368, 0x369,
  0x36A, 0x36B, 0x36C, 0x36D, 0x36E, 0x36F, 0x483, 0x484, 0x485, 0x486, 0x487, 0x592,
  0x593, 0x594, 0x595, 0x597, 0x598, 0x599, 0x59C, 0x59D, 0x59E, 0x59F, 0x5A0, 0x5A1,
  0x5A8, 0x5A9, 0x5AB, 0x5AC, 0x5AF, 0x5C4, 0x610, 0x611, 0x612, 0x613, 0x614, 0x615,
  0x616, 0x617, 0x657, 0x658, 0x659, 0x65A, 0x65B, 0x65D, 0x65E, 0x6D6, 0x6D7, 0x6D8,
  0x6D9, 0x6DA, 0x6DB, 0x6DC, 0x6DF, 0x6E0, 0x6E1, 0x6E2, 0x6E4, 0x6E7, 0x6E8, 0x6EB,
  0x6EC, 0x730, 0x732, 0x733, 0x735, 0x736, 0x73A, 0x73D, 0x73F, 0x740, 0x741, 0x743,
  0x745, 0x747, 0x749, 0x74A, 0x7EB, 0x7EC, 0x7ED, 0x7EE, 0x7EF, 0x7F0, 0x7F1, 0x7F3,
  0x816, 0x817, 0x818, 0x819, 0x81B, 0x81C, 0x81D, 0x81E, 0x81F, 0x820, 0x821, 0x822,
  0x823, 0x825, 0x826, 0x827, 0x829, 0x82A, 0x82B, 0x82C, 0x82D, 0x951, 0x953, 0x954,
  0xF82, 0xF83, 0xF86, 0xF87, 0x135D, 0x135E, 0x135F, 0x17DD, 0x193A, 0x1A17, 0x1A75, 0x1A76,
  0x1A77, 0x1A78, 0x1A79, 0x1A7A, 0x1A7B, 0x1A7C, 0x1B6B, 0x1B6D, 0x1B6E, 0x1B6F, 0x1B70, 0x1B71,
  0x1B72, 0x1B73, 0x1CD0, 0x1CD1, 0x1CD2, 0x1CDA, 0x1CDB, 0x1CE0, 0x1DC0, 0x1DC1, 0x1DC3, 0x1DC4,
  0x1DC5, 0x1DC6, 0x1DC7, 0x1DC8, 0x1DC9, 0x1DCB, 0x1DCC, 0x1DD1, 0x1DD2, 0x1DD3, 0x1DD4, 0x1DD5,
  0x1DD6, 0x1DD7, 0x1DD8, 0x1DD9, 0x1DDA, 0x1DDB, 0x1DDC, 0x1DDD, 0x1DDE, 0x1DDF, 0x1DE0, 0x1DE1,
  0x1DE2, 0x1DE3, 0x1DE4, 0x1DE5, 0x1DE6, 0x1DFE, 0x20D0, 0x20D1, 0x20D4, 0x20D5, 0x20D6, 0x20D7,
  0x20DB, 0x20DC, 0x20E1, 0x20E7, 0x20E9, 0x20F0, 0x2CEF, 0x2CF0, 0x2CF1, 0x2DE0, 0x2DE1, 0x2DE2,
  0x2DE3, 0x2DE4, 0x2DE5, 0x2DE6, 0x2DE7, 0x2DE8, 0x2DE9, 0x2DEA, 0x2DEB, 0x2DEC, 0x2DED, 0x2DEE,
  0x2DEF, 0x2DF0, 0x2DF1, 0x2DF2, 0x2DF3, 0x2DF4, 0x2DF5, 0x2DF6, 0x2DF7, 0x2DF8, 0x2DF9, 0x2DFA,
  0x2DFB, 0x2DFC, 0x2DFD, 0x2DFE, 0x2DFF, 0xA66F, 0xA67C, 0xA67D, 0xA6F0, 0xA6F1, 0xA8E0, 0xA8E1,
  0xA8E2, 0xA8E3, 0xA8E4, 0xA8E5, 0xA8E6, 0xA8E7, 0xA8E8, 0xA8E9, 0xA8EA, 0xA8EB, 0xA8EC, 0xA8ED,
  0xA8EE, 0xA8EF, 0xA8F0, 0xA8F1, 0xAAB0, 0xAAB2, 0xAAB3, 0xAAB7, 0xAAB8, 0xAABE, 0xAABF, 0xAAC1,
  0xFE20, 0xFE21, 0xFE22, 0xFE23, 0xFE24, 0xFE25, 0xFE26, 0x10A0F, 0x10A38, 0x1D185, 0x1D186, 0x1D187,
  0x1D188, 0x1D189, 0x1D1AA, 0x1D1AB, 0x1D1AC, 0x1D1AD, 0x1D242, 0x1D243, 0x1D244,
].map((c) => String.fromCodePoint(c));
export const PLACEHOLDER = String.fromCodePoint(0x10eeee);

const parseCell = (value: string): [number, number] | null => {
  const m = /^(\d+)x(\d+)$/.exec(value.trim());
  return m && +m[1] > 0 && +m[1] <= 512 && +m[2] > 0 && +m[2] <= 512 ? [+m[1], +m[2]] : null;
};

/** The folder WezTerm's config writes cell sizes to (one file per window and pane). */
function cellsDir(): string | null {
  const editor = getEditor();
  const prefix = editor.getEnv("FRESH_WEZTERM_METRICS_PREFIX");
  if (prefix) return editor.pathDirname(prefix);
  const local = editor.getEnv("LOCALAPPDATA");
  return local ? editor.pathJoin(local, "fresh", "wezterm-cells") : null;
}

/** The size the most recently written of those files says: kept by refreshCellPixels. */
let newestCell: [number, number] | null = null;

/** Re-reads the newest cell size any WezTerm window wrote. herdr outlives the WezTerm window it
 *  was started from, so the window and pane in its environment can be long gone; the newest file
 *  is the window in use (they share a font, as a rule). Called every half second. */
export async function refreshCellPixels(): Promise<void> {
  const editor = getEditor();
  const dir = cellsDir();
  if (!dir) return;
  try {
    const r = await editor.walkTree(dir, { maxDepth: 1, maxEntries: 500 });
    let best: { path: string; mtime: number } | null = null;
    for (const e of r.entries) {
      if (e.kind === "file" && e.rel.endsWith(".txt") && (!best || e.mtime > best.mtime)) best = e;
    }
    newestCell = best ? parseCell(editor.readFile(best.path) ?? "") : null;
  } catch {
    // no such folder (WezTerm's config doesn't write one): the other sources, or the guess
  }
}

/** The terminal cell's size in pixels as measured: WR_CELL_PX=<w>x<h> (wr sets it), else the
 *  newest size WezTerm wrote (see refreshCellPixels), else this pane's own file; null when none
 *  says. */
export function measuredCellPixels(): [number, number] | null {
  const editor = getEditor();
  const override = parseCell(editor.getEnv("WR_CELL_PX") ?? "");
  if (override) return override;
  if (newestCell) return newestCell;
  const prefix = editor.getEnv("FRESH_WEZTERM_METRICS_PREFIX");
  const pane = editor.getEnv("WEZTERM_PANE");
  if (prefix && pane && /^\d+$/.test(pane)) return parseCell(editor.readFile(prefix + pane + ".txt") ?? "");
  return null;
}

/** The size of a terminal cell in pixels: as measured, else herdr's 8x16. */
export function cellPixels(): [number, number] {
  return measuredCellPixels() ?? [8, 16];
}

/** Width and height of a base64 PNG, from its IHDR chunk; null if it isn't one. */
export function pngSize(b64: string): [number, number] | null {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes: number[] = [];
  let bits = 0, acc = 0;
  for (const ch of b64.slice(0, 44)) {
    const v = abc.indexOf(ch);
    if (v < 0) break;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  if (bytes.length < 24 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const u32 = (i: number) => ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
  return [u32(16), u32(20)];
}

/** Sends a base64 PNG to the terminal as image `id` (24 bits: the colour alone names it), placed
 *  virtually over `cols`×`rows` cells. False if the terminal can't be written to. */
export function uploadPng(b64: string, id: number, cols: number, rows: number): boolean {
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += 4096) chunks.push(b64.slice(i, i + 4096));
  const esc = (ctl: string, data = "") => `\x1b_G${ctl}${data ? ";" + data : ""}\x1b\\`;
  let seq = chunks
    .map((c, i) => {
      const more = i < chunks.length - 1 ? 1 : 0;
      return i === 0 ? esc(`a=t,f=100,i=${id},q=2,m=${more}`, c) : esc(`m=${more}`, c);
    })
    .join("");
  seq += esc(`a=p,U=1,i=${id},c=${cols},r=${rows},q=2`);
  return getEditor().writeTerminalGraphics(seq);
}

/** Deletes images from the terminal. */
export function deleteImages(ids: number[]): void {
  if (ids.length) getEditor().writeTerminalGraphics(ids.map((id) => `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`).join(""));
}

/** The colour an image's placeholders are drawn in: its id. */
export function imageFg(id: number): [number, number, number] {
  return [(id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff];
}

/** The placeholder text of one row of an image `cols` cells wide. */
export function imageRow(cols: number, row: number): string {
  let s = "";
  for (let col = 0; col < cols; col++) s += PLACEHOLDER + DIACRITICS[row] + DIACRITICS[col];
  return s;
}

/** A theme colour as `#rrggbb`, from the current theme's data; `fallback` if it can't be read. */
export function themeHex(key: string, fallback: string): string {
  const editor = getEditor();
  const name = String(editor.getConfig().theme ?? "");
  const data = (editor.getThemeData(name) ?? editor.getThemeData(name.toLowerCase())) as Record<string, unknown> | null;
  const [section, field] = key.split(".");
  const v = (data?.[section] as Record<string, unknown> | undefined)?.[field];
  if (!Array.isArray(v) || v.length !== 3) return fallback;
  return "#" + v.map((c) => Math.max(0, Math.min(255, Number(c))).toString(16).padStart(2, "0")).join("");
}
