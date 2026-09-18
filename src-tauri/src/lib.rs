mod artifact;
mod envpath;
mod host;
#[cfg(test)]
mod host_e2e;
mod review;
mod settings;
mod snapshot;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .register_asynchronous_uri_scheme_protocol(artifact::SCHEME, artifact::handle)
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // Resolve the login shell PATH off the main thread before the first child needs it.
      std::thread::spawn(|| {
        let _ = envpath::search_path();
      });
      app.manage(snapshot::SnapshotHandle::spawn(app.handle().clone()));
      app.manage(host::HostHandle::spawn(app.handle().clone()));
      app.manage(review::Writes::default());
      settings::load_saved_home(app.handle().clone());
      // macOS ignores the config's `maximized` when it creates the window, which
      // leaves a fixed 1440x900 window taller than a smaller screen, with the
      // sidebar's footer behind the Dock. Asking once the window exists works.
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.maximize();
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      host::host_start,
      host::host_stop,
      host::host_restart,
      host::send,
      host::cancel_turn,
      host::get_state,
      host::answer_permission,
      settings::home_get,
      settings::home_choose,
      snapshot::snapshot_refresh,
      snapshot::snapshot_latest,
      snapshot::pane_capture,
      review::review_get,
      review::review_comment,
      review::review_discard,
      review::review_submit,
      review::review_settle,
      review::review_seen,
      review::review_summary,
      review::review_answer,
      review::review_scene,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      // Closing the last window or quitting ends here: stop the first mate's
      // whole process group so nothing it started outlives the app.
      if let tauri::RunEvent::Exit = event {
        if let Some(host) = app.try_state::<host::HostHandle>() {
          host.kill_on_exit();
        }
      }
    });
}
