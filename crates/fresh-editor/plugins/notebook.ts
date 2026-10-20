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

import { cellPixels, deleteImages, DIACRITICS, imageFg, imageRow, pngSize, themeHex, uploadPng } from "./lib/kitty.ts";

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
const NS_CELL = "notebook-cell";
const NS_PAD = "notebook-pad:";
const NS_MD = "notebook-md";

type Cell = { id: string; kind: string; source: string };
type Output = Record<string, unknown>;
type Run = {
  count: number | null;
  outputs: Output[];
  state: "idle" | "queued" | "busy" | "ok" | "error";
  expanded?: boolean;
  /** When it started running, and how long it took (ms), for the rule's timing. */
  startedAt?: number;
  took?: number;
};

/** A run's time the way the rule shows it: 0.42s, 3.1s, 12s, 2m 05s. */
function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 1) return `${s.toFixed(2)}s`;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s - 60 * m)).padStart(2, "0")}s`;
}

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
  /** The markdown cell the cursor was in at the last redraw (its source shows, the others are
   *  typeset), and the typeset ones by the line of their `# %%` marker, for clicks. */
  cursorCell?: string | null;
  /** The text changed since the last redraw (its spans are out of date). */
  edited?: boolean;
  typeset?: Map<number, { cell: string; lines: MdLine[]; rowPx: number }>;
  spans?: Span[];
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

/** A colour or bold range of an output line (byte offsets in its text). */
type Span8 = { start: number; end: number; fg?: string | [number, number, number]; bold?: boolean };

/** The 16 ANSI colours as theme colours, so coloured output (tracebacks, logs, rich) follows it. */
const ANSI_THEME = ["editor.line_number_fg", "diagnostic.error_fg", "syntax.string", "diagnostic.warning_fg",
  "syntax.function", "syntax.keyword", "syntax.type", "editor.fg"];
const XTERM6 = [0, 95, 135, 175, 215, 255];
function xterm256(n: number): string | [number, number, number] {
  if (n < 16) return ANSI_THEME[n % 8];
  if (n < 232) {
    const k = n - 16;
    return [XTERM6[Math.floor(k / 36)], XTERM6[Math.floor(k / 6) % 6], XTERM6[k % 6]];
  }
  const g = 8 + 10 * (n - 232);
  return [g, g, g];
}

/** One line of terminal output as plain text plus its colour ranges: SGR colours and bold kept,
 *  other escapes dropped, and a line redrawn with `\r` (a progress bar) as its last state. */
export function ansiLine(raw: string): { text: string; spans: Span8[] } {
  const parts = raw.split("\r");
  let line = parts[parts.length - 1];
  for (let k = parts.length - 1; k >= 0 && stripAnsi(line) === ""; k--) line = parts[k];
  let text = "";
  const spans: Span8[] = [];
  let fg: Span8["fg"];
  let bold = false;
  let open = 0;
  const close = () => {
    const end = bytes(text);
    if (end > open && (fg !== undefined || bold)) spans.push({ start: open, end, fg, bold: bold || undefined });
    open = end;
  };
  const re = /\x1b\[([0-9;?]*)([ -/]*[@-~])/g;
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    text += line.slice(last, m.index);
    last = re.lastIndex;
    if (m[2] !== "m") continue;
    close();
    const codes = m[1] === "" ? [0] : m[1].split(";").map((c) => Number(c) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { fg = undefined; bold = false; }
      else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c === 39) fg = undefined;
      else if (c >= 30 && c <= 37) fg = ANSI_THEME[c - 30];
      else if (c >= 90 && c <= 97) fg = ANSI_THEME[c - 90];
      else if (c === 38 && codes[i + 1] === 5) { fg = xterm256(codes[i + 2] ?? 7); i += 2; }
      else if (c === 38 && codes[i + 1] === 2) { fg = [codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0]; i += 4; }
      else if (c === 48 && (codes[i + 1] === 5 || codes[i + 1] === 2)) i += codes[i + 1] === 5 ? 2 : 4;
    }
  }
  text += line.slice(last);
  close();
  return { text, spans };
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

/** IPython magics and shell escapes (`%matplotlib inline`, `%%time`, `!pip install x`) aren't
 *  Python: in the working copy they're behind `#!`, a comment to the language server (shown without
 *  it), and come back as they were. */
const MAGIC = /^(%|!)/;
const HIDDEN_MAGIC = /^#!(?=%|!)/;
const hideMagics = (src: string) => src.split("\n").map((l) => (MAGIC.test(l) ? "#!" + l : l)).join("\n");

/** A markdown (or raw) cell's text is one raw string in the working copy, its lines as they are: a
 *  bare string is nothing to Python's tools. The `r"""` has a line to itself (hidden), the closing
 *  `"""` ends the last line (concealed). Text with a `"""` of its own can't be in one: it is a
 *  comment, a `# ` before each line, the plain percent format. */
const OPEN_QUOTE = /^[rR]?"""/;
const CLOSE_QUOTE = /"""$/;
const quotable = (source: string) => !source.includes('"""');

/** Cells as percent-format text. */
export function cellsToText(cells: Cell[]): string {
  if (cells.length === 0) return markerLine({ id: newId(), kind: "code", source: "" }) + "\n";
  return cells
    .map((c) => {
      const body = c.kind === "code"
        ? hideMagics(c.source)
        : quotable(c.source)
          ? `r"""\n${c.source}"""`
          : c.source.split("\n").map((l) => (l.length ? "# " + l : "#")).join("\n");
      return markerLine(c) + "\n" + body + (body.endsWith("\n") || body === "" ? "" : "\n");
    })
    .join("\n");
}

type Span = {
  cell: Cell;
  start: number;
  markerEnd: number;
  lastLine: number;
  lastEnd: number;
  end: number;
  hasId: boolean;
  /** Where each line of the source starts (bytes), up to the last one with text. */
  lineStarts: number[];
  /** A markdown cell in a raw string: where its `r"""` line and its `"""` line start and end (a
   *  quote an edit joined to a line of text stays on it, until `fixQuotes` puts it back). */
  quotes?: { open: number; openEnd: number; close: number; closeEnd: number };
};

/** The cells of percent-format text, with where each sits (byte offsets). */
export function textToCells(text: string): Span[] {
  const lines = text.split("\n");
  const spans: Span[] = [];
  let offset = 0;
  let current: { span: Span; body: string[]; ends: number[] } | null = null;
  const finish = () => {
    if (!current) return;
    let body = current.body;
    // the blank line written between cells belongs to no cell
    if (body.length && body[body.length - 1] === "") body = body.slice(0, -1);
    const n = body.length;
    if (current.span.cell.kind !== "code" && n && OPEN_QUOTE.test(body[0])) {
      // a raw string: the text after the `r"""` line (or after the quote, an edit having joined
      // them), up to the closing quotes (ones an edit took away are put back by `fixQuotes`)
      const span = current.span;
      const starts = span.lineStarts.slice(0, n);
      const ends = current.ends.slice(0, n);
      const open = OPEN_QUOTE.exec(body[0])![0].length;
      const lines = body.slice();
      lines[0] = lines[0].slice(open);
      starts[0] += open;
      const tail = /"{1,3}$/.exec(lines[n - 1]);
      span.quotes = { open: span.lineStarts[0], openEnd: current.ends[0], close: ends[n - 1] - (tail?.[0].length ?? 0), closeEnd: ends[n - 1] };
      lines[n - 1] = lines[n - 1].slice(0, lines[n - 1].length - (tail?.[0].length ?? 0));
      if (n > 1 && lines[0] === "") (lines.shift(), starts.shift(), ends.shift());
      span.cell.source = lines.join("\n");
      span.lineStarts = starts;
      span.lastLine = starts[starts.length - 1];
      span.lastEnd = span.quotes.close;
      span.end = span.quotes.closeEnd;
      spans.push(span);
      return;
    }
    if (current.span.cell.kind !== "code") body = body.map((l) => l.replace(/^# ?/, ""));
    else body = body.map((l) => l.replace(HIDDEN_MAGIC, ""));
    current.span.cell.source = body.join("\n");
    current.span.lineStarts = current.span.lineStarts.filter((p) => p <= current!.span.lastLine);
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
          lastEnd: lineEnd,
          end: lineEnd,
          hasId: m[2] !== undefined,
          lineStarts: [],
        },
        body: [],
        ends: [],
      };
    } else if (current) {
      current.body.push(line);
      current.ends.push(lineEnd);
      current.span.lineStarts.push(offset);
      // outputs hang under the cell's last line with text (the line at the very end of the file
      // draws no virtual lines)
      if (line.trim() !== "") {
        current.span.lastLine = offset;
        current.span.lastEnd = lineEnd;
      }
      current.span.end = lineEnd;
    } else if (line.trim() !== "") {
      // text before the first marker: a code cell of its own
      current = {
        span: { cell: { id: newId(), kind: "code", source: "" }, start: offset, markerEnd: offset, lastLine: offset, lastEnd: lineEnd, end: lineEnd, hasId: false, lineStarts: [offset] },
        body: [line],
        ends: [lineEnd],
      };
    }
    offset = lineEnd + 1;
  });
  finish();
  return spans;
}

/** Where a cell's source starts in the working copy (past its `# %%` line, and its `r"""` line). */
function sourceStart(s: Span): number {
  if (s.quotes) return s.lineStarts[0] ?? s.quotes.openEnd;
  return s.markerEnd > s.start ? Math.min(s.markerEnd + 1, s.end) : s.start;
}

