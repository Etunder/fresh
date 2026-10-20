//! The markdown preview: "Markdown: Open Preview to the Side" puts the file, typeset by `nb serve`
//! (played by a small Python stand-in, as in the notebook tests), in a pane beside it; edits are
//! typeset again, and a click on the page puts the cursor on the markdown nb maps it to.

#![cfg(unix)]

use crate::common::harness::{copy_plugin, copy_plugin_lib, EditorTestHarness};
use crossterm::event::{KeyCode, KeyModifiers};
use fresh::config::{Config, PluginConfig};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

const README: &str = "# Title\n\nSome text.\n\n## Second\n\nMore text.\n";

/// `md` answers two tiles (3 rows at the default 8x16 cells, drawn at twice that) and writes the
/// text it was sent to md-<n>.txt; `mdjump` answers where "## Second" is.
const FAKE_NB: &str = r###"#!/usr/bin/env python3
import http.server, json, os, sys, urllib.parse, uuid

here = os.path.dirname(sys.argv[2])
PNG = "iVBORw0KGgoAAAANSUhEUgAAAFAAAAAwCAIAAAAJh2qgAAAAUklEQVR4nO3PAQkAMAzAsEmbf1O/jEMfqIBmzu5XzfMDYGBgYGBg4G8CrgdcD7gecD3gesD1gOsB1wOuB1wPuB5wPeB6wPWA6wHXA64HXA+43gUuHnJLsVlJ8gAAAABJRU5ErkJggg=="
token = uuid.uuid4().hex
renders = [0]
last = [""]

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(url.query)
        body = {"ok": True}
        req = None
        if "req" in q:
            with open(q["req"][0]) as f:
                req = json.load(f)
            os.remove(q["req"][0])
        if q.get("token", [""])[0] != token:
            body = {"ok": False, "message": "bad token"}
        elif url.path == "/md":
            renders[0] += 1
            last[0] = req["text"]
            row = req["row_px"]
            body.update(width=req["width_px"], height=3 * row, tiles=[
                {"hash": "top", "height": 2 * row, "png": PNG},
                {"hash": "end-%d" % len(req["text"]), "height": row, "png": PNG},
            ])
            with open(os.path.join(here, "md-%d.txt" % renders[0]), "w") as f:
                f.write(req["text"])
        elif url.path == "/mdjump":
            body["offset"] = last[0].encode().find(b"## Second")
        elif url.path == "/mdlocate":
            body["y"] = 0
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
print(json.dumps({"event": "ready", "port": server.server_address[1], "token": token}), flush=True)
server.serve_forever()
"###;

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
    copy_plugin(&plugins_dir, "markdown_preview");
    copy_plugin_lib(&plugins_dir);
    let mut config = Config::default();
    // the preview runs the nb the notebook plugin is set to
    config.plugins.insert(
        "notebook".to_string(),
        PluginConfig {
            enabled: true,
            path: None,
            settings: serde_json::json!({ "nbCommand": fake_nb.to_str().unwrap() }),
        },
    );
    EditorTestHarness::with_config_and_working_dir(120, 30, config, project.to_path_buf()).unwrap()
}

#[test]
fn a_markdown_file_previews_beside_itself_and_a_click_goes_to_the_source() {
    if !python3_available() {
        eprintln!("Skipping: no python3 for the stand-in nb");
        return;
    }
    let tmp = tempfile::TempDir::new().unwrap();
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let readme = project.join("README.md");
    fs::write(&readme, README).unwrap();
    let fake_nb = tmp.path().join("nb");
    fs::write(&fake_nb, FAKE_NB).unwrap();
    fs::set_permissions(&fake_nb, fs::Permissions::from_mode(0o755)).unwrap();

    let mut h = harness(&project, &fake_nb);
    h.open_file(&readme).unwrap();
    h.send_key(KeyCode::Char('p'), KeyModifiers::CONTROL)
        .unwrap();
    h.wait_for_prompt().unwrap();
    h.type_text("Open Preview to the Side").unwrap();
    h.send_key(KeyCode::Enter, KeyModifiers::NONE).unwrap();

    // the pane beside the file, its rows the tiles' placeholders (U+10EEEE)
    h.wait_until(|h| {
        let s = h.screen_to_string();
        s.contains("*Preview README.md*") && s.matches('\u{10EEEE}').count() >= 3 * 50
    })
    .unwrap();
    assert_eq!(
        fs::read_to_string(project.join("md-1.txt")).unwrap(),
        README
    );
    // the file keeps the focus
    assert!(
        h.get_status_bar().contains("Ln 1,"),
        "{}",
        h.get_status_bar()
    );

    // a click on the page: the cursor goes where nb maps it, in the file, which gets the focus
    let screen = h.screen_to_string();
    let tab_row = screen.lines().find(|l| l.contains("*Preview")).unwrap();
    let col = tab_row.chars().position(|c| c == '*').unwrap() as u16;
    h.mouse_click(col + 4, 3).unwrap();
    h.wait_until(|h| h.get_status_bar().contains("Ln 5, Col 1"))
        .unwrap();

    // typing in the file typesets it again, with the new text
    h.type_text("x").unwrap();
    // (a render may come between, for the pane's width)
    h.wait_until(|_| {
        (2..10).any(|n| {
            fs::read_to_string(project.join(format!("md-{n}.txt")))
                .map(|t| t.contains("x## Second"))
                .unwrap_or(false)
        })
    })
    .unwrap();
}
