/// <reference path="./lib/fresh.d.ts" />

// Markdown, typeset: "Markdown: Open Preview to the Side" shows the file laid out by Typst (through
// herdr-wr's nb) in a pane beside it, as kitty images (see lib/kitty.ts). It follows the file:
// edits re-typeset it (only the slices of the page that changed are sent to the terminal again),
// scrolling the file scrolls it to the same place, and a click on it puts the cursor on the
// markdown that was clicked.
//
// The page is cut into tiles of TILE_ROWS rows; the preview buffer is their placeholder rows, one
// line per terminal row, so its scrolling is the editor's own.

import { cellPixels, deleteImages, DIACRITICS, imageFg, imageRow, themeHex, uploadPng } from "./lib/kitty.ts";
import { byteLength } from "./lib/text.ts";

const editor = getEditor();

/** nb, as the notebook plugin runs it (its `nbCommand` setting). */
function nbCommand(): string {
  const plugins = (editor.getConfig() as unknown as Record<string, unknown>).plugins as
    | Record<string, { settings?: Record<string, unknown> }>
    | undefined;
  const set = plugins?.notebook?.settings?.nbCommand;
  return typeof set === "string" && set ? set : "nb";
}

const TILE_ROWS = 8;
/** Pixels drawn per terminal pixel, for HiDPI. */
const DENSITY = 2;
const SIZE_PT = 11;

type Tile = { hash: string; id: number; rows: number };
type Preview = {
  source: number;
  path: string;
  buf: number;
  split: number;
  cols: number;
  tiles: Tile[];
  /** Byte offset of each row of the preview buffer. */
  rowStarts: number[];
  rowPx: number;
  rendering: boolean;
  again: boolean;
  /** When this plugin last scrolled each side: the viewport event that follows is its own. */
  scrolledPreview: number;
  scrolledSource: number;
};

const previews = new Map<number, Preview>(); // by source buffer
/** Uploaded tiles, by hash: shared by the previews, deleted once none shows them. */
const tileImages = new Map<string, { id: number; rows: number; cols: number }>();
let nextImageId = 0x6d0000;

// ── nb serve ─────────────────────────────────────────────────────────

type Server = { processId: number; port: number; token: string; seq: number; stdout: string; ready: Promise<boolean> };
let server: Server | null = null;

function startServer(path: string): Server {
  let settle = (_ok: boolean) => {};
  const ready = new Promise<boolean>((resolve) => (settle = resolve));
  const proc = editor.spawnBackgroundProcess(nbCommand(), ["serve", path], editor.pathDirname(path));
  const s: Server = { processId: proc.processId, port: 0, token: "", seq: 0, stdout: "", ready };
  (s as Server & { settle: (ok: boolean) => void }).settle = settle;
  proc.then((r) => {
    if (server === s) server = null;
    if (s.port === 0) {
      settle(false);
      editor.setStatus(`markdown preview: ${nbCommand()} serve didn't start (exit ${r.exit_code}). Is herdr-wr's nb installed?`);
    }
  });
  return s;
}

registerHandler("md_preview_on_stdout", (e: { process_id: number; data: string }) => {
  const s = server;
  if (!s || e.process_id !== s.processId || s.port) return;
  s.stdout += e.data;
  for (const line of s.stdout.split("\n")) {
    try {
      const ev = JSON.parse(line);
      if (ev.event === "ready") {
        s.port = ev.port;
        s.token = ev.token;
        (s as Server & { settle: (ok: boolean) => void }).settle(true);
      }
    } catch (_e) {
      // a partial line, or not ours
    }
  }
});
editor.on("onProcessStdout", "md_preview_on_stdout");

async function ask(path: string, verb: string, req: unknown): Promise<Record<string, unknown>> {
  if (!server) server = startServer(path);
  const s = server;
  if (!(await s.ready)) return { ok: false, message: "nb didn't start" };
  const dir = editor.pathJoin(editor.getDataDir(), "notebooks", "requests");
  editor.createDir(dir);
  s.seq += 1;
  const reqPath = editor.pathJoin(dir, `md-${s.processId}-${s.seq}.json`);
  editor.writeFile(reqPath, JSON.stringify(req));
  const url = `http://127.0.0.1:${s.port}/${verb}?token=${s.token}&req=${encodeURIComponent(reqPath)}`;
  const answer = editor.pathJoin(dir, `md-${s.processId}-${s.seq}-answer.json`);
  const r = await editor.httpFetch(url, answer);
  if (r.exit_code !== 0) return { ok: false, message: r.stderr || `HTTP ${r.exit_code}` };
  return JSON.parse(editor.readFile(answer) ?? "{}");
}

// ── drawing ──────────────────────────────────────────────────────────

