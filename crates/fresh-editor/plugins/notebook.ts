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
// Palette: "Notebook: Run All", "Notebook: Restart Kernel".

const editor = getEditor();

const NB_COMMAND = editor.defineConfigString("nbCommand", {
  default: "nb",
  description: "The nb program that runs notebook kernels (herdr-wr's nb). A path, or a name on PATH.",
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
        r.state = e.status === "ok" ? "ok" : "error";
        if (typeof e.execution_count === "number") r.count = e.execution_count;
      }
      break;
    case "error":
      editor.setStatus(`notebook: ${String(e.message).split("\n")[0]}`);
      if (cell) run(nb, cell).state = "error";
      break;
  }
  void decorate(nb);
}

// ── drawing ──────────────────────────────────────────────────────────

/** An output's text, as lines, with the colour it draws in. */
function outputLines(o: Output): { text: string; fg: string }[] {
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
    let out: { text: string; fg: string }[] = r.outputs.flatMap(outputLines);
    if (out.length > MAX_OUTPUT_LINES) {
      const more = out.length - MAX_OUTPUT_LINES;
      out = out.slice(0, MAX_OUTPUT_LINES).concat([{ text: `… ${more} more lines`, fg: "editor.line_number_fg" }]);
    }
    out.forEach((l, j) =>
      editor.addVirtualLine(buf, s.lastLine, "  " + l.text, { fg: l.fg, gutterGlyph: j === 0 ? "›" : undefined },
        false, NS_OUT, j));
  });
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