/** The `# ` a markdown line has in front of it in the working copy (none in a raw string). */
const mdPrefix = (s: Span, raw: string) => (s.quotes ? "" : /^# ?/.exec(raw)?.[0] ?? "");

/** A markdown cell's line as the working copy has it, without the string's quotes. */
function mdText(s: Span, lineStart: number, lineAt: Map<number, string>): string {
  let raw = lineAt.get(lineStart) ?? "";
  const q = s.quotes;
  if (!q) return raw;
  if (lineStart > q.open && lineStart <= q.openEnd) raw = raw.replace(OPEN_QUOTE, ""); // (joined)
  return lineStart === s.lastLine ? raw.replace(/"{1,3}$/, "") : raw;
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
  const chosen = chosenKernels()[ipynb];
  const args = ["serve", ipynb];
  if (chosen?.python) args.push("--python", chosen.python);
  else if (chosen?.kernel) args.push("--kernel", chosen.kernel);
  const proc = editor.spawnBackgroundProcess(NB_COMMAND, args, dir);
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

/** The kernels picked with "Notebook: Select Kernel", by notebook path (nb is started with them). */
type Choice = { python?: string; kernel?: string };
function chosenKernelsPath(): string {
  return editor.pathJoin(editor.getDataDir(), "notebooks", "kernels.json");
}
function chosenKernels(): Record<string, Choice> {
  try {
    return JSON.parse(editor.readFile(chosenKernelsPath()) ?? "{}");
  } catch {
    return {};
  }
}
function rememberKernel(ipynb: string, choice: Choice): void {
  const all = chosenKernels();
  all[ipynb] = choice;
  editor.createDir(editor.pathDirname(chosenKernelsPath()));
  editor.writeFile(chosenKernelsPath(), JSON.stringify(all, null, 1));
}

/** The working copy for a notebook: under the data dir, named after it so the tab reads well. */
function workingCopyPath(ipynb: string): string {
  // inside the notebook's repo when it has one, under .git where git keeps no track of it: the
  // language server then sees the copy as part of the project (its venv, its modules)
  const root = repoRoot(editor.pathDirname(ipynb));
  const base = root ? editor.pathJoin(root, ".git", "fresh-notebooks") : editor.pathJoin(editor.getDataDir(), "notebooks");
  const name = root ? ipynb.slice(root.length) : ipynb;
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(-60);
  const dir = editor.pathJoin(base, key);
  editor.createDir(dir);
  // which notebook this is, for a working copy the editor restores on its own (below)
  editor.writeFile(editor.pathJoin(dir, "notebook.txt"), ipynb);
  return editor.pathJoin(dir, editor.pathBasename(ipynb) + ".py");
}

/** The repository `dir` is in: the nearest folder up with a `.git` directory (not a worktree's
 *  `.git` file, which has no room for the copies). */
function repoRoot(dir: string): string | null {
  for (let d = dir; ; ) {
    const git = editor.fileStat(editor.pathJoin(d, ".git")) as { isDir?: boolean } | null;
    if (git?.isDir) return d;
    const up = editor.pathDirname(d);
    if (!up || up === d) return null;
    d = up;
  }
}

/** The notebook a working copy belongs to, if `path` is one (from the note beside it). */
function notebookOfCopy(path: string): string | null {
  const inData = path.startsWith(editor.pathJoin(editor.getDataDir(), "notebooks"));
  const inRepo = /[\\/]\.git[\\/]fresh-notebooks[\\/]/.test(path);
  if (!(inData || inRepo) || !path.endsWith(".py")) return null;
  const note = editor.readFile(editor.pathJoin(editor.pathDirname(path), "notebook.txt"));
  return note ? note.trim() : null;
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
        r.startedAt = Date.now();
        r.took = undefined;
        tick();
      }
      break;
    case "output":
      if (cell) {
        // stream text arrives in pieces (a progress bar's every redraw): one output per stream,
        // as Jupyter keeps it, so a `\r` in one piece overwrites what the last one printed
        const outs = run(nb, cell).outputs;
        const o = e.output as Output;
        const last = outs[outs.length - 1];
        if (o.output_type === "stream" && last?.output_type === "stream" && last.name === o.name) {
          const text = (v: unknown) => (Array.isArray(v) ? v.join("") : String(v ?? ""));
          outs[outs.length - 1] = { ...last, text: text(last.text) + text(o.text) };
        } else outs.push(o);
      }
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
        if (r.startedAt !== undefined && r.state !== "idle") r.took = Date.now() - r.startedAt;
      }
      break;
    case "input": {
      // input() in the running cell: asked in a prompt; Esc interrupts the cell
      asking = nb;
      const prompt = String(e.prompt ?? "").trimEnd();
      editor.startPrompt(`${prompt || "input()"}${e.password ? " (shown as typed)" : ""} `, "notebook-input");
      return;
    }
    case "error":
      editor.setStatus(`notebook: ${String(e.message).split("\n")[0]}`);
      if (cell) run(nb, cell).state = "error";
      break;
  }
  showKernel(nb);
  void decorate(nb);
}

/** While a cell runs, its rule's clock is redrawn every second. */
let ticking = false;
function tick(): void {
  if (ticking) return;
  ticking = true;
  editor.setTimeout(1000, "notebook_tick");
}
registerHandler("notebook_tick", async () => {
  ticking = false;
  const busy = [...byCopy.values()].filter((nb) => [...nb.runs.values()].some((r) => r.state === "busy"));
  for (const nb of busy) await decorate(nb);
  if (busy.length) tick();
});

/** The notebook whose running cell waits for an answer to input(). */
let asking: Notebook | null = null;
registerHandler("notebook_input_answered", async (e: { prompt_type: string; input: string }) => {
  if (e.prompt_type !== "notebook-input" || !asking) return;
  const nb = asking;
  asking = null;
  const r = await ask(nb, "input", { value: e.input });
  if (!r.ok) editor.setStatus(`notebook: ${r.message}`);
});
editor.on("prompt_confirmed", "notebook_input_answered");
registerHandler("notebook_input_cancelled", async (e: { prompt_type: string }) => {
  if (e.prompt_type !== "notebook-input" || !asking) return;
  const nb = asking;
  asking = null;
  await ask(nb, "interrupt");
  editor.setStatus("notebook: input cancelled, the cell interrupted");
});
editor.on("prompt_cancelled", "notebook_input_cancelled");

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
    case "selected":
      return `○ ${name} not started`;
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

// ── markdown cells: LaTeX as Unicode, inline marks ──────────────────

const LATEX_SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
  varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "ϕ",
  varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ",
  Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", oint: "∮", partial: "∂", nabla: "∇",
  infty: "∞", pm: "±", mp: "∓", times: "×", div: "÷", cdot: "·", cdots: "⋯", ldots: "…", dots: "…",
  vdots: "⋮", ddots: "⋱", le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", ll: "≪", gg: "≫",
  approx: "≈", equiv: "≡", sim: "∼", simeq: "≃", cong: "≅", propto: "∝", in: "∈", notin: "∉",
  ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇", cup: "∪", cap: "∩",
  setminus: "∖", emptyset: "∅", varnothing: "∅", forall: "∀", exists: "∃", neg: "¬", lnot: "¬",
  land: "∧", wedge: "∧", lor: "∨", vee: "∨", oplus: "⊕", otimes: "⊗", to: "→", rightarrow: "→",
  leftarrow: "←", gets: "←", Rightarrow: "⇒", Leftarrow: "⇐", implies: "⇒", iff: "⇔",
  leftrightarrow: "↔", Leftrightarrow: "⇔", mapsto: "↦", uparrow: "↑", downarrow: "↓",
  langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", circ: "∘",
  bullet: "•", star: "⋆", ast: "∗", ell: "ℓ", hbar: "ℏ", Re: "ℜ", Im: "ℑ", aleph: "ℵ", top: "⊤",
  bot: "⊥", perp: "⊥", parallel: "∥", angle: "∠", triangle: "△", square: "□", prime: "′",
  degree: "°", checkmark: "✓", quad: "  ", qquad: "    ", ",": " ", ";": " ", ":": " ", "!": "",
  " ": " ", "{": "{", "}": "}", "%": "%", "$": "$", "#": "#", "&": "&", "_": "_", "|": "‖",
  lbrace: "{", rbrace: "}", vert: "|", Vert: "‖", backslash: "\\",
};
const LATEX_FUNCTIONS = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos",
  "arctan", "sinh", "cosh", "tanh", "log", "ln", "lg", "exp", "max", "min", "sup", "inf", "lim",
  "limsup", "liminf", "det", "dim", "ker", "deg", "gcd", "arg", "Pr", "mod", "bmod"]);
const LATEX_ACCENTS: Record<string, string> = { hat: "̂", widehat: "̂", bar: "̄",
  overline: "̅", vec: "⃗", dot: "̇", ddot: "̈", tilde: "̃",
  widetilde: "̃", acute: "́", grave: "̀", underline: "̲" };
