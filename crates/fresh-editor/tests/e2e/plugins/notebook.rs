//! The notebook plugin: a .ipynb opens as its cells, Alt+Enter runs one, saving writes the cells
//! back — all through `nb serve`, played here by a small Python stand-in that speaks the same
//! protocol (JSON-line events on stdout, GET requests with the request JSON in a file), so the
//! test needs neither nb nor a Jupyter kernel.

#![cfg(unix)]

use crate::common::harness::{copy_plugin, copy_plugin_lib, EditorTestHarness};
use crossterm::event::{KeyCode, KeyModifiers};
use fresh::config::{Config, PluginConfig, StatusBarElement};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

const NOTEBOOK: &str = r##"{
 "cells": [
  {"cell_type": "markdown", "id": "intro", "metadata": {}, "source": ["# Report"]},
  {"cell_type": "code", "execution_count": null, "id": "hello", "metadata": {}, "outputs": [],
   "source": ["print('hello')"]}
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 5
}
"##;

/// `nb serve` as far as the plugin can tell: `ready`, then `open`/`run`/`save`/`shutdown`.
const FAKE_NB: &str = r#"#!/usr/bin/env python3
import http.server, json, os, sys, urllib.parse, uuid

notebook = sys.argv[2]
# an 80x48 px PNG: 10x3 cells at herdr's 8x16
PNG = "iVBORw0KGgoAAAANSUhEUgAAAFAAAAAwCAIAAAAJh2qgAAAAUklEQVR4nO3PAQkAMAzAsEmbf1O/jEMfqIBmzu5XzfMDYGBgYGBg4G8CrgdcD7gecD3gesD1gOsB1wOuB1wPuB5wPeB6wPWA6wHXA64HXA+43gUuHnJLsVlJ8gAAAABJRU5ErkJggg=="
saved = os.path.join(os.path.dirname(notebook), "saved.json")
token = uuid.uuid4().hex
count = [0]
waiting = []

def emit(event):
    print(json.dumps(event), flush=True)

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(url.query)
        body = {"ok": True}
        if q.get("token", [""])[0] != token:
            body = {"ok": False, "message": "bad token"}
        else:
            req = None
            if "req" in q:
                with open(q["req"][0]) as f:
                    req = json.load(f)
                os.remove(q["req"][0])
            if url.path == "/open":
                with open(notebook) as f:
                    nb = json.load(f)
                body["cells"] = [{"id": c["id"], "kind": c["cell_type"], "source": "".join(c["source"])}
                                 for c in nb["cells"]]
                body["language"] = "python"
                # the outputs saved in the notebook, as nb gives them
                body["runs"] = {c["id"]: {"execution_count": c.get("execution_count"), "outputs": c["outputs"]}
                                for c in nb["cells"] if c.get("outputs")}
            elif url.path == "/input":
                cell = waiting.pop()
                emit({"event": "output", "cell": cell,
                      "output": {"output_type": "stream", "name": "stdout", "text": "hi " + req["value"] + "\n"}})
                emit({"event": "done", "cell": cell, "status": "ok", "execution_count": count[0]})
            elif url.path == "/run" and req["code"].startswith("ask"):
                count[0] += 1
                emit({"event": "busy", "cell": req["cell"]})
                waiting.append(req["cell"])
                emit({"event": "input", "cell": req["cell"], "prompt": "name? ", "password": False})
            elif url.path == "/run":
                count[0] += 1
                if count[0] == 1:
                    emit({"event": "kernel", "state": "starting", "name": "/work/repo/.venv/bin/python"})
                    emit({"event": "kernel", "state": "ready"})
                emit({"event": "busy", "cell": req["cell"]})
                if req["code"].startswith("svg"):
                    emit({"event": "output", "cell": req["cell"],
                          "output": {"output_type": "display_data", "metadata": {},
                                     "data": {"image/svg+xml": "<svg xmlns='http://www.w3.org/2000/svg'/>", "text/plain": "<Figure>"}}})
                elif req["code"].startswith("sym"):
                    emit({"event": "output", "cell": req["cell"],
                          "output": {"output_type": "execute_result", "execution_count": count[0], "metadata": {},
                                     "data": {"text/plain": "x**2 + 1", "text/latex": "$\\displaystyle x^{2} + 1$"}}})
                elif req["code"].startswith("noisy"):
                    # in pieces, as a kernel sends them: the bar's redraws one by one
                    pieces = ["\x1b[31mfailed\x1b[0m twice\n"] + [f"\r{p}%" for p in (10, 50, 100)] + ["\n"]
                    pieces.append("".join(f"line {k}\n" for k in range(50)))
                    for text in pieces:
                        emit({"event": "output", "cell": req["cell"],
                              "output": {"output_type": "stream", "name": "stdout", "text": text}})
                elif req["code"].startswith("fig"):
                    fig = {"data": [{"type": "scatter", "y": [1, 3]}, {"type": "bar", "y": [2, 1]}],
                           "layout": {"title": {"text": "Returns"}}}
                    emit({"event": "output", "cell": req["cell"],
                          "output": {"output_type": "display_data", "metadata": {},
                                     "data": {"application/vnd.plotly.v1+json": fig, "text/html": "<div>plot</div>",
                                              "text/plain": "Figure({...})"}}})
                elif req["code"].startswith("table"):
                    emit({"event": "output", "cell": req["cell"],
                          "output": {"output_type": "execute_result", "execution_count": count[0], "metadata": {},
                                     "data": {"text/plain": "   fund  ret\n0  Alpha  1.5", "text/html":
                                              '<div><style scoped>.dataframe {}</style><table border="1" class="dataframe">'
                                              '<thead><tr style="text-align: right;"><th></th><th>fund</th><th>return</th></tr></thead>'
                                              '<tbody><tr><th>0</th><td>Alpha &amp; Co</td><td>1.5</td></tr>'
                                              '<tr><th>1</th><td>Beta</td><td>-12.25</td></tr></tbody></table>'
                                              '<p>2 rows × 2 columns</p></div>'}}})
                elif req["code"].startswith("plot"):
                    emit({"event": "output", "cell": req["cell"],
                          "output": {"output_type": "display_data", "metadata": {},
                                     "data": {"image/png": PNG, "text/plain": "<Figure 80x48>"}}})
                else:
                    emit({"event": "output", "cell": req["cell"],
                          "output": {"output_type": "stream", "name": "stdout", "text": "ran: " + req["code"] + "\n"}})
                emit({"event": "done", "cell": req["cell"], "status": "ok", "execution_count": count[0]})
            elif url.path == "/math":
                with open(os.path.join(os.path.dirname(notebook), "math.json"), "w") as f:
                    json.dump(req, f)
                body.update({"png": PNG, "width": 80, "height": 48})
            elif url.path == "/complete":
                with open(os.path.join(os.path.dirname(notebook), "complete.json"), "w") as f:
                    json.dump(req, f)
                code, cursor = req["code"], req["cursor"]
                if code[:cursor].endswith("os."):
                    body.update({"matches": [{"text": "path", "type": "module"}, {"text": "pardir", "type": "instance"}],
                                 "start": cursor, "end": cursor})
                else:
                    # a qualified match, as IPython sends without jedi, and a typed one
                    body.update({"matches": [{"text": "fruit_basket", "type": "instance", "signature": ""},
                                             {"text": "fruit_salad", "type": "class"}],
                                 "start": cursor - 3, "end": cursor})
            elif url.path == "/inspect":
                body.update({"found": True, "text": "Signature: len(obj, /)\nDocstring: Return the number of items in a container."})
            elif url.path == "/kernels":
                body.update({"current": "/work/.venv/bin/python", "options": [
                    {"python": "/work/.venv/bin/python", "label": "/work/.venv/bin/python", "current": True},
                    {"kernel": "other", "label": "Other Kernel", "detail": "/usr/bin/python3", "current": False}]})
            elif url.path == "/select":
                with open(os.path.join(os.path.dirname(notebook), "selected.json"), "w") as f:
                    json.dump(req, f)
                emit({"event": "kernel", "state": "selected", "name": "Other Kernel"})
                body["name"] = "Other Kernel"
            elif url.path == "/topng":
                with open(os.path.join(os.path.dirname(notebook), "topng.json"), "w") as f:
                    json.dump(req, f)
                body.update({"png": PNG, "width": 80, "height": 48})
            elif url.path == "/md" and "Typeset" in req["text"]:
                if "Slowly" in req["text"]:
                    import time
                    time.sleep(1.5)
                # a page of two tiles: 3 rows (at 8x16 cells, drawn at twice that)
                with open(os.path.join(os.path.dirname(notebook), "md.json"), "w") as f:
                    json.dump(req, f)
                row = req["row_px"]
                body.update(width=req["width_px"], height=3 * row, tiles=[
                    {"hash": "a", "height": 2 * row, "png": PNG}, {"hash": "b", "height": row, "png": PNG}])
            elif url.path == "/mdjump":
                with open(os.path.join(os.path.dirname(notebook), "md.json")) as f:
                    body["offset"] = json.load(f)["text"].encode().find(b"words")
            elif url.path == "/clear":
                with open(os.path.join(os.path.dirname(notebook), "cleared.json"), "w") as f:
                    json.dump(req, f)
            elif url.path == "/snapshot":
                with open(os.path.join(os.path.dirname(notebook), "snapshot.json"), "w") as f:
                    json.dump(req, f)
                body.update({"png": PNG, "width": 80, "height": 48})
            elif url.path == "/interactive":
                with open(os.path.join(os.path.dirname(notebook), "interactive.json"), "w") as f:
                    json.dump(req, f)
                body["path"] = "/tmp/page.html"
            elif url.path == "/interrupt":
                open(os.path.join(os.path.dirname(notebook), "interrupted"), "w").close()
            elif url.path == "/save":
                with open(saved, "w") as f:
                    json.dump(req["cells"], f)
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        if url.path == "/shutdown":
            os._exit(0)

