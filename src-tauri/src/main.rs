// Entry point for the Tauri backend.
//
// Almost all the interesting logic for this app lives in the frontend
// (src/main.js + the pdf.js viewer it hosts). The Rust side here just
// wires up the two plugins we need:
//   - dialog: native "Open PDF" file picker
//   - fs:     reading the PDF bytes in, and writing the annotated
//             bytes back out on autosave

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running pdf-annotator");
}
