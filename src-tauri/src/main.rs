// Entry point for the Tauri backend.
//
// Almost all the interesting logic for this app lives in the frontend
// (src/main.js + the pdf.js viewer it hosts). The Rust side here just
// wires up the two plugins we need:
//   - dialog: native "Open PDF" file picker
//   - fs:     reading the PDF bytes in, and writing the annotated
//             bytes back out on autosave
// ...plus a handful of small custom commands:
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
//   - long_paths_enabled / enable_long_paths: read and (with an elevation
//     prompt) set the machine-wide HKLM\...\FileSystem\LongPathsEnabled
//     registry value. Together with the `longPathAware` manifest entry
//     (see build.rs) this is what lets drag-and-drop accept PDFs whose
//     full path exceeds 259 chars. Surfaced in the app's Settings dialog.
//   - open_external: open an https:// link in the system browser (used
//     by the "why administrator access is needed" link next to the
//     long-path toggle). Avoids pulling in tauri-plugin-opener for one
//     link.

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

// CreateProcess flag that keeps a spawned console program (reg.exe,
// powershell.exe, rundll32.exe) from flashing a console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
const LONG_PATHS_KEY: &str = r"HKLM\SYSTEM\CurrentControlSet\Control\FileSystem";

/// `Some(true)`  — LongPathsEnabled is 1 (long paths active machine-wide).
/// `Some(false)` — the value is 0 or the value/key is absent.
/// `None`        — couldn't run `reg` to find out.
#[cfg(windows)]
#[tauri::command]
fn long_paths_enabled() -> Option<bool> {
    use std::os::windows::process::CommandExt;

    let out = std::process::Command::new("reg")
        .args(["query", LONG_PATHS_KEY, "/v", "LongPathsEnabled"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;

    if !out.status.success() {
        // Non-zero exit from `reg query` means the value isn't there.
        return Some(false);
    }

    // A matching line looks like:
    //     LongPathsEnabled    REG_DWORD    0x1
    let stdout = String::from_utf8_lossy(&out.stdout);
    let enabled = stdout
        .lines()
        .find(|line| line.contains("LongPathsEnabled"))
        .and_then(|line| line.split_whitespace().last())
        .map(|token| token.eq_ignore_ascii_case("0x1"))
        .unwrap_or(false);
    Some(enabled)
}

#[cfg(not(windows))]
#[tauri::command]
fn long_paths_enabled() -> Option<bool> {
    None
}

/// Set LongPathsEnabled to 1. Writing under HKLM needs elevation, so this
/// shells out to PowerShell's `Start-Process -Verb RunAs`, which raises the
/// UAC prompt. Returns `Err` if the prompt is declined or the write fails.
#[cfg(windows)]
#[tauri::command]
fn enable_long_paths() -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    // One elevated `reg add`. -PassThru + exiting with the child's own
    // exit code so a genuine failure is distinguishable from success; the
    // catch turns a declined UAC prompt (a terminating error) into exit 1.
    let script = "try { \
$p = Start-Process -FilePath reg.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop \
-ArgumentList 'add','HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem','/v','LongPathsEnabled','/t','REG_DWORD','/d','1','/f'; \
exit $p.ExitCode \
} catch { exit 1 }";

    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| format!("Could not launch the elevation prompt: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Administrator approval was declined or the registry update failed.".into())
    }
}

#[cfg(not(windows))]
#[tauri::command]
fn enable_long_paths() -> Result<(), String> {
    Err("Long path support is a Windows-only setting.".into())
}

/// Open an `https://` URL in the system default browser.
#[cfg(windows)]
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    if !url.starts_with("https://") {
        return Err("Only https:// links can be opened.".into());
    }

    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Could not open the link: {e}"))?;
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
fn open_external(_url: String) -> Result<(), String> {
    Err("Opening external links is only supported on Windows.".into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            get_os_username,
            get_launch_path,
            long_paths_enabled,
            enable_long_paths,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running pdf-annotator");
}