function paneWidth(split: number): number {
  const pane = editor.listSplits().find((s) => s.splitId === split);
  return pane?.viewport.width ?? 80;
}

async function render(p: Preview): Promise<void> {
  if (p.rendering) {
    p.again = true;
    return;
  }
  p.rendering = true;
  try {
    do {
      p.again = false;
      await renderOnce(p);
    } while (p.again && previews.get(p.source) === p);
  } finally {
    p.rendering = false;
  }
}

async function renderOnce(p: Preview): Promise<void> {
  const [cw, ch] = cellPixels();
  // a column spare, so a row never wraps
  const cols = Math.max(10, paneWidth(p.split) - 1);
  const rowPx = ch * DENSITY;
  const text = await editor.getBufferText(p.source, 0, editor.getBufferLength(p.source));
  const r = await ask(p.path, "md", {
    id: String(p.source),
    text,
    dir: editor.pathDirname(p.path),
    width_px: cols * cw * DENSITY,
    // the em about as tall as the terminal's own letters
    px_per_pt: (0.8 * rowPx) / SIZE_PT,
    size_pt: SIZE_PT,
    tile_px: TILE_ROWS * rowPx,
    row_px: rowPx,
    theme: {
      fg: themeHex("editor.fg", "#c0caf5"),
      accent: themeHex("syntax.function", "#7aa2f7"),
      muted: themeHex("syntax.comment", "#565f89"),
      code_bg: themeHex("editor.current_line_bg", "#232636"),
      link: themeHex("syntax.type", "#7dcfff"),
    },
    have: [...tileImages.entries()].filter(([, t]) => t.cols === cols).map(([h]) => h),
  });
  if (previews.get(p.source) !== p) return;
  if (!r.ok) {
    editor.setStatus(`markdown preview: ${String(r.message ?? "nb failed").split("\n")[0]}`);
    return;
  }
  const tiles: Tile[] = [];
  for (const t of r.tiles as { hash: string; height: number; png?: string }[]) {
    const rows = Math.max(1, Math.round(t.height / rowPx));
    let img = tileImages.get(t.hash);
    if (t.png) {
      if (img) deleteImages([img.id]);
      img = { id: nextImageId++, rows, cols };
      if (!uploadPng(t.png, img.id, cols, rows)) {
        editor.setStatus("markdown preview: this terminal doesn't take kitty images");
        return;
      }
      tileImages.set(t.hash, img);
    }
    if (!img) continue;
    tiles.push({ hash: t.hash, id: img.id, rows });
  }
  const entries: TextPropertyEntry[] = [];
  const rowStarts: number[] = [];
  let at = 0;
  for (const t of tiles) {
    const fg = imageFg(t.id);
    for (let row = 0; row < t.rows && row < DIACRITICS.length; row++) {
      const line = imageRow(cols, row) + "\n";
      rowStarts.push(at);
      at += byteLength(line);
      entries.push({ text: line, style: { fg } as Partial<OverlayOptions> });
    }
  }
  p.tiles = tiles;
  p.cols = cols;
  p.rowPx = rowPx;
  p.rowStarts = rowStarts;
  editor.setVirtualBufferContent(p.buf, entries);
  dropStaleTiles();
  await followSource(p);
}

function dropStaleTiles(): void {
  const live = new Set<string>();
  for (const p of previews.values()) p.tiles.forEach((t) => live.add(t.hash));
  const stale: number[] = [];
  for (const [hash, img] of tileImages) {
    if (live.has(hash)) continue;
    stale.push(img.id);
    tileImages.delete(hash);
  }
  deleteImages(stale);
}

// ── following each other ─────────────────────────────────────────────

function sourceSplit(p: Preview): SplitSnapshot | undefined {
  return editor.listSplits().find((s) => s.bufferId === p.source);
}

/** Scrolls the preview to where the source's top line is. */
async function followSource(p: Preview): Promise<void> {
  const src = sourceSplit(p);
  if (!src || !p.rowStarts.length) return;
  const r = await ask(p.path, "mdlocate", { id: String(p.source), offset: src.viewport.topByte });
  if (typeof r.y !== "number") return;
  const row = Math.min(p.rowStarts.length - 1, Math.floor(r.y / p.rowPx));
  p.scrolledPreview = Date.now();
  editor.setSplitScroll(p.split, p.rowStarts[Math.max(0, row)]);
}

