// Entry point for the Tauri backend.
//
// Almost all the interesting logic for this app lives in the frontend
// (src/main.js + the pdf.js viewer it hosts). The Rust side here just
// wires up the two plugins we need:
//   - dialog: native "Open PDF" file picker
//   - fs:     reading the PDF bytes in, and writing the annotated
//             bytes back out on autosave
// ...plus two small custom commands:
//   - get_os_username: the webview has no way to read the logged-in OS
//     account name itself, so this reads the USERNAME env var (set by
//     Windows for every session) and hands it back as the default for
//     the global "commenter name" setting.
//   - get_launch_path: when the app is launched by double-clicking a
//     PDF, via the "Open with" context menu, or as `pdf-annotator.exe
//     file.pdf` from a shell, Windows passes the file path as the first
//     command-line argument. There's deliberately no single-instance
//     handling (see tauri-plugin-single-instance) — each launch is a
//     fresh process with its own argv, which is what gives us multiple
//     independent windows instead of funnelling every open into one.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn get_os_username() -> Option<String> {
    std::env::var("USERNAME")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[tauri::command]
fn get_launch_path() -> Option<String> {
    std::env::args()
        .nth(1)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![get_os_username, get_launch_path])
        .run(tauri::generate_context!())
        .expect("error while running pdf-annotator");
}
