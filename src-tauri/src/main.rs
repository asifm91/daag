// Entry point for the Tauri backend.
//
// Almost all the interesting logic for this app lives in the frontend
// (src/main.js + the pdf.js viewer it hosts). The Rust side here just
// wires up the two plugins we need:
//   - dialog: native "Open PDF" file picker
//   - fs:     reading the PDF bytes in, and writing the annotated
//             bytes back out on autosave
// ...plus one small custom command: the webview has no way to read the
// logged-in OS account name itself, so `get_os_username` reads the
// USERNAME env var (set by Windows for every session) and hands it back
// as the default for the global "commenter name" setting.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn get_os_username() -> Option<String> {
    std::env::var("USERNAME")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![get_os_username])
        .run(tauri::generate_context!())
        .expect("error while running pdf-annotator");
}