server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
emit({"event": "ready", "port": server.server_address[1], "token": token})
server.serve_forever()
"#;

fn python3_available() -> bool {
    std::process::Command::new("python3")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn harness(project: &Path, fake_nb: &Path) -> EditorTestHarness {
    harness_sized(project, fake_nb, 40)
}

fn harness_sized(project: &Path, fake_nb: &Path, rows: u16) -> EditorTestHarness {
    let plugins_dir = project.join("plugins");
    fs::create_dir_all(&plugins_dir).unwrap();
    copy_plugin(&plugins_dir, "notebook");
    copy_plugin_lib(&plugins_dir);
    let mut config = Config::default();
    config.editor.status_bar.left = vec![
        StatusBarElement::Mode,
        StatusBarElement::CustomToken("notebook:kernel".to_string()),
    ];
    config.plugins.insert(
        "notebook".to_string(),
        PluginConfig {
            enabled: true,
            path: None,
            settings: serde_json::json!({ "nbCommand": fake_nb.to_str().unwrap() }),
        },
    );
    EditorTestHarness::with_config_and_working_dir(120, rows, config, project.to_path_buf())
        .unwrap()
}

#[test]
fn a_notebook_opens_as_cells_runs_a_cell_and_saves_back() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("report.ipynb");
    fs::write(&nb_path, NOTEBOOK).unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    let mut h = harness(&project, &fake_nb);
    h.open_file(&nb_path).unwrap();

    // the cells, not the JSON; the `# %%` lines drawn as rules; no kernel until the first run
    h.wait_until(|h| {
        let s = h.screen_to_string();
        s.contains("print('hello')") && s.contains("── 2 [ ]")
    })
    .unwrap();
    h.wait_until(|h| h.get_status_bar().contains("○ no kernel yet"))
        .unwrap();
    // the tab is the notebook's name, not its working copy's
    h.wait_until(|h| h.screen_to_string().contains(" report.ipynb "))
        .unwrap();
    assert!(!h.screen_to_string().contains("report.ipynb.py"));
    // the working copy lives under the data dir, whose other files open read-only
    assert!(
        !h.editor().active_window().is_editing_disabled(),
        "a notebook can be edited"
    );
    let screen = h.screen_to_string();
    assert!(
        !screen.contains("nbformat"),
        "the JSON view is gone:\n{screen}"
    );
    // it opens with no cell being edited, the cursor in the code cell: the markdown rendered (once
    // nb has answered for its page), no `# ` prefix nor heading mark, no quotes
    h.wait_until(|h| {
        let s = h.screen_to_string();
        s.contains("   Report") && !s.contains("# Report") && !s.contains("\"\"\"")
    })
    .unwrap();

    // Alt+Enter on the code cell runs it
    h.send_key(KeyCode::Enter, KeyModifiers::ALT).unwrap();
    h.wait_until(|h| {
        let s = h.screen_to_string();
        // the run's time beside its count
        s.contains("ran: print('hello')") && s.contains("── 2 [1] ✓ 0.")
    })
    .unwrap();
    // with the cursor out of it, the markdown cell is rendered: no `# ` prefix, no heading mark
    let screen = h.screen_to_string();
    assert!(
        !screen.contains("# Report") && screen.contains("   Report"),
        "a markdown cell renders when the cursor leaves it:\n{screen}"
    );
    // the mode badge and the kernel's state dot, herdr's way
    h.wait_until(|h| {
        h.get_status_bar()
            .starts_with(" NOTEBOOK   ● Python (.venv) idle")
    })
    .unwrap();

    // saving the working copy sends the cells, with their ids, to nb
    h.send_key(KeyCode::Char('s'), KeyModifiers::CONTROL)
        .unwrap();
    let saved = project.join("saved.json");
    h.wait_until(|_| saved.exists()).unwrap();
    let cells: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&saved).unwrap()).unwrap();
    assert_eq!(
        cells,
        serde_json::json!([
            {"id": "intro", "kind": "markdown", "source": "# Report"},
            {"id": "hello", "kind": "code", "source": "print('hello')"}
        ])
    );

    // the palette's interrupt reaches nb
    h.send_key(KeyCode::Char('p'), KeyModifiers::CONTROL)
        .unwrap();
    h.wait_for_prompt().unwrap();
    h.type_text("Notebook: Interrupt Kernel").unwrap();
    h.send_key(KeyCode::Enter, KeyModifiers::NONE).unwrap();
    let interrupted = project.join("interrupted");
    h.wait_until(|_| interrupted.exists()).unwrap();
    h.assert_no_plugin_errors();
}