const BLACKBOARD: Record<string, string> = { N: "ℕ", Z: "ℤ", Q: "ℚ", R: "ℝ", C: "ℂ", P: "ℙ", E: "𝔼", H: "ℍ" };
const SUP = "0⁰1¹2²3³4⁴5⁵6⁶7⁷8⁸9⁹+⁺-⁻=⁼(⁽)⁾nⁿiⁱaᵃbᵇcᶜdᵈeᵉfᶠgᵍhʰjʲkᵏlˡmᵐoᵒpᵖrʳsˢtᵗuᵘvᵛwʷxˣyʸzᶻTᵀAᴬBᴮDᴰEᴱGᴳHᴴIᴵJᴶKᴷLᴸMᴹNᴺOᴼPᴾRᴿUᵁVⱽWᵂ′′*˟";
const SUB = "0₀1₁2₂3₃4₄5₅6₆7₇8₈9₉+₊-₋=₌(₍)₎aₐeₑhₕiᵢjⱼkₖlₗmₘnₙoₒpₚrᵣsₛtₜuᵤvᵥxₓβᵦγᵧρᵨφᵩχᵪ";
const pairs = (t: string) => {
  const m = new Map<string, string>();
  const cs = [...t];
  for (let i = 0; i + 1 < cs.length; i += 2) m.set(cs[i], cs[i + 1]);
  return m;
};
const SUP_MAP = pairs(SUP);
const SUB_MAP = pairs(SUB);

/** LaTeX math as plain Unicode, for a terminal: `\alpha^2 + \sum_{i=1}^n x_i` → `α² + ∑ᵢ₌₁ⁿ xᵢ`.
 *  Covers what notebooks write in prose (Greek, operators, relations, arrows, scripts, \frac,
 *  \sqrt, accents, \mathbb, \text); anything it doesn't know is kept as written, minus braces. */
export function latexToUnicode(src: string): string {
  let i = 0;
  const s = src;
  const skipSpaces = () => {
    while (i < s.length && s[i] === " ") i++;
  };
  // one argument: a {group}, a \command or a single character
  const arg = (): string => {
    skipSpaces();
    if (i >= s.length) return "";
    if (s[i] === "{") {
      let depth = 0;
      const start = i;
      for (; i < s.length; i++) {
        if (s[i] === "\\") {
          i++;
          continue;
        }
        if (s[i] === "{") depth++;
        else if (s[i] === "}" && --depth === 0) break;
      }
      const inner = s.slice(start + 1, i);
      i++;
      return latexToUnicode(inner);
    }
    if (s[i] === "\\") return command();
    return s[i++];
  };
  const script = (text: string, map: Map<string, string>, mark: string): string => {
    const cs = [...text];
    if (cs.length && cs.every((c) => map.has(c))) return cs.map((c) => map.get(c)).join("");
    return cs.length === 1 ? mark + text : `${mark}(${text})`;
  };
  const wrap = (t: string) => ([...t].length > 1 && !/^[\p{L}\p{N}.]+$/u.test(t) ? `(${t})` : t);
  const command = (): string => {
    i++; // the backslash
    const m = /^([A-Za-z]+|.)/.exec(s.slice(i));
    if (!m) return "\\";
    const name = m[1];
    i += name.length;
    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const a = arg();
      const b = arg();
      return `${wrap(a)}/${wrap(b)}`;
    }
    if (name === "sqrt") {
      let n = "";
      skipSpaces();
      if (s[i] === "[") {
        const close = s.indexOf("]", i);
        n = latexToUnicode(s.slice(i + 1, close));
        i = close + 1;
      }
      const x = arg();
      const root = n === "3" ? "∛" : n === "4" ? "∜" : n ? script(n, SUP_MAP, "^") + "√" : "√";
      return root + wrap(x);
    }
    if (name in LATEX_ACCENTS) {
      const x = arg();
      return [...x].length === 1 ? x + LATEX_ACCENTS[name] : x;
    }
    if (name === "mathbb") {
      const x = arg();
      return [...x].map((c) => BLACKBOARD[c] ?? c).join("");
    }
    if (["text", "textrm", "mathrm", "mathbf", "mathit", "mathsf", "mathtt", "mathcal", "operatorname",
      "boldsymbol", "textbf", "textit", "emph"].includes(name)) return arg();
    if (name === "left" || name === "right" || name === "big" || name === "Big" || name === "bigg"
      || name === "Bigg" || name === "displaystyle" || name === "limits" || name === "nolimits") {
      if ((name === "left" || name === "right") && s[i] === ".") i++;
      return "";
    }
    if (name === "begin" || name === "end") {
      arg(); // the environment's name
      return "";
    }
    if (name === "\\") return "  ";
    if (LATEX_FUNCTIONS.has(name)) return name;
    if (name in LATEX_SYMBOLS) return LATEX_SYMBOLS[name];
    return name;
  };
  let out = "";
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") out += command();
    else if (c === "^") {
      i++;
      out += script(arg(), SUP_MAP, "^");
    } else if (c === "_") {
      i++;
      out += script(arg(), SUB_MAP, "_");
    } else if (c === "{" || c === "}") i++;
    else if (c === "&") {
      out += " ";
      i++;
    } else if (c === "~") {
      out += " ";
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/ {3,}/g, "  ");
}

/** An inline mark in a markdown line, by character offsets: the whole of it, the text it shows,
 *  and how. `math` shows `text` in place of the whole; the others hide the marks around `inner`. */
export type MdMark = {
  kind: "code" | "bold" | "italic" | "link" | "math";
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
  text: string;
};

/** The inline marks of one markdown line, left to right, not overlapping. */
export function markdownMarks(line: string): MdMark[] {
  const re = /`([^`]+)`|\$\$(.+?)\$\$|\$([^$\s](?:[^$]*[^$\s])?)\$|\*\*(.+?)\*\*|__(.+?)__|\*([^*\s](?:[^*]*[^*\s])?)\*|(?<![\w])_([^_\s](?:[^_]*[^_\s])?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)/g;
  const marks: MdMark[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const start = m.index;
    const end = start + m[0].length;
    const at = (inner: string, open: number) => ({ innerStart: start + open, innerEnd: start + open + inner.length });
    if (m[1] !== undefined) marks.push({ kind: "code", start, end, ...at(m[1], 1), text: m[1] });
    else if (m[2] !== undefined) marks.push({ kind: "math", start, end, ...at(m[2], 2), text: latexToUnicode(m[2]) });
    else if (m[3] !== undefined) marks.push({ kind: "math", start, end, ...at(m[3], 1), text: latexToUnicode(m[3]) });
    else if (m[4] !== undefined) marks.push({ kind: "bold", start, end, ...at(m[4], 2), text: m[4] });
    else if (m[5] !== undefined) marks.push({ kind: "bold", start, end, ...at(m[5], 2), text: m[5] });
    else if (m[6] !== undefined) marks.push({ kind: "italic", start, end, ...at(m[6], 1), text: m[6] });
    else if (m[7] !== undefined) marks.push({ kind: "italic", start, end, ...at(m[7], 1), text: m[7] });
    else if (m[8] !== undefined) marks.push({ kind: "link", start, end, ...at(m[8], 1), text: m[8] });
  }
  return marks;
}

// ── images (kitty graphics, Unicode placeholders) ────────────────────

type Image = { id: number; cols: number; rows: number };
/** Uploaded images, by the output they show; dropped (and deleted in the terminal) once their
 *  output is gone. */
const images = new Map<Output, Image>();
let nextImageId = 0x4e4200; // within 24 bits, so the colour alone names the image

/** Sends the PNG to the terminal and places it virtually, once per output. */
function uploadImage(o: Output, b64: string): Image | null {
  const known = images.get(o);
  if (known) return known;
  const size = pngSize(b64);
  if (!size) return null;
  const img = sendImage(b64, size[0], size[1]);
  if (img) images.set(o, img);
  return img;
}

/** Uploads a PNG of `w`×`h` pixels (at `density` pixels per terminal pixel) and places it
 *  virtually over as many cells as it covers, no wider than the setting nor the pane. */
function sendImage(b64: string, w: number, h: number, density = 1): Image | null {
  const [cw, ch] = cellPixels();
  let cols = Math.max(1, Math.ceil(w / density / cw));
  let rows = Math.max(1, Math.ceil(h / density / ch));
  // no wider than the setting, nor than the pane (a soft-wrapped row would break the image)
  const pane = editor.getViewport()?.width ?? 0;
  const widest = pane > 20 ? Math.min(IMAGE_MAX_COLUMNS, pane - 4) : IMAGE_MAX_COLUMNS;
  if (cols > widest) {
    rows = Math.max(1, Math.round((rows * widest) / cols));
    cols = widest;
  }
  rows = Math.min(rows, DIACRITICS.length);
  const id = nextImageId++;
  if (!uploadPng(b64, id, cols, rows)) return null;
  return { id, cols, rows };
}

/** Outputs whose image nb is converting to PNG (or couldn't). */
const converting = new Map<Output, "pending" | "failed">();

/** An output's JPEG, GIF or SVG image, once nb has made a PNG of it (the notebook is redrawn then);
 *  null until then, or for good if it can't. */
function convertedImage(nb: Notebook, o: Output, mime: string, data: string): Image | null {
  const known = images.get(o);
  if (known) return known;
  if (!["image/jpeg", "image/gif", "image/svg+xml"].includes(mime) || converting.has(o)) return null;
  converting.set(o, "pending");
  void ask(nb, "topng", { mime, data }).then((r) => {
    const img = r.ok && typeof r.png === "string"
      ? sendImage(r.png, Number(r.width), Number(r.height), mime === "image/svg+xml" ? 2 : 1)
      : null;
    if (!img) {
      converting.set(o, "failed");
      return;
    }
    converting.delete(o);
    images.set(o, img);
    void decorate(nb);
  });
  return null;
}

/** Display math typeset by nb (Typst), by formula and colour: the image once it's there, or
 *  "pending" / "failed" (the Unicode text shows meanwhile, or for good). Kept for the session. */
const formulas = new Map<string, Image | "pending" | "failed">();

/** The typeset image of a formula, or null while it's on its way (the notebook is redrawn when it
 *  comes) or if Typst can't make it out. */
function formulaImage(nb: Notebook, latex: string, colorKey = "syntax.number"): Image | null {
  if (!IMAGES) return null;
  const color = themeHex(colorKey, colorKey === "syntax.number" ? "#ff9e64" : "#c0caf5");
  const key = `${color} ${latex}`;
  const known = formulas.get(key);
  if (known !== undefined) return typeof known === "string" ? null : known;
  formulas.set(key, "pending");
  // rendered at twice the cell size, for HiDPI; the em as tall as a text row
  const [, ch] = cellPixels();
  const size = 14;
  void ask(nb, "math", { latex, color, size, scale: (2 * ch) / size }).then((r) => {
    const img = r.ok && typeof r.png === "string"
      ? sendImage(r.png, Number(r.width), Number(r.height), 2)
      : null;
    formulas.set(key, img ?? "failed");
    if (img) void decorate(nb);
  });
  return null;
}

/** Deletes the images whose outputs are no longer shown by any notebook. */
function dropStaleImages(): void {
  const live = new Set<Output>();
  for (const nb of byCopy.values()) for (const r of nb.runs.values()) r.outputs.forEach((o) => live.add(o));
  const stale: number[] = [];
  for (const [o, img] of images) {
    if (live.has(o)) continue;
    stale.push(img.id);
    images.delete(o);
  }
  deleteImages(stale);
}

// ── markdown cells, typeset ──────────────────────────────────────────

/** Where a line of a markdown cell's text is: in the markdown nb typesets, and in the buffer
 *  (past its `# `). */
