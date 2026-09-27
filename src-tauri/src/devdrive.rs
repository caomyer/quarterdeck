//! A development build's remote control, so an agent can play the captain in
//! the real app, against a real first mate, and see what the captain would see.
//!
//! The app's window is a WKWebView, which no browser automation reaches, and a
//! terminal is usually denied the screen-recording permission a window capture
//! needs. So the app drives itself: with `QUARTERDECK_DEVDRIVE=<dir>` in a debug
//! build it reads requests from `<dir>/in/<id>.json` and answers each in
//! `<dir>/out/<id>.json` as `{"ok": bool, "value": ...}`:
//!
//! - `{"eval": "<script>", "deadline_ms": <epoch ms>}` runs the script in the
//!   window as the body of an async function, so it may `await` and `return`;
//!   the value comes back as JSON, or the error's text when it throws. Past its
//!   deadline it does not run at all;
//! - `{"snapshot": "<absolute path>.png", "size": [width, height]}` writes what
//!   the window shows, the artifact frames included, through WebKit's own
//!   snapshot. `size` is the page's viewport: the webview reaches further than
//!   the page is laid out, and the snapshot would show that strip as blank.
//!
//! A release build never starts it.
//! `scripts/devtest.sh` brings up a scratch home with it and `scripts/drive.mjs`
//! is its client.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// How long the drive lets the page sit idle before it sends a script that does nothing.
const KEEP_WARM: Duration = Duration::from_secs(10);

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
    stay_awake(&app);
    log::info!("driven from {}", dir.display());
    std::thread::spawn(move || {
        let mut warmed = std::time::Instant::now();
        loop {
            for (id, request) in take_requests(&dir.join("in")) {
                handle(&app, &dir, &id, request);
                warmed = std::time::Instant::now();
            }
            // Even with every switch off, macOS parks a hidden page that has
            // nothing to do and takes up to a minute to wake it for the next
            // request. A script that does nothing, now and then, keeps it warm.
            if warmed.elapsed() > KEEP_WARM {
                if let Some(window) = app.get_webview_window("main") {
                    eval(&window, dir.clone(), String::new(), "return 0");
                }
                warmed = std::time::Instant::now();
            }
            std::thread::sleep(Duration::from_millis(100));
        }
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
        // A script whose caller stopped waiting must not run later, when the
        // page wakes: a message typed and sent then would go twice.
        let script = match request["deadline_ms"].as_u64() {
            Some(deadline) => format!("if (Date.now() > {deadline}) throw new Error(\"expired before the page could run it\");\n{script}"),
            None => script.to_string(),
        };
        eval(&window, dir.to_path_buf(), id.to_string(), &script);
    } else if let Some(path) = request["snapshot"].as_str() {
        let size = request["size"].as_array().and_then(|size| Some((size.first()?.as_f64()?, size.get(1)?.as_f64()?)));
        snapshot(&window, dir.to_path_buf(), id.to_string(), PathBuf::from(path), size);
    } else {
        answer(dir, id, false, json!("a request names either eval or snapshot"));
    }
}

fn answer(dir: &Path, id: &str, ok: bool, value: Value) {
    // The keep-warm script has no name, and nobody waits for it.
    if id.is_empty() {
        return;
    }
    let partial = dir.join("out").join(format!("{id}.json.tmp"));
    let body = json!({"ok": ok, "value": value}).to_string();
    if std::fs::write(&partial, body).is_ok() {
        let _ = std::fs::rename(&partial, dir.join("out").join(format!("{id}.json")));
    }
}