const PLOT_NOTEBOOK: &str = r##"{
 "cells": [
  {"cell_type": "code", "execution_count": null, "id": "plot", "metadata": {}, "outputs": [],
   "source": ["plot()"]}
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 5
}
"##;

/// A PNG output goes to the terminal once as kitty graphics (upload + a virtual placement) and shows
/// as rows of Unicode placeholders under the cell, coloured with the image id.
#[test]
fn an_image_output_is_drawn_with_kitty_placeholders() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("plot.ipynb");
    fs::write(&nb_path, PLOT_NOTEBOOK).unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    let mut h = harness(&project, &fake_nb);
    h.open_file(&nb_path).unwrap();
    // the notebook keys work once the badge says so
    h.wait_until(|h| h.get_status_bar().starts_with(" NOTEBOOK "))
        .unwrap();
    h.send_key(KeyCode::Enter, KeyModifiers::ALT).unwrap();
    let placeholder = '\u{10EEEE}';
    h.wait_until(|h| {
        h.screen_to_string()
            .lines()
            .filter(|l| l.contains(placeholder))
            .count()
            == 3
    })
    .unwrap();

    // 10 placeholder cells per row, each with its own row and column diacritics, in the id colour
    let buffer = h.buffer();
    let cells: Vec<_> = (0..buffer.area.height)
        .flat_map(|y| (0..buffer.area.width).map(move |x| (x, y)))
        .filter_map(|(x, y)| buffer.cell((x, y)))
        .filter(|c| c.symbol().starts_with(placeholder))
        .collect();
    assert_eq!(cells.len(), 30);
    assert!(cells
        .iter()
        .all(|c| c.fg == ratatui::style::Color::Rgb(0x4e, 0x42, 0x00)));
    assert_eq!(cells[0].symbol(), "\u{10EEEE}\u{305}\u{305}");
    assert_eq!(
        cells[11].symbol(),
        "\u{10EEEE}\u{30D}\u{30D}",
        "row 1, column 1"
    );

    // the PNG went up once, then the virtual placement of 10x3 cells
    let sent = String::from_utf8(h.editor_mut().take_pending_escape_sequences()).unwrap();
    assert!(
        sent.starts_with("\x1b_Ga=t,f=100,i=5128704,q=2,m=0;iVBORw0KGgo"),
        "{sent:?}"
    );
    assert!(
        sent.ends_with("\x1b_Ga=p,U=1,i=5128704,c=10,r=3,q=2\x1b\\"),
        "{sent:?}"
    );
    h.assert_no_plugin_errors();
}

const MATH_NOTEBOOK: &str = r##"{
 "cells": [
  {"cell_type": "markdown", "id": "maths", "metadata": {}, "source": ["Euler:\n", "$$e^{i\\pi} + 1 = 0$$"]},
  {"cell_type": "code", "execution_count": null, "id": "after", "metadata": {}, "outputs": [],
   "source": ["x = 1"]}
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 5
}
"##;

/// Display math goes to nb to be typeset and comes back as an image under the block (drawn at
/// twice the cell size, so the 80x48 PNG covers 5x2 cells); the source hides once the cursor
/// leaves the cell.
#[test]
fn display_math_is_typeset_as_an_image() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("maths.ipynb");
    fs::write(&nb_path, MATH_NOTEBOOK).unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    let mut h = harness(&project, &fake_nb);
    h.open_file(&nb_path).unwrap();
    let placeholder = '\u{10EEEE}';
    let rows = |h: &EditorTestHarness| {
        h.screen_to_string()
            .lines()
            .filter(|l| l.contains(placeholder))
            .count()
    };
    h.wait_until(|h| rows(h) == 2).unwrap();
    let req: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(project.join("math.json")).unwrap()).unwrap();
    assert_eq!(req["latex"], "e^{i\\pi} + 1 = 0");
    // it opens with no cell being edited: the image, not the source
    assert!(!h.screen_to_string().contains("$$"));
    // in the cell, the source shows above the image
    // (once the notebook has put the cursor in its code cell, on opening)
    h.wait_until(|h| h.cursor_position() > 0).unwrap();
    h.send_key(KeyCode::Home, KeyModifiers::CONTROL).unwrap();
    h.send_key(KeyCode::Down, KeyModifiers::NONE).unwrap();
    h.wait_until(|h| h.screen_to_string().contains("$$e^{i\\pi} + 1 = 0$$"))
        .unwrap();

    h.wait_until(|h| h.get_status_bar().starts_with(" NOTEBOOK "))
        .unwrap();
    h.send_key(KeyCode::Enter, KeyModifiers::ALT).unwrap();
    h.wait_until(|h| !h.screen_to_string().contains("$$"))
        .unwrap();
    let screen = h.screen_to_string();
    assert!(screen.contains("   Euler:"), "{screen}");
    assert_eq!(rows(&h), 2, "{screen}");
    assert!(
        !screen.contains("e^{"),
        "no Unicode fallback once typeset:\n{screen}"
    );
    h.assert_no_plugin_errors();
}

const CODE_NOTEBOOK: &str = r##"{
 "cells": [
  {"cell_type": "code", "execution_count": null, "id": "code", "metadata": {}, "outputs": [],
   "source": ["import os\n", "fru"]}
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 5
}
"##;

/// The kernel's completions in the editor's popup (Ctrl+Space, and at once after a `.`), its docs
/// on Alt+K, and the kernel picker.
#[test]
fn the_kernel_completes_documents_and_can_be_chosen() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("code.ipynb");
    fs::write(&nb_path, CODE_NOTEBOOK).unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    let mut h = harness(&project, &fake_nb);
    h.open_file(&nb_path).unwrap();
    h.wait_until(|h| h.get_status_bar().starts_with(" NOTEBOOK "))
        .unwrap();
    // (once the notebook has put the cursor in its code cell, on opening)
    h.wait_until(|h| h.cursor_position() > 0).unwrap();
    // the end of `fru` (the working copy ends with a newline)
    h.send_key(KeyCode::End, KeyModifiers::CONTROL).unwrap();
    h.send_key(KeyCode::Left, KeyModifiers::NONE).unwrap();

    // Ctrl+Space: the kernel's names for the word at the cursor
    h.send_key(KeyCode::Char(' '), KeyModifiers::CONTROL)
        .unwrap();
    h.wait_until(|h| h.screen_to_string().contains("fruit_basket"))
        .unwrap();
    let req: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(project.join("complete.json")).unwrap()).unwrap();
    assert_eq!(
        req,
        serde_json::json!({"code": "import os\nfru\n", "cursor": 13})
    );
    assert!(h.screen_to_string().contains("fruit_salad"));
    h.send_key(KeyCode::Tab, KeyModifiers::NONE).unwrap();
    h.wait_until(|h| {
        let s = h.screen_to_string();
        s.contains("fruit_basket") && !s.contains("fruit_salad")
    })
    .unwrap();

    // a `.` asks at once
    h.send_key(KeyCode::Enter, KeyModifiers::NONE).unwrap();
    h.type_text("os.").unwrap();
    h.wait_until(|h| h.screen_to_string().contains("pardir"))
        .unwrap();
    h.send_key(KeyCode::Tab, KeyModifiers::NONE).unwrap();
    h.wait_until(|h| h.screen_to_string().contains("os.path"))
        .unwrap();

    // Alt+K: the docs of the name at the cursor
    h.send_key(KeyCode::Char('k'), KeyModifiers::ALT).unwrap();
    h.wait_until(|h| h.screen_to_string().contains("Return the number of items"))
        .unwrap();
    h.send_key(KeyCode::Esc, KeyModifiers::NONE).unwrap();

    // the picker lists what nb offers; the choice goes to nb and is remembered
    h.send_key(KeyCode::Char('p'), KeyModifiers::CONTROL)
        .unwrap();
    h.wait_for_prompt().unwrap();
    h.type_text("Notebook: Select Kernel").unwrap();
    h.send_key(KeyCode::Enter, KeyModifiers::NONE).unwrap();
    h.wait_until(|h| h.screen_to_string().contains("Other Kernel"))
        .unwrap();
    h.type_text("other").unwrap();
    h.send_key(KeyCode::Enter, KeyModifiers::NONE).unwrap();
    let selected = project.join("selected.json");
    h.wait_until(|_| selected.exists()).unwrap();
    let req: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&selected).unwrap()).unwrap();
    assert_eq!(req, serde_json::json!({"kernel": "other"}));
    h.wait_until(|h| h.get_status_bar().contains("○ Other Kernel not started"))
        .unwrap();
    h.assert_no_plugin_errors();
}