/** Scrolls the source to the markdown at the preview's top row. */
async function followPreview(p: Preview, topByte: number): Promise<void> {
  const src = sourceSplit(p);
  if (!src) return;
  let row = p.rowStarts.findIndex((b) => b > topByte) - 1;
  if (row < 0) row = topByte > 0 ? p.rowStarts.length - 1 : 0;
  const r = await ask(p.path, "mdjump", { id: String(p.source), x: 0, y: (row + 0.5) * p.rowPx });
  if (typeof r.offset !== "number") return;
  const text = await editor.getBufferText(p.source, 0, r.offset);
  const lineStart = text.lastIndexOf("\n") + 1;
  p.scrolledSource = Date.now();
  editor.setSplitScroll(src.splitId, byteLength(text.slice(0, lineStart)));
}

const OWN_SCROLL_MS = 300;

registerHandler("md_preview_viewport", (e: { split_id: number; buffer_id: number; top_byte: number; width: number }) => {
  for (const p of previews.values()) {
    if (e.buffer_id === p.buf) {
      if (e.width - 1 !== p.cols && e.width > 10) void render(p);
      else if (Date.now() - p.scrolledPreview > OWN_SCROLL_MS) void followPreview(p, e.top_byte);
    } else if (e.buffer_id === p.source && Date.now() - p.scrolledSource > OWN_SCROLL_MS) {
      void followSource(p);
    }
  }
});
editor.on("viewport_changed", "md_preview_viewport");

// a click on the page: the cursor goes to the markdown under it
registerHandler("md_preview_click", async (e: MouseClickHookArgs) => {
  if (e.button !== "left" || e.buffer_id === null || e.buffer_row === null) return;
  const p = [...previews.values()].find((q) => q.buf === e.buffer_id);
  if (!p) return;
  const [cw] = cellPixels();
  const col = Math.max(0, e.column - e.content_x);
  const r = await ask(p.path, "mdjump", {
    id: String(p.source),
    x: (col + 0.5) * cw * DENSITY,
    y: (e.buffer_row + 0.5) * p.rowPx,
  });
  if (typeof r.offset !== "number") return;
  const src = sourceSplit(p);
  if (src) editor.focusSplit(src.splitId);
  editor.setBufferCursor(p.source, r.offset);
});
editor.on("mouse_click", "md_preview_click");

// ── opening and closing ──────────────────────────────────────────────

const isMarkdown = (path: string) => /\.(md|markdown|mdown|mkd)$/i.test(path);

registerHandler("md_preview_open", async () => {
  const source = editor.getActiveBufferId();
  const path = source ? editor.getBufferPath(source) : "";
  if (!path || !isMarkdown(path)) {
    editor.setStatus("markdown preview: not a markdown file");
    return;
  }
  const open = previews.get(source);
  if (open) {
    editor.closeBuffer(open.buf);
    return;
  }
  const sourceSplitId = editor.getActiveSplitId();
  const name = path.split(/[\\/]/).pop() ?? path;
  const { bufferId, splitId } = await editor.createVirtualBufferInSplit({
    name: `*Preview ${name}*`,
    mode: "md-preview",
    readOnly: true,
    editingDisabled: true,
    showLineNumbers: false,
    showCursors: false,
    lineWrap: false,
    direction: "vertical",
    ratio: 0.5,
    entries: [],
  });
  const p: Preview = {
    source,
    path,
    buf: bufferId,
    split: splitId ?? 0,
    cols: 0,
    tiles: [],
    rowStarts: [],
    rowPx: 32,
    rendering: false,
    again: false,
    scrolledPreview: 0,
    scrolledSource: 0,
  };
  previews.set(source, p);
  editor.focusSplit(sourceSplitId);
  await editor.flush();
  await render(p);
});
editor.registerCommand(
  "Markdown: Open Preview to the Side",
  "The file typeset (by Typst) beside it: follows edits and scrolling; a click goes to that text. Again: close it",
  "md_preview_open",
  null,
);
editor.defineMode("md-preview", [], true);

let pending = new Set<number>();
registerHandler("md_preview_rerender", () => {
  const due = pending;
  pending = new Set();
  for (const source of due) {
    const p = previews.get(source);
    if (p) void render(p);
  }
});
registerHandler("md_preview_on_modified", (e: { buffer_id: number }) => {
  if (!previews.has(e.buffer_id) || pending.has(e.buffer_id)) return;
  if (pending.size === 0) editor.setTimeout(120, "md_preview_rerender");
  pending.add(e.buffer_id);
});
editor.on("buffer_modified", "md_preview_on_modified");

registerHandler("md_preview_on_close", (e: { buffer_id: number }) => {
  for (const p of [...previews.values()]) {
    if (e.buffer_id !== p.buf && e.buffer_id !== p.source) continue;
    previews.delete(p.source);
    if (e.buffer_id === p.source) editor.closeBuffer(p.buf);
    void ask(p.path, "mdclose", { id: String(p.source) });
    dropStaleTiles();
  }
});
editor.on("buffer_closed", "md_preview_on_close");
