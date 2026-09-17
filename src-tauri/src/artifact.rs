//! Review artifacts: the pages the first mate and its crew present with
//! firstmate's `bin/fm-artifact.sh`, served to the review screen.
//!
//! The `artifact` URL scheme serves one presented revision's files from the
//! saved home's data folder, read-only:
//!
//!   artifact://localhost/task/<task-id>/<name>/rev-<n>/<file path>
//!   artifact://localhost/chat/<name>/rev-<n>/<file path>
//!
//! which map to `data/<task-id>/artifacts/<name>/rev-<n>/files/<file path>`
//! and `data/.artifacts/<name>/rev-<n>/files/<file path>`. firstmate's script
//! owns that layout. Only a complete revision (one with `revision.json`) is
//! served, never a dotfile or anything that resolves outside its `files`
//! folder, and every refusal is a plain 404 that names nothing on disk. The
//! review screen loads these pages in a sandboxed frame without same-origin
//! access, so a page can reach the network but never the app.
//!
//! Starting the first mate in a home that can present artifacts also records
//! `quarterdeck` in its `config/presentation`, unless the home already names a
//! mode, so its scouts present here instead of in a browser.

use std::path::{Component, Path, PathBuf};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Runtime, UriSchemeContext, UriSchemeResponder};

pub const SCHEME: &str = "artifact";

/// Why a request was refused; only ever logged, never shown to the page.
#[derive(Debug, PartialEq)]
pub enum Refusal {
    Malformed,
    Incomplete,
    Missing,
}

fn valid_task_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('.')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 64
        && chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn valid_rev(rev: &str) -> bool {
    rev.strip_prefix("rev-")
        .is_some_and(|n| !n.is_empty() && n.len() <= 9 && n.chars().all(|c| c.is_ascii_digit()) && !n.starts_with('0'))
}

fn percent_decode(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = segment.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The file on disk a request path names, inside the home's data folder.
pub fn resolve(data: &Path, request_path: &str) -> Result<PathBuf, Refusal> {
    let mut segments = Vec::new();
    for raw in request_path.trim_start_matches('/').split('/') {
        let segment = percent_decode(raw).ok_or(Refusal::Malformed)?;
        if segment.is_empty() || segment.starts_with('.') || segment.contains(['/', '\\', '\0']) {
            return Err(Refusal::Malformed);
        }
        segments.push(segment);
    }
    let (artifact_dir, rest) = match segments.first().map(String::as_str) {
        Some("task") if segments.len() >= 5 && valid_task_id(&segments[1]) && valid_name(&segments[2]) => {
            (data.join(&segments[1]).join("artifacts").join(&segments[2]), &segments[3..])
        }
        Some("chat") if segments.len() >= 4 && valid_name(&segments[1]) => (data.join(".artifacts").join(&segments[1]), &segments[2..]),
        _ => return Err(Refusal::Malformed),
    };
    let (rev, file) = rest.split_first().ok_or(Refusal::Malformed)?;
    if !valid_rev(rev) || file.is_empty() {
        return Err(Refusal::Malformed);
    }
    let revision = artifact_dir.join(rev);
    if !revision.join("revision.json").is_file() {
        return Err(Refusal::Incomplete);
    }
    let files = std::fs::canonicalize(revision.join("files")).map_err(|_| Refusal::Missing)?;
    let wanted: PathBuf = file.iter().collect();
    if wanted.components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err(Refusal::Malformed);
    }
    let found = std::fs::canonicalize(files.join(wanted)).map_err(|_| Refusal::Missing)?;
    if !found.starts_with(&files) || !found.is_file() {
        return Err(Refusal::Missing);
    }
    Ok(found)
}

fn content_type(path: &Path) -> &'static str {
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" | "md" => "text/plain; charset=utf-8",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(b"Not found".to_vec())
        .unwrap_or_default()
}