const TABLE_NOTEBOOK: &str = r##"{
 "cells": [
  {"cell_type": "code", "execution_count": null, "id": "df", "metadata": {}, "outputs": [],
   "source": ["table()"]}
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 5
}
"##;

/// A DataFrame's HTML comes out as an aligned table: the header over a rule, numbers to the right,
/// pandas' size note under it.
#[test]
fn an_html_table_is_drawn_as_a_text_table() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("df.ipynb");
    fs::write(&nb_path, TABLE_NOTEBOOK).unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    let mut h = harness(&project, &fake_nb);
    h.open_file(&nb_path).unwrap();
    h.wait_until(|h| h.get_status_bar().starts_with(" NOTEBOOK "))
        .unwrap();
    h.send_key(KeyCode::Enter, KeyModifiers::ALT).unwrap();
    h.wait_until(|h| h.screen_to_string().contains("2 rows × 2 columns"))
        .unwrap();
    let screen = h.screen_to_string();
    let rows: Vec<&str> = screen
        .lines()
        .filter(|l| l.contains('│') || l.contains('┼'))
        .map(|l| l.trim_end())
        .collect();
    assert_eq!(
        rows,
        [
            "     │ fund       │ return",
            "   ──┼────────────┼───────",
            "   0 │ Alpha & Co │    1.5",
            "   1 │ Beta       │ -12.25",
        ]
        .map(|r| r.to_string()),
        "{screen}"
    );
    h.assert_no_plugin_errors();
}

const FIGURE_NOTEBOOK: &str = r##"{
 "cells": [
  {"cell_type": "code", "execution_count": null, "id": "setup", "metadata": {}, "outputs": [
    {"output_type": "display_data", "metadata": {}, "data": {"application/javascript": "window.loaded = 1;", "text/plain": ""}}],
   "source": ["setup()"]},
  {"cell_type": "code", "execution_count": null, "id": "chart", "metadata": {}, "outputs": [],
   "source": ["fig()"]}
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 5
}
"##;

/// An interactive chart (a Plotly figure here) says what it is, and a click on it or Alt+O opens
/// the cell's outputs in the browser through nb, with the scripts earlier cells output.
#[test]
fn an_interactive_output_opens_in_the_browser() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("charts.ipynb");
    fs::write(&nb_path, FIGURE_NOTEBOOK).unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    let mut h = harness(&project, &fake_nb);
    h.open_file(&nb_path).unwrap();
    h.wait_until(|h| h.get_status_bar().starts_with(" NOTEBOOK "))
        .unwrap();
    // (once the notebook has put the cursor in its code cell, on opening)
    h.wait_until(|h| h.cursor_position() > 0).unwrap();
    // run the chart cell
    h.send_key(KeyCode::End, KeyModifiers::CONTROL).unwrap();
    h.send_key(KeyCode::Enter, KeyModifiers::ALT).unwrap();
    // what it is while its picture is taken; then the picture (the stand-in's 80x48 PNG: 3 rows)
    let placeholder = '\u{10EEEE}';
    h.wait_until(|h| {
        let s = h.screen_to_string();
        s.lines().filter(|l| l.contains(placeholder)).count() == 3
            && s.contains("open interactive in the browser")
    })
    .unwrap();
    let shot: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(project.join("snapshot.json")).unwrap()).unwrap();
    assert_eq!(
        shot["output"]["data"]["application/vnd.plotly.v1+json"]["layout"]["title"]["text"],
        "Returns"
    );
    assert_eq!(shot["prelude"], serde_json::json!(["window.loaded = 1;"]));
    assert!(shot["width_px"].as_u64().unwrap() >= 160);
    let screen = h.screen_to_string();
    // the first cell's output is a loader script: nothing to show, as in Jupyter
    assert_eq!(screen.matches("open interactive").count(), 1, "{screen}");
    assert!(
        !screen.contains("Figure({...})"),
        "the picture, not the repr"
    );

    // a click on the open line
    let row = screen
        .lines()
        .position(|l| l.contains("open interactive in the browser"))
        .unwrap() as u16;
    h.mouse_click(10, row).unwrap();
    let asked = project.join("interactive.json");
    h.wait_until(|_| asked.exists()).unwrap();
    let req: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&asked).unwrap()).unwrap();
    assert_eq!(req["title"], "charts.ipynb · cell 2");
    assert_eq!(
        req["outputs"][0]["data"]["application/vnd.plotly.v1+json"]["layout"]["title"]["text"],
        "Returns"
    );
    assert_eq!(req["prelude"], serde_json::json!(["window.loaded = 1;"]));

    // Alt+O from inside the cell does the same
    fs::remove_file(&asked).unwrap();
    h.send_key(KeyCode::Up, KeyModifiers::NONE).unwrap();
    h.send_key(KeyCode::Char('o'), KeyModifiers::ALT).unwrap();
    h.wait_until(|_| asked.exists()).unwrap();
    h.assert_no_plugin_errors();
}

