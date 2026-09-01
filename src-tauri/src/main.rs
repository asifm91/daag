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
//     PDF, via the "Open with" context menu, or as `daag.exe
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
//   - summarize_comments / cancel_summarize: POST the document's comments
//     to a user-configured OpenAI-compatible /chat/completions endpoint
//     and return the model's summary; cancel_summarize aborts an
//     in-flight request (dropping the connection so a local model stops
//     generating). Done here rather than with fetch() in the webview so it
//     sidesteps CORS entirely and any API key never enters the renderer.
//     Cross-platform (no #[cfg]).

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

// ---- AI comment summary -------------------------------------------------
// Sends the document's comments to any OpenAI-compatible
// `/chat/completions` endpoint (local Ollama by default — see the AI
// settings section in src/main.js) and hands the summary back. The
// front-end builds both prompt strings; this just does the HTTP so the
// webview never makes the cross-origin call and never holds the API key.

#[derive(serde::Deserialize)]
struct ChatMessageOut {
    content: Option<String>,
}

#[derive(serde::Deserialize)]
struct ChatChoiceOut {
    message: ChatMessageOut,
}

#[derive(serde::Deserialize)]
struct ChatResponseOut {
    choices: Vec<ChatChoiceOut>,
}

fn truncate_message(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

/// Turn an error response body into a short, human-readable line. Handles
/// the OpenAI shape (`{"error": {"message": ...}}`), the Ollama shape
/// (`{"error": "model ... not found"}`), and a couple of other common
/// `{"message"|"detail": ...}` shapes; otherwise falls back to a terse
/// status-based sentence rather than dumping the raw JSON at the user.
fn concise_http_error(status: reqwest::StatusCode, body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        let msg = v
            .get("error")
            .and_then(|e| {
                e.as_str()
                    .map(str::to_string)
                    .or_else(|| e.get("message").and_then(|m| m.as_str()).map(str::to_string))
            })
            .or_else(|| v.get("message").and_then(|m| m.as_str()).map(str::to_string))
            .or_else(|| v.get("detail").and_then(|m| m.as_str()).map(str::to_string));
        if let Some(m) = msg {
            if !m.trim().is_empty() {
                return truncate_message(&m, 300);
            }
        }
    }
    match status.as_u16() {
        400 => "The AI endpoint rejected the request (400). Check the model name.".to_string(),
        401 | 403 => "The AI endpoint rejected the API key.".to_string(),
        404 => "The AI endpoint or model was not found. Check the endpoint URL and model name.".to_string(),
        429 => "The AI endpoint is rate-limiting requests. Try again shortly.".to_string(),
        500..=599 => format!("The AI endpoint reported a server error ({}).", status.as_u16()),
        other => format!("The AI endpoint returned HTTP {other}."),
    }
}

// Holds the currently-running summary task so cancel_summarize can abort
// it. Single-flight is enforced on the JS side; the generation id only
// keeps summarize_comments from clearing a slot a newer request claimed.
#[derive(Default)]
struct SummaryTask {
    current: std::sync::Mutex<Option<(u64, tauri::async_runtime::JoinHandle<()>)>>,
    next_id: std::sync::atomic::AtomicU64,
}

#[tauri::command]
async fn summarize_comments(
    task: tauri::State<'_, SummaryTask>,
    base_url: String,
    api_key: Option<String>,
    model: String,
    system_prompt: String,
    user_prompt: String,
) -> Result<String, String> {
    let id = task
        .next_id
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    // Run the request on its own task so an abort() actually drops the
    // in-flight reqwest future (closing the connection, which stops a
    // local model mid-generation) instead of just detaching from it.
    let (tx, mut rx) = tauri::async_runtime::channel::<Result<String, String>>(1);
    let handle = tauri::async_runtime::spawn(async move {
        let result =
            run_chat_request(base_url, api_key, model, system_prompt, user_prompt).await;
        let _ = tx.send(result).await;
    });

    if let Some((_, stale)) = task.current.lock().unwrap().replace((id, handle)) {
        stale.abort();
    }

    let outcome = match rx.recv().await {
        Some(result) => result,
        // Sender dropped without sending -> the task was aborted.
        None => Err("Summary cancelled.".to_string()),
    };

    let mut guard = task.current.lock().unwrap();
    if guard.as_ref().map(|(cur, _)| *cur == id).unwrap_or(false) {
        *guard = None;
    }

    outcome
}

#[tauri::command]
fn cancel_summarize(task: tauri::State<'_, SummaryTask>) {
    if let Some((_, handle)) = task.current.lock().unwrap().take() {
        handle.abort();
    }
}

async fn run_chat_request(
    base_url: String,
    api_key: Option<String>,
    model: String,
    system_prompt: String,
    user_prompt: String,
) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("No AI endpoint is configured. Set one in Settings.".into());
    }
    let url = format!("{base}/chat/completions");

    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt },
        ],
        "stream": false,
        "temperature": 0.2,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("Could not create the HTTP client: {e}"))?;

    let mut req = client.post(&url).json(&body);
    if let Some(key) = api_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
    {
        req = req.bearer_auth(key);
    }

    let resp = req.send().await.map_err(|e| {
        if e.is_timeout() {
            format!("The AI endpoint at {base} timed out. The model may be too slow, or not running.")
        } else if e.is_connect() {
            format!("Could not connect to the AI endpoint at {base}. Is the server running?")
        } else {
            format!("Could not reach the AI endpoint at {base}.")
        }
    })?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|_| "Could not read the response from the AI endpoint.".to_string())?;

    if !status.is_success() {
        return Err(concise_http_error(status, &text));
    }

    let parsed: ChatResponseOut = serde_json::from_str(&text)
        .map_err(|_| "The AI endpoint returned an unexpected response format.".to_string())?;

    parsed
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.message.content)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "The AI endpoint returned an empty summary.".into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(SummaryTask::default())
        .invoke_handler(tauri::generate_handler![
            get_os_username,
            get_launch_path,
            long_paths_enabled,
            enable_long_paths,
            open_external,
            summarize_comments,
            cancel_summarize
        ])
        .run(tauri::generate_context!())
        .expect("error while running Daag");
}
