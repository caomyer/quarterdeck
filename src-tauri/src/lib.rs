mod envpath;
mod host;
mod snapshot;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
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
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      host::host_start,
      host::host_stop,
      host::host_restart,
      host::send,
      host::get_state,
      snapshot::snapshot_refresh,
      snapshot::pane_capture,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