/// A working copy the editor brings back by itself (session restore, crash recovery with unsaved
/// edits) is attached to its notebook as it is: the edits kept, the notebook view on, and the
/// notebook's own JSON tab, if it comes back too, folded into it.
#[test]
fn a_restored_working_copy_is_attached_to_its_notebook() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("report.ipynb");
    fs::write(&nb_path, NOTEBOOK).unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    let mut h = harness(&project, &fake_nb);
    // what a previous session left: the working copy with an edit never saved to the notebook
    let dir = h
        .editor()
        .dir_context()
        .data_dir
        .join("notebooks")
        .join("report");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("notebook.txt"), nb_path.to_str().unwrap()).unwrap();
    let copy = dir.join("report.ipynb.py");
    fs::write(
        &copy,
        "# %% [markdown] id=intro\n# # Report\n\n# %% id=hello\nprint('edited, unsaved')\n",
    )
    .unwrap();
    h.open_file(&copy).unwrap();
    h.wait_until(|h| h.get_status_bar().starts_with(" NOTEBOOK "))
        .unwrap();
    h.wait_until(|h| h.screen_to_string().contains("── 2 [ ]"))
        .unwrap();
    assert!(h.screen_to_string().contains("print('edited, unsaved')"));
    assert!(!h.editor().active_window().is_editing_disabled());

    // the notebook itself opening again shows the same view, no JSON tab
    h.open_file(&nb_path).unwrap();
    h.wait_until(|h| {
        let s = h.screen_to_string();
        !s.contains("nbformat") && s.contains("print('edited, unsaved')")
    })
    .unwrap();

    // and saving writes the kept edit into the notebook
    h.send_key(KeyCode::Char('s'), KeyModifiers::CONTROL)
        .unwrap();
    let saved = project.join("saved.json");
    h.wait_until(|_| saved.exists()).unwrap();
    let cells: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&saved).unwrap()).unwrap();
    assert_eq!(cells[1]["source"], "print('edited, unsaved')");
    h.assert_no_plugin_errors();
}

/// Arrowing through the explorer previews files, which fires no after_file_open: a notebook
/// previewed that way still shows as its cells, and one already open switches to its view rather
/// than a second tab of JSON.
#[test]
fn a_previewed_notebook_shows_as_cells() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("report.ipynb");
    fs::write(&nb_path, NOTEBOOK).unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    let mut h = harness(&project, &fake_nb);
    let shows_cells = |h: &EditorTestHarness| {
        let s = h.screen_to_string();
        s.contains("print('hello')") && s.contains("── 2 [ ]") && !s.contains("nbformat")
    };
    h.editor_mut().open_file_preview(&nb_path).unwrap();
    h.wait_until(shows_cells).unwrap();

    // previewed again while open: still the one view
    h.editor_mut().open_file_preview(&nb_path).unwrap();
    h.wait_until(shows_cells).unwrap();
    h.wait_until(|h| h.get_status_bar().starts_with(" NOTEBOOK "))
        .unwrap();
    h.assert_no_plugin_errors();
}

fn palette(h: &mut EditorTestHarness, command: &str) {
    h.send_key(KeyCode::Char('p'), KeyModifiers::CONTROL)
        .unwrap();
    h.wait_for_prompt().unwrap();
    h.type_text(command).unwrap();
    h.send_key(KeyCode::Enter, KeyModifiers::NONE).unwrap();
}

/// Saves and returns the cells nb was sent, as (kind, source) pairs.
fn saved_cells(h: &mut EditorTestHarness, project: &Path) -> Vec<(String, String)> {
    let saved = project.join("saved.json");
    let _ = fs::remove_file(&saved);
    h.send_key(KeyCode::Char('s'), KeyModifiers::CONTROL)
        .unwrap();
    h.wait_until(|_| saved.exists()).unwrap();
    let cells: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&saved).unwrap()).unwrap();
    cells
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["kind"].as_str().unwrap().to_string(),
                c["source"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

/// Cells are added, moved, split, merged, converted and deleted with commands; the saved
/// notebook follows.
#[test]
fn cells_are_edited_with_commands() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("report.ipynb");
    fs::write(&nb_path, NOTEBOOK).unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    let mut h = harness(&project, &fake_nb);
    h.open_file(&nb_path).unwrap();
    h.wait_until(|h| h.get_status_bar().starts_with(" NOTEBOOK "))
        .unwrap();
    let pair = |k: &str, s: &str| (k.to_string(), s.to_string());

    // a new cell under the markdown one (the cursor to it: it opens in the code cell), typed into,
    // then moved to the top
    // (once the notebook has put the cursor in its code cell, on opening)
    h.wait_until(|h| h.cursor_position() > 0).unwrap();
    h.send_key(KeyCode::Home, KeyModifiers::CONTROL).unwrap();
    palette(&mut h, "Notebook: Insert Cell Below");
    h.wait_until(|h| h.screen_to_string().contains("── 3 [ ]"))
        .unwrap();
    h.type_text("x = 1").unwrap();
    h.send_key(KeyCode::Up, KeyModifiers::ALT | KeyModifiers::SHIFT)
        .unwrap();
    assert_eq!(
        saved_cells(&mut h, &project),
        [
            pair("code", "x = 1"),
            pair("markdown", "# Report"),
            pair("code", "print('hello')")
        ]
    );

    // to markdown and back, a split, a merge
    palette(&mut h, "Notebook: Change Cell to Markdown");
    h.wait_until(|h| h.screen_to_string().contains("── 1 markdown"))
        .unwrap();
    palette(&mut h, "Notebook: Change Cell to Code");
    h.wait_until(|h| h.screen_to_string().contains("── 1 [ ]"))
        .unwrap();
    h.send_key(KeyCode::End, KeyModifiers::NONE).unwrap();
    h.type_text("\ny = 2").unwrap();
    h.send_key(KeyCode::Home, KeyModifiers::NONE).unwrap();
    palette(&mut h, "Notebook: Split Cell");
    h.wait_until(|h| h.screen_to_string().contains("── 4 [ ]"))
        .unwrap();
    assert_eq!(
        saved_cells(&mut h, &project),
        [
            pair("code", "x = 1"),
            pair("code", "y = 2"),
            pair("markdown", "# Report"),
            pair("code", "print('hello')")
        ]
    );
    palette(&mut h, "Notebook: Move Cell Up");
    palette(&mut h, "Notebook: Merge Cell Below");
    h.wait_until(|h| !h.screen_to_string().contains("── 4"))
        .unwrap();
    assert_eq!(
        saved_cells(&mut h, &project),
        [
            pair("code", "y = 2\nx = 1"),
            pair("markdown", "# Report"),
            pair("code", "print('hello')")
        ]
    );

    // delete it; clear every output (nb is told, so a save writes them empty)
    palette(&mut h, "Notebook: Delete Cell");
    h.wait_until(|h| !h.screen_to_string().contains("y = 2"))
        .unwrap();
    assert_eq!(
        saved_cells(&mut h, &project),
        [pair("markdown", "# Report"), pair("code", "print('hello')")]
    );
    palette(&mut h, "Notebook: Clear All Outputs");
    let cleared = project.join("cleared.json");
    h.wait_until(|_| cleared.exists()).unwrap();
    let req: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&cleared).unwrap()).unwrap();
    assert_eq!(req, serde_json::json!({"cells": ["intro", "hello"]}));
    h.assert_no_plugin_errors();
}

const MAGIC_NOTEBOOK: &str = r##"{
 "cells": [
  {"cell_type": "markdown", "id": "intro", "metadata": {}, "source": ["# Plots"]},
  {"cell_type": "code", "execution_count": null, "id": "setup", "metadata": {}, "outputs": [],
   "source": ["%matplotlib inline\n", "!pip install -q pandas\n", "x = 1"]}
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 5
}
"##;