type MdLine = { md: number; buf: number };
/** A markdown cell typeset by nb (Typst) as tiles of one long page: shown in place of the cell's
 *  source while the cursor is in another cell. `key` is what it was made from. */
type Page = { key: string; state: "pending" | "failed" | "ready"; tiles: Image[]; rowPx: number };
const pages = new Map<Notebook, Map<string, Page>>();
/** The tiles' images, by their hash (the same slice of page is sent once). */
const pageTiles = new Map<string, Image>();
const PAGE_TILE_ROWS = 8;
/** Pixels drawn per terminal pixel, for HiDPI. */
const PAGE_DENSITY = 2;
const PAGE_SIZE_PT = 11;

/** A markdown cell's text without its `# ` prefixes, and where each line of it is. */
function cellMarkdown(s: Span, lineAt: Map<number, string>): { md: string; lines: MdLine[] } {
  let md = "";
  const lines: MdLine[] = [];
  for (const lineStart of s.lineStarts) {
    const raw = mdText(s, lineStart, lineAt);
    const prefix = mdPrefix(s, raw);
    lines.push({ md: bytes(md), buf: lineStart + bytes(prefix) });
    md += raw.slice(prefix.length) + "\n";
  }
  return { md, lines };
}

/** The cell's typeset page, or null while nb is making it (the notebook is redrawn when it comes)
 *  or if it can't. */
function cellPage(nb: Notebook, s: Span, md: string): Page | null {
  if (!IMAGES || !md.trim()) return null;
  const [cw, ch] = cellPixels();
  const width = editor.getViewport()?.width ?? 80;
  // a page of text: as wide as the pane, up to a readable measure
  const cols = Math.max(20, Math.min(120, width - 4));
  const key = `${cols} ${md}`;
  let byCell = pages.get(nb);
  if (!byCell) pages.set(nb, (byCell = new Map()));
  const known = byCell.get(s.cell.id);
  if (known?.key === key) return known.state === "ready" ? known : null;
  const rowPx = ch * PAGE_DENSITY;
  const page: Page = { key, state: "pending", tiles: [], rowPx };
  byCell.set(s.cell.id, page);
  void ask(nb, "md", {
    id: `cell:${s.cell.id}`,
    text: md,
    dir: editor.pathDirname(nb.ipynb),
    width_px: cols * cw * PAGE_DENSITY,
    // the em about as tall as the terminal's own letters
    px_per_pt: (0.8 * rowPx) / PAGE_SIZE_PT,
    size_pt: PAGE_SIZE_PT,
    tile_px: PAGE_TILE_ROWS * rowPx,
    row_px: rowPx,
    theme: {
      fg: themeHex("editor.fg", "#c0caf5"),
      accent: themeHex("ui.tab_active_bg", "#7aa2f7"),
      muted: themeHex("editor.line_number_fg", "#565f89"),
      code_bg: themeHex("ui.notebook_cell_bg", "#1f2335"),
      link: themeHex("syntax.type", "#7dcfff"),
    },
    have: [...pageTiles.keys()],
  }).then((r) => {
    if (byCell!.get(s.cell.id) !== page) return;
    if (!r.ok || !Array.isArray(r.tiles)) {
      page.state = "failed";
      editor.debug(`notebook: markdown cell not typeset: ${r.message ?? "?"}`);
      return;
    }
    for (const t of r.tiles as { hash: string; height: number; png?: string }[]) {
      const rows = Math.min(DIACRITICS.length, Math.max(1, Math.round(t.height / rowPx)));
      let img = pageTiles.get(t.hash);
      if (!img && t.png) {
        img = { id: nextImageId++, cols, rows };
        if (!uploadPng(t.png, img.id, cols, rows)) {
          page.state = "failed";
          return;
        }
        pageTiles.set(t.hash, img);
      }
      if (!img) {
        // nb thought we had it: ask again, sending everything
        pageTiles.clear();
        byCell!.delete(s.cell.id);
        void decorate(nb);
        return;
      }
      page.tiles.push(img);
    }
    page.state = "ready";
    void decorate(nb);
  });
  return null;
}

/** Deletes the tiles no page shows any more. */
function dropStalePages(): void {
  const live = new Set<number>();
  for (const byCell of pages.values()) for (const p of byCell.values()) p.tiles.forEach((t) => live.add(t.id));
  const stale: number[] = [];
  for (const [hash, img] of pageTiles) {
    if (live.has(img.id)) continue;
    stale.push(img.id);
    pageTiles.delete(hash);
  }
  deleteImages(stale);
}

// ── drawing ──────────────────────────────────────────────────────────

/** A line drawn under a cell: text in a theme colour, or one row of an image. */
type OutLine = { text: string; fg: string | [number, number, number]; clip?: boolean; spans?: Span8[] };

/** The cells of an HTML table's rows (`<th>`/`<td>`, tags inside stripped, entities decoded, a
 *  `colspan` as that many cells) and the text after the table (pandas' "5 rows × 3 columns"); null
 *  if there is no table. */
export function htmlTable(html: string): { rows: { cells: string[]; head: boolean }[]; note: string } | null {
  const table = /<table[\s\S]*?<\/table>/i.exec(html);
  if (!table) return null;
  const decode = (s: string) =>
    s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const rows: { cells: string[]; head: boolean }[] = [];
  for (const tr of table[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    let head = true;
    for (const c of tr[1].matchAll(/<(th|td)([^>]*)>([\s\S]*?)<\/\1>/gi)) {
      if (c[1].toLowerCase() === "td") head = false;
      const span = Number(/colspan="?(\d+)/i.exec(c[2])?.[1] ?? 1);
      cells.push(decode(c[3]));
      for (let k = 1; k < span; k++) cells.push("");
    }
    if (cells.length) rows.push({ cells, head });
  }
  if (!rows.length) return null;
  const note = decode(html.slice(table.index + table[0].length));
  return { rows, note };
}

/** A table as aligned rows: the header in the accent colour over a rule, numbers to the right. */
function tableLines(t: { rows: { cells: string[]; head: boolean }[]; note: string }): OutLine[] {
  const n = Math.max(...t.rows.map((r) => r.cells.length));
  const width = (s: string) => editor.stringWidth(s);
  const widths = Array.from({ length: n }, (_, c) => Math.max(...t.rows.map((r) => width(r.cells[c] ?? ""))));
  const numeric = /^[-+]?(\d[\d,_]*\.?\d*|\.\d+)(e[-+]?\d+)?%?$|^(nan|NaN|inf|-inf|None|NaT|…|\.\.\.)$/;
  const line = (r: { cells: string[]; head: boolean }) =>
    widths.map((w, c) => {
      const cell = r.cells[c] ?? "";
      const pad = " ".repeat(w - width(cell));
      return !r.head && numeric.test(cell) ? pad + cell : cell + pad;
    }).join(" │ ");
  const out: OutLine[] = [];
  let headDone = false;
  for (const r of t.rows) {
    if (!r.head && !headDone && out.length) {
      out.push({ text: widths.map((w) => "─".repeat(w)).join("─┼─"), fg: "editor.line_number_fg", clip: true });
      headDone = true;
    }
    out.push({ text: line(r), fg: r.head ? "ui.tab_active_bg" : "editor.fg", clip: true });
  }
  if (t.note) out.push({ text: t.note, fg: "editor.line_number_fg" });
  return out;
}

/** An output's lines: its text in the colour it draws in, or the rows of its image. */
function outputLines(nb: Notebook, o: Output): OutLine[] {
  const join = (v: unknown) => (Array.isArray(v) ? v.join("") : String(v ?? ""));
  const lines = (s: string, fg: string): OutLine[] =>
    s.replace(/\n$/, "").split("\n").map((raw) => {
      const { text, spans } = ansiLine(raw);
      return { text, fg, spans };
    });
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
          const fg = imageFg(img.id);
          return Array.from({ length: img.rows }, (_, row) => ({ text: imageRow(img.cols, row), fg }));
        }
      } else if (image && IMAGES) {
        // JPEG, GIF, SVG: nb makes a PNG of it once; the placeholder line shows meanwhile
        const img = convertedImage(nb, o, image, join(data[image]));
        if (img) {
          const fg = imageFg(img.id);
          return Array.from({ length: img.rows }, (_, row) => ({ text: imageRow(img.cols, row), fg }));
        }
      }
      // a formula (sympy's text/latex: `$\displaystyle …$`), typeset like display math
      if (data["text/latex"] !== undefined && !image) {
        const latex = join(data["text/latex"]).trim().replace(/^\$\$?|\$\$?$/g, "").replace(/^\\displaystyle\s*/, "").trim();
        const img = latex ? formulaImage(nb, latex, "editor.fg") : null;
        if (img) {
          const fg = imageFg(img.id);
          return Array.from({ length: img.rows }, (_, row) => ({ text: imageRow(img.cols, row), fg }));
        }
        if (latex) return [{ text: latexToUnicode(latex), fg: "editor.fg" }];
      }
      const html = data["text/html"] !== undefined ? htmlTable(join(data["text/html"])) : null;
      if (html) return tableLines(html);
      if (image) return [{ text: `▣ ${image}${data["text/plain"] ? "  " + join(data["text/plain"]).split("\n")[0] : ""}`, fg: "syntax.type" }];
      if (data["text/plain"] !== undefined) return lines(join(data["text/plain"]), "editor.fg");
      return [{ text: `[${kinds.join(", ")}]`, fg: "editor.line_number_fg" }];
    }
  }
  return [];
}