fn serve(data: Option<PathBuf>, request_path: &str) -> Response<Vec<u8>> {
    let Some(data) = data else { return not_found() };
    let path = match resolve(&data, request_path) {
        Ok(path) => path,
        Err(refusal) => {
            log::info!("artifact request refused ({refusal:?}): {request_path}");
            return not_found();
        }
    };
    match std::fs::read(&path) {
        Ok(body) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type(&path))
            // The page runs in an opaque origin, so its own module scripts and fonts are cross-origin requests.
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            // A revision never changes once presented.
            .header(header::CACHE_CONTROL, "private, max-age=31536000, immutable")
            .body(body)
            .unwrap_or_else(|_| not_found()),
        Err(error) => {
            log::warn!("could not read artifact file {}: {error}", path.display());
            not_found()
        }
    }
}

/// Handler for the `artifact` scheme. Files are read off the webview's thread.
pub fn handle<R: Runtime>(context: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let data = crate::settings::saved_home(context.app_handle()).map(|home| home.join("data"));
    let request_path = request.uri().path().to_string();
    tauri::async_runtime::spawn_blocking(move || responder.respond(serve(data, &request_path)));
}

/// What starting in a home did about its presentation mode.
#[derive(Debug, PartialEq)]
pub enum Presentation {
    /// The home predates `bin/fm-artifact.sh`, so it keeps presenting however it did.
    Unsupported,
    /// The home already names a mode, which is the captain's to change.
    AlreadySet,
    Claimed,
}