/// IPython magics sit behind a hidden `#!` in the working copy (a comment to the language server),
/// show as written, and are saved and run as written.
#[test]
fn magics_are_hidden_from_python_but_kept() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("plots.ipynb");
    fs::write(&nb_path, MAGIC_NOTEBOOK).unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    let mut h = harness(&project, &fake_nb);
    h.open_file(&nb_path).unwrap();
    h.wait_until(|h| h.get_status_bar().starts_with(" NOTEBOOK "))
        .unwrap();
    h.wait_until(|h| h.screen_to_string().contains("── 2 [ ]"))
        .unwrap();
    let screen = h.screen_to_string();
    assert!(
        screen.contains("   %matplotlib inline") && !screen.contains("#!%"),
        "{screen}"
    );
    let text = h.get_buffer_content().unwrap();
    assert!(
        text.contains("#!%matplotlib inline\n#!!pip install -q pandas\nx = 1"),
        "{text:?}"
    );

    // run it (Alt+Enter on the markdown cell moves on, then runs the code cell): nb gets the magic
    h.send_key(KeyCode::Enter, KeyModifiers::ALT).unwrap();
    h.send_key(KeyCode::Enter, KeyModifiers::ALT).unwrap();
    h.wait_until(|h| h.screen_to_string().contains("ran: %matplotlib inline"))
        .unwrap();
    assert_eq!(
        saved_cells(&mut h, &project)[1],
        (
            "code".to_string(),
            "%matplotlib inline\n!pip install -q pandas\nx = 1".to_string()
        )
    );
    h.assert_no_plugin_errors();
}

const NOISY_NOTEBOOK: &str = r##"{
 "cells": [
  {"cell_type": "code", "execution_count": null, "id": "n", "metadata": {}, "outputs": [],
   "source": ["noisy()"]}
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 5
}
"##;

/// Terminal output as a terminal shows it: its colours (as the theme's), a progress bar redrawn
/// with `\r` at its last state; long output cut at 40 lines until expanded.
#[test]
fn output_keeps_colours_progress_bars_settle_and_long_output_expands() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("noisy.ipynb");
    fs::write(&nb_path, NOISY_NOTEBOOK).unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    // tall enough for the cut output and its "more lines" note
    let mut h = harness_sized(&project, &fake_nb, 60);
    h.open_file(&nb_path).unwrap();
    h.wait_until(|h| h.get_status_bar().starts_with(" NOTEBOOK "))
        .unwrap();
    h.send_key(KeyCode::Enter, KeyModifiers::ALT).unwrap();
    // the output's lines come in one by one: wait for its last one, the "more lines" note
    h.wait_until(|h| {
        let s = h.screen_to_string();
        s.contains("failed twice") && s.contains("… 12 more lines")
    })
    .unwrap();
    let screen = h.screen_to_string();
    assert!(
        !screen.contains("[31m") && !screen.contains("50%"),
        "{screen}"
    );
    assert!(screen.contains("   100%"), "{screen}");
    assert!(screen.contains("… 12 more lines"), "{screen}");

    // "failed" in the theme's error colour, "twice" in the output's own
    let (x, y) = h.find_text_on_screen("failed twice").unwrap();
    let error = h.editor().theme().diagnostic_error_fg;
    assert_eq!(h.get_cell_style(x, y).unwrap().fg, Some(error));
    assert_ne!(h.get_cell_style(x + 7, y).unwrap().fg, Some(error));

    palette(&mut h, "Notebook: Expand Output");
    h.wait_until(|h| !h.screen_to_string().contains("more lines"))
        .unwrap();
    h.assert_no_plugin_errors();
}

const SYMPY_NOTEBOOK: &str = r##"{
 "cells": [
  {"cell_type": "code", "execution_count": null, "id": "s", "metadata": {}, "outputs": [],
   "source": ["sym()"]}
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 5
}
"##;

/// A formula as a cell's result (sympy's text/latex) is typeset like display math.
#[test]
fn a_latex_result_is_typeset() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("sym.ipynb");
    fs::write(&nb_path, SYMPY_NOTEBOOK).unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    let mut h = harness(&project, &fake_nb);
    h.open_file(&nb_path).unwrap();
    h.wait_until(|h| h.get_status_bar().starts_with(" NOTEBOOK "))
        .unwrap();
    h.send_key(KeyCode::Enter, KeyModifiers::ALT).unwrap();
    let placeholder = '\u{10EEEE}';
    h.wait_until(|h| {
        h.screen_to_string()
            .lines()
            .filter(|l| l.contains(placeholder))
            .count()
            == 2
    })
    .unwrap();
    let req: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(project.join("math.json")).unwrap()).unwrap();
    assert_eq!(req["latex"], "x^{2} + 1");
    h.assert_no_plugin_errors();
}

/// An SVG (or JPEG) output goes to nb to become a PNG, then shows as an image like any other.
#[test]
fn an_svg_output_is_converted_and_drawn() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("svg.ipynb");
    fs::write(&nb_path, SYMPY_NOTEBOOK.replace("sym()", "svg()")).unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    let mut h = harness(&project, &fake_nb);
    h.open_file(&nb_path).unwrap();
    h.wait_until(|h| h.get_status_bar().starts_with(" NOTEBOOK "))
        .unwrap();
    h.send_key(KeyCode::Enter, KeyModifiers::ALT).unwrap();
    let placeholder = '\u{10EEEE}';
    h.wait_until(|h| {
        h.screen_to_string()
            .lines()
            .filter(|l| l.contains(placeholder))
            .count()
            == 2
    })
    .unwrap();
    let req: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(project.join("topng.json")).unwrap()).unwrap();
    assert_eq!(req["mime"], "image/svg+xml");
    h.assert_no_plugin_errors();
}

/// input() in a running cell is asked for in a prompt; the answer goes back to the kernel.
#[test]
fn input_is_asked_in_a_prompt() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("ask.ipynb");
    fs::write(&nb_path, SYMPY_NOTEBOOK.replace("sym()", "ask()")).unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    let mut h = harness(&project, &fake_nb);
    h.open_file(&nb_path).unwrap();
    h.wait_until(|h| h.get_status_bar().starts_with(" NOTEBOOK "))
        .unwrap();
    h.send_key(KeyCode::Enter, KeyModifiers::ALT).unwrap();
    h.wait_until(|h| h.screen_to_string().contains("name? "))
        .unwrap();
    h.type_text("Ada").unwrap();
    h.send_key(KeyCode::Enter, KeyModifiers::NONE).unwrap();
    h.wait_until(|h| h.screen_to_string().contains("hi Ada"))
        .unwrap();
    h.assert_no_plugin_errors();
}