/// A driven app usually sits behind other windows, on another Space or under
/// a locked screen. There App Nap slows it, and WebKit suspends the page's
/// process whatever the window's throttling policy says, so a script would wait
/// until someone looked. WebKit's window-occlusion detection is what decides
/// the page is hidden; a debug build may turn that private switch off, and a
/// WebKit without it is logged rather than trusted.
#[cfg(target_os = "macos")]
fn stay_awake(app: &AppHandle) {
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{msg_send, sel};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
        NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
        &NSString::from_str("driven by scripts/drive.mjs"),
    );
    // Held for the app's whole life: dropping it would end the activity.
    std::mem::forget(activity);
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.with_webview(|webview| {
        // SAFETY: on macOS the platform webview is a WKWebView, an object that
        // answers respondsToSelector:, and the switch is sent only when it exists.
        unsafe {
            let wk: &AnyObject = &*webview.inner().cast();
            let configuration: *mut AnyObject = msg_send![wk, configuration];
            let preferences: *mut AnyObject = msg_send![configuration, preferences];
            // Each switch off, where this WebKit has it.
            macro_rules! off {
                ($target:expr, $switch:ident) => {{
                    let target: &AnyObject = $target;
                    let exists: Bool = msg_send![target, respondsToSelector: sel!($switch:)];
                    if exists.as_bool() {
                        let _: () = msg_send![target, $switch: Bool::NO];
                    } else {
                        log::warn!("this WebKit has no {}, so a hidden window may stop answering; drive it while it is visible", stringify!($switch));
                    }
                }};
            }
            off!(wk, _setWindowOcclusionDetectionEnabled);
            off!(&*preferences, _setPageVisibilityBasedProcessSuppressionEnabled);
            off!(&*preferences, _setHiddenPageDOMTimerThrottlingEnabled);
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn stay_awake(_app: &AppHandle) {}

/// Runs a script through WebKit itself, which awaits the promise it returns and
/// hands back the result: nothing of the app's own IPC is involved, and nothing
/// is exposed to the page.
#[cfg(target_os = "macos")]
fn eval(window: &tauri::WebviewWindow, dir: PathBuf, id: String, script: &str) {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::MainThreadMarker;
    use objc2_foundation::{NSError, NSString};
    use objc2_web_kit::{WKContentWorld, WKWebView};

    // The value comes back as JSON text, so WebKit only ever converts a string.
    let body = format!(
        "try {{ const value = await (async () => {{ {script}\n }})(); return JSON.stringify({{ ok: true, value: value === undefined ? null : value }}); }} catch (error) {{ return JSON.stringify({{ ok: false, value: String(error && error.stack ? error.stack : error) }}); }}"
    );
    let fail_dir = dir.clone();
    let fail_id = id.clone();
    let result = window.with_webview(move |webview| {
        let Some(mtm) = MainThreadMarker::new() else {
            return answer(&dir, &id, false, json!("the window was reached off its main thread"));
        };
        let done = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
            // SAFETY: WebKit hands the block a result or an error, each alive
            // for the block's call; the script returns a string or throws.
            let (value, error) = unsafe { (value.as_ref(), error.as_ref()) };
            let text = value.and_then(|value| value.downcast_ref::<NSString>()).map(NSString::to_string);
            match (text.and_then(|text| serde_json::from_str::<Value>(&text).ok()), error) {
                (Some(reply), _) => answer(&dir, &id, reply["ok"].as_bool().unwrap_or(false), reply["value"].clone()),
                (None, Some(error)) => answer(&dir, &id, false, json!(error.localizedDescription().to_string())),
                (None, None) => answer(&dir, &id, false, json!("the script returned nothing WebKit could hand back")),
            }
        });
        // SAFETY: on macOS the platform webview is a WKWebView, and this runs
        // on the main thread, where `with_webview` calls it.
        unsafe {
            let wk: &WKWebView = &*webview.inner().cast();
            wk.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                &NSString::from_str(&body),
                None,
                None,
                &WKContentWorld::pageWorld(mtm),
                Some(&done),
            );
        }
    });
    if let Err(error) = result {
        answer(&fail_dir, &fail_id, false, json!(format!("the window could not be reached: {error}")));
    }
}

#[cfg(not(target_os = "macos"))]
fn eval(_window: &tauri::WebviewWindow, dir: PathBuf, id: String, _script: &str) {
    answer(&dir, &id, false, json!("the drive runs only on macOS"));
}

#[cfg(target_os = "macos")]
fn snapshot(window: &tauri::WebviewWindow, dir: PathBuf, id: String, path: PathBuf, size: Option<(f64, f64)>) {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

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
            let config = size.and_then(|(width, height)| {
                let config = WKSnapshotConfiguration::new(MainThreadMarker::new()?);
                config.setRect(CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(width, height)));
                Some(config)
            });
            wk.takeSnapshotWithConfiguration_completionHandler(config.as_deref(), &written);
        }
    });
    if let Err(error) = result {
        answer(&fail_dir, &fail_id, false, json!(format!("the window could not be reached: {error}")));
    }
}

#[cfg(not(target_os = "macos"))]
fn snapshot(_window: &tauri::WebviewWindow, dir: PathBuf, id: String, _path: PathBuf, _size: Option<(f64, f64)>) {
    answer(&dir, &id, false, json!("snapshots are made only on macOS"));
}
