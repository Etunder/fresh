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
const NS_CELL = "notebook-cell";
const NS_PAD = "notebook-pad:";
const NS_MD = "notebook-md";

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
};

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
      };
    } else if (current) {
      current.body.push(line);
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
  return { id, cols, rows };
}

/** The colour an image's placeholders are drawn in: its id. */
function imageFg(img: Image): [number, number, number] {
  return [(img.id >> 16) & 0xff, (img.id >> 8) & 0xff, img.id & 0xff];
}

/** Display math typeset by nb (Typst), by formula and colour: the image once it's there, or
 *  "pending" / "failed" (the Unicode text shows meanwhile, or for good). Kept for the session. */
const formulas = new Map<string, Image | "pending" | "failed">();

/** The typeset image of a formula, or null while it's on its way (the notebook is redrawn when it
 *  comes) or if Typst can't make it out. */
function formulaImage(nb: Notebook, latex: string): Image | null {
  if (!IMAGES) return null;
  const color = themeHex("syntax.number", "#ff9e64");
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

/** A theme colour as `#rrggbb`, from the current theme's data; `fallback` if it can't be read. */
function themeHex(key: string, fallback: string): string {
  const name = String(editor.getConfig().theme ?? "");
  const data = (editor.getThemeData(name) ?? editor.getThemeData(name.toLowerCase())) as Record<string, unknown> | null;
  const [section, field] = key.split(".");
  const v = (data?.[section] as Record<string, unknown> | undefined)?.[field];
  if (!Array.isArray(v) || v.length !== 3) return fallback;
  return "#" + v.map((c) => Math.max(0, Math.min(255, Number(c))).toString(16).padStart(2, "0")).join("");
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
type OutLine = { text: string; fg: string | [number, number, number]; clip?: boolean };

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
          const fg = imageFg(img);
          return Array.from({ length: img.rows }, (_, row) => ({ text: imageRow(img, row), fg }));
        }
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
function renderMarkdown(nb: Notebook, buf: number, s: Span, lineAt: Map<number, string>): void {
  const scope: [number, number] = [s.start, s.end + 1];
  const conceal = (start: number, end: number, with_: string) =>
    editor.addConceal(buf, NS_MD, start, end, with_, "unless-cursor-in", scope[0], scope[1]);
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
      const raw = lineAt.get(lineStart) ?? "";
      const prefix = /^# ?/.exec(raw)?.[0].length ?? 0;
      const content = raw.slice(prefix);
      const from = lineStart + bytes(raw.slice(0, prefix));
      const to = from + bytes(content);
      const bare = content.trim() === "$$";
      const one = /^\s*\$\$(.+)\$\$\s*$/.exec(content);
      conceal(from, to, img || bare ? "" : "    " + latexToUnicode(one ? one[1] : content));
      style(from, to, { fg: "syntax.number" });
    }
    if (img) {
      const fg = imageFg(img);
      const last = block.lines[block.lines.length - 1];
      for (let row = 0; row < img.rows; row++)
        editor.addVirtualLine(buf, last, "    " + imageRow(img, row), { fg }, false, NS_OUT, 10 + row);
    }
  };
  for (const lineStart of s.lineStarts) {
    const raw = lineAt.get(lineStart) ?? "";
    const prefix = /^# ?/.exec(raw)?.[0].length ?? 0;
    const content = raw.slice(prefix);
    const b = (chars: number) => lineStart + bytes(raw.slice(0, prefix + chars));
    const lineEnd = b(content.length);
    // the comment prefix becomes the margin the code cells have, so text lines up with code
    conceal(lineStart, b(0), "   ");
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
      if (level <= 2) {
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
}

async function decorate(nb: Notebook): Promise<void> {
  const buf = nb.bufferId;
  if (buf === null) return;
  const text = await editor.getBufferText(buf);
  const spans = textToCells(text);
  editor.clearVirtualTextNamespace(buf, NS_OUT);
  editor.clearConcealNamespace(buf, NS_RULE);
  editor.clearNamespace(buf, NS_CELL);
  editor.removeVirtualTextsByPrefix(buf, NS_PAD);
  editor.clearConcealNamespace(buf, NS_MD);
  editor.clearNamespace(buf, NS_MD);
  // each line's text by its start (bytes), for the markdown cells
  const lineAt = new Map<number, string>();
  let at = 0;
  for (const line of text.split("\n")) {
    lineAt.set(at, line);
    at += bytes(line) + 1;
  }
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
    // a code cell's source on its own ground, the full width, like a notebook's cell box (the
    // rule above it and the outputs below stay on the editor's)
    const bodyStart = s.markerEnd > s.start ? s.markerEnd + 1 : s.start;
    if (s.cell.kind === "code" && s.lastEnd > bodyStart) {
      editor.addOverlay(buf, NS_CELL, bodyStart, s.lastEnd, { bg: "ui.notebook_cell_bg", extendToLineEnd: true });
      // half a row of the same ground above and below the source (the half blocks ▄ ▀ in the
      // cell's colour), so the box isn't cut at the text; clipped at the pane's edge, never wrapped
      const band = { fg: "ui.notebook_cell_bg", clip: true };
      editor.addVirtualLine(buf, bodyStart, "▄".repeat(500), band, true, NS_OUT, -1);
      editor.addVirtualLine(buf, s.lastLine, "▀".repeat(500), band, false, NS_OUT, -2);
      // and two columns of it before each line
      s.lineStarts.forEach((p, k) =>
        editor.addVirtualTextStyled(buf, `${NS_PAD}${i}:${k}`, p, "  ", { bg: "ui.notebook_cell_bg" }, true));
    }
    if (s.cell.kind === "markdown") renderMarkdown(nb, buf, s, lineAt);
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
    if (!out.length) return;
    out.forEach((l, j) =>
      // three columns in, level with the cell's code (its two-column margin plus the inlay space)
      editor.addVirtualLine(buf, s.lastLine, "   " + l.text, { fg: l.fg, gutterGlyph: j === 0 ? "›" : undefined, clip: l.clip },
        false, NS_OUT, j + 1));
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

/** The working copy is open in `buffer`: set it up as the notebook's view. */
function copyOpened(nb: Notebook, buffer: number): void {
  nb.bufferId = buffer;
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
  const bodyStart = s ? (s.markerEnd > s.start ? s.markerEnd + 1 : s.start) : 0;
  const offset = s && cursor > bodyStart ? (await editor.getBufferText(nb.bufferId!, bodyStart, cursor)).length : 0;
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
  if (at) editor.setBufferCursor(nb.bufferId!, at.markerEnd > at.start ? Math.min(at.markerEnd + 1, at.end) : at.start);
  await decorate(nb);
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
    // a markdown cell's source is shown with `# ` before each line: split it at the cursor's line
    let at = offset;
    if (c.kind !== "code") {
      const shown = c.source.split("\n").map((l) => (l.length ? "# " + l : "#"));
      let line = 0, n = 0;
      while (line < shown.length && n + shown[line].length < offset) n += shown[line++].length + 1;
      at = c.source.split("\n").slice(0, line).reduce((k, l) => k + l.length + 1, 0);
    }
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