/// A markdown cell the cursor isn't in shows typeset (nb's page, as image rows, its source folded
/// away); a click on the page puts the cursor on the markdown under it, and the source shows.
#[test]
fn markdown_cells_are_typeset_and_a_click_goes_to_the_source() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("doc.ipynb");
    fs::write(
        &nb_path,
        NOTEBOOK.replace(
            r##""source": ["# Report"]"##,
            r##""source": ["# Typeset\n", "\n", "Some words here."]"##,
        ),
    )
    .unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    let mut h = harness(&project, &fake_nb);
    h.open_file(&nb_path).unwrap();
    // it opens with the markdown typeset: three image rows under its rule, no source
    h.wait_until(|h| {
        let s = h.screen_to_string();
        !s.contains("Some words") && s.lines().filter(|l| l.contains('\u{10EEEE}')).count() == 3
    })
    .unwrap();
    let req: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(project.join("md.json")).unwrap()).unwrap();
    assert_eq!(
        req["text"], "# Typeset\n\nSome words here.\n",
        "the cell's markdown, without its `# `"
    );

    // a click on the page's second row: the cursor goes to "words", in the source
    let screen = h.screen_to_string();
    let row = screen
        .lines()
        .position(|l| l.contains('\u{10EEEE}'))
        .unwrap() as u16
        + 1;
    h.mouse_click(20, row).unwrap();
    // its source, in a cell box like a code cell's (a band of half blocks above it, two columns of
    // the cell's ground before each line)
    h.wait_until(|h| {
        let screen = h.screen_to_string();
        let lines: Vec<&str> = screen.lines().collect();
        let at = |text: &str| lines.iter().position(|l| l.contains(text));
        match (at("# Typeset"), at("Some words here.")) {
            (Some(title), Some(words)) => {
                title > 0 && lines[title - 1].starts_with('▄') && lines[words + 1].starts_with('▀')
            }
            _ => false,
        }
    })
    .unwrap();
    h.wait_until(|h| h.screen_to_string().contains("Some words here."))
        .unwrap();
    // (the cell opens at the click; the cursor lands on the text once nb has said where)
    h.wait_until(|h| {
        let at = h.cursor_position();
        let text = h.get_buffer_content().unwrap_or_default();
        text.get(at..).is_some_and(|t| t.starts_with("words"))
    })
    .unwrap();
    h.type_text("X").unwrap();
    h.wait_until(|h| h.screen_to_string().contains("Some Xwords here."))
        .unwrap();
    h.assert_no_plugin_errors();
}

/// A markdown cell is its text as written, no `# ` before each line: a raw string in the working
/// copy, whose quotes stay out of sight and out of the cursor's way, and go back where they belong
/// when an edit at the text's ends takes them along.
#[test]
fn a_markdown_cell_is_edited_as_plain_text() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("report.ipynb");
    fs::write(&nb_path, NOTEBOOK).unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    let mut h = harness(&project, &fake_nb);
    h.open_file(&nb_path).unwrap();
    h.wait_until(|h| h.get_status_bar().starts_with(" NOTEBOOK "))
        .unwrap();
    h.wait_until(|h| h.screen_to_string().contains("── 2 [ ]"))
        .unwrap();
    let text = |h: &EditorTestHarness| h.get_buffer_content().unwrap_or_default();
    assert!(
        text(&h).starts_with("# %% [markdown] id=intro\nr\"\"\"\n# Report\"\"\"\n"),
        "{}",
        text(&h)
    );
    let screen = h.screen_to_string();
    assert!(
        !screen.contains("\"\"\"") && !screen.contains("# # Report"),
        "{screen}"
    );
    let at = |h: &EditorTestHarness, s: &str| text(h).find(s).unwrap();

    // down from the `# %%` line (the top: the notebook opens in its code cell): past the hidden
    // `r"""` line, onto the text
    // (once the notebook has put the cursor in its code cell, on opening)
    h.wait_until(|h| h.cursor_position() > 0).unwrap();
    h.send_key(KeyCode::Home, KeyModifiers::CONTROL).unwrap();
    h.send_key(KeyCode::Down, KeyModifiers::NONE).unwrap();
    h.wait_until(|h| h.cursor_position() == at(h, "# Report"))
        .unwrap();
    // End stops before the closing quotes; what's typed goes in the text
    h.send_key(KeyCode::End, KeyModifiers::NONE).unwrap();
    h.wait_until(|h| h.cursor_position() == at(h, "\"\"\"\n\n"))
        .unwrap();
    h.type_text("!").unwrap();
    h.send_key(KeyCode::Enter, KeyModifiers::NONE).unwrap();
    h.type_text("more").unwrap();
    h.wait_until(|h| text(h).contains("\nr\"\"\"\n# Report!\nmore\"\"\"\n"))
        .unwrap();

    // a Delete at the end takes a closing quote: it comes back, the cursor where it was
    h.send_key(KeyCode::Delete, KeyModifiers::NONE).unwrap();
    h.wait_until(|h| {
        text(h).contains("\nmore\"\"\"\n") && h.cursor_position() == at(h, "\"\"\"\n\n")
    })
    .unwrap();

    // a Backspace at the start of the text joins the `r"""` line to it: it goes back on its own
    h.send_key(KeyCode::Up, KeyModifiers::NONE).unwrap();
    h.send_key(KeyCode::Home, KeyModifiers::NONE).unwrap();
    h.wait_until(|h| h.cursor_position() == at(h, "# Report!"))
        .unwrap();
    h.send_key(KeyCode::Backspace, KeyModifiers::NONE).unwrap();
    h.wait_until(|h| {
        text(h).contains("id=intro\nr\"\"\"\n# Report!\n")
            && h.cursor_position() == at(h, "# Report!")
    })
    .unwrap();
    h.type_text(">").unwrap();
    h.wait_until(|h| text(h).contains("\nr\"\"\"\n># Report!\nmore\"\"\"\n"))
        .unwrap();

    // and the notebook gets the text as typed
    h.send_key(KeyCode::Char('s'), KeyModifiers::CONTROL)
        .unwrap();
    let saved = project.join("saved.json");
    h.wait_until(|_| saved.exists()).unwrap();
    let cells: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&saved).unwrap()).unwrap();
    assert_eq!(cells[0]["source"], "># Report!\nmore");
    h.assert_no_plugin_errors();
}

/// A resize redraws the typeset markdown for the new width (nb asked again, narrower), and an
/// image row never wraps onto the next line meanwhile.
#[test]
fn a_resize_typesets_markdown_again_at_the_new_width() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("doc.ipynb");
    fs::write(
        &nb_path,
        NOTEBOOK.replace(
            r##""source": ["# Report"]"##,
            r##""source": ["# Typeset\n", "\n", "Some words here."]"##,
        ),
    )
    .unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    let mut h = harness(&project, &fake_nb);
    h.open_file(&nb_path).unwrap();
    // the notebook drawn (its cell box), then the cursor to the code cell
    h.wait_until(|h| {
        h.get_status_bar().starts_with(" NOTEBOOK ")
            && h.screen_to_string().lines().any(|l| l.starts_with('▀'))
    })
    .unwrap();
    h.send_key(KeyCode::End, KeyModifiers::CONTROL).unwrap();
    let placeholder = '\u{10EEEE}';
    let rows = |h: &EditorTestHarness| {
        h.screen_to_string()
            .lines()
            .filter(|l| l.contains(placeholder))
            .count()
    };
    h.wait_until(|h| rows(h) == 3).unwrap();
    let width = |p: &Path| -> u64 {
        let req: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(p.join("md.json")).unwrap()).unwrap();
        req["width_px"].as_u64().unwrap()
    };
    let wide = width(&project);

    h.resize(60, 30).unwrap();
    h.wait_until(|_| width(&project) < wide).unwrap();
    h.wait_until(|h| rows(h) == 3).unwrap();
    // no row of the picture runs into the next line: each holds placeholders only after the indent
    for l in h
        .screen_to_string()
        .lines()
        .filter(|l| l.contains(placeholder))
    {
        assert!(l.starts_with("   "), "{l}");
    }
    h.assert_no_plugin_errors();
}

