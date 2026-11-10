// Phase 1 keeps the native side minimal: window + link opener.
// Later phases add native audio capture (recorder), file-system access (notes)
// and the Spotify OAuth callback here.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running Omni");
}
