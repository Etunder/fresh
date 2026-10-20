/// <reference path="./lib/fresh.d.ts" />

// Jupyter notebooks, in an editor buffer.
//
// Opening a .ipynb shows its cells as a Python file in the "percent" format VS Code and Jupytext
// use — a `# %%` line starts each cell, markdown cells are `# `-commented — so the cells get the
// editor's own Python editing, highlighting and language server. The file lives next to nothing:
// it is a working copy under the editor's data dir, written back into the .ipynb on save.
//
// The kernel is `nb serve` (herdr-wr's nb): this plugin spawns it per notebook, reads its JSON-line
// events from stdout, and asks it things with GET requests whose JSON travels in a file — the two
// channels a plugin has. Outputs show as virtual lines under their cell; `# %%` lines are drawn as
// quiet rules carrying the cell's run count and state.
//
// Keys in a notebook: Shift+Enter (or Alt+Enter) run the cell and move to the next, Ctrl+Enter run
// it and stay.
// Palette: "Notebook: Run All", "Notebook: Interrupt Kernel", "Notebook: Restart Kernel".
//
// Images (plots) show inline with the kitty graphics protocol's Unicode placeholders, which herdr
// passes through to WezTerm: the PNG goes to the terminal once (`writeTerminalGraphics`), and the
// rows below the cell are virtual lines of placeholder characters whose colour is the image id.
// Setting `images` off, or WR_NO_KITTY=1 (wr's switch for terminals without kitty images), shows
// a one-line placeholder instead. The cell size comes from WR_CELL_PX=<w>x<h> (wr sets it from
// WezTerm), else herdr's 8x16.

const editor = getEditor();

const NB_COMMAND = editor.defineConfigString("nbCommand", {
  default: "nb",
  description: "The nb program that runs notebook kernels (herdr-wr's nb). A path, or a name on PATH.",
});

const IMAGES = editor.defineConfigBoolean("images", {
  default: true,
  description: "Show image outputs (plots) inline with the kitty graphics protocol (herdr, WezTerm, kitty, Ghostty). Off: a one-line placeholder.",
}) && !editor.getEnv("WR_NO_KITTY");

const IMAGE_MAX_COLUMNS = editor.defineConfigInteger("imageMaxColumns", {
  default: 100,
  minimum: 8,
  maximum: 297,
  description: "The widest an inline image gets, in columns (it keeps its aspect ratio).",
});

const MAX_OUTPUT_LINES = 40;
const NS_OUT = "notebook-out";
const NS_RULE = "notebook-rule";

type Cell = { id: string; kind: string; source: string };
type Output = Record<string, unknown>;
type Run = { count: number | null; outputs: Output[]; state: "idle" | "queued" | "busy" | "ok" | "error" };

type Notebook = {
  ipynb: string;
  copy: string;
  bufferId: number | null;
  processId: number;
  port: number;
  token: string;
  stdout: string;
  runs: Map<string, Run>;
  kernel: string;
  /** The kernel's display name, from its `starting` event. */
  kernelName: string;
  seq: number;
  ready: Promise<void>;
  markReady: () => void;
  /** The .ipynb's JSON view, closed once the working copy has opened. */
  jsonBuffer: number | null;
};

const byCopy = new Map<string, Notebook>();
const byIpynb = new Map<string, Notebook>();
const byProcess = new Map<number, Notebook>();

// ── text helpers ─────────────────────────────────────────────────────