/// A notebook opens with no cell being edited: its markdown typeset at once, the cursor off it.
/// Shift+Enter in a markdown cell ends editing it: typeset, even with no cell after it to go to.
#[test]
fn markdown_opens_typeset_and_shift_enter_typesets_it_again() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("doc.ipynb");
    fs::write(
        &nb_path,
        NOTEBOOK.replace(
            r##""source": ["# Report"]"##,
            r##""source": ["# Typeset\n", "\n", "Some words here."]"##,
        ),
    )
    .unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    let mut h = harness(&project, &fake_nb);
    h.open_file(&nb_path).unwrap();
    let placeholder = '\u{10EEEE}';
    let typeset = |h: &EditorTestHarness| {
        let s = h.screen_to_string();
        s.lines().filter(|l| l.contains(placeholder)).count() == 3 && !s.contains("Some words")
    };
    // typeset without the cursor having moved; the cursor in the code cell, the rule drawn
    h.wait_until(|h| typeset(h) && h.screen_to_string().contains("── 1 markdown"))
        .unwrap();
    let at = h.cursor_position();
    let text = h.get_buffer_content().unwrap();
    assert_eq!(
        &text[at..at + 5],
        "print",
        "the cursor starts in the code cell"
    );

    // into the markdown cell (its source, to edit), then Shift+Enter there: typeset again
    // (once the notebook has put the cursor in its code cell, on opening)
    h.wait_until(|h| h.cursor_position() > 0).unwrap();
    h.send_key(KeyCode::Home, KeyModifiers::CONTROL).unwrap();
    h.send_key(KeyCode::Down, KeyModifiers::NONE).unwrap();
    h.wait_until(|h| h.screen_to_string().contains("Some words here."))
        .unwrap();
    h.send_key(KeyCode::Enter, KeyModifiers::SHIFT).unwrap();
    h.wait_until(typeset).unwrap();
    h.assert_no_plugin_errors();
}

/// While a markdown cell's page is made, its source doesn't show (it would jump when the page
/// comes): a line says it's being typeset. Opened again, the notebook holds the room the page took,
/// so the cells below are where they'll stay before it's drawn.
#[test]
fn a_typesetting_cell_holds_its_place() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("doc.ipynb");
    fs::write(
        &nb_path,
        NOTEBOOK.replace(
            r##""source": ["# Report"]"##,
            r##""source": ["# Typeset\n", "\n", "Slowly typeset words."]"##,
        ),
    )
    .unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    let mut h = harness(&project, &fake_nb);
    let placeholder = '\u{10EEEE}';
    let rule_row = |h: &EditorTestHarness| {
        h.screen_to_string()
            .lines()
            .position(|l| l.contains("── 2 [ ]"))
    };
    let pictured = |h: &EditorTestHarness| {
        h.screen_to_string()
            .lines()
            .filter(|l| l.contains(placeholder))
            .count()
            == 3
    };

    // (another file open too: closing the notebook mustn't leave the window empty, the explorer
    // would open and the pane narrow, and a page for another width is another page)
    let other = project.join("notes.txt");
    fs::write(&other, "notes\n").unwrap();
    h.open_file(&other).unwrap();
    h.open_file(&nb_path).unwrap();
    // the page on its way: a line saying so, never the source
    h.wait_until(|h| h.screen_to_string().contains("typesetting…"))
        .unwrap();
    assert!(!h.screen_to_string().contains("Slowly typeset words"));
    h.wait_until(pictured).unwrap();
    let final_row = rule_row(&h);

    // opened again: the page's 3 rows held while it's made, the code cell already where it stays
    let buffer = h.editor().active_buffer();
    h.editor_mut().close_buffer(buffer).unwrap();
    h.render().unwrap();
    h.open_file(&nb_path).unwrap();
    h.wait_until(|h| rule_row(h).is_some() && !pictured(h))
        .unwrap();
    assert_eq!(rule_row(&h), final_row, "{}", h.screen_to_string());
    assert!(!h.screen_to_string().contains("typesetting…"));
    h.wait_until(pictured).unwrap();
    assert_eq!(rule_row(&h), final_row);
    h.assert_no_plugin_errors();
}

/// Ctrl+Enter and Shift+Enter in a markdown cell (the last one here: there's no cell to go on to)
/// typeset it; the cursor rests on its rule, which stays a rule, the cell's id out of reach. A click
/// on the page edits it again, as many times as it's typeset.
#[test]
fn the_run_keys_typeset_a_markdown_cell() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let nb_path = project.join("doc.ipynb");
    let nb = r##"{
 "cells": [
  {"cell_type": "code", "execution_count": null, "id": "hello", "metadata": {}, "outputs": [], "source": ["print('hello')"]},
  {"cell_type": "markdown", "id": "intro", "metadata": {}, "source": ["# Typeset\n", "\n", "Some words here."]}
 ],
 "metadata": {}, "nbformat": 4, "nbformat_minor": 5
}"##;
    fs::write(&nb_path, nb).unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();
    let mut h = harness(&project, &fake_nb);
    h.open_file(&nb_path).unwrap();
    let placeholder = '\u{10EEEE}';
    let typeset = |h: &EditorTestHarness| {
        let s = h.screen_to_string();
        s.lines().filter(|l| l.contains(placeholder)).count() == 3 && !s.contains("Some words")
    };
    // (each time somewhere else: two quick clicks in one place are a double click)
    let edit = |h: &mut EditorTestHarness, col: u16| {
        let row = h
            .screen_to_string()
            .lines()
            .position(|l| l.contains('\u{10EEEE}'))
            .unwrap() as u16
            + 1;
        h.mouse_click(col, row).unwrap();
        h.wait_until(|h| h.screen_to_string().contains("Some words here."))
            .unwrap();
    };
    h.wait_until(typeset).unwrap();
    // it opens in the code cell, not on its `# %%` line
    h.wait_until(|h| h.cursor_position() > 0).unwrap();
    assert!(!h.screen_to_string().contains("id=hello"));

    for (key, col) in [(KeyModifiers::CONTROL, 20), (KeyModifiers::SHIFT, 30)] {
        edit(&mut h, col);
        h.send_key(KeyCode::Enter, key).unwrap();
        h.wait_until(typeset).unwrap();
        // the cursor on the cell's rule: still drawn as the rule
        let text = h.get_buffer_content().unwrap();
        let rule_end = text.find("[markdown] id=intro").unwrap() + "[markdown] id=intro".len();
        h.wait_until(|h| h.cursor_position() == rule_end).unwrap();
        let screen = h.screen_to_string();
        assert!(
            screen.contains("── 2 markdown") && !screen.contains("id=intro"),
            "{screen}"
        );
    }
    h.assert_no_plugin_errors();
}