/** A markdown cell as rendered text while the cursor is elsewhere (the `# ` prefixes, `#` heading
 *  marks, `**`, backticks and link targets hidden, math as Unicode), its source while editing it:
 *  every conceal is "unless the cursor is in this cell". The styles stay on in both. */
function renderMarkdown(nb: Notebook, buf: number, s: Span, lineAt: Map<number, string>, editing = false): void {
  const scope: [number, number] = [s.start, s.end + 1];
  // a raw string's lines get the margin the code cells have (in the cell's box, its own): ahead of
  // what hides a line's first characters, as anything anchored there hides with them; else on its own
  const margins = new Set(s.quotes && !editing ? s.lineStarts : []);
  const conceal = (start: number, end: number, with_: string) => {
    if (margins.delete(start)) with_ = "   " + with_;
    editor.addConceal(buf, NS_MD, start, end, with_, "unless-cursor-in", scope[0], scope[1]);
  };
  const style = (start: number, end: number, o: Record<string, unknown>) => {
    if (end > start) editor.addOverlay(buf, NS_MD, start, end, o);
  };
  // a $$ … $$ block, on one line or spread over several: typeset by nb under the block (shown
  // while editing it too, as a preview; the source hides once the cursor leaves), else as Unicode
  let display: { latex: string[]; lines: number[] } | null = null;
  const endDisplay = (block: { latex: string[]; lines: number[] }) => {
    const latex = block.latex.join("\n").trim();
    const img = latex ? formulaImage(nb, latex) : null;
    for (const lineStart of block.lines) {
      const raw = mdText(s, lineStart, lineAt);
      const prefix = mdPrefix(s, raw).length;
      const content = raw.slice(prefix);
      const from = lineStart + bytes(raw.slice(0, prefix));
      const to = from + bytes(content);
      const bare = content.trim() === "$$";
      const one = /^\s*\$\$(.+)\$\$\s*$/.exec(content);
      conceal(from, to, img || bare ? "" : "    " + latexToUnicode(one ? one[1] : content));
      style(from, to, { fg: "syntax.number" });
    }
    if (img) {
      const fg = imageFg(img.id);
      const last = block.lines[block.lines.length - 1];
      for (let row = 0; row < img.rows; row++)
        editor.addVirtualLine(buf, last, "    " + imageRow(img.cols, row), { fg }, false, NS_OUT, 10 + row);
    }
  };
  for (const lineStart of s.lineStarts) {
    const raw = mdText(s, lineStart, lineAt);
    const prefix = mdPrefix(s, raw).length;
    const content = raw.slice(prefix);
    const b = (chars: number) => lineStart + bytes(raw.slice(0, prefix + chars));
    const lineEnd = b(content.length);
    // the comment prefix becomes the margin the code cells have, so text lines up with code
    if (prefix) conceal(lineStart, b(0), "   ");
    // prose in the text colour (it's a Python comment underneath)
    style(b(0), lineEnd, { fg: "editor.fg" });
    if (display) {
      display.lines.push(lineStart);
      if (content.trim() === "$$") {
        endDisplay(display);
        display = null;
      } else display.latex.push(content);
      continue;
    }
    if (content.trim() === "$$") {
      display = { latex: [], lines: [lineStart] };
      continue;
    }
    const block = /^\s*\$\$(.+)\$\$\s*$/.exec(content);
    if (block) {
      endDisplay({ latex: [block[1]], lines: [lineStart] });
      continue;
    }
    const heading = /^(#{1,6})\s+/.exec(content);
    if (heading) {
      const level = heading[1].length;
      conceal(b(0), b(heading[0].length), "");
      style(b(heading[0].length), lineEnd, level <= 2 ? { fg: "ui.tab_active_bg", bold: true } : { fg: "editor.fg", bold: true });
      // (not while the cell is edited in its box: the rule would cut it)
      if (level <= 2 && !editing) {
        const rule = level === 1 ? "━" : "─";
        editor.addVirtualLine(buf, lineStart, "   " + rule.repeat(500), { fg: level === 1 ? "ui.tab_active_bg" : "editor.line_number_fg", clip: true }, false, NS_OUT, -3);
      }
      continue;
    }
    if (/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(content)) {
      conceal(b(0), lineEnd, "─".repeat(48));
      style(b(0), lineEnd, { fg: "editor.line_number_fg" });
      continue;
    }
    let from = 0;
    const quote = /^>\s?/.exec(content);
    if (quote) {
      conceal(b(0), b(quote[0].length), "▌ ");
      style(b(0), lineEnd, { fg: "editor.line_number_fg" });
      from = quote[0].length;
    }
    const bullet = /^(\s*)([-*+])\s/.exec(content.slice(from));
    if (bullet) {
      const at = from + bullet[1].length;
      conceal(b(at), b(at + 1), "•");
      style(b(at), b(at + 1), { fg: "ui.tab_active_bg" });
    }
    for (const m of markdownMarks(content)) {
      if (bullet && m.start <= from + bullet[1].length) continue; // the bullet's own *
      if (m.kind === "math") {
        conceal(b(m.start), b(m.end), m.text);
        style(b(m.start), b(m.end), { fg: "syntax.number" });
        continue;
      }
      conceal(b(m.start), b(m.innerStart), "");
      conceal(b(m.innerEnd), b(m.end), "");
      const look: Record<string, unknown> =
        m.kind === "code" ? { fg: "syntax.string", bg: "ui.notebook_cell_bg" }
        : m.kind === "bold" ? { fg: "editor.fg", bold: true }
        : m.kind === "italic" ? { fg: "editor.fg", italic: true }
        : { fg: "ui.tab_active_bg", underline: true };
      style(b(m.innerStart), b(m.innerEnd), look);
    }
  }
  if (display) endDisplay(display); // a block the cell never closes
  for (const p of margins) editor.addVirtualTextStyled(buf, `${NS_PAD}md:${p}`, p, "   ", {}, true);
}

/** Draws the notebook's cells: rules, boxes, outputs, typeset markdown. `cursor`: where the cursor
 *  is going, when the plugin just moved it (the editor's answer lags, and no cursor_moved comes). */
async function decorate(nb: Notebook, cursorAt?: number): Promise<void> {
  const buf = nb.bufferId;
  if (buf === null) return;
  let text = await editor.getBufferText(buf);
  if (fixQuotes(buf, text)) text = await editor.getBufferText(buf);
  const spans = textToCells(text);
  editor.clearVirtualTextNamespace(buf, NS_OUT);
  editor.clearConcealNamespace(buf, NS_RULE);
  editor.clearNamespace(buf, NS_CELL);
  editor.removeVirtualTextsByPrefix(buf, NS_PAD);
  editor.clearConcealNamespace(buf, NS_MD);
  editor.clearNamespace(buf, NS_MD);
  editor.clearFolds(buf);
  nb.spans = spans;
  nb.edited = false;
  const cursor = cursorAt ?? (editor.getActiveBufferId() === buf ? editor.getCursorPosition() : -1);
  nb.cursorCell = markdownCellAt(spans, cursor);
  const typeset = new Map<number, { cell: string; lines: MdLine[]; rowPx: number }>();
  nb.typeset = typeset;
  // the line number of each line start, for the typeset cells' markers
  const lineNo = new Map<number, number>();
  // each line's text by its start (bytes), for the markdown cells
  const lineAt = new Map<number, string>();
  let at = 0;
  for (const line of text.split("\n")) {
    lineNo.set(at, lineNo.size);
    lineAt.set(at, line);
    at += bytes(line) + 1;
  }
  // where a line's text starts on screen: after the hidden `#!` of a magic, which takes whatever is
  // anchored at its first byte with it
  const textStart = (p: number) => (HIDDEN_MAGIC.test(lineAt.get(p) ?? "") ? p + 2 : p);
  spans.forEach((s, i) => {
    const r = nb.runs.get(s.cell.id);
    // the `# %%` line as a quiet rule: cell number, kind, run count and state (herdr's muted
    // overlay tone, the comment colour); the raw line comes back while the cursor is on it
    if (s.markerEnd > s.start) {
      const took = r?.took !== undefined ? ` ${duration(r.took)}` : "";
      const state = !r ? "" : r.state === "busy" ? ` ● running ${duration(Date.now() - (r.startedAt ?? Date.now()))}`
        : r.state === "queued" ? " ○ queued"
        : r.state === "error" ? ` ✗${took}` : r.state === "ok" ? ` ✓${took}` : "";
      const count = s.cell.kind === "code" ? (r?.count != null ? ` [${r.count}]` : " [ ]") : ` ${s.cell.kind}`;
      const label = `── ${i + 1}${count}${state} `;
      editor.addConceal(buf, NS_RULE, s.start, s.markerEnd, label + "─".repeat(Math.max(4, 48 - label.length)),
        "unless-cursor-in", s.start, s.markerEnd + 1);
    }
    // a code cell's source on its own ground, the full width, like a notebook's cell box (the
    // rule above it and the outputs below stay on the editor's)
    // (a markdown cell's source too, while it's being edited)
    const bodyStart = sourceStart(s);
    const boxed = s.cell.kind === "code" || (s.cell.kind === "markdown" && nb.cursorCell === s.cell.id);
    if (boxed && (s.lastEnd > bodyStart || (s.quotes && s.lineStarts.length))) {
      editor.addOverlay(buf, NS_CELL, bodyStart, s.lastEnd, { bg: "ui.notebook_cell_bg", extendToLineEnd: true });
      // half a row of the same ground above and below the source (the half blocks ▄ ▀ in the
      // cell's colour), so the box isn't cut at the text; clipped at the pane's edge, never wrapped
      const band = { fg: "ui.notebook_cell_bg", clip: true };
      editor.addVirtualLine(buf, textStart(bodyStart), "▄".repeat(500), band, true, NS_OUT, -1);
      editor.addVirtualLine(buf, textStart(s.lastLine), "▀".repeat(500), band, false, NS_OUT, -2);
      // and two columns of it before each line
      s.lineStarts.forEach((p, k) =>
        editor.addVirtualTextStyled(buf, `${NS_PAD}${i}:${k}`, textStart(p), "  ", { bg: "ui.notebook_cell_bg" }, true));
    }
    if (s.cell.kind === "markdown") {
      // typeset, unless the cursor is in it (its source then, to edit): the source folds away under
      // the `# %%` rule, the page's rows hang under that
      const md = s.markerEnd > s.start && nb.cursorCell !== s.cell.id ? cellMarkdown(s, lineAt) : null;
      const page = md ? cellPage(nb, s, md.md) : null;
      const last = s.quotes ? s.quotes.closeEnd : s.lastEnd;
      if (md && page && page.tiles.length && last + 1 <= at) {
        // (a fold always shows a mark after its first line: a pencil, the cell is there to edit)
        editor.addFold(buf, s.markerEnd + 1, last + 1, "✎");
        let row = 0;
        for (const img of page.tiles) {
          const fg = imageFg(img.id);
          for (let k = 0; k < img.rows; k++, row++)
            editor.addVirtualLine(buf, s.start, "   " + imageRow(img.cols, k), { fg }, false, NS_OUT, 100 + row);
        }
        typeset.set(lineNo.get(s.start) ?? -1, { cell: s.cell.id, lines: md.lines, rowPx: page.rowPx });
      } else {
        renderMarkdown(nb, buf, s, lineAt, nb.cursorCell === s.cell.id);
        // the raw string's quotes out of sight: its `r"""` line (with nothing after the line above),
        // the `"""` at the end of the last
        const q = s.quotes;
        if (q && q.open > s.markerEnd && q.openEnd + 1 <= at && s.lineStarts[0] > q.openEnd)
          editor.addFold(buf, q.open, q.openEnd + 1, "");
        if (q && q.closeEnd > q.close) editor.addConceal(buf, NS_MD, q.close, q.closeEnd, "");
      }
    }
    if (s.cell.kind === "code") {
      for (const p of s.lineStarts) {
        const line = lineAt.get(p) ?? "";
        if (!HIDDEN_MAGIC.test(line)) continue;
        editor.addConceal(buf, NS_MD, p, p + 2, "", "unless-cursor-in", p, p + bytes(line) + 1);
        editor.addOverlay(buf, NS_MD, p + 2, p + bytes(line), { fg: "syntax.keyword" });
      }
    }
    if (!r || s.cell.kind !== "code") return;
    // long text output is cut (unless expanded); image rows are never (half a plot helps nobody)
    let shown = 0;
    let more = 0;
    const out: OutLine[] = r.outputs.flatMap((o) => outputLines(nb, o)).filter((l) => {
      if (Array.isArray(l.fg) && !l.spans) return true;
      if (r.expanded || shown < MAX_OUTPUT_LINES) return ++shown > 0;
      more++;
      return false;
    });
    if (more) out.push({ text: `… ${more} more lines (Notebook: Expand Output)`, fg: "editor.line_number_fg" });
    if (!out.length) return;
    out.forEach((l, j) =>
      // three columns in, level with the cell's code (its two-column margin plus the inlay space)
      editor.addVirtualLine(buf, textStart(s.lastLine), "   " + l.text, {
        fg: l.fg, gutterGlyph: j === 0 ? "›" : undefined, clip: l.clip,
        // the indent shifts the ranges by its three bytes
        textOverlays: l.spans?.length ? l.spans.map((sp) => ({ ...sp, start: sp.start + 3, end: sp.end + 3 })) : undefined,
      },
        false, NS_OUT, j + 1));
  });
  dropStaleImages();
  dropStalePages();
}

/** Puts a markdown cell's quotes back the way they go after an edit took them out of place: a
 *  Backspace at the start of its text joins the hidden `r"""` line to it, a Delete at its end takes
 *  away a closing quote. Says whether it changed anything. */
function fixQuotes(buf: number, text: string): boolean {
  // what goes where, and whether the cursor there stays before it (on the text)
  const edits: { at: number; insert: string; before: boolean }[] = [];
  for (const s of textToCells(text)) {
    const q = s.quotes;
    if (!q) continue;
    // `r"""text`: the text starts on the quote's line
    const first = s.lineStarts[0];
    if (first !== undefined && first > q.open && first <= q.openEnd) edits.push({ at: first, insert: "\n", before: false });
    const quotes = q.closeEnd - q.close;
    if (quotes < 3) edits.push({ at: q.closeEnd, insert: '"'.repeat(3 - quotes), before: true });
  }
  if (!edits.length) return false;
  const cursor = editor.getActiveBufferId() === buf ? editor.getCursorPosition() : -1;
  // from the end, so the earlier positions stay put
  edits.sort((a, b) => b.at - a.at);
  for (const e of edits) editor.insertText(buf, e.at, e.insert);
  if (cursor >= 0) {
    const shift = edits.filter((e) => e.at < cursor || (e.at === cursor && !e.before)).reduce((n, e) => n + e.insert.length, 0);
    editor.setBufferCursor(buf, cursor + shift);
  }
  return true;
}

/** The id of the markdown cell holding `pos` (its `# %%` line included), if any. */
function markdownCellAt(spans: Span[], pos: number): string | null {
  const s = spans.find((s) => s.start <= pos && pos <= s.end);
  return s?.cell.kind === "markdown" ? s.cell.id : null;
}

// the cursor going into a typeset markdown cell shows its source, and leaving it typesets it
registerHandler("notebook_cursor_moved", (e: { buffer_id: number; old_position: number; new_position: number }) => {
  for (const nb of byCopy.values()) {
    if (nb.bufferId !== e.buffer_id || !nb.spans) continue;
    if (offTheQuotes(nb, e.old_position, e.new_position)) return;
    if (markdownCellAt(nb.spans, e.new_position) !== nb.cursorCell) void decorate(nb);
  }
});

/** The cursor on a markdown cell's hidden quote line goes on, to the text (or out of the cell, the
 *  way it was going). Says whether it moved it. */
function offTheQuotes(nb: Notebook, from: number, to: number): boolean {
  // (the spans are the last redraw's: an edit since moves the text, and the redraw follows it)
  if (nb.bufferId === null || nb.edited) return false;
  const s = nb.spans?.find((s) => s.quotes && s.quotes.open <= to && to <= s.quotes.closeEnd);
  const q = s?.quotes;
  if (!s || !q) return false;
  let at = -1;
  // on the `r"""` line: up, to the `# %%` line; down, to the text
  if (to <= q.openEnd && s.lineStarts[0] > q.openEnd) at = from > to ? s.markerEnd : s.lineStarts[0];
  // past the text, on the closing quotes: back to the end of the text
  else if (to > q.close) at = q.close;
  if (at < 0 || at === to) return false;
  editor.setBufferCursor(nb.bufferId, at);
  return true;
}
editor.on("cursor_moved", "notebook_cursor_moved");

// a click on a typeset cell: the cursor goes to the markdown under it
registerHandler("notebook_page_click", async (e: MouseClickHookArgs) => {
  if (e.button !== "left" || e.virtual_row === null || e.buffer_row === null) return;
  const nb = [...byCopy.values()].find((n) => n.bufferId === e.buffer_id);
  const hit = nb?.typeset?.get(e.buffer_row);
  if (!nb || !hit) return;
  const [cw] = cellPixels();
  const r = await ask(nb, "mdjump", {
    id: `cell:${hit.cell}`,
    x: Math.max(0, (e.virtual_col ?? 3) - 3 + 0.5) * cw * PAGE_DENSITY,
    y: (e.virtual_row + 0.5) * hit.rowPx,
  });
  const offset = typeof r.offset === "number" ? r.offset : 0;
  let line = hit.lines[0];
  for (const l of hit.lines) if (l.md <= offset) line = l;
  if (!line || nb.bufferId === null) return;
  editor.setBufferCursor(nb.bufferId, line.buf + offset - line.md);
});
editor.on("mouse_click", "notebook_page_click");

// ── opening, saving, closing ─────────────────────────────────────────

/** Shows the working copy; its own after_file_open (below) then closes the .ipynb's JSON view — in
 *  that order, so the editor never has no file open for a moment (it would open and focus the file
 *  explorer). */
function showCopy(nb: Notebook, jsonBuffer: number): void {
  nb.jsonBuffer = jsonBuffer;
  editor.openFile(nb.copy);
}

/** The working copy is open in `buffer`: set it up as the notebook's view. */
function copyOpened(nb: Notebook, buffer: number): void {
  nb.bufferId = buffer;
  // the tab is the notebook's, not its working copy's (name.ipynb.py)
  editor.setBufferTabLabel(buffer, nb.ipynb.split(/[\\/]/).pop() ?? nb.ipynb);
  editor.setLineNumbersDefault(buffer, false);
  // the kernel's completions, asked at once after a `.`
  editor.registerCompletionSource(buffer, ".");
  showKernel(nb);
  if (nb.jsonBuffer !== null) editor.closeBuffer(nb.jsonBuffer, true);
  nb.jsonBuffer = null;
  followMode();
}

registerHandler("notebook_after_open", async (e: { path: string; buffer_id: number }) => {
  const copyOf = byCopy.get(e.path);
  if (copyOf) {
    copyOpened(copyOf, e.buffer_id);
    await decorate(copyOf);
    return;
  }
  // a working copy the editor brought back by itself (its session, or crash recovery with the
  // unsaved edits): attach it to its notebook as it is, and start the notebook's nb
  const restoredOf = notebookOfCopy(e.path);
  if (restoredOf) {
    const nb = byIpynb.get(restoredOf) ?? start(restoredOf);
    byIpynb.set(restoredOf, nb);
    byCopy.set(e.path, nb);
    nb.copy = e.path;
    const opened = await ask(nb, "open");
    if (opened.ok) {
      for (const [id, r] of Object.entries(opened.runs as Record<string, { execution_count: number | null; outputs: Output[] }>)) {
        if (!nb.runs.has(id)) nb.runs.set(id, { count: r.execution_count, outputs: r.outputs, state: "idle" });
      }
    }
    copyOpened(nb, e.buffer_id);
    await decorate(nb);
    return;
  }
  if (e.path.toLowerCase().endsWith(".ipynb")) await openNotebook(e.path, e.buffer_id);
});

/** A notebook's JSON is showing in `jsonBuffer` (opened, or previewed from the explorer): show its
 *  cells instead, starting its nb the first time. */
async function openNotebook(path: string, jsonBuffer: number): Promise<void> {
  const known = byIpynb.get(path);
  if (known) {
    if (known.bufferId !== null) {
      // its working copy is open already: show that, drop the JSON view
      editor.openFile(known.copy);
      editor.closeBuffer(jsonBuffer, true);
    } else {
      // still opening: the JSON view goes once the copy is up
      known.jsonBuffer = jsonBuffer;
    }
    return;
  }
  editor.setStatus(`notebook: opening ${editor.pathBasename(path)}…`);
  const nb = start(path);
  byIpynb.set(path, nb);
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
  showCopy(nb, nb.jsonBuffer ?? jsonBuffer);
  editor.setStatus(`${editor.pathBasename(path)} · Shift/Alt+Enter runs a cell · saving writes the notebook`);
}
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
    editor.setBufferCursor(nb.bufferId!, sourceStart(next));
    await decorate(nb, sourceStart(next));
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

// ── the kernel's completions and docs ────────────────────────────────

/** The code cell at a byte position of the working copy: its source up to there and after. */
async function codeAt(nb: Notebook, position: number): Promise<{ before: string; code: string } | null> {
  const spans = textToCells(await editor.getBufferText(nb.bufferId!));
  const s = spans.find((s, k) => position >= s.start && (k === spans.length - 1 || position < spans[k + 1].start));
  if (!s || s.cell.kind !== "code") return null;
  const bodyStart = s.markerEnd > s.start ? s.markerEnd + 1 : s.start;
  if (position < bodyStart) return null;
  const before = await editor.getBufferText(nb.bufferId!, bodyStart, position);
  const after = await editor.getBufferText(nb.bufferId!, position, Math.max(position, s.end));
  return { before, code: before + after };
}

const KINDS: Record<string, string> = {
  function: "function", method: "function", instance: "variable", statement: "variable",
  module: "module", class: "class", keyword: "keyword", param: "property", property: "property",
};

registerHandler("notebook_complete", async (e: { buffer_id: number; request_id: number; position: number }) => {
  const nb = [...byCopy.values()].find((n) => n.bufferId === e.buffer_id);
  const items: PluginCompletionItem[] = [];
  const at = nb ? await codeAt(nb, e.position) : null;
  if (nb && at) {
    const cursor = Array.from(at.before).length;
    const r = await ask(nb, "complete", { code: at.code, cursor });
    // the editor replaces the word before the cursor; the kernel says what it replaces (a dotted
    // name, say): keep the part of each match from the word on
    const word = /[\p{L}\p{N}_]*$/u.exec(at.before)![0];
    const chars = Array.from(at.code);
    const from = cursor - Array.from(word).length;
    const start = Number(r.start ?? cursor);
    const lead = chars.slice(start, from).join("");
    const seen = new Set<string>();
    for (const m of (r.matches ?? []) as { text: string; type?: string; signature?: string }[]) {
      if (start > from || !m.text.startsWith(lead)) continue;
      const label = m.text.slice(lead.length);
      if (!label || seen.has(label)) continue;
      seen.add(label);
      // IPython says "<unknown>" for what it didn't evaluate: no detail then
      const type = m.type && m.type !== "<unknown>" ? m.type : undefined;
      items.push({ label, kind: type ? KINDS[type] : undefined, detail: m.signature || type });
    }
  }
  editor.supplyCompletions(e.request_id, items);
});
editor.on("completion_requested", "notebook_complete");

registerHandler("notebook_docs", async () => {
  const nb = active();
  if (!nb) return;
  const at = await codeAt(nb, editor.getCursorPosition());
  if (!at) {
    editor.setStatus("notebook: put the cursor on a name in a code cell");
    return;
  }
  const r = await ask(nb, "inspect", { code: at.code, cursor: Array.from(at.before).length });
  if (!r.ok || !r.found) {
    editor.setStatus(`notebook: ${r.ok ? "the kernel knows nothing about this name" : r.message}`);
    return;
  }
  const lines = String(r.text).replace(/\s+$/, "").split("\n");
  const message = lines.slice(0, 40).join("\n") + (lines.length > 40 ? "\n…" : "");
  editor.showActionPopup({
    id: "notebook-docs",
    title: "Documentation",
    message,
    actions: [{ id: "close", label: "Close" }],
    buffer_id: nb.bufferId ?? undefined,
  });
});
editor.registerCommand("Notebook: Show Documentation", "The kernel's signature and docstring for the name at the cursor", "notebook_docs", "notebook");

// ── choosing the kernel ──────────────────────────────────────────────

type KernelOption = { python?: string; kernel?: string; label: string; detail?: string; current: boolean };
let kernelOptions: { nb: Notebook; options: KernelOption[] } | null = null;

registerHandler("notebook_select_kernel", async () => {
  const nb = active();
  if (!nb) return;
  const r = await ask(nb, "kernels");
  if (!r.ok) {
    editor.setStatus(`notebook: ${r.message}`);
    return;
  }
  const options = r.options as KernelOption[];
  kernelOptions = { nb, options };
  editor.startPrompt("Kernel (or a python's path): ", "notebook-kernel");
  editor.setPromptSuggestions(
    options.map((o, i) => ({
      id: String(i),
      text: o.python ? shortKernelName(o.python) : o.label,
      description: (o.current ? "● current  " : "") + (o.python ?? o.detail ?? ""),
      value: String(i),
    })),
    Math.max(0, options.findIndex((o) => o.current)),
  );
});

registerHandler("notebook_kernel_chosen", async (e: { prompt_type: string; input: string; selected_index: number | null }) => {
  if (e.prompt_type !== "notebook-kernel" || !kernelOptions) return;
  const { nb, options } = kernelOptions;
  kernelOptions = null;
  const picked = /^\d+$/.test(e.input) ? options[Number(e.input)] : undefined;
  const choice: Choice = picked
    ? picked.python ? { python: picked.python } : { kernel: picked.kernel }
    : { python: e.input.trim() };
  if (!choice.python && !choice.kernel) return;
  const r = await ask(nb, "select", choice);
  if (!r.ok) {
    editor.setStatus(`notebook: ${r.message}`);
    return;
  }
  rememberKernel(nb.ipynb, choice);
  for (const run of nb.runs.values()) if (run.state === "busy" || run.state === "queued") run.state = "error";
  editor.setStatus(`notebook: ${r.name}; the next run starts it`);
  await decorate(nb);
});
editor.on("prompt_confirmed", "notebook_kernel_chosen");
editor.registerCommand("Notebook: Select Kernel", "Choose the venv or Jupyter kernel this notebook runs on (remembered)", "notebook_select_kernel", "notebook");

// ── cell commands ────────────────────────────────────────────────────

/** Replaces the buffer's text with `next`, as one edit of the part that differs (so the cursor,
 *  undo and the decorations elsewhere stay as they were). */
function replaceText(buf: number, prev: string, next: string): void {
  let a = 0;
  while (a < prev.length && a < next.length && prev[a] === next[a]) a++;
  let b = 0;
  while (b < prev.length - a && b < next.length - a && prev[prev.length - 1 - b] === next[next.length - 1 - b]) b++;
  const from = bytes(prev.slice(0, a));
  const to = from + bytes(prev.slice(a, prev.length - b));
  if (to > from) editor.deleteRange(buf, from, to);
  const insert = next.slice(a, next.length - b);
  if (insert) editor.insertText(buf, from, insert);
}

/** The cells, the index of the one under the cursor, and how far into its source the cursor is
 *  (characters of the source as written in the working copy). */
async function cellsAtCursor(nb: Notebook): Promise<{ text: string; spans: Span[]; i: number; offset: number }> {
  const spans = await cellsWithIds(nb);
  const text = await editor.getBufferText(nb.bufferId!);
  const cursor = editor.getCursorPosition();
  const i = Math.max(0, spans.findIndex((s, k) => cursor >= s.start && (k === spans.length - 1 || cursor < spans[k + 1].start)));
  const s = spans[i];
  const bodyStart = s ? sourceStart(s) : 0;
  const shown = s && cursor > bodyStart ? await editor.getBufferText(nb.bufferId!, bodyStart, cursor) : "";
  // where that is in the cell's source (a comment-form markdown cell's `# `s aren't in it)
  let offset = shown.length;
  if (s && s.cell.kind !== "code" && !s.quotes) {
    const lines = shown.split("\n");
    const src = s.cell.source.split("\n");
    const col = lines[lines.length - 1];
    const k = lines.length - 1;
    offset = src.slice(0, k).reduce((n, l) => n + l.length + 1, 0) + Math.max(0, col.length - (/^# ?/.exec(col)?.[0].length ?? 0));
  }
  return { text, spans, i, offset };
}

/** Rewrites the cells (`edit` changes the list and says which cell the cursor goes to), puts the
 *  cursor at the start of that cell's source, and redraws. */
async function editCells(edit: (cells: Cell[], i: number, offset: number) => number | null): Promise<void> {
  const nb = active();
  if (!nb) return;
  const { text, spans, i, offset } = await cellsAtCursor(nb);
  const cells = spans.map((s) => ({ ...s.cell }));
  const target = edit(cells, i, offset);
  if (target === null) return;
  if (cells.length === 0) cells.push({ id: newId(), kind: "code", source: "" });
  const next = cellsToText(cells);
  replaceText(nb.bufferId!, text, next);
  const at = textToCells(next)[Math.max(0, Math.min(target, cells.length - 1))];
  if (at) editor.setBufferCursor(nb.bufferId!, sourceStart(at));
  await decorate(nb, at ? sourceStart(at) : undefined);
}

const blank = (kind = "code"): Cell => ({ id: newId(), kind, source: "" });

registerHandler("notebook_insert_below", () => editCells((cells, i) => (cells.splice(i + 1, 0, blank()), i + 1)));
registerHandler("notebook_insert_above", () => editCells((cells, i) => (cells.splice(i, 0, blank()), i)));
registerHandler("notebook_insert_markdown_below", () =>
  editCells((cells, i) => (cells.splice(i + 1, 0, blank("markdown")), i + 1)));
registerHandler("notebook_delete_cell", () => editCells((cells, i) => (cells.splice(i, 1), Math.min(i, cells.length - 1))));
registerHandler("notebook_move_up", () =>
  editCells((cells, i) => (i === 0 ? null : (([cells[i - 1], cells[i]] = [cells[i], cells[i - 1]]), i - 1))));
registerHandler("notebook_move_down", () =>
  editCells((cells, i) => (i >= cells.length - 1 ? null : (([cells[i], cells[i + 1]] = [cells[i + 1], cells[i]]), i + 1))));
registerHandler("notebook_split", () =>
  editCells((cells, i, offset) => {
    const c = cells[i];
    // (a markdown cell splits at the start of the cursor's line)
    let at = offset;
    if (c.kind !== "code") at = c.source.slice(0, offset).lastIndexOf("\n") + 1;
    const before = c.source.slice(0, at).replace(/\n$/, "");
    const after = c.source.slice(at).replace(/^\n/, "");
    if (!before.trim() || !after.trim()) return null;
    cells.splice(i, 1, { ...c, source: before }, { id: newId(), kind: c.kind, source: after });
    return i + 1;
  }));
registerHandler("notebook_merge_below", () =>
  editCells((cells, i) => {
    if (i >= cells.length - 1) return null;
    const [a, b] = [cells[i], cells[i + 1]];
    cells.splice(i, 2, { ...a, source: [a.source, b.source].filter((s) => s !== "").join("\n") });
    return i;
  }));
registerHandler("notebook_to_markdown", () =>
  editCells((cells, i) => (cells[i].kind === "markdown" ? null : ((cells[i] = { ...cells[i], kind: "markdown" }), i))));
registerHandler("notebook_to_code", () =>
  editCells((cells, i) => (cells[i].kind === "code" ? null : ((cells[i] = { ...cells[i], kind: "code" }), i))));

/** Clears outputs and run counts (in nb too, so saving writes them empty). */
async function clearOutputs(all: boolean): Promise<void> {
  const nb = active();
  if (!nb) return;
  const { spans, i } = await cellsAtCursor(nb);
  const ids = (all ? spans : spans.slice(i, i + 1)).map((s) => s.cell.id);
  const r = await ask(nb, "clear", { cells: ids });
  if (!r.ok) {
    editor.setStatus(`notebook: ${r.message}`);
    return;
  }
  for (const id of ids) nb.runs.delete(id);
  await decorate(nb);
}
registerHandler("notebook_clear_output", () => clearOutputs(false));
registerHandler("notebook_clear_all", () => clearOutputs(true));

registerHandler("notebook_expand_output", async () => {
  const nb = active();
  if (!nb) return;
  const { spans, i } = await cellsAtCursor(nb);
  const r = spans[i] && nb.runs.get(spans[i].cell.id);
  if (!r) return;
  r.expanded = !r.expanded;
  await decorate(nb);
});

registerHandler("notebook_run_above", async () => {
  const nb = active();
  if (!nb) return;
  const { spans, i } = await cellsAtCursor(nb);
  await runCells(nb, spans.slice(0, i));
});
registerHandler("notebook_run_below", async () => {
  const nb = active();
  if (!nb) return;
  const { spans, i } = await cellsAtCursor(nb);
  await runCells(nb, spans.slice(i));
});
registerHandler("notebook_restart_run_all", async () => {
  const nb = active();
  if (!nb) return;
  await ask(nb, "restart");
  for (const r of nb.runs.values()) if (r.state === "busy" || r.state === "queued") r.state = "error";
  await runCells(nb, await cellsWithIds(nb));
});

for (const [name, what, handler] of [
  ["Insert Cell Below", "A new code cell after this one", "notebook_insert_below"],
  ["Insert Cell Above", "A new code cell before this one", "notebook_insert_above"],
  ["Insert Markdown Cell Below", "A new markdown cell after this one", "notebook_insert_markdown_below"],
  ["Delete Cell", "Remove the cell under the cursor (Ctrl+Z brings it back)", "notebook_delete_cell"],
  ["Move Cell Up", "Swap this cell with the one above (Alt+Shift+Up)", "notebook_move_up"],
  ["Move Cell Down", "Swap this cell with the one below (Alt+Shift+Down)", "notebook_move_down"],
  ["Split Cell", "Split this cell in two at the cursor", "notebook_split"],
  ["Merge Cell Below", "Join the next cell onto this one", "notebook_merge_below"],
  ["Change Cell to Markdown", "This cell becomes a markdown cell", "notebook_to_markdown"],
  ["Change Cell to Code", "This cell becomes a code cell", "notebook_to_code"],
  ["Clear Cell Output", "Remove this cell's outputs and run count", "notebook_clear_output"],
  ["Clear All Outputs", "Remove every cell's outputs and run counts", "notebook_clear_all"],
  ["Expand Output", "Show all of this cell's output, or cut it at 40 lines again", "notebook_expand_output"],
  ["Run Cells Above", "Run every code cell before this one", "notebook_run_above"],
  ["Run Cell and Below", "Run this cell and every one after it", "notebook_run_below"],
  ["Restart and Run All", "A fresh kernel, then every code cell from the top", "notebook_restart_run_all"],
]) editor.registerCommand(`Notebook: ${name}`, what, handler, "notebook");

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
  ["M-k", "notebook_docs"],
  ["M-S-Up", "notebook_move_up"],
  ["M-S-Down", "notebook_move_down"],
], false);

function followMode(): void {
  const nb = active();
  editor.setContext("notebook", nb !== null);
  const mode = editor.getEditorMode();
  if (nb && mode == null && editor.getInputMode() == null) editor.setEditorMode("notebook");
  else if (!nb && mode === "notebook") editor.setEditorMode(null);
}
registerHandler("notebook_mode_follow", () => {
  followMode();
  // a notebook previewed from the explorer fires no after_file_open: its JSON tab coming to the
  // front is the cue
  const id = editor.getActiveBufferId();
  const path = id ? editor.getBufferPath(id) : "";
  if (path && path.toLowerCase().endsWith(".ipynb")) void openNotebook(path, id);
});
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
  for (const nb of byCopy.values()) {
    if (nb.bufferId === e.buffer_id) {
      nb.edited = true;
      if (pending) return;
      pending = true;
      editor.setTimeout(150, "notebook_redraw");
      return;
    }
  }
});
editor.on("buffer_modified", "notebook_on_modified");
