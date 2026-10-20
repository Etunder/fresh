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
                    emit({"event": "kernel", "state": "starting", "name": "Python 3 (ipykernel)"})
                    emit({"event": "kernel", "state": "ready"})
                emit({"event": "busy", "cell": req["cell"]})
                emit({"event": "output", "cell": req["cell"],
                      "output": {"output_type": "stream", "name": "stdout", "text": "ran: " + req["code"] + "\n"}})
                emit({"event": "done", "cell": req["cell"], "status": "ok", "execution_count": count[0]})
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
    // the mode badge and the kernel's state dot, herdr's way
    h.wait_until(|h| h.get_status_bar().starts_with(" NOTEBOOK   ● Python 3 idle"))
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
    h.assert_no_plugin_errors();
}
