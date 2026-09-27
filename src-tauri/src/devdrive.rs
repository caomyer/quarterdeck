//! A development build's remote control, so an agent can play the captain in
//! the real app, against a real first mate, and see what the captain would see.
//!
//! The app's window is a WKWebView, which no browser automation reaches, and a
//! terminal is usually denied the screen-recording permission a window capture
//! needs. So the app drives itself: with `QUARTERDECK_DEVDRIVE=<dir>` in a debug
//! build it reads requests from `<dir>/in/<id>.json` and answers each in
//! `<dir>/out/<id>.json` as `{"ok": bool, "value": ...}`:
//!
//! - `{"eval": "<script>"}` runs the script in the window as the body of an
//!   async function, so it may `await` and `return`; the value comes back as
//!   JSON, or the error's text when it throws;
//! - `{"snapshot": "<absolute path>.png"}` writes what the window shows, the
//!   artifact frames included, through WebKit's own snapshot.
//!
//! A release build never starts it, and `devdrive_done` refuses unless it runs.
//! `scripts/devtest.sh` brings up a scratch home with it and `scripts/drive.mjs`
//! is its client.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager};

static DRIVE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// The drive's folder, when this is a debug build that was asked for one.
pub(crate) fn requested() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var_os("QUARTERDECK_DEVDRIVE").filter(|dir| !dir.is_empty()).map(PathBuf::from)
}

/// Starts reading requests, when a debug build was asked to.
pub(crate) fn start(app: AppHandle) {
    let Some(dir) = requested() else { return };
    for sub in ["in", "out"] {
        if let Err(error) = std::fs::create_dir_all(dir.join(sub)) {
            log::warn!("the drive cannot use {}: {error}", dir.display());
            return;
        }
    }
    let _ = DRIVE_DIR.set(dir.clone());
    log::info!("driven from {}", dir.display());
    std::thread::spawn(move || loop {
        for (id, request) in take_requests(&dir.join("in")) {
            handle(&app, &dir, &id, request);
        }
        std::thread::sleep(Duration::from_millis(100));
    });
}

/// Requests waiting, oldest name first, each removed as it is taken.
fn take_requests(inbox: &Path) -> Vec<(String, Value)> {
    let Ok(entries) = std::fs::read_dir(inbox) else { return Vec::new() };
    let mut names: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    names.sort();
    names
        .into_iter()
        .filter_map(|path| {
            let id = path.file_stem()?.to_string_lossy().to_string();
            let text = std::fs::read_to_string(&path).ok()?;
            let _ = std::fs::remove_file(&path);
            Some((id, serde_json::from_str(&text).unwrap_or(Value::Null)))
        })
        .collect()
}

fn handle(app: &AppHandle, dir: &Path, id: &str, request: Value) {
    let Some(window) = app.get_webview_window("main") else {
        return answer(dir, id, false, json!("the app has no main window"));
    };
    if let Some(script) = request["eval"].as_str() {
        let wrapped = format!(
            r#"(async () => {{
  const done = (ok, value) => window.__TAURI_INTERNALS__.invoke("devdrive_done", {{ id: {id}, ok, value }});
  try {{
    const value = await (async () => {{ {script}
    }})();
    await done(true, value === undefined ? null : JSON.parse(JSON.stringify(value)));
  }} catch (error) {{
    await done(false, String(error && error.stack ? error.stack : error));
  }}
}})();"#,
            id = json!(id),
        );
        if let Err(error) = window.eval(&wrapped) {
            answer(dir, id, false, json!(format!("the window refused the script: {error}")));
        }
    } else if let Some(path) = request["snapshot"].as_str() {
        snapshot(&window, dir.to_path_buf(), id.to_string(), PathBuf::from(path));
    } else {
        answer(dir, id, false, json!("a request names either eval or snapshot"));
    }
}

fn answer(dir: &Path, id: &str, ok: bool, value: Value) {
    let partial = dir.join("out").join(format!("{id}.json.tmp"));
    let body = json!({"ok": ok, "value": value}).to_string();
    if std::fs::write(&partial, body).is_ok() {
        let _ = std::fs::rename(&partial, dir.join("out").join(format!("{id}.json")));
    }
}

/// Where a script's result comes back to.
#[tauri::command]
pub fn devdrive_done(id: String, ok: bool, value: Value) -> Result<(), String> {
    let dir = DRIVE_DIR.get().ok_or("the app is not being driven")?;
    if id.is_empty() || id.contains(['/', '\\']) || id.starts_with('.') {
        return Err("that is not a request's name".into());
    }
    answer(dir, &id, ok, value);
    Ok(())
}

#[cfg(target_os = "macos")]
fn snapshot(window: &tauri::WebviewWindow, dir: PathBuf, id: String, path: PathBuf) {
    use block2::RcBlock;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;

    let fail_dir = dir.clone();
    let fail_id = id.clone();
    let result = window.with_webview(move |webview| {
        let written = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            // SAFETY: WebKit hands the block either an image or an error, each
            // alive for the block's call.
            let (image, error) = unsafe { (image.as_ref(), error.as_ref()) };
            let Some(image) = image else {
                let why = error.map(|e| e.localizedDescription().to_string()).unwrap_or_else(|| "no image".into());
                return answer(&dir, &id, false, json!(format!("the snapshot failed: {why}")));
            };
            let png = image
                .TIFFRepresentation()
                .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
                // SAFETY: an empty dictionary is a valid set of properties.
                .and_then(|rep| unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) });
            match png.map(|data| std::fs::write(&path, data.to_vec())) {
                Some(Ok(())) => answer(&dir, &id, true, json!(path)),
                Some(Err(e)) => answer(&dir, &id, false, json!(format!("could not write {}: {e}", path.display()))),
                None => answer(&dir, &id, false, json!("the snapshot could not be made a PNG")),
            }
        });
        // SAFETY: on macOS the platform webview is a WKWebView, and this runs
        // on the main thread, where `with_webview` calls it.
        unsafe {
            let wk: &WKWebView = &*webview.inner().cast();
            wk.takeSnapshotWithConfiguration_completionHandler(None, &written);
        }
    });
    if let Err(error) = result {
        answer(&fail_dir, &fail_id, false, json!(format!("the window could not be reached: {error}")));
    }
}

#[cfg(not(target_os = "macos"))]
fn snapshot(_window: &tauri::WebviewWindow, dir: PathBuf, id: String, _path: PathBuf) {
    answer(&dir, &id, false, json!("snapshots are made only on macOS"));
}
