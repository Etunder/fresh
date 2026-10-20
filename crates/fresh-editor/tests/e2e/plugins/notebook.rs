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
                body["runs"] = {}
            elif url.path == "/run":
                count[0] += 1
                if count[0] == 1:
                    emit({"event": "kernel", "state": "starting", "name": "/work/repo/.venv/bin/python"})
                    emit({"event": "kernel", "state": "ready"})
                emit({"event": "busy", "cell": req["cell"]})
                if req["code"].startswith("plot"):
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
    EditorTestHarness::with_config_and_working_dir(120, 40, config, project.to_path_buf()).unwrap()
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
    let screen = h.screen_to_string();
    assert!(
        !screen.contains("nbformat"),
        "the JSON view is gone:\n{screen}"
    );
    // the cursor starts in the markdown cell: its source, `# `-commented in the working copy
    assert!(
        screen.contains("# # Report"),
        "markdown cells are commented:\n{screen}"
    );

    // Alt+Enter on the markdown cell moves on; on the code cell it runs it
    h.send_key(KeyCode::Enter, KeyModifiers::ALT).unwrap();
    h.send_key(KeyCode::Enter, KeyModifiers::ALT).unwrap();
    h.wait_until(|h| {
        let s = h.screen_to_string();
        s.contains("ran: print('hello')") && s.contains("── 2 [1] ✓")
    })
    .unwrap();
    // with the cursor out of it, the markdown cell is rendered: no `# ` prefix, no heading mark
    let screen = h.screen_to_string();
    assert!(
        !screen.contains("# # Report") && screen.contains("   Report"),
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
    // while the cursor is in the cell, the source shows above the image
    assert!(h.screen_to_string().contains("$$e^{i\\pi} + 1 = 0$$"));

    h.wait_until(|h| h.get_status_bar().starts_with(" NOTEBOOK "))
        .unwrap();
    h.send_key(KeyCode::Enter, KeyModifiers::ALT).unwrap();
    h.wait_until(|h| !h.screen_to_string().contains("$$")).unwrap();
    let screen = h.screen_to_string();
    assert!(screen.contains("   Euler:"), "{screen}");
    assert_eq!(rows(&h), 2, "{screen}");
    assert!(!screen.contains("e^{"), "no Unicode fallback once typeset:\n{screen}");
    h.assert_no_plugin_errors();
}