/** UTF-8 length of a JS string: the editor's positions are bytes. */
function bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function newId(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

const MARKER = /^# %%(?:\s*\[(\w+)\])?(?:.*?\bid=([\w-]+))?.*$/;

function markerLine(cell: Cell): string {
  const kind = cell.kind === "code" ? "" : ` [${cell.kind}]`;
  return `# %%${kind} id=${cell.id}`;
}

/** Cells as percent-format text. */
export function cellsToText(cells: Cell[]): string {
  if (cells.length === 0) return markerLine({ id: newId(), kind: "code", source: "" }) + "\n";
  return cells
    .map((c) => {
      const body = c.kind === "code"
        ? c.source
        : c.source.split("\n").map((l) => (l.length ? "# " + l : "#")).join("\n");
      return markerLine(c) + "\n" + body + (body.endsWith("\n") || body === "" ? "" : "\n");
    })
    .join("\n");
}

type Span = { cell: Cell; start: number; markerEnd: number; lastLine: number; end: number; hasId: boolean };

/** The cells of percent-format text, with where each sits (byte offsets). */
export function textToCells(text: string): Span[] {
  const lines = text.split("\n");
  const spans: Span[] = [];
  let offset = 0;
  let current: { span: Span; body: string[] } | null = null;
  const finish = () => {
    if (!current) return;
    let body = current.body;
    // the blank line written between cells belongs to no cell
    if (body.length && body[body.length - 1] === "") body = body.slice(0, -1);
    if (current.span.cell.kind !== "code") body = body.map((l) => l.replace(/^# ?/, ""));
    current.span.cell.source = body.join("\n");
    spans.push(current.span);
  };
  lines.forEach((line) => {
    const m = MARKER.exec(line);
    const lineEnd = offset + bytes(line);
    if (m) {
      finish();
      current = {
        span: {
          cell: { id: m[2] ?? newId(), kind: m[1] ?? "code", source: "" },
          start: offset,
          markerEnd: lineEnd,
          lastLine: offset,
          end: lineEnd,
          hasId: m[2] !== undefined,
        },
        body: [],
      };
    } else if (current) {
      current.body.push(line);
      // outputs hang under the cell's last line with text (the line at the very end of the file
      // draws no virtual lines)
      if (line.trim() !== "") current.span.lastLine = offset;
      current.span.end = lineEnd;
    } else if (line.trim() !== "") {
      // text before the first marker: a code cell of its own
      current = {
        span: { cell: { id: newId(), kind: "code", source: "" }, start: offset, markerEnd: offset, lastLine: offset, end: lineEnd, hasId: false },
        body: [line],
      };
    }
    offset = lineEnd + 1;
  });
  finish();
  return spans;
}

// ── talking to nb serve ──────────────────────────────────────────────

async function ask(nb: Notebook, verb: string, req?: unknown): Promise<Record<string, unknown>> {
  await nb.ready;
  const dir = editor.pathJoin(editor.getDataDir(), "notebooks", "requests");
  editor.createDir(dir);
  let url = `http://127.0.0.1:${nb.port}/${verb}?token=${nb.token}`;
  if (req !== undefined) {
    nb.seq += 1;
    const path = editor.pathJoin(dir, `${nb.processId}-${nb.seq}.json`);
    editor.writeFile(path, JSON.stringify(req));
    url += `&req=${encodeURIComponent(path)}`;
  }
  const answer = editor.pathJoin(dir, `${nb.processId}-${nb.seq}-answer.json`);
  const r = await editor.httpFetch(url, answer);
  if (r.exit_code !== 0) return { ok: false, message: r.stderr || `HTTP ${r.exit_code}` };
  const text = editor.readFile(answer) ?? "{}";
  return JSON.parse(text);
}

function start(ipynb: string): Notebook {
  const dir = editor.pathDirname(ipynb);
  const proc = editor.spawnBackgroundProcess(NB_COMMAND, ["serve", ipynb], dir);
  let markReady = () => {};
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  const nb: Notebook = {
    ipynb,
    copy: workingCopyPath(ipynb),
    bufferId: null,
    processId: proc.processId,
    port: 0,
    token: "",
    stdout: "",
    runs: new Map(),
    kernel: "",
    kernelName: "",
    seq: 0,
    ready,
    markReady,
    jsonBuffer: null,
  };
  byProcess.set(proc.processId, nb);
  proc.then((r) => {
    byProcess.delete(nb.processId);
    if (nb.port === 0) {
      editor.setStatus(
        `notebook: ${NB_COMMAND} serve didn't start (exit ${r.exit_code}). Is nb installed? (setting plugins.notebook.nbCommand)`,
      );
    }
  });
  return nb;
}

/** The working copy for a notebook: under the data dir, named after it so the tab reads well. */
function workingCopyPath(ipynb: string): string {
  const key = ipynb.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(-60);
  const dir = editor.pathJoin(editor.getDataDir(), "notebooks", key);
  editor.createDir(dir);
  return editor.pathJoin(dir, editor.pathBasename(ipynb) + ".py");
}

registerHandler("notebook_on_stdout", (e: { process_id: number; data: string }) => {
  const nb = byProcess.get(e.process_id);
  if (!nb) return;
  nb.stdout += e.data;
  let nl: number;
  while ((nl = nb.stdout.indexOf("\n")) >= 0) {
    const line = nb.stdout.slice(0, nl).trim();
    nb.stdout = nb.stdout.slice(nl + 1);
    if (!line) continue;
    try {
      onEvent(nb, JSON.parse(line));
    } catch (_e) {
      // not one of ours (a stray print): ignore
    }
  }
});
editor.on("onProcessStdout", "notebook_on_stdout");

function run(nb: Notebook, id: string): Run {
  let r = nb.runs.get(id);
  if (!r) {
    r = { count: null, outputs: [], state: "idle" };
    nb.runs.set(id, r);
  }
  return r;
}

function onEvent(nb: Notebook, e: Record<string, unknown>): void {
  const cell = typeof e.cell === "string" ? e.cell : null;
  switch (e.event) {
    case "ready":
      nb.port = e.port as number;
      nb.token = e.token as string;
      nb.markReady();
      return;
    case "kernel":
      nb.kernel = e.state as string;
      if (typeof e.name === "string") nb.kernelName = shortKernelName(e.name);
      if (e.state === "starting") editor.setStatus(`notebook: starting ${e.name ?? "the kernel"}…`);
      else if (e.state === "ready") editor.setStatus("notebook: kernel ready");
      else if (e.state === "dead") editor.setStatus(`notebook: the kernel stopped${e.message ? ": " + String(e.message).split("\n")[0] : ""}`);
      break;
    case "busy":
      if (cell) {
        const r = run(nb, cell);
        r.state = "busy";
        r.outputs = [];
      }
      break;
    case "output":
      if (cell) run(nb, cell).outputs.push(e.output as Output);
      break;
    case "clear":
      if (cell) run(nb, cell).outputs = [];
      break;
    case "done":
      if (cell) {
        const r = run(nb, cell);
        // aborted: queued behind a cell that failed or was interrupted, so it never ran
        r.state = e.status === "ok" ? "ok" : e.status === "aborted" ? "idle" : "error";
        if (typeof e.execution_count === "number") r.count = e.execution_count;
      }
      break;
    case "error":
      editor.setStatus(`notebook: ${String(e.message).split("\n")[0]}`);
      if (cell) run(nb, cell).state = "error";
      break;
  }
  showKernel(nb);
  void decorate(nb);
}

// ── the status bar's kernel token ────────────────────────────────────

editor.registerStatusBarElement("kernel", "Notebook kernel");

/** herdr's state dots: `● python3 idle`, `● python3 busy`, `○` while there is no kernel. */
function kernelBadge(nb: Notebook): string {
  const name = nb.kernelName || "kernel";
  switch (nb.kernel) {
    case "starting":
      return `◐ ${name} starting`;
    case "ready": {
      const busy = [...nb.runs.values()].some((r) => r.state === "busy");
      return `● ${name} ${busy ? "busy" : "idle"}`;
    }
    case "dead":
      return `○ ${name} stopped`;
    default:
      return "○ no kernel yet";
  }
}

/** A kernel name short enough for the bar: "Python 3 (ipykernel)" reads as "Python 3", and a repo
 *  venv's interpreter path (nb names those by path) as "Python (.venv)". */
function shortKernelName(name: string): string {
  if (/[\\/]/.test(name)) {
    const parts = name.split(/[\\/]+/).filter((p) => p);
    const bin = parts.findIndex((p) => /^(bin|scripts)$/i.test(p));
    return bin > 0 ? `Python (${parts[bin - 1]})` : "Python";
  }
  return name.replace(/\s*\(.*\)$/, "");
}

function showKernel(nb: Notebook): void {
  if (nb.bufferId !== null) editor.setStatusBarValue(nb.bufferId, "kernel", kernelBadge(nb));
}

// ── images (kitty graphics, Unicode placeholders) ────────────────────

/** The row/column diacritics of kitty's placeholder scheme (rowcolumn-diacritics.txt). */
const DIACRITICS = [
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
const PLACEHOLDER = String.fromCodePoint(0x10eeee);

type Image = { id: number; cols: number; rows: number };
/** Uploaded images, by the output they show; dropped (and deleted in the terminal) once their
 *  output is gone. */
const images = new Map<Output, Image>();
let nextImageId = 0x4e4200; // within 24 bits, so the colour alone names the image

function cellPixels(): [number, number] {
  const m = /^(\d+)x(\d+)$/.exec(editor.getEnv("WR_CELL_PX") ?? "");
  return m && +m[1] > 0 && +m[2] > 0 ? [+m[1], +m[2]] : [8, 16];
}

/** Width and height of a base64 PNG, from its IHDR chunk; null if it isn't one. */
function pngSize(b64: string): [number, number] | null {
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

/** Sends the PNG to the terminal and places it virtually, once per output. */
function uploadImage(o: Output, b64: string): Image | null {
  const known = images.get(o);
  if (known) return known;
  const size = pngSize(b64);
  if (!size) return null;
  const [cw, ch] = cellPixels();
  let cols = Math.max(1, Math.ceil(size[0] / cw));
  let rows = Math.max(1, Math.ceil(size[1] / ch));
  // no wider than the setting, nor than the pane (a soft-wrapped row would break the image)
  const pane = editor.getViewport()?.width ?? 0;
  const widest = pane > 20 ? Math.min(IMAGE_MAX_COLUMNS, pane - 4) : IMAGE_MAX_COLUMNS;
  if (cols > widest) {
    rows = Math.max(1, Math.round((rows * widest) / cols));
    cols = widest;
  }
  rows = Math.min(rows, DIACRITICS.length);
  const id = nextImageId++;
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
  if (!editor.writeTerminalGraphics(seq)) return null;
  const img = { id, cols, rows };
  images.set(o, img);
  return img;
}

/** The placeholder text of one image row. */
function imageRow(img: Image, row: number): string {
  let s = "";
  for (let col = 0; col < img.cols; col++) s += PLACEHOLDER + DIACRITICS[row] + DIACRITICS[col];
  return s;
}

/** Deletes the images whose outputs are no longer shown by any notebook. */
function dropStaleImages(): void {
  const live = new Set<Output>();
  for (const nb of byCopy.values()) for (const r of nb.runs.values()) r.outputs.forEach((o) => live.add(o));
  let seq = "";
  for (const [o, img] of images) {
    if (live.has(o)) continue;
    seq += `\x1b_Ga=d,d=I,i=${img.id},q=2\x1b\\`;
    images.delete(o);
  }
  if (seq) editor.writeTerminalGraphics(seq);
}

// ── drawing ──────────────────────────────────────────────────────────

/** A line drawn under a cell: text in a theme colour, or one row of an image. */
type OutLine = { text: string; fg: string | [number, number, number] };

/** An output's lines: its text in the colour it draws in, or the rows of its image. */
function outputLines(o: Output): OutLine[] {
  const join = (v: unknown) => (Array.isArray(v) ? v.join("") : String(v ?? ""));
  const lines = (s: string, fg: string) =>
    stripAnsi(s).replace(/\n$/, "").split("\n").map((text) => ({ text, fg }));
  switch (o.output_type) {
    case "stream":
      return lines(join(o.text), o.name === "stderr" ? "diagnostic.warning_fg" : "editor.fg");
    case "error": {
      const tb = Array.isArray(o.traceback) && o.traceback.length
        ? (o.traceback as string[]).join("\n")
        : `${o.ename}: ${o.evalue}`;
      return lines(tb, "diagnostic.error_fg");
    }
    case "execute_result":
    case "display_data": {
      const data = (o.data ?? {}) as Record<string, unknown>;
      const kinds = Object.keys(data).filter((k) => k !== "text/plain");
      const image = kinds.find((k) => k.startsWith("image/"));
      if (data["image/png"] && IMAGES) {
        const img = uploadImage(o, join(data["image/png"]).replace(/\s+/g, ""));
        if (img) {
          const fg: [number, number, number] = [(img.id >> 16) & 0xff, (img.id >> 8) & 0xff, img.id & 0xff];
          return Array.from({ length: img.rows }, (_, row) => ({ text: imageRow(img, row), fg }));
        }
      }
      if (image) return [{ text: `▣ ${image}${data["text/plain"] ? "  " + join(data["text/plain"]).split("\n")[0] : ""}`, fg: "syntax.type" }];
      if (data["text/plain"] !== undefined) return lines(join(data["text/plain"]), "editor.fg");
      return [{ text: `[${kinds.join(", ")}]`, fg: "editor.line_number_fg" }];
    }
  }
  return [];
}

async function decorate(nb: Notebook): Promise<void> {
  const buf = nb.bufferId;
  if (buf === null) return;
  const text = await editor.getBufferText(buf);
  const spans = textToCells(text);
  editor.clearVirtualTextNamespace(buf, NS_OUT);
  editor.clearConcealNamespace(buf, NS_RULE);
  spans.forEach((s, i) => {
    const r = nb.runs.get(s.cell.id);
    // the `# %%` line as a quiet rule: cell number, kind, run count and state (herdr's muted
    // overlay tone, the comment colour); the raw line comes back while the cursor is on it
    if (s.markerEnd > s.start) {
      const state = !r ? "" : r.state === "busy" ? " ● running" : r.state === "queued" ? " ○ queued"
        : r.state === "error" ? " ✗" : r.state === "ok" ? " ✓" : "";
      const count = s.cell.kind === "code" ? (r?.count != null ? ` [${r.count}]` : " [ ]") : ` ${s.cell.kind}`;
      const label = `── ${i + 1}${count}${state} `;
      editor.addConceal(buf, NS_RULE, s.start, s.markerEnd, label + "─".repeat(Math.max(4, 48 - label.length)),
        "unless-cursor-in", s.start, s.markerEnd + 1);
    }
    if (!r || s.cell.kind !== "code") return;
    // long text output is cut; image rows are never (half a plot helps nobody)
    let shown = 0;
    let more = 0;
    const out: OutLine[] = r.outputs.flatMap(outputLines).filter((l) => {
      if (Array.isArray(l.fg)) return true;
      if (shown < MAX_OUTPUT_LINES) return ++shown > 0;
      more++;
      return false;
    });
    if (more) out.push({ text: `… ${more} more lines`, fg: "editor.line_number_fg" });
    out.forEach((l, j) =>
      editor.addVirtualLine(buf, s.lastLine, "  " + l.text, { fg: l.fg, gutterGlyph: j === 0 ? "›" : undefined },
        false, NS_OUT, j));
  });
  dropStaleImages();
}

// ── opening, saving, closing ─────────────────────────────────────────

/** Shows the working copy; its own after_file_open (below) then closes the .ipynb's JSON view — in
 *  that order, so the editor never has no file open for a moment (it would open and focus the file
 *  explorer). */
function showCopy(nb: Notebook, jsonBuffer: number): void {
  nb.jsonBuffer = jsonBuffer;
  editor.openFile(nb.copy);
}

registerHandler("notebook_after_open", async (e: { path: string; buffer_id: number }) => {
  const copyOf = byCopy.get(e.path);
  if (copyOf) {
    copyOf.bufferId = e.buffer_id;
    showKernel(copyOf);
    if (copyOf.jsonBuffer !== null) editor.closeBuffer(copyOf.jsonBuffer, true);
    copyOf.jsonBuffer = null;
    followMode();
    await decorate(copyOf);
    return;
  }
  if (!e.path.toLowerCase().endsWith(".ipynb")) return;
  const known = byIpynb.get(e.path);
  if (known) {
    showCopy(known, e.buffer_id);
    return;
  }
  editor.setStatus(`notebook: opening ${editor.pathBasename(e.path)}…`);
  const nb = start(e.path);
  byIpynb.set(e.path, nb);
  byCopy.set(nb.copy, nb);
  const opened = await ask(nb, "open");
  if (!opened.ok) {
    editor.setStatus(`notebook: ${opened.message ?? "can't open"}`);
    return;
  }
  for (const [id, r] of Object.entries(opened.runs as Record<string, { execution_count: number | null; outputs: Output[] }>)) {
    nb.runs.set(id, { count: r.execution_count, outputs: r.outputs, state: "idle" });
  }
  editor.writeFile(nb.copy, cellsToText(opened.cells as Cell[]));
  showCopy(nb, e.buffer_id);
  editor.setStatus(`${editor.pathBasename(e.path)} · Shift/Alt+Enter runs a cell · saving writes the notebook`);
});
editor.on("after_file_open", "notebook_after_open");

/** Gives every cell an id in the buffer (a new `# %%` line has none), so outputs stay attached. */
async function cellsWithIds(nb: Notebook): Promise<Span[]> {
  const buf = nb.bufferId!;
  let spans = textToCells(await editor.getBufferText(buf));
  const missing = spans.filter((s) => !s.hasId && s.markerEnd > s.start);
  // from the end, so earlier offsets stay right
  for (const s of missing.reverse()) editor.insertText(buf, s.markerEnd, ` id=${s.cell.id}`);
  if (missing.length) spans = textToCells(await editor.getBufferText(buf));
  return spans;
}

registerHandler("notebook_after_save", async (e: { path: string }) => {
  const nb = byCopy.get(e.path);
  if (!nb || nb.bufferId === null) return;
  const spans = await cellsWithIds(nb);
  const r = await ask(nb, "save", { cells: spans.map((s) => s.cell) });
  editor.setStatus(r.ok ? `Saved ${editor.pathBasename(nb.ipynb)}` : `notebook: not saved: ${r.message}`);
});
editor.on("after_file_save", "notebook_after_save");

registerHandler("notebook_on_close", (e: { buffer_id: number }) => {
  for (const nb of byCopy.values()) {
    if (nb.bufferId !== e.buffer_id) continue;
    void ask(nb, "shutdown");
    byCopy.delete(nb.copy);
    byIpynb.delete(nb.ipynb);
  }
});
editor.on("buffer_closed", "notebook_on_close");

// ── running ──────────────────────────────────────────────────────────

function active(): Notebook | null {
  const id = editor.getActiveBufferId();
  for (const nb of byCopy.values()) if (nb.bufferId === id) return nb;
  return null;
}

async function runCells(nb: Notebook, spans: Span[]): Promise<void> {
  for (const s of spans) {
    if (s.cell.kind !== "code" || s.cell.source.trim() === "") continue;
    const r = run(nb, s.cell.id);
    r.state = "queued";
    const answer = await ask(nb, "run", { cell: s.cell.id, code: s.cell.source });
    if (!answer.ok) editor.setStatus(`notebook: ${answer.message}`);
  }
  await decorate(nb);
}

async function runAtCursor(advance: boolean): Promise<void> {
  const nb = active();
  if (!nb) return;
  const spans = await cellsWithIds(nb);
  const cursor = editor.getCursorPosition();
  const i = Math.max(0, spans.findIndex((s, k) => cursor >= s.start && (k === spans.length - 1 || cursor < spans[k + 1].start)));
  if (!spans[i]) return;
  await runCells(nb, [spans[i]]);
  if (advance && spans[i + 1]) {
    const next = spans[i + 1];
    editor.setBufferCursor(nb.bufferId!, Math.min(next.markerEnd + 1, next.end));
  }
}

registerHandler("notebook_run_advance", () => runAtCursor(true));
registerHandler("notebook_run_stay", () => runAtCursor(false));
registerHandler("notebook_run_all", async () => {
  const nb = active();
  if (nb) await runCells(nb, await cellsWithIds(nb));
});
registerHandler("notebook_restart", async () => {
  const nb = active();
  if (!nb) return;
  await ask(nb, "restart");
  for (const r of nb.runs.values()) if (r.state === "busy" || r.state === "queued") r.state = "error";
  editor.setStatus("notebook: kernel restarted; the next run starts a fresh one");
  await decorate(nb);
});

editor.registerCommand("Notebook: Run Cell", "Run the cell under the cursor and move to the next", "notebook_run_advance", "notebook");
editor.registerCommand("Notebook: Run Cell and Stay", "Run the cell under the cursor", "notebook_run_stay", "notebook");
editor.registerCommand("Notebook: Run All", "Run every code cell, top to bottom", "notebook_run_all", "notebook");
registerHandler("notebook_interrupt", async () => {
  const nb = active();
  if (!nb) return;
  const r = await ask(nb, "interrupt");
  editor.setStatus(r.ok ? "notebook: interrupted; the kernel and its variables are kept" : `notebook: ${r.message}`);
});

editor.registerCommand("Notebook: Interrupt Kernel", "Stop the running cell (and the ones queued after it), keeping the kernel and its variables", "notebook_interrupt", "notebook");
editor.registerCommand("Notebook: Restart Kernel", "Stop the kernel, even mid-cell; the next run starts a new one", "notebook_restart", "notebook");

// Shift+Enter / Ctrl+Enter in a notebook; everything else types and edits as usual.
// Alt+Enter too: without an extended keyboard protocol a terminal sends Shift+Enter as plain Enter.
editor.defineMode("notebook", [
  ["S-Enter", "notebook_run_advance"],
  ["M-Enter", "notebook_run_advance"],
  ["C-Enter", "notebook_run_stay"],
], false);

function followMode(): void {
  const nb = active();
  editor.setContext("notebook", nb !== null);
  const mode = editor.getEditorMode();
  if (nb && mode == null && editor.getInputMode() == null) editor.setEditorMode("notebook");
  else if (!nb && mode === "notebook") editor.setEditorMode(null);
}
registerHandler("notebook_mode_follow", followMode);
editor.on("buffer_activated", "notebook_mode_follow");
editor.on("active_buffer_changed", "notebook_mode_follow");

// redraw a notebook's rules and outputs after its text changes (positions move)
let pending = false;
registerHandler("notebook_redraw", async () => {
  pending = false;
  const nb = active();
  if (nb) await decorate(nb);
});
registerHandler("notebook_on_modified", (e: { buffer_id: number }) => {
  if (pending) return;
  for (const nb of byCopy.values()) {
    if (nb.bufferId === e.buffer_id) {
      pending = true;
      editor.setTimeout(150, "notebook_redraw");
      return;
    }
  }
});
editor.on("buffer_modified", "notebook_on_modified");