/// Records `quarterdeck` in the home's `config/presentation` when the home can
/// present artifacts and names no mode yet. Written to a temporary file and
/// renamed, so a crash never leaves half a file.
pub fn claim_presentation(home: &Path) -> Result<Presentation, String> {
    if !home.join("bin").join("fm-artifact.sh").is_file() {
        return Ok(Presentation::Unsupported);
    }
    let config = home.join("config");
    let target = config.join("presentation");
    if target.exists() {
        return Ok(Presentation::AlreadySet);
    }
    std::fs::create_dir_all(&config).map_err(|e| format!("could not create {}: {e}", config.display()))?;
    let temporary = config.join(".presentation.quarterdeck.tmp");
    std::fs::write(&temporary, "quarterdeck\n").map_err(|e| format!("could not write {}: {e}", temporary.display()))?;
    std::fs::rename(&temporary, &target).map_err(|e| format!("could not save {}: {e}", target.display()))?;
    Ok(Presentation::Claimed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fm-artifact-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    /// A data folder with one complete task revision, one chat revision, and one revision still being written.
    fn store(name: &str) -> PathBuf {
        let data = scratch(name);
        let files = data.join("t1/artifacts/plan/rev-2/files");
        std::fs::create_dir_all(files.join("img")).unwrap();
        std::fs::write(files.join("My Plan.html"), "<h1>Plan</h1>").unwrap();
        std::fs::write(files.join("img/a.png"), "png").unwrap();
        std::fs::write(files.join(".hidden"), "secret").unwrap();
        std::fs::write(data.join("t1/artifacts/plan/rev-2/revision.json"), "{}").unwrap();
        std::fs::create_dir_all(data.join(".artifacts/board/rev-1/files")).unwrap();
        std::fs::write(data.join(".artifacts/board/rev-1/files/board.html"), "board").unwrap();
        std::fs::write(data.join(".artifacts/board/rev-1/revision.json"), "{}").unwrap();
        std::fs::create_dir_all(data.join("t1/artifacts/plan/rev-3/files")).unwrap();
        std::fs::write(data.join("t1/artifacts/plan/rev-3/files/My Plan.html"), "half").unwrap();
        std::fs::write(data.join("t1/report.md"), "report").unwrap();
        data
    }

    #[test]
    fn a_complete_revision_serves_its_files() {
        let data = store("serve");
        let files = data.join("t1/artifacts/plan/rev-2/files");
        assert_eq!(resolve(&data, "/task/t1/plan/rev-2/My%20Plan.html"), Ok(files.join("My Plan.html")));
        assert_eq!(resolve(&data, "/task/t1/plan/rev-2/img/a.png"), Ok(files.join("img/a.png")));
        assert_eq!(resolve(&data, "/chat/board/rev-1/board.html"), Ok(data.join(".artifacts/board/rev-1/files/board.html")));
        let response = serve(Some(data.clone()), "/task/t1/plan/rev-2/My%20Plan.html");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "text/html; charset=utf-8");
        assert_eq!(response.body(), b"<h1>Plan</h1>");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn nothing_outside_a_complete_revision_is_served() {
        let data = store("refuse");
        let outside = scratch("refuse-outside");
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), data.join("t1/artifacts/plan/rev-2/files/link.txt")).unwrap();
        for (path, refusal) in [
            ("/task/t1/plan/rev-3/My%20Plan.html", Refusal::Incomplete),
            ("/task/t1/plan/rev-2/link.txt", Refusal::Missing),
            ("/task/t1/plan/rev-2/missing.html", Refusal::Missing),
            ("/task/t1/plan/rev-2/img", Refusal::Missing),
            ("/task/t1/plan/rev-2/.hidden", Refusal::Malformed),
            ("/task/t1/plan/rev-2/%2Ehidden", Refusal::Malformed),
            ("/task/t1/plan/rev-2/../../../report.md", Refusal::Malformed),
            ("/task/t1/plan/rev-2/%2E%2E/%2E%2E/%2E%2E/report.md", Refusal::Malformed),
            ("/task/t1/plan/rev-2/img%2F..%2F..%2Frevision.json", Refusal::Malformed),
            ("/task/t1/plan/rev-2/img%5Ca.png", Refusal::Malformed),
            ("/task/t1/plan/rev-2//My%20Plan.html", Refusal::Malformed),
            ("/task/t1/plan/rev-2/bad%zz", Refusal::Malformed),
            ("/task/t1/plan/rev-2", Refusal::Malformed),
            ("/task/t1/plan/rev-02/My%20Plan.html", Refusal::Malformed),
            ("/task/t1/Plan/rev-2/My%20Plan.html", Refusal::Malformed),
            ("/task/.t1/plan/rev-2/My%20Plan.html", Refusal::Malformed),
            ("/chat/board/rev-1", Refusal::Malformed),
            ("/files/t1/plan/rev-2/My%20Plan.html", Refusal::Malformed),
            ("/", Refusal::Malformed),
        ] {
            assert_eq!(resolve(&data, path), Err(refusal), "{path}");
        }
        let response = serve(Some(data.clone()), "/task/t1/plan/rev-2/link.txt");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response.body(), b"Not found");
        assert_eq!(serve(None, "/task/t1/plan/rev-2/My%20Plan.html").status(), StatusCode::NOT_FOUND);
        let _ = std::fs::remove_dir_all(data);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn starting_claims_presentation_only_where_it_is_supported_and_unset() {
        let home = scratch("presentation");
        assert_eq!(claim_presentation(&home), Ok(Presentation::Unsupported));
        assert!(!home.join("config/presentation").exists());

        std::fs::create_dir_all(home.join("bin")).unwrap();
        std::fs::write(home.join("bin/fm-artifact.sh"), "#!/bin/sh\n").unwrap();
        assert_eq!(claim_presentation(&home), Ok(Presentation::Claimed));
        assert_eq!(std::fs::read_to_string(home.join("config/presentation")).unwrap(), "quarterdeck\n");
        assert!(!home.join("config/.presentation.quarterdeck.tmp").exists());

        std::fs::write(home.join("config/presentation"), "lavish\n").unwrap();
        assert_eq!(claim_presentation(&home), Ok(Presentation::AlreadySet));
        assert_eq!(std::fs::read_to_string(home.join("config/presentation")).unwrap(), "lavish\n");
        let _ = std::fs::remove_dir_all(home);
    }
}
