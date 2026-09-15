mod envpath;
mod host;
#[cfg(test)]
mod host_e2e;
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
      host::cancel_turn,
      host::get_state,
      snapshot::snapshot_refresh,
      snapshot::pane_capture,
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
