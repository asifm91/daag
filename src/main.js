import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile, rename, exists, readDir } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { dirname, basename, join } from "@tauri-apps/api/path";
import { getVersion } from "@tauri-apps/api/app";
import { check as checkTauriUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
// Default AI summary system prompt — kept in its own plain-text file rather
// than inline so it's easy to read and tweak. `?raw` inlines it at build.
import DEFAULT_SUMMARY_SYSTEM_PROMPT from "./summary-system-prompt.txt?raw";

// ---- State -----------------------------------------------------------
let currentPath = null; // absolute path of the PDF currently open
let dirty = false; // true if there are unsaved annotation changes
let saveInFlight = false;
let autosaveTimer = null;
// Pristine bytes of currentPath as of the moment it was opened THIS
// session — i.e. before any edit made through this app touched it. Powers
// "Undo All" (see revertToSessionStart below): reverting doesn't walk
// pdf.js's undo stack (which has its own documented gaps — see
// attachUndoRedoHook), it just reloads the document from this snapshot,
// which uniformly undoes every kind of edit at once, including ones
// already autosaved to disk this session.
let sessionOriginalBytes = null;

// Folder-scoped Previous/Next navigation (see refreshFolderNavigation below).
// Recomputed on every open rather than cached indefinitely, so it self-heals
// if files are added/removed/renamed in the folder between navigations.
let folderPdfDir = null; // absolute path of currentPath's containing folder
let folderPdfList = []; // sorted filenames (not full paths) ending in .pdf
let folderPdfIndex = -1; // index of currentPath's file within folderPdfList

const AUTOSAVE_DEBOUNCE_MS = 4000; // save 4s after the last edit
const AUTOSAVE_MAX_WAIT_MS = 20000; // ...but never wait longer than this
// The summary dialog's Stop button ignores clicks for this long after a
// run starts, so a double-click on Regenerate can't immediately kill the
// request it just began (Regenerate → Stop swap in place).
const STOP_BUTTON_ARM_MS = 800;
const RECENT_FILES_KEY = "pdfAnnotator.recentFiles";
const MAX_RECENT_FILES = 8;
const MAX_LOG_ENTRIES = 200;
// The window/titlebar title with no document open — matches
// tauri.conf.json's configured title and index.html's #titlebarTitle text.
const DEFAULT_WINDOW_TITLE = "দাগ — Daag";
// Frequency-ranked short review phrases surfaced on right-click / Q in the
// viewer — see the "Quick comments" section below. Never seeded.
const QUICK_COMMENTS_KEY = "pdfAnnotator.quickComments";
const MAX_QUICK_COMMENT_MENU_ITEMS = 12;
const COMMENTER_NAME_KEY = "pdfAnnotator.commenterName";
const OPEN_MODE_KEY = "pdfAnnotator.openMode"; // "overwrite" | "ask" | "copy"
const COPY_MAPPINGS_KEY = "pdfAnnotator.copyMappings";
const THEME_KEY = "pdfAnnotator.theme"; // "default" | "light" | "dark"
const THEME_CYCLE = ["default", "light", "dark"];
// AI comment summary (see the "AI comment summary settings" section and
// summarizeComments() below). Endpoint/model fall back to a local Ollama
// server so the feature works with nothing configured and nothing leaves
// the machine by default.
const AI_ENDPOINT_KEY = "pdfAnnotator.aiEndpoint";
const AI_MODEL_KEY = "pdfAnnotator.aiModel";
const AI_API_KEY_KEY = "pdfAnnotator.aiApiKey";
// User override for the summary system prompt (Settings). Blank / unset =
// use the bundled default from summary-system-prompt.txt.
const AI_SYSTEM_PROMPT_KEY = "pdfAnnotator.aiSystemPrompt";
// Recently-used model names, most-recent-first, surfaced as a datalist so
// switching models doesn't mean retyping the whole name.
const AI_MODEL_HISTORY_KEY = "pdfAnnotator.aiModelHistory";
const MAX_AI_MODEL_HISTORY = 10;
const AI_ENDPOINT_DEFAULT = "http://localhost:11434/v1";
const AI_MODEL_DEFAULT = "llama3.2";
// Set right after the user enables Windows long path support from Settings;
// cleared on the next app start (a fresh process picks the setting up), so
// the Settings status can say "restart to apply" only while that's true.
const LONG_PATH_RESTART_PENDING_KEY = "pdfAnnotator.longPathRestartPending";
// learn.microsoft.com page describing MAX_PATH and how enabling long paths
// needs both the app manifest (we ship it — see build.rs) and this registry
// value, which is why turning it on needs administrator approval.
const LONG_PATH_DOC_URL =
  "https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation#enable-long-paths-in-windows-10-version-1607-and-later";
const OLLAMA_DOC_URL = "https://ollama.com/download";
// Auto-update. The updater plugin (see src-tauri) points at a GitHub
// release's latest.json; the check runs once, quietly, a few seconds after
// launch so it never competes with opening a document, and again on demand
// from Settings.
const UPDATE_STARTUP_CHECK_DELAY_MS = 4000;

// "default" keeps the original look (dark chrome, light pdf.js viewer —
// matches pdf.js's own default toolbar color); "light"/"dark" force both
// the outer chrome and the pdf.js viewer uniformly. Validated against
// THEME_CYCLE in case a future downgrade leaves a stale/unknown value.
let currentTheme = THEME_CYCLE.includes(localStorage.getItem(THEME_KEY))
  ? localStorage.getItem(THEME_KEY)
  : "default";

const bodyEl = document.body;
const titlebarEl = document.getElementById("titlebar");
const titlebarTitleEl = document.getElementById("titlebarTitle");
const titlebarDocActionsEl = document.getElementById("titlebarDocActions");
const titlebarOpenBtn = document.getElementById("titlebarOpenBtn");
const titlebarPrevBtn = document.getElementById("titlebarPrevBtn");
const titlebarNextBtn = document.getElementById("titlebarNextBtn");
const titlebarStatusBtn = document.getElementById("titlebarStatusBtn");
const titlebarSettingsBtn = document.getElementById("titlebarSettingsBtn");
const titlebarThemeBtn = document.getElementById("titlebarThemeBtn");
const titlebarMinimizeBtn = document.getElementById("titlebarMinimizeBtn");
const titlebarMaximizeBtn = document.getElementById("titlebarMaximizeBtn");
const titlebarCloseBtn = document.getElementById("titlebarCloseBtn");
const landingScreen = document.getElementById("landingScreen");
const viewerScreen = document.getElementById("viewerScreen");
const openBtn = document.getElementById("openBtn");
const landingSettingsBtn = document.getElementById("landingSettingsBtn");
const landingOpenModeWarningEl = document.getElementById("landingOpenModeWarning");
const landingStatusEl = document.getElementById("landingStatus");
const recentFilesListEl = document.getElementById("recentFilesList");
const toastContainerEl = document.getElementById("toastContainer");
const logDialogEl = document.getElementById("logDialog");
const logDialogCloseButtonEl = document.getElementById("logDialogCloseButton");
const logListEl = document.getElementById("logList");
const frame = document.getElementById("viewerFrame");
const settingsDialogEl = document.getElementById("settingsDialog");
const settingsDialogCloseButtonEl = document.getElementById("settingsDialogCloseButton");
const settingsDialogCancelButtonEl = document.getElementById("settingsDialogCancelButton");
const settingsDialogSaveButtonEl = document.getElementById("settingsDialogSaveButton");
const commenterNameInputEl = document.getElementById("commenterNameInput");
const openModeSelectEl = document.getElementById("openModeSelect");
const quickCommentsManageListEl = document.getElementById("quickCommentsManageList");
const longPathRowEl = document.getElementById("longPathRow");
const longPathStatusEl = document.getElementById("longPathStatus");
const enableLongPathButtonEl = document.getElementById("enableLongPathButton");
const longPathDocLinkEl = document.getElementById("longPathDocLink");
const updateStatusEl = document.getElementById("updateStatus");
const checkUpdateButtonEl = document.getElementById("checkUpdateButton");
const updateDialogEl = document.getElementById("updateDialog");
const updateDialogCloseButtonEl = document.getElementById("updateDialogCloseButton");
const updateDialogVersionLineEl = document.getElementById("updateDialogVersionLine");
const updateDialogNotesEl = document.getElementById("updateDialogNotes");
const updateDialogProgressEl = document.getElementById("updateDialogProgress");
const updateDialogProgressBarEl = document.querySelector("#updateDialogProgressTrack > span");
const updateDialogProgressTextEl = document.getElementById("updateDialogProgressText");
const updateDialogLaterButtonEl = document.getElementById("updateDialogLaterButton");
const updateDialogInstallButtonEl = document.getElementById("updateDialogInstallButton");
const aiEndpointInputEl = document.getElementById("aiEndpointInput");
const aiModelInputEl = document.getElementById("aiModelInput");
const aiApiKeyInputEl = document.getElementById("aiApiKeyInput");
const aiSystemPromptInputEl = document.getElementById("aiSystemPromptInput");
const aiSystemPromptRestoreButtonEl = document.getElementById("aiSystemPromptRestoreButton");
const aiModelHistoryListEl = document.getElementById("aiModelHistoryList");
const ollamaDocLinkEl = document.getElementById("ollamaDocLink");
const summaryDialogEl = document.getElementById("summaryDialog");
const summaryDialogCloseButtonEl = document.getElementById("summaryDialogCloseButton");
const summaryModelInputEl = document.getElementById("summaryModelInput");
const summaryDialogBodyEl = document.getElementById("summaryDialogBody");
const summaryDialogNoticeEl = document.getElementById("summaryDialogNotice");
const summaryDialogRegenerateButtonEl = document.getElementById("summaryDialogRegenerateButton");
const summaryDialogStopButtonEl = document.getElementById("summaryDialogStopButton");
const summaryDialogCopyButtonEl = document.getElementById("summaryDialogCopyButton");
const summaryDialogSaveButtonEl = document.getElementById("summaryDialogSaveButton");
const undoAllDialogEl = document.getElementById("undoAllDialog");
const undoAllDialogCloseButtonEl = document.getElementById("undoAllDialogCloseButton");
const undoAllDialogCancelButtonEl = document.getElementById("undoAllDialogCancelButton");
const undoAllDialogConfirmButtonEl = document.getElementById("undoAllDialogConfirmButton");
const undoAllStripAllCheckboxEl = document.getElementById("undoAllStripAllCheckbox");
const overwriteCopyDialogEl = document.getElementById("overwriteCopyDialog");
const overwriteCopyDialogCloseButtonEl = document.getElementById("overwriteCopyDialogCloseButton");
const overwriteCopyDialogCancelButtonEl = document.getElementById("overwriteCopyDialogCancelButton");
const overwriteCopyDialogOverwriteButtonEl = document.getElementById("overwriteCopyDialogOverwriteButton");
const overwriteCopyDialogCopyButtonEl = document.getElementById("overwriteCopyDialogCopyButton");
const overwriteCopyDialogRememberCheckboxEl = document.getElementById("overwriteCopyDialogRememberCheckbox");
const overwriteCopyDialogPathEl = document.getElementById("overwriteCopyDialogPath");
const continueOrStartOverDialogEl = document.getElementById("continueOrStartOverDialog");
const continueOrStartOverDialogCloseButtonEl = document.getElementById("continueOrStartOverDialogCloseButton");
const continueOrStartOverDialogCancelButtonEl = document.getElementById("continueOrStartOverDialogCancelButton");
const continueOrStartOverDialogStartOverButtonEl = document.getElementById("continueOrStartOverDialogStartOverButton");
const continueOrStartOverDialogContinueButtonEl = document.getElementById("continueOrStartOverDialogContinueButton");
const continueOrStartOverDialogPathEl = document.getElementById("continueOrStartOverDialogPath");

// ---- Status reporting ----------------------------------------------------
// Every status update — dirty/saving/saved/error, however minor — always
// goes to the console and the activity log (appendLogEntry), so the full
// history is there if you go looking (click the colored dot injected into
// pdf.js's toolbar; see injectStatusButton below). `toast` is opt-in per
// call site precisely because most of these fire far too often to pop up
// a notification for each one — "Unsaved changes…" on literally every
// edit — so it's reserved for things worth interrupting for: errors, and
// (via saveNow's `force` flag) a confirmation when *you* clicked Save,
// not for every unattended autosave tick.
function setStatus(text, kind = "", { toast = false } = {}) {
  (kind === "error" ? console.error : console.log)(`[status] ${text}`);
  appendLogEntry(text, kind);
  updateStatusIndicator(kind);
  if (toast) showToast(text, kind);
}

// Mirrors an error onto whichever screen is actually visible — openPath()
// can fail while either one is showing (a stale recent-files entry is
// clicked on the landing screen; a startup auto-reopen fails before the
// viewer screen is ever shown). landingStatusEl only exists on the
// landing screen; setStatus's toast covers the viewer-screen case.
function reportError(message) {
  setStatus(message, "error", { toast: true });
  landingStatusEl.textContent = message;
  landingStatusEl.className = "error";
}

function showToast(message, kind) {
  const toast = document.createElement("div");
  toast.className = kind === "error" ? "toast error" : "toast";
  toast.textContent = message;
  toast.title = "Click to dismiss";
  toast.addEventListener("click", () => toast.remove());
  toastContainerEl.appendChild(toast);
  setTimeout(() => toast.remove(), kind === "error" ? 6000 : 3500);
}

function appendLogEntry(text, kind) {
  const li = document.createElement("li");
  if (kind === "error") li.className = "error";
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = new Date().toLocaleTimeString();
  li.append(time, text);
  logListEl.appendChild(li);
  while (logListEl.children.length > MAX_LOG_ENTRIES) {
    logListEl.firstElementChild.remove();
  }
  if (logDialogEl.open) li.scrollIntoView({ block: "nearest" });
}

function openLogDialog() {
  logDialogEl.showModal();
  logListEl.lastElementChild?.scrollIntoView({ block: "nearest" });
}

logDialogCloseButtonEl.addEventListener("click", () => logDialogEl.close());
// Native <dialog> already closes on Escape; this adds click-outside (the
// backdrop is the dialog element itself — a click lands on it directly
// only when it's *not* on the content inside, which stopPropagation-free
// child elements would otherwise bubble past).
logDialogEl.addEventListener("click", (event) => {
  if (event.target === logDialogEl) logDialogEl.close();
});

// ---- Global "commenter name" setting -------------------------------------
// Stamped onto every annotation on save (see attachAnnotationHooks below)
// so PDFs opened elsewhere (Acrobat, etc.) show who made each comment,
// via the standard PDF "T"/author field. Stored in localStorage, same as
// the recent-files list — this is a global app setting, not per-document.
// Defaults to the OS account name (via the get_os_username Tauri command;
// the webview has no way to read that itself) the first time the app runs
// with nothing saved yet, but is always user-editable afterwards from the
// toolbar's Settings button.
function getCommenterName() {
  return localStorage.getItem(COMMENTER_NAME_KEY) || "";
}

function setCommenterName(name) {
  localStorage.setItem(COMMENTER_NAME_KEY, name);
}

async function seedDefaultCommenterName() {
  if (localStorage.getItem(COMMENTER_NAME_KEY) !== null) return; // already set (even if blank)
  try {
    const osName = await invoke("get_os_username");
    if (osName) setCommenterName(osName);
  } catch (err) {
    console.error("Failed to read OS username:", err);
  }
}

// ---- AI comment summary settings --------------------------------------
// The "Summarize Comments" toolbar button sends the document's comments to
// an OpenAI-compatible /chat/completions endpoint and shows the reply (see
// summarizeComments() below). Endpoint/model default to a local Ollama
// server, so it works out of the box and nothing leaves the machine unless
// the user points it elsewhere. The HTTP call is made Rust-side
// (summarize_comments in src/main.rs) — that sidesteps CORS and keeps the
// API key out of the webview. Same localStorage-backed shape as the
// commenter-name setting above; a blank stored value falls back to the
// default rather than disabling the feature.
function getAiEndpoint() {
  return (localStorage.getItem(AI_ENDPOINT_KEY) || AI_ENDPOINT_DEFAULT).trim();
}

function getAiModel() {
  return (localStorage.getItem(AI_MODEL_KEY) || AI_MODEL_DEFAULT).trim();
}

function getAiApiKey() {
  return (localStorage.getItem(AI_API_KEY_KEY) || "").trim();
}

// Settings holds an optional override; a blank/unset value means "use the
// bundled default" (so a later edit to summary-system-prompt.txt still
// reaches users who never customised it).
function getAiSystemPrompt() {
  const stored = localStorage.getItem(AI_SYSTEM_PROMPT_KEY);
  return stored && stored.trim() ? stored : DEFAULT_SUMMARY_SYSTEM_PROMPT.trim();
}

// ---- Recently-used AI model names ------------------------------------
// Both model inputs (Settings and the summary dialog) point a <datalist>
// at this list so the user can pick a previously-used model instead of
// retyping it. Most-recent-first, delimited to MAX_AI_MODEL_HISTORY.
function getAiModelHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(AI_MODEL_HISTORY_KEY));
    return Array.isArray(parsed) ? parsed.filter((m) => typeof m === "string" && m.trim()) : [];
  } catch {
    return [];
  }
}

function addAiModelToHistory(model) {
  const name = (model || "").trim();
  if (!name) return;
  const next = [name, ...getAiModelHistory().filter((m) => m !== name)].slice(
    0,
    MAX_AI_MODEL_HISTORY
  );
  localStorage.setItem(AI_MODEL_HISTORY_KEY, JSON.stringify(next));
  renderAiModelDatalist();
}

function renderAiModelDatalist() {
  if (!aiModelHistoryListEl) return;
  // Always offer the built-in default even before anything's been used.
  const names = [...new Set([...getAiModelHistory(), AI_MODEL_DEFAULT])];
  aiModelHistoryListEl.replaceChildren(
    ...names.map((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      return opt;
    })
  );
}

// ---- Global "open mode" setting + per-file copy-destination memory -------
// Governs what happens when a PDF is opened: overwrite it in place (today's
// only behavior, and still the default here), always ask, or always create
// a copy and work in that instead — see resolveOpenTarget() below for how
// this is actually applied. Same localStorage-backed getter/setter shape as
// the commenter-name setting above.
function getOpenMode() {
  const mode = localStorage.getItem(OPEN_MODE_KEY);
  return mode === "ask" || mode === "copy" ? mode : "overwrite";
}

function setOpenMode(mode) {
  localStorage.setItem(OPEN_MODE_KEY, mode);
}

// Landing-screen-only nudge: "overwrite" saves annotations straight into
// the original file with no per-open confirmation, so it's worth flagging
// before the user picks a file. Refreshed on init and whenever Settings is
// saved — those are the only two points the global mode can change.
function updateLandingOpenModeWarning() {
  landingOpenModeWarningEl.classList.toggle("hidden", getOpenMode() !== "overwrite");
}

// Per-original-file memory of what was decided, so reopening the same file
// doesn't re-ask or re-copy — { [originalAbsolutePath]: {mode:"overwrite"}
// | {mode:"copy", copyPath} }. Not capped like recent-files; this is small
// per-file metadata that should persist as long as the mapping is valid.
function getCopyMappings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COPY_MAPPINGS_KEY));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getCopyMapping(originalPath) {
  return getCopyMappings()[originalPath] || null;
}

function setCopyMapping(originalPath, entry) {
  const mappings = getCopyMappings();
  mappings[originalPath] = entry;
  localStorage.setItem(COPY_MAPPINGS_KEY, JSON.stringify(mappings));
}

function clearCopyMapping(originalPath) {
  const mappings = getCopyMappings();
  if (!(originalPath in mappings)) return;
  delete mappings[originalPath];
  localStorage.setItem(COPY_MAPPINGS_KEY, JSON.stringify(mappings));
}

// Is `path` itself a copy this app previously created for some other
// original? If so it must be opened like a plain "overwrite" file — never
// re-prompted or copied again — otherwise opening a copy from its own
// Recent Files entry would create a copy-of-the-copy (mode "copy") or
// re-prompt forever (mode "ask"). Scans values rather than keeping a
// second reverse index; copyMappings is small, read only at open time.
function isKnownCopyPath(path) {
  return Object.values(getCopyMappings()).some((entry) => entry.mode === "copy" && entry.copyPath === path);
}

function openSettingsDialog() {
  commenterNameInputEl.value = getCommenterName();
  openModeSelectEl.value = getOpenMode();
  aiEndpointInputEl.value = getAiEndpoint();
  aiModelInputEl.value = getAiModel();
  aiApiKeyInputEl.value = getAiApiKey();
  aiSystemPromptInputEl.value = getAiSystemPrompt();
  renderAiModelDatalist();
  renderQuickCommentsManageList();
  refreshLongPathStatus(); // fire-and-forget; fills in the status line async
  refreshUpdateRow(); // ditto — sets the Updates row (version / pending update)
  settingsDialogEl.showModal();
  commenterNameInputEl.focus();
}

// ---- Windows long path support (Settings) -------------------------------
// Drag-and-drop of a PDF whose full path is longer than 259 chars is
// silently refused by Explorer unless the process is long-path aware. We
// ship the manifest half of that (build.rs); the other half is the
// machine-wide HKLM LongPathsEnabled registry value, which needs elevation
// to set. long_paths_enabled/enable_long_paths (src/main.rs) read and set
// it; here we just reflect the state and offer the button. The whole row
// is Windows-only — on any other platform long_paths_enabled resolves to
// null (a no-op stub) and the row is hidden.
async function refreshLongPathStatus() {
  longPathRowEl.hidden = false;
  setLongPathStatus("Checking…", null, { showButton: false });
  let enabled;
  try {
    enabled = await invoke("long_paths_enabled");
  } catch (err) {
    console.error("Could not check long path support:", err);
    setLongPathStatus("Couldn't check long path support.", "warn", { showButton: true });
    return;
  }
  if (enabled === null || enabled === undefined) {
    longPathRowEl.hidden = true; // not a Windows build
  } else if (!enabled) {
    localStorage.removeItem(LONG_PATH_RESTART_PENDING_KEY);
    setLongPathStatus(
      "Not enabled — long-path files can't be opened by drag-and-drop.",
      "warn",
      { showButton: true },
    );
  } else if (localStorage.getItem(LONG_PATH_RESTART_PENDING_KEY)) {
    setLongPathStatus("Enabled — restart দাগ to apply.", "ok", { showButton: false });
  } else {
    setLongPathStatus("Enabled.", "ok", { showButton: false });
  }
}

function setLongPathStatus(text, state, { showButton }) {
  longPathStatusEl.textContent = text;
  if (state) longPathStatusEl.dataset.state = state;
  else delete longPathStatusEl.dataset.state;
  enableLongPathButtonEl.hidden = !showButton;
}

enableLongPathButtonEl.addEventListener("click", async () => {
  enableLongPathButtonEl.disabled = true;
  setLongPathStatus("Waiting for administrator approval…", null, { showButton: true });
  try {
    await invoke("enable_long_paths");
    localStorage.setItem(LONG_PATH_RESTART_PENDING_KEY, "1");
    await refreshLongPathStatus();
  } catch (err) {
    console.error("Could not enable long path support:", err);
    setLongPathStatus(String(err), "warn", { showButton: true });
  } finally {
    enableLongPathButtonEl.disabled = false;
  }
});

longPathDocLinkEl.addEventListener("click", (event) => {
  event.preventDefault();
  invoke("open_external", { url: LONG_PATH_DOC_URL }).catch((err) => {
    console.error("Could not open the long path docs:", err);
  });
});

ollamaDocLinkEl.addEventListener("click", (event) => {
  event.preventDefault();
  invoke("open_external", { url: OLLAMA_DOC_URL }).catch((err) => {
    console.error("Could not open the Ollama download page:", err);
  });
});

// ---- Auto-update (Settings + startup) ----------------------------------
// The updater plugin (src-tauri) checks the GitHub release's latest.json;
// if a newer *signed* build is published it can be downloaded, installed
// over the current one and relaunched — all from #updateDialog. Two entry
// points reach the check:
//   - a quiet pass once at startup that only shows UI if there's an update
//     (a failed check — offline, GitHub down, no release yet — is logged,
//     never toasted);
//   - the Settings "Check for updates…" button, which always reports back.
// The download/install/relaunch itself only ever runs on an explicit
// Install click — the app never updates itself without the user saying so.
let pendingUpdate = null; // the Update handle from a check that found one
let updateCheckInFlight = false;
let updateInstalling = false;

function errText(err) {
  return String(err?.message || err || "unknown error");
}

function formatBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function setUpdateStatus(text, state) {
  updateStatusEl.textContent = text;
  if (state) updateStatusEl.dataset.state = state;
  else delete updateStatusEl.dataset.state;
}

// Reflect current state into the Settings "Updates" row every time the
// dialog opens — the pending-update banner if a check already found one,
// otherwise just the running version.
async function refreshUpdateRow() {
  checkUpdateButtonEl.disabled = updateCheckInFlight || updateInstalling;
  if (pendingUpdate) {
    setUpdateStatus(`Update available — v${pendingUpdate.version}`, "ok");
    return;
  }
  if (updateCheckInFlight) return;
  let v = "";
  try {
    v = await getVersion();
  } catch {
    /* getVersion only fails outside a Tauri context (plain vite dev) */
  }
  setUpdateStatus(v ? `দাগ v${v}` : "দাগ", null);
}

async function checkForUpdate({ silent }) {
  if (updateCheckInFlight || updateInstalling) return;
  updateCheckInFlight = true;
  if (!silent) {
    checkUpdateButtonEl.disabled = true;
    setUpdateStatus("Checking for updates…", null);
  }
  try {
    const update = await checkTauriUpdate();
    if (update) {
      pendingUpdate = update;
      if (!silent) setUpdateStatus(`Update available — v${update.version}`, "ok");
      setStatus(`Update available — দাগ v${update.version}`, "", { toast: silent });
      openUpdateDialog(update);
    } else {
      pendingUpdate = null;
      if (silent) {
        setStatus("দাগ is up to date", "");
      } else {
        let v = "";
        try {
          v = await getVersion();
        } catch {
          /* ignore */
        }
        setUpdateStatus(v ? `Up to date — দাগ v${v}` : "Up to date", "ok");
      }
    }
  } catch (err) {
    console.error("Update check failed:", err);
    if (silent) {
      setStatus(`Update check skipped — ${errText(err)}`, "");
    } else {
      setUpdateStatus(`Couldn't check for updates — ${errText(err)}`, "warn");
    }
  } finally {
    updateCheckInFlight = false;
    if (!silent) checkUpdateButtonEl.disabled = updateInstalling;
  }
}

function openUpdateDialog(update) {
  updateDialogVersionLineEl.textContent =
    `Version ${update.version} is available. You're on v${update.currentVersion}.`;
  updateDialogNotesEl.textContent = (update.body || "").trim();
  updateDialogProgressEl.hidden = true;
  updateDialogProgressBarEl.style.width = "0%";
  updateDialogProgressTextEl.textContent = "";
  updateDialogInstallButtonEl.disabled = false;
  updateDialogLaterButtonEl.disabled = false;
  updateDialogCloseButtonEl.disabled = false;
  if (!updateDialogEl.open) updateDialogEl.showModal();
}

updateDialogInstallButtonEl.addEventListener("click", async () => {
  if (!pendingUpdate || updateInstalling) return;
  updateInstalling = true;
  updateDialogInstallButtonEl.disabled = true;
  updateDialogLaterButtonEl.disabled = true;
  updateDialogCloseButtonEl.disabled = true;
  updateDialogProgressEl.hidden = false;
  updateDialogProgressBarEl.style.width = "0%";
  updateDialogProgressTextEl.textContent = "Starting download…";
  setStatus(`Downloading update v${pendingUpdate.version}`, "saving");

  let downloaded = 0;
  let total = 0;
  try {
    await pendingUpdate.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data?.contentLength ?? 0;
          break;
        case "Progress": {
          downloaded += event.data?.chunkLength ?? 0;
          if (total) {
            const pct = Math.min(100, Math.round((downloaded / total) * 100));
            updateDialogProgressBarEl.style.width = `${pct}%`;
            updateDialogProgressTextEl.textContent =
              `Downloading… ${pct}% (${formatBytes(downloaded)} of ${formatBytes(total)})`;
          } else {
            updateDialogProgressTextEl.textContent = `Downloading… ${formatBytes(downloaded)}`;
          }
          break;
        }
        case "Finished":
          updateDialogProgressBarEl.style.width = "100%";
          updateDialogProgressTextEl.textContent = "Installing…";
          break;
      }
    });
    updateDialogProgressTextEl.textContent = "Update installed — restarting দাগ…";
    setStatus(`Updated to v${pendingUpdate.version} — restarting`, "", { toast: true });
    await relaunch();
  } catch (err) {
    console.error("Update install failed:", err);
    updateInstalling = false;
    updateDialogProgressTextEl.textContent = `Update failed — ${errText(err)}`;
    updateDialogInstallButtonEl.disabled = false;
    updateDialogLaterButtonEl.disabled = false;
    updateDialogCloseButtonEl.disabled = false;
    setStatus(`Update failed — ${errText(err)}`, "error", { toast: true });
  }
});

function dismissUpdateDialog() {
  if (!updateInstalling) updateDialogEl.close();
}
updateDialogLaterButtonEl.addEventListener("click", dismissUpdateDialog);
updateDialogCloseButtonEl.addEventListener("click", dismissUpdateDialog);
updateDialogEl.addEventListener("click", (event) => {
  if (event.target === updateDialogEl) dismissUpdateDialog();
});
// Block Escape from closing the dialog while an install is in progress —
// the download/relaunch keeps running regardless, so hiding it just loses
// the progress readout.
updateDialogEl.addEventListener("cancel", (event) => {
  if (updateInstalling) event.preventDefault();
});
checkUpdateButtonEl.addEventListener("click", () => checkForUpdate({ silent: false }));

settingsDialogSaveButtonEl.addEventListener("click", () => {
  setCommenterName(commenterNameInputEl.value.trim());
  setOpenMode(openModeSelectEl.value);
  // Store raw (possibly blank) — the getters fall back to the defaults, so
  // clearing a field resets it rather than breaking the feature.
  localStorage.setItem(AI_ENDPOINT_KEY, aiEndpointInputEl.value.trim());
  const modelValue = aiModelInputEl.value.trim();
  localStorage.setItem(AI_MODEL_KEY, modelValue);
  addAiModelToHistory(modelValue);
  localStorage.setItem(AI_API_KEY_KEY, aiApiKeyInputEl.value.trim());
  // Blank, or unchanged from the bundled default → store nothing, so a
  // future default edit still flows through.
  const promptValue = aiSystemPromptInputEl.value.trim();
  if (!promptValue || promptValue === DEFAULT_SUMMARY_SYSTEM_PROMPT.trim()) {
    localStorage.removeItem(AI_SYSTEM_PROMPT_KEY);
  } else {
    localStorage.setItem(AI_SYSTEM_PROMPT_KEY, promptValue);
  }
  updateLandingOpenModeWarning();
  settingsDialogEl.close();
});

aiSystemPromptRestoreButtonEl.addEventListener("click", () => {
  aiSystemPromptInputEl.value = DEFAULT_SUMMARY_SYSTEM_PROMPT.trim();
  aiSystemPromptInputEl.focus();
});
settingsDialogCancelButtonEl.addEventListener("click", () => settingsDialogEl.close());
settingsDialogCloseButtonEl.addEventListener("click", () => settingsDialogEl.close());
settingsDialogEl.addEventListener("click", (event) => {
  if (event.target === settingsDialogEl) settingsDialogEl.close();
});
commenterNameInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") settingsDialogSaveButtonEl.click();
});

// ---- Undo All confirmation dialog ----------------------------------------
// Reset to unchecked every time the dialog opens — the stronger,
// also-strip-pre-existing-annotations option shouldn't silently stick
// from a previous use.
function openUndoAllDialog() {
  undoAllStripAllCheckboxEl.checked = false;
  undoAllDialogConfirmButtonEl.textContent = "Undo All";
  undoAllDialogEl.showModal();
}

undoAllStripAllCheckboxEl.addEventListener("change", () => {
  undoAllDialogConfirmButtonEl.textContent = undoAllStripAllCheckboxEl.checked
    ? "Remove All Annotations"
    : "Undo All";
});

undoAllDialogConfirmButtonEl.addEventListener("click", () => {
  const stripAllAnnotationsToo = undoAllStripAllCheckboxEl.checked;
  undoAllDialogEl.close();
  revertToSessionStart({ stripAllAnnotationsToo }).catch((err) => {
    console.error("Undo All failed:", err);
    reportError("Undo All failed");
  });
});
undoAllDialogCancelButtonEl.addEventListener("click", () => undoAllDialogEl.close());
undoAllDialogCloseButtonEl.addEventListener("click", () => undoAllDialogEl.close());
undoAllDialogEl.addEventListener("click", (event) => {
  if (event.target === undoAllDialogEl) undoAllDialogEl.close();
});

// ---- Overwrite-or-copy prompt dialog --------------------------------------
// Shown by resolveOpenTarget() (below) when the global open-mode setting is
// "ask" and a given original file has no remembered decision yet. Unlike
// the fire-and-forget dialogs above, openPath() needs to *await* the
// user's choice — including, for "Create a Copy…", a chained native Save
// dialog — before it knows what to actually load. The dialog element is
// created once and its listeners wired once, so every call routes through
// one module-level "settle" slot: whichever of a button click / Escape
// (fires "cancel") / any other close fires first clears the slot and wins,
// and every other listener's `settle?.(...)` becomes a guaranteed no-op —
// no per-call listener add/remove, no risk of double-resolving.
let settleOverwriteCopyPrompt = null;

function resolveOverwriteCopyPrompt(result) {
  const settle = settleOverwriteCopyPrompt;
  settleOverwriteCopyPrompt = null; // clear BEFORE close() so the "close" listener below is a no-op
  overwriteCopyDialogEl.close();
  settle?.(result);
}

overwriteCopyDialogOverwriteButtonEl.addEventListener("click", () =>
  resolveOverwriteCopyPrompt({ action: "overwrite", remember: overwriteCopyDialogRememberCheckboxEl.checked })
);
overwriteCopyDialogCopyButtonEl.addEventListener("click", () =>
  resolveOverwriteCopyPrompt({ action: "copy", remember: overwriteCopyDialogRememberCheckboxEl.checked })
);
overwriteCopyDialogCancelButtonEl.addEventListener("click", () => resolveOverwriteCopyPrompt(null));
overwriteCopyDialogCloseButtonEl.addEventListener("click", () => resolveOverwriteCopyPrompt(null));
overwriteCopyDialogEl.addEventListener("click", (event) => {
  if (event.target === overwriteCopyDialogEl) resolveOverwriteCopyPrompt(null);
});
// Escape fires "cancel" then "close" without going through any button
// handler above — must be caught separately or the promise never settles.
overwriteCopyDialogEl.addEventListener("cancel", () => resolveOverwriteCopyPrompt(null));
// Belt-and-suspenders: however else the dialog ends up closed, still
// settle instead of leaking the promise pending forever.
overwriteCopyDialogEl.addEventListener("close", () => {
  const settle = settleOverwriteCopyPrompt;
  settleOverwriteCopyPrompt = null;
  settle?.(null);
});

// Not safe to call while a previous call's dialog is still open (showModal()
// throws on an already-open <dialog>) — openPath's single-flight queue (see
// openInFlight below) guarantees at most one caller is ever pending.
function promptOverwriteOrCopy(originalPath) {
  return new Promise((resolve) => {
    settleOverwriteCopyPrompt = resolve;
    overwriteCopyDialogRememberCheckboxEl.checked = true; // always defaults checked
    overwriteCopyDialogPathEl.textContent = originalPath;
    overwriteCopyDialogEl.showModal();
  });
}

// ---- Continue-with-copy-or-start-over prompt dialog -----------------------
// Shown by resolveOpenTarget() (below) whenever the original being opened
// already has a remembered "copy" mapping and that copy still exists —
// i.e. right before what used to be a silent redirect to the copy. Same
// settle-slot pattern as promptOverwriteOrCopy above, kept as a separate
// dialog/slot since the two can never be open at the same time (both only
// ever run from within resolveOpenTarget, serialized by openPath's
// openInFlight queue) but represent different questions.
let settleContinueOrStartOverPrompt = null;

function resolveContinueOrStartOverPrompt(result) {
  const settle = settleContinueOrStartOverPrompt;
  settleContinueOrStartOverPrompt = null; // clear BEFORE close() so the "close" listener below is a no-op
  continueOrStartOverDialogEl.close();
  settle?.(result);
}

continueOrStartOverDialogContinueButtonEl.addEventListener("click", () =>
  resolveContinueOrStartOverPrompt("continue")
);
continueOrStartOverDialogStartOverButtonEl.addEventListener("click", () =>
  resolveContinueOrStartOverPrompt("startOver")
);
continueOrStartOverDialogCancelButtonEl.addEventListener("click", () => resolveContinueOrStartOverPrompt(null));
continueOrStartOverDialogCloseButtonEl.addEventListener("click", () => resolveContinueOrStartOverPrompt(null));
continueOrStartOverDialogEl.addEventListener("click", (event) => {
  if (event.target === continueOrStartOverDialogEl) resolveContinueOrStartOverPrompt(null);
});
// Escape fires "cancel" then "close" without going through any button
// handler above — must be caught separately or the promise never settles.
continueOrStartOverDialogEl.addEventListener("cancel", () => resolveContinueOrStartOverPrompt(null));
// Belt-and-suspenders: however else the dialog ends up closed, still
// settle instead of leaking the promise pending forever.
continueOrStartOverDialogEl.addEventListener("close", () => {
  const settle = settleContinueOrStartOverPrompt;
  settleContinueOrStartOverPrompt = null;
  settle?.(null);
});

// Not safe to call while a previous call's dialog is still open (showModal()
// throws on an already-open <dialog>) — openPath's single-flight queue (see
// openInFlight below) guarantees at most one caller is ever pending.
function promptContinueOrStartOver(originalPath, copyPath) {
  return new Promise((resolve) => {
    settleContinueOrStartOverPrompt = resolve;
    continueOrStartOverDialogPathEl.textContent = copyPath;
    continueOrStartOverDialogEl.showModal();
  });
}

function showViewer() {
  landingScreen.classList.add("hidden");
  viewerScreen.classList.remove("hidden");
  titlebarDocActionsEl.classList.remove("hidden");
  updateTitlebarChrome();
  // The iframe doesn't take focus just by becoming visible, so the
  // shortcut keys (attachKeyboardShortcuts, bound on frame.contentDocument)
  // and pdf.js's own key handling would stay dead until the first click
  // inside it. Hand it focus now.
  frame.contentWindow?.focus();
}

// ---- Configuring the embedded pdf.js viewer ----------------------------
// pdf.js's "generic" build ships two features that are off by default:
//   - enableHighlightFloatingButton: lets you select text with no tool
//     active and get a floating Highlight/Comment button, instead of
//     forcing you to pre-select the Highlight tool before selecting text.
//   - enableComment: adds the "Comment" floating button, an editable
//     comment popup on highlights, and the comments sidebar.
// Both are read once, synchronously, very early in
// PDFViewerApplication.initialize() (before any page or annotation
// editor is set up), via pdf.js's own `Preferences` class, which in the
// "generic" build just reads/writes localStorage["pdfjs.preferences"].
// Since the iframe is same-origin (served by Vite/Tauri), we can seed
// that key directly — this is why the iframe has no `src` in index.html:
// we must write localStorage *before* pointing it at viewer.html, or
// pdf.js's startup will have already read the (missing) prefs by the
// time we set them.
function configurePdfjsPreferences() {
  const STORAGE_KEY = "pdfjs.preferences";
  let prefs = {};
  try {
    prefs = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    prefs = {};
  }
  Object.assign(prefs, {
    enableHighlightFloatingButton: true,
    enableComment: true,
    // 1 = light, 2 = dark (see pdfjsColorSchemeMode below) — read once by
    // pdf.js during its own init, before our live docStyle override in
    // applyPdfjsColorScheme() would have anything to act on yet.
    viewerCssTheme: currentTheme === "dark" ? 2 : 1,
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

// ---- Suppressing pdf.js's bundled sample PDF ---------------------------
// The "generic" build ships compressed.tracemonkey-pldi-09.pdf as its
// `defaultUrl` option and auto-opens it on startup whenever there's no
// `?file=` query string on viewer.html — which is always the case here
// (see web/viewer.mjs: `file = params.get("file") ?? AppOptions.get
// ("defaultUrl")`, then `if (file) this.open({url: file})`). We want an
// empty state (or the reopened last file, below) instead.
//
// defaultUrl isn't tagged `OptionKind.PREFERENCE`, so it can't be
// overridden via the localStorage trick configurePdfjsPreferences() uses
// for enableComment/enableHighlightFloatingButton — pdf.js's Preferences
// class only merges storage values for options that opted into that. But
// viewer.mjs dispatches a cancelable "webviewerloaded" CustomEvent on
// *our* document, with `detail.source` set to the iframe's window, right
// before it calls `PDFViewerApplication.run(config)` — the officially
// intended embedding hook for exactly this kind of pre-run override, and
// synchronous/ordered by construction, so there's no DOMContentLoaded
// timing race to worry about the way there would be if we tried to reach
// into the iframe ourselves from the outside.
document.addEventListener("webviewerloaded", (event) => {
  event.detail?.source?.PDFViewerApplicationOptions?.set("defaultUrl", "");
});

configurePdfjsPreferences();
frame.src = "pdfjs/web/viewer.html";

// A page reload (Vite HMR in dev; a WebView2 Ctrl+R/F5 refresh in prod)
// resets all in-page JS state back to its initial values — including
// currentTitleBase (see applyWindowTitleBar below), correctly landing back
// on the plain landing screen — but does NOT touch the *native* OS window
// title on its own: that's state Tauri's setTitle() previously set, and
// nothing tells WebView2/the OS a reload just happened, so the title bar
// just keeps showing whichever document was open beforehand. Reset it back
// to the app's own default here, at startup, before any file has a chance
// to be opened. Idempotent on a genuine fresh launch too, since
// tauri.conf.json's configured window title is already "দাগ — Daag".
getCurrentWindow()
  .setTitle(DEFAULT_WINDOW_TITLE)
  .catch((err) => console.error("Could not reset window title:", err));

// ---- Custom titlebar: window controls -------------------------------
// decorations: false in tauri.conf.json means these three buttons are the
// only way to minimize/maximize/close the window — nothing native left.
titlebarMinimizeBtn.addEventListener("click", () =>
  getCurrentWindow()
    .minimize()
    .catch((err) => console.error("Could not minimize window:", err))
);
titlebarMaximizeBtn.addEventListener("click", () =>
  getCurrentWindow()
    .toggleMaximize()
    .catch((err) => console.error("Could not toggle window maximize state:", err))
);
titlebarCloseBtn.addEventListener("click", () =>
  getCurrentWindow()
    .close()
    .catch((err) => console.error("Could not close window:", err))
);

// The maximize button's icon (and double-clicking the titlebar, and
// dragging to a screen edge) all change the window's maximized state
// without going through toggleMaximize() above, so its own click handler
// can't be the only thing that keeps the icon in sync — re-check after
// every resize instead, which covers all of those paths uniformly.
async function syncMaximizeButtonState() {
  try {
    const maximized = await getCurrentWindow().isMaximized();
    titlebarMaximizeBtn.classList.toggle("is-maximized", maximized);
    titlebarMaximizeBtn.setAttribute("aria-label", maximized ? "Restore" : "Maximize");
  } catch (err) {
    console.error("Could not read window maximized state:", err);
  }
}
syncMaximizeButtonState();
getCurrentWindow().onResized(syncMaximizeButtonState);

// ---- Titlebar theme button: default / light / dark ----------------------
// "default" is the original look — dark chrome, light pdf.js viewer (pdf.js's
// own default toolbar color, see the titlebar-light CSS comment above).
// "light"/"dark" force both the outer chrome (landing screen, dialogs — see
// the CSS variables at the top of index.html) and the pdf.js viewer to
// match uniformly. Persisted so it survives a reload/relaunch.
const THEME_LABELS = {
  default: "Theme: Default — click for Light",
  light: "Theme: Light — click for Dark",
  dark: "Theme: Dark — click for Default",
};

function pdfjsColorSchemeMode() {
  return currentTheme === "dark" ? "dark" : "light";
}

// Live-updates the already-loaded pdf.js page the same way its own
// initialize() does internally (viewer.mjs: docStyle.setProperty("color-
// scheme", mode), where docStyle is document.documentElement.style) — pdf.js
// only reads the seeded viewerCssTheme preference once, at its own startup,
// so changing that preference alone wouldn't do anything for a theme change
// made mid-session without reloading the iframe. Every contentWindow?.
// access below is optional-chained because this runs three times over the
// app's life: once synchronously at module init (frame.src was just
// assigned a couple lines up — frame.contentWindow is still the placeholder
// document, so this call is a deliberate, harmless no-op), once for real
// once initializeViewer()'s waitForViewer() resolves (see its comment —
// this is what actually seeds --app-color-scheme etc. for the first time),
// and then again on every subsequent theme-button click, by which point the
// iframe has long since been warm.
function applyPdfjsColorScheme() {
  const contentWindow = frame.contentWindow;
  const mode = pdfjsColorSchemeMode();
  const docStyle = contentWindow?.document.documentElement.style;
  docStyle?.setProperty("color-scheme", mode);
  // Also mirrored onto a plain custom property — see custom-viewer.css's
  // .commentPopup/.annotationCommentButton rule for why `color-scheme`
  // alone (even via `inherit`) isn't enough for those two.
  docStyle?.setProperty("--app-color-scheme", mode);
  refreshPdfjsCommentForegroundColorCache(contentWindow);
}

// A comment popup's background is tinted to contrast against its
// highlight's own color (pdf.mjs CommentManager#_makeCommentColor →
// findContrastColor(highlightColor, CSSConstants.commentForegroundColor)),
// computed fresh every time a popup opens. But commentForegroundColor
// itself (also pdf.mjs) is a lazy getter memoized via pdf.js's own shadow()
// helper (Object.defineProperty, configurable but write-once) the first
// time anything reads it, and never recomputed after — meaning it's frozen
// at whatever --comment-fg-color resolved to at that first access, forever,
// even though the live CSS variable keeps updating with our theme toggle
// (once custom-viewer.css's `.commentPopup,.annotationCommentButton{color-
// scheme:var(--app-color-scheme,inherit)}` override is in place — see that
// file for why the popup TEXT itself needed a separate fix too, not just
// this cached background).
// Can't fix the memoization at its source without hand-editing the vendored
// pdf.mjs (never done, see CLAUDE.md); instead, replicate the getter's own
// logic and reassign its cached property with a freshly computed value,
// using only pdf.js's own exported helpers (globalThis.pdfjsLib.getRGB) for
// the exact same conversion pdf.js itself would use. This corrects every
// popup opened from this point on; one already open at the moment of the
// switch was already styled imperatively when it opened, so it still needs
// a close/reopen to catch up — a much smaller residual gap than the
// alternative (permanently wrong until the app restarts).
//
// KNOWN LIMITATION this does NOT cover: the small comment-marker button
// drawn directly on a highlight gets its own highlight-tinted background
// the same way (commentButtonColor → makeCommentColor → this same cache),
// but unlike the popup it's painted once when its page first renders this
// session and never revisited — confirmed empirically (three highlights on
// three pages each permanently kept whatever background matched the theme
// active the first time that specific page rendered, even ones first
// rendered *after* a later theme switch). Fixing that would need calling
// into whichever object owns that specific marker's repaint, and — unlike
// the popup, which pdf.js's own AnnotationEditorUIManager.getEditors()
// reaches directly — that object turned out to live behind a private field
// on pdf.js's plain (non-editor) annotation-layer rendering path
// (PopupElement's private #updateColor(), reachable only through its
// public updateEdited() — pdf.mjs, "src/display/annotation_layer.js"
// section) with no public registry exposed to find *which* instance
// belongs to which visible marker from outside. Confirmed getEditors()
// finds nothing for these pages at all — even ones already scrolled to and
// showing a marker — via a live console check
// (PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager
// .getEditors(pageIndex) returned empty everywhere), so this genuinely
// isn't reachable the way the popup was, not just an unlucky guess.
// Reopening the document forces every marker to repaint fresh and picks up
// whatever theme is active at that point.
function refreshPdfjsCommentForegroundColorCache(contentWindow) {
  const pdfjsLib = contentWindow?.pdfjsLib;
  const CSSConstants = pdfjsLib?.CSSConstants;
  if (!CSSConstants) return;
  const doc = contentWindow.document;
  const probe = doc.createElement("span");
  probe.classList.add("comment", "sidebar");
  probe.style.cssText = "width:0;height:0;display:none;color:var(--comment-fg-color);";
  doc.body.append(probe);
  const { color } = contentWindow.getComputedStyle(probe);
  probe.remove();
  Object.defineProperty(CSSConstants, "commentForegroundColor", {
    value: pdfjsLib.getRGB(color),
    configurable: true,
    enumerable: true,
    writable: false,
  });
}

// Recomputes just the titlebar's own light/dark state — kept separate from
// applyTheme() because it also needs to rerun on its own whenever the
// viewer is shown (see showViewer()), independent of any theme change.
function updateTitlebarChrome() {
  const viewerIsOpen = !viewerScreen.classList.contains("hidden");
  const light = currentTheme === "light" || (currentTheme === "default" && viewerIsOpen);
  titlebarEl.classList.toggle("titlebar-light", light);
}

function applyTheme(theme) {
  currentTheme = theme;
  localStorage.setItem(THEME_KEY, theme);
  bodyEl.classList.toggle("theme-light", theme === "light");
  updateTitlebarChrome();
  applyPdfjsColorScheme();
  titlebarThemeBtn.dataset.theme = theme;
  titlebarThemeBtn.title = THEME_LABELS[theme];
  titlebarThemeBtn.setAttribute("aria-label", THEME_LABELS[theme]);
}

titlebarThemeBtn.addEventListener("click", () => {
  applyTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(currentTheme) + 1) % THEME_CYCLE.length]);
});

applyTheme(currentTheme);

// ---- Blocking WebView2's reload accelerators (F5 / Ctrl+R) --------------
// The real block is Rust-side (disable_browser_accelerator_keys in
// src-tauri/src/main.rs turns off AreBrowserAcceleratorKeysEnabled) — the
// webview host acts on these above the DOM, so historically a JS
// preventDefault couldn't stop them. This capture-phase guard is
// belt-and-braces: it covers `vite` dev (no Tauri webview settings) and any
// runtime where that COM call doesn't take. Ctrl+R/F5/Ctrl+Shift+R only.
function blockReloadKeys(target) {
  target.addEventListener(
    "keydown",
    (event) => {
      const isCtrlR =
        (event.ctrlKey || event.metaKey) && !event.altKey && event.key?.toLowerCase() === "r";
      if (event.key === "F5" || isCtrlR) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    { capture: true }
  );
}
blockReloadKeys(window);

// ---- Ctrl+W: close the current document, back to the landing screen -----
// Reload (Ctrl+R/F5) used to double as "close" only because startup doesn't
// auto-reopen the last file — but it *does* reopen a file passed on the
// command line / via Explorer's "Open with" (get_launch_path in the module
// init below), so there Ctrl+W just silently reloaded the same document
// straight back (and reload is blocked now anyway, see above). This is a
// real in-app close instead: flush any pending save (this app's whole
// premise is that disk never lags the screen), drop the pdf.js document,
// reset session state, and show the landing screen. No-op when already on
// the landing screen.
let closeInFlight = false;
async function closeCurrentPdf(event) {
  event?.preventDefault();
  event?.stopPropagation();
  if (!currentPath || closeInFlight) return;
  closeInFlight = true;
  try {
    const closedName = filenameFromPath(currentPath);

    if (dirty) await saveNow({ force: true });
    clearTimeout(autosaveTimer);
    closeQuickCommentMenu();

    try {
      await getViewerApp()?.close();
    } catch (err) {
      console.error("Could not close the pdf.js document:", err);
    }

    currentPath = null;
    dirty = false;
    sessionOriginalBytes = null;
    summaryCache = null;
    folderPdfDir = null;
    folderPdfList = [];
    folderPdfIndex = -1;
    currentTitleBase = null;

    if (toolbarSaveButton) toolbarSaveButton.disabled = true;
    if (toolbarUndoAllButton) toolbarUndoAllButton.disabled = true;
    if (toolbarExportCommentsButton) toolbarExportCommentsButton.disabled = true;
    if (toolbarSummarizeCommentsButton) toolbarSummarizeCommentsButton.disabled = true;
    titlebarPrevBtn.disabled = true;
    titlebarNextBtn.disabled = true;

    viewerScreen.classList.add("hidden");
    landingScreen.classList.remove("hidden");
    titlebarDocActionsEl.classList.add("hidden");
    landingStatusEl.textContent = "";
    landingStatusEl.className = "";
    titlebarTitleEl.textContent = DEFAULT_WINDOW_TITLE;
    titlebarTitleEl.title = "";
    getCurrentWindow()
      .setTitle(DEFAULT_WINDOW_TITLE)
      .catch((err) => console.error("Could not reset window title:", err));
    updateTitlebarChrome();
    renderRecentFiles();
    // Focus was on the iframe (see showViewer) — move it to the landing
    // screen so it isn't stranded on a now-hidden element.
    openBtn.focus();
    setStatus(`Closed ${closedName}`, "");
  } finally {
    closeInFlight = false;
  }
}

// Attached at the parent-document level (in addition to the iframe-scoped
// binding in attachKeyboardShortcuts) because the landing screen leaves the
// PDF viewer iframe at display:none — it can't hold focus, so a listener
// scoped only inside it would never see this key while no file is open.
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key?.toLowerCase() === "w") {
    closeCurrentPdf(event);
  }
});

// ---- Waiting for the embedded pdf.js viewer to be ready ---------------
// pdf.js's viewer.html builds a global `PDFViewerApplication` and resolves
// `PDFViewerApplication.initializedPromise` once it's ready to accept a
// document. Version numbers differ across pdf.js releases, so if this
// doesn't fire, check your dropped-in build's web/viewer.mjs for the
// exact ready signal it exposes.
function getViewerApp() {
  return frame.contentWindow && frame.contentWindow.PDFViewerApplication;
}

async function waitForViewer() {
  return new Promise((resolve) => {
    const check = () => {
      const app = getViewerApp();
      if (app && app.initializedPromise) {
        app.initializedPromise.then(() => resolve(app));
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}

// ---- Loading our CSS into the embedded viewer --------------------------
// The Save-button styling further down lives in public/custom-viewer.css,
// loaded here via a real <link>, NOT an inline <style> tag. viewer.html
// ships its own CSP (style-src 'self', no 'unsafe-inline') that silently
// drops inline style rules — Chromium logs a console warning but nothing
// throws, and the button/element the style was meant for still renders
// using pdf.js's own defaults, so this is easy to miss entirely. A
// same-origin <link rel="stylesheet"> satisfies style-src 'self'. See the
// comment at the top of that CSS file for more.
function ensureCustomStylesheetLoaded(doc) {
  if (doc.getElementById("custom-viewer-stylesheet")) return;
  const link = doc.createElement("link");
  link.id = "custom-viewer-stylesheet";
  link.rel = "stylesheet";
  link.href = "/custom-viewer.css";
  doc.head.appendChild(link);
}

// A thin rule marking a boundary between clusters of toolbar buttons —
// pdf.js's own class, already styled in viewer.css (same one used between
// the editor-mode buttons and Print), so no custom-viewer.css entry needed.
function createToolbarSeparator(doc) {
  const separator = doc.createElement("div");
  separator.className = "verticalToolbarSeparator";
  return separator;
}

// ---- Adding our own Save button to pdf.js's toolbar --------------------
// pdf.js's own toolbar has a button labeled "Save" (`downloadButton`, see
// web/viewer.html) that's actually Save As: it builds a blob: URL and
// clicks a synthetic <a download> (web/viewer.mjs DownloadManager
// #_triggerDownload) — a browser-download pattern Tauri's WebView2 doesn't
// wire up on its own, so inside this app it's a dead button that silently
// does nothing (as is its twin in the overflow "Tools" menu,
// #secondaryDownload — same handler, same l10n label). We hide both (in
// custom-viewer.css) and add our own toolbar button, which writes
// annotations back to the original file path via the Tauri fs plugin (the
// same path autosave and the external "Save Now" button use) and is only
// enabled once a file we can write back to is open. The button element
// itself is injected as DOM rather than hand-edited into the vendored
// viewer.html, since that file gets dropped in wholesale on a pdf.js
// upgrade — a patch made directly in it would silently vanish next
// upgrade.
let toolbarSaveButton = null;
function injectSaveButton() {
  if (toolbarSaveButton) return;
  const doc = frame.contentDocument;
  const downloadButton = doc.getElementById("downloadButton");
  const group = downloadButton && downloadButton.closest(".toolbarHorizontalGroup");
  if (!group) return;

  ensureCustomStylesheetLoaded(doc);

  const button = doc.createElement("button");
  button.id = "customSaveButton";
  button.className = "toolbarButton";
  button.type = "button";
  button.title = "Save annotations into the original PDF file on disk (Ctrl+S)";
  button.disabled = true;
  button.addEventListener("click", () => saveNow({ force: true }));

  // Visually hidden per .toolbarButton > span (see viewer.css) — keeps the
  // button accessible to screen readers despite being icon-only.
  const label = doc.createElement("span");
  label.textContent = "Save to Disk";
  button.appendChild(label);

  // Last button in this toolbar — after Undo All/Export Comments/Print
  // (native); see the toolbar layout comment above initializeViewer.
  group.appendChild(createToolbarSeparator(doc));
  group.appendChild(button);

  toolbarSaveButton = button;
}

// ---- Open/Previous/Next/Activity Log/Settings: titlebar, not pdf.js's
// toolbar -------------------------------------------------------------
// Unlike Save/Undo All/Export Comments below, these live as static HTML in
// the titlebar (#titlebarDocActions in index.html) rather than being
// DOM-injected into pdf.js's toolbar — they don't need to survive a pdf.js
// upgrade the way toolbar buttons do, since they're not inside viewer.html
// at all. Wired here, unconditionally, rather than gated behind
// waitForViewer() like the injectors below: being outside the iframe
// entirely, there's no pdf.js readiness to wait for. Hidden until a file
// is open (updateTitlebarDocActionsVisibility, called from showViewer())
// — the landing screen already has its own Open/Settings buttons, and
// Previous/Next/Activity Log have nothing to act on before then anyway.
titlebarOpenBtn.addEventListener("click", () =>
  pickAndOpenPdf().catch((err) => {
    console.error(err);
    reportError("Failed to open file");
  })
);
titlebarPrevBtn.addEventListener("click", () =>
  navigateFolder(-1).catch((err) => {
    console.error(err);
    reportError("Failed to open previous file");
  })
);
titlebarNextBtn.addEventListener("click", () =>
  navigateFolder(1).catch((err) => {
    console.error(err);
    reportError("Failed to open next file");
  })
);
titlebarStatusBtn.addEventListener("click", openLogDialog);
titlebarSettingsBtn.addEventListener("click", openSettingsDialog);

// setStatus's `kind` doubles as the indicator's visual state, except ""
// (used for routine info like "Open: <path>" and "Saved <time>") maps to
// the "saved" (green/idle-good) dot rather than getting its own class.
function updateStatusIndicator(kind) {
  titlebarStatusBtn.className = `titlebarButton status-${kind || "saved"}`;
}

// ---- Adding an "Undo All" button to pdf.js's toolbar ---------------------
// Reverts to the exact bytes the current file had when it was opened this
// session and immediately saves that reverted state to disk — see
// revertToSessionStart below. Disabled until a file is open, same as Save.
// Injected the same way and for the same reasons as the other toolbar
// buttons.
let toolbarUndoAllButton = null;
function injectUndoAllButton() {
  if (toolbarUndoAllButton) return;
  const doc = frame.contentDocument;
  const downloadButton = doc.getElementById("downloadButton");
  const group = downloadButton && downloadButton.closest(".toolbarHorizontalGroup");
  if (!group) return;

  ensureCustomStylesheetLoaded(doc);

  const button = doc.createElement("button");
  button.id = "customUndoAllButton";
  button.className = "toolbarButton";
  button.type = "button";
  button.title = "Remove annotations made this session — optionally all annotations in the file";
  button.disabled = true;
  button.addEventListener("click", openUndoAllDialog);

  const label = doc.createElement("span");
  label.textContent = "Undo All";
  button.appendChild(label);

  // Leftmost of our custom buttons — inserted before pdf.js's own Print
  // button, right after the existing editor-tools separator, as the start
  // of an "act on your edits" cluster (Undo All, Export Comments, Print).
  const printButton = doc.getElementById("printButton");
  group.insertBefore(button, printButton || null);

  toolbarUndoAllButton = button;
}

// ---- Adding an "Export Comments" button to pdf.js's toolbar --------------
// Writes every commented annotation in the document to a Markdown file —
// see exportComments() below. Disabled until a file is open, same as
// Save/Undo All. Injected the same way and for the same reasons as the
// other toolbar buttons.
let toolbarExportCommentsButton = null;
function injectExportCommentsButton() {
  if (toolbarExportCommentsButton) return;
  const doc = frame.contentDocument;
  const downloadButton = doc.getElementById("downloadButton");
  const group = downloadButton && downloadButton.closest(".toolbarHorizontalGroup");
  if (!group) return;

  ensureCustomStylesheetLoaded(doc);

  const button = doc.createElement("button");
  button.id = "customExportCommentsButton";
  button.className = "toolbarButton";
  button.type = "button";
  button.title = "Export all comments to a Markdown file";
  button.disabled = true;
  button.addEventListener("click", () =>
    exportComments().catch((err) => {
      console.error(err);
      setStatus("Export comments failed", "error", { toast: true });
    })
  );

  const label = doc.createElement("span");
  label.textContent = "Export Comments";
  button.appendChild(label);

  // Same "act on your edits" cluster as Undo All and Print — inserted right
  // after Undo All (also before Print), since both target the same anchor.
  const printButton = doc.getElementById("printButton");
  group.insertBefore(button, printButton || null);

  toolbarExportCommentsButton = button;
}

// ---- Adding a "Summarize Comments" button to pdf.js's toolbar -----------
// Same comment-collection path as Export Comments, but instead of writing
// the comments to Markdown it sends them to a configurable
// OpenAI-compatible endpoint and shows the model's summary in a dialog —
// see summarizeComments() below. Disabled until a file is open. Injected
// the same way and for the same reasons as the other toolbar buttons.
let toolbarSummarizeCommentsButton = null;
function injectSummarizeCommentsButton() {
  if (toolbarSummarizeCommentsButton) return;
  const doc = frame.contentDocument;
  const downloadButton = doc.getElementById("downloadButton");
  const group = downloadButton && downloadButton.closest(".toolbarHorizontalGroup");
  if (!group) return;

  ensureCustomStylesheetLoaded(doc);

  const button = doc.createElement("button");
  button.id = "customSummarizeCommentsButton";
  button.className = "toolbarButton";
  button.type = "button";
  button.title = "Summarize all comments with AI";
  button.disabled = true;
  button.addEventListener("click", () =>
    onSummarizeButtonClick().catch((err) => {
      console.error(err);
      setStatus("Summarize comments failed", "error", { toast: true });
    })
  );

  const label = doc.createElement("span");
  label.textContent = "Summarize Comments";
  button.appendChild(label);

  // Same "act on your edits" cluster — just after Export Comments, still
  // before pdf.js's own Print.
  const printButton = doc.getElementById("printButton");
  group.insertBefore(button, printButton || null);

  toolbarSummarizeCommentsButton = button;
}

// ---- Blocking pdf.js's own internal "Open File" paths -------------------
// pdf.js has three ways to open a *different* PDF that completely bypass
// openPath()/pickAndOpenPdf() below: the "Open File…" entry in its overflow Tools menu
// (#secondaryOpenFile, hidden in custom-viewer.css), dropping a PDF onto
// the viewer, and Ctrl+O / Cmd+O — the latter two wired as plain
// `window.addEventListener("drop"/"keydown", ..., {signal})` calls in
// web/viewer.mjs with no capture flag, i.e. bubble phase (the drop target
// is appConfig.mainContainer; the keydown target is window itself, whose
// own bubble-phase listener is the very last thing to run in the whole
// propagation path). All three read the file through the browser's File
// API and call `app.open({ url: URL.createObjectURL(file), ... })`
// directly, which never touches currentPath. If any ran, the document
// itself would load and mostly work (attachCommentSaveHook/
// attachUndoRedoHook are wired to the persistent app.eventBus, so they'd
// still fire), but currentPath would keep pointing at the *previous*
// file — so the next autosave would silently write the newly opened
// document's bytes over the OLD file on disk, destroying it, while the
// file that was actually opened never gets touched at its real path at
// all. There's no way to instead track the newly opened file's path and
// make this safe: the browser File API never exposes a real absolute
// filesystem path, only a filename, so pdf.js-internal opens can't be
// made autosave-safe in this app regardless of how we wire things up.
//
// Hiding the button covers one path; drag-and-drop and Ctrl+O have no
// button to hide, so we intercept the events directly. A capture-phase
// listener on the iframe's document fires before ANY bubble-phase
// listener further along the same propagation path (including one on
// window itself) ever sees the event, regardless of which was registered
// first — and calling preventDefault() on dragover/drop also suppresses
// the browser's own default behavior for a dropped file (navigating the
// whole webview to it), not just pdf.js's.
//
// Drag-and-drop has no safe substitute (still just blocked, with an error
// toast pointing at the toolbar button), but Ctrl+O does: since it's
// already fully intercepted here before pdf.js's own handler ever sees
// it, there's no reason to just show an error — redirect it straight to
// pickAndOpenPdf(), the same picker the toolbar Open button uses.
let internalFileOpenBlocked = false;
function blockInternalFileOpen(doc) {
  if (internalFileOpenBlocked) return;
  internalFileOpenBlocked = true;
  const block = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.type !== "dragover") {
      setStatus("Use the Open button in the toolbar to open a file", "error", { toast: true });
    }
  };
  doc.addEventListener("dragover", block, { capture: true });
  doc.addEventListener("drop", block, { capture: true });
  doc.addEventListener(
    "keydown",
    (event) => {
      const isOpenShortcut =
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key?.toLowerCase() === "o";
      if (!isOpenShortcut || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      pickAndOpenPdf().catch((err) => {
        console.error(err);
        reportError("Failed to open file");
      });
    },
    { capture: true }
  );
}

// ---- Disabling pdf.js's own "leave site?" prompt ------------------------
// web/viewer.mjs registers its own `beforeunload` listener directly on the
// iframe's window (bindWindowEvents -> onBeforeUnload), independent of and
// in addition to our own accurate one in this file. It guards on
// `_hasChanges()`, which is `annotationStorage.size > 0` — true for the
// entire lifetime of any document that has ever had annotations, saved or
// not, not "there are unsaved changes". Once autosave has already written
// everything to disk, that prompt still fires on every reload/close because
// the annotations are still sitting in storage. `_hasChanges()` is also
// what gates pdf.js's internal close()'s auto-save-on-close, which goes
// through the broken Save-As/blob-download path (see injectSaveButton) —
// disabling it here is a fix for that too, not just the prompt. `_hasChanges`
// is a plain instance method (not `#`-private), safe to reassign; our own
// `dirty`-based beforeunload listener (below) is the real, accurate guard.
function disableInternalBeforeUnloadPrompt(app) {
  app._hasChanges = () => false;
}

// ---- Keyboard shortcuts: Save, and the annotation tools -----------------
// Ctrl+O is handled above in blockInternalFileOpen (already intercepted
// there to block pdf.js's unsafe internal open, so it's redirected to the
// real open path in the same place rather than adding a second listener
// for the same key here).
//
// Ctrl+S: pdf.js's own handler (web/viewer.mjs onKeyDown) binds bare
// Ctrl+S to the "download" event — its Save-As button, which is broken in
// this embedding (see injectSaveButton above) and completely unrelated to
// our real save path. Intercepted the same way as Ctrl+O: a capture-phase
// listener on the iframe's document, which runs before pdf.js's own
// bubble-phase listener on window regardless of registration order.
//
// Text/Draw/Highlight: bare letters A/D/F, chosen to avoid every bare-
// letter shortcut pdf.js already binds in the same handler — H, J, K, N,
// P, R, S (cursor tools and page-turning) — so none of these collide.
// "Images" (Stamp) deliberately has no shortcut.
//
// Comment (C) is deliberately NOT wired to editorCommentButton — that
// toolbar button toggles AnnotationEditorType.POPUP, which opens the
// read-only "all comments" sidebar, not "add a comment on the text I just
// selected". The actual add-a-comment-on-selection action is what pdf.js's
// own floating Comment button does when it appears over a text selection
// (enableComment + enableHighlightFloatingButton, both on — see
// configurePdfjsPreferences below): FloatingToolbar (pdf.mjs) wires that
// button's click straight to `uiManager.commentSelection("floating_button")`.
// C calls that same UI-manager method directly — it no-ops harmlessly if
// there's no active selection (highlightSelection() bails out on
// `selection.isCollapsed`), same as the real button would.
//
// Bare letters mean this needs the same "not while typing" guard pdf.js
// applies before running its own H/S/R/etc (onKeyDown's curElementTagName
// check) — without it, typing a comment or free-text annotation
// containing any of these letters would toggle tools out from under you
// mid-edit. Reimplemented here against the iframe's own activeElement
// rather than reusing pdf.js's private getActiveOrFocusedElement().
function isTypingTarget(doc) {
  const el = doc.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

const TOOL_BUTTON_ID_BY_KEY = {
  a: "editorFreeTextButton",
  d: "editorInkButton",
  f: "editorHighlightButton",
};

let keyboardShortcutsAttached = false;
function attachKeyboardShortcuts(doc) {
  if (keyboardShortcutsAttached) return;
  keyboardShortcutsAttached = true;

  doc.addEventListener(
    "keydown",
    (event) => {
      if (event.repeat) return;

      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        if (event.key?.toLowerCase() === "s") {
          event.preventDefault();
          event.stopPropagation();
          saveNow({ force: true });
        } else if (event.key?.toLowerCase() === "w") {
          closeCurrentPdf(event);
        }
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          event.stopPropagation();
          // These buttons live in the titlebar (outer document) now, not
          // in doc (the iframe) like the pdf.js tool buttons below.
          const button = event.key === "ArrowLeft" ? titlebarPrevBtn : titlebarNextBtn;
          if (!button.disabled) button.click();
        }
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (isTypingTarget(doc)) return;

      const key = event.key?.toLowerCase();

      if (key === "c") {
        const uiManager = getViewerApp()?.pdfViewer?._layerProperties?.annotationEditorUIManager;
        if (uiManager?.commentSelection) {
          event.preventDefault();
          event.stopPropagation();
          uiManager.commentSelection("floating_button");
        }
        return;
      }

      // Q: open the quick-comment menu at the pointer (see the "Quick
      // comments" section). lastIframePointer is kept by
      // attachQuickCommentMenu's mousemove listener.
      if (key === "q") {
        event.preventDefault();
        event.stopPropagation();
        const p = lastIframePointer || {
          x: doc.documentElement.clientWidth / 2,
          y: doc.documentElement.clientHeight / 2,
        };
        openQuickCommentMenu(p.x, p.y);
        return;
      }

      const buttonId = TOOL_BUTTON_ID_BY_KEY[key];
      if (!buttonId) return;
      const button = doc.getElementById(buttonId);
      if (button && !button.disabled) {
        event.preventDefault();
        event.stopPropagation();
        button.click();
      }
    },
    { capture: true }
  );
}

// ---- Adding shortcut-key hints to the tool buttons' tooltips ------------
// Just appending to .title directly would get silently wiped: pdf.js's
// l10n system (DOMLocalization, web/viewer.mjs) keeps a live
// MutationObserver on every element that has a data-l10n-id attribute,
// and re-applies that element's Fluent-sourced title on ANY attribute
// mutation to it (translateMutations queues it, applyTranslations resets
// title/aria-label from the translation) — including the very
// `button.title = ...` set below, on the next animation frame. Removing
// data-l10n-id/data-l10n-args first opts the button out of that observer
// permanently (translateMutations only re-queues elements that still
// carry data-l10n-id), which is safe here because by the time this runs
// (initializeViewer, after waitForViewer's initializedPromise) pdf.js has
// already done its one-time initial translation, so `button.title`
// already holds the real localized text we're appending to.
function addShortcutHints(doc) {
  for (const [key, buttonId] of Object.entries(TOOL_BUTTON_ID_BY_KEY)) {
    const button = doc.getElementById(buttonId);
    if (!button || !button.title) continue;
    button.removeAttribute("data-l10n-id");
    button.removeAttribute("data-l10n-args");
    button.title = `${button.title} (${key.toUpperCase()})`;
  }
}

// ---- Recent-files list ---------------------------------------------------
// Persisted as an array of {path, lastOpened} objects, most-recent-first,
// in localStorage (outer page's storage, unrelated to the iframe's own
// pdfjs.preferences key above). getRecentFiles() also accepts the older
// plain-string-array format (pre-dating lastOpened) still sitting in an
// existing user's localStorage, normalizing each bare string into
// {path, lastOpened: null}.
function getRecentFiles() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_FILES_KEY));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => (typeof entry === "string" ? { path: entry, lastOpened: null } : entry));
  } catch {
    return [];
  }
}

function addToRecentFiles(path) {
  const files = [{ path, lastOpened: Date.now() }, ...getRecentFiles().filter((f) => f.path !== path)].slice(
    0,
    MAX_RECENT_FILES
  );
  localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(files));
}

function removeFromRecentFiles(path) {
  localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(getRecentFiles().filter((f) => f.path !== path)));
}

function filenameFromPath(path) {
  return path.split(/[\\/]/).pop() || path;
}

// Neutralizes Markdown structural characters that could otherwise corrupt
// the generated export's structure when they appear inside PDF-sourced
// text we don't control (comment text, highlighted source text) — a line
// starting with "# " or "> " in a comment would otherwise be read back as
// our own heading/blockquote syntax, not literal text.
function escapeMarkdown(text) {
  return text
    .replace(/[\\`*_[\]]/g, "\\$&") // inline emphasis/link syntax
    .replace(/^(#{1,6}\s|>\s|-\s|\+\s|\d+\.\s)/gm, "\\$1"); // leading block syntax
}

function renderRecentFiles() {
  const files = getRecentFiles();
  recentFilesListEl.replaceChildren();

  if (files.length === 0) {
    const empty = document.createElement("li");
    empty.id = "recentFilesEmpty";
    empty.textContent = "No recent files";
    recentFilesListEl.appendChild(empty);
    return;
  }

  for (const { path, lastOpened } of files) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.title = path;

    const row = document.createElement("div");
    row.className = "recentFileRow";

    const name = document.createElement("span");
    name.className = "recentFileName";
    name.textContent = filenameFromPath(path);
    row.appendChild(name);

    if (lastOpened) {
      const meta = document.createElement("span");
      meta.className = "recentFileMeta";
      meta.textContent = new Date(lastOpened).toLocaleString();
      row.appendChild(meta);
    }
    button.appendChild(row);

    const pathEl = document.createElement("span");
    pathEl.className = "recentFilePath";
    pathEl.textContent = path;
    button.appendChild(pathEl);

    button.addEventListener("click", () => {
      openPath(path).catch((err) => {
        console.error(err);
        reportError("Failed to open file");
      });
    });
    li.appendChild(button);
    recentFilesListEl.appendChild(li);
  }
}

// ---- Reflecting the open document in the native window titlebar --------
// pdf.js has its own setTitle()/_docTitle logic (web/viewer.mjs), but it's
// a no-op for us: `isViewerEmbedded: window.parent !== window` is true
// for any iframe, and setTitle() early-returns without touching
// document.title whenever that's set — by design, since an embedder is
// expected to own the outer chrome (our native OS window, in this case)
// itself. So instead of trying to read pdf.js's internal state, we fetch
// the PDF's metadata ourselves via the public pdfDocument.getMetadata()
// API and set the *native* window title directly via Tauri's window API
// (needs the core:window:allow-set-title capability — not part of
// core:default, see src-tauri/capabilities/default.json).
//
// The title-preference logic (XMP dc:title, skipping the placeholder
// "Untitled" and titles that decoded to private-use-area garbage
// characters, else the Info dictionary's Title field) mirrors pdf.js's
// own `_docTitle` getter, just reimplemented against the public API
// rather than reaching into private viewer state.
//
// Sets the filename immediately (metadata.getMetadata() is async and can
// take a moment on a large/complex PDF) and refines it to the PDF's own
// title afterwards if one turns out to be present. Guards against a
// second file being opened before the first one's metadata fetch
// resolves by checking pdfDocument is still the current one before
// applying the refined title.
// Private-use-area code points in a decoded title (hex FFF0 through
// FFFF) mean the PDF's declared encoding didn't actually match its
// bytes — pdf.js's own _docTitle getter (web/viewer.mjs) checks the same
// range, via a regex; done here by code point comparison instead purely
// because that regex's escape sequence kept getting mangled in transit
// through this conversation, not for any functional reason.
function hasPrivateUseAreaChar(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0xfff0 && code <= 0xffff) return true;
  }
  return false;
}

// currentTitleBase holds the document part of the title (filename, or the
// PDF's own title once metadata resolves) — set once per open/metadata
// resolution, applied via applyWindowTitleBar(). No longer carries an
// "unsaved changes" marker of its own: that's what the titlebar's Activity
// Log status dot (see updateStatusIndicator) is for now.
let currentTitleBase = null;

function applyWindowTitleBar() {
  if (!currentTitleBase) return;
  const title = `${currentTitleBase} — দাগ`;
  // The custom titlebar's own text is what's actually visible now that
  // decorations are off; setTitle() still matters too — it's what the
  // taskbar/Alt+Tab/Win+Tab show, none of which read our HTML.
  titlebarTitleEl.textContent = title;
  // The title text itself is just a filename (or the PDF's own metadata
  // title) — the full path is only a hover away, same idea as the
  // recent-files list already showing it under each entry's name.
  titlebarTitleEl.title = currentPath || "";
  getCurrentWindow()
    .setTitle(title)
    .catch((err) => console.error("Could not set window title:", err));
}

function updateWindowTitle(app, path) {
  const { pdfDocument } = app;

  currentTitleBase = filenameFromPath(path);
  applyWindowTitleBar();

  pdfDocument
    ?.getMetadata()
    .then(({ info, metadata }) => {
      if (app.pdfDocument !== pdfDocument) return; // a newer document was opened meanwhile
      const xmpTitle = metadata?.get("dc:title");
      const pdfTitle =
        xmpTitle && xmpTitle !== "Untitled" && !hasPrivateUseAreaChar(xmpTitle) ? xmpTitle : info?.Title;
      if (pdfTitle) {
        currentTitleBase = `${pdfTitle} (${currentTitleBase})`;
        applyWindowTitleBar();
      }
    })
    .catch((err) => console.error("Could not read PDF metadata for window title:", err));
}

// ---- Loading a document into the viewer ---------------------------------
// Shared by every way a document can end up open — the outer/toolbar Open
// buttons and a recent-files click — so all of them end up in the exact
// same state: currentPath set, save buttons enabled, annotation hooks
// attached, recent-files list updated, window title reflecting the doc.
async function loadPdfIntoViewer(app, path, bytes) {
  // `open()` accepts a plain Uint8Array under `data`. Some pdf.js versions
  // want { data: bytes } directly, older ones wrap it differently —
  // check your bundled version if this throws.
  await app.open({ data: bytes });

  currentPath = path;
  dirty = false;
  summaryCache = null; // a different document — last summary no longer applies
  if (toolbarSaveButton) toolbarSaveButton.disabled = false;
  if (toolbarUndoAllButton) toolbarUndoAllButton.disabled = false;
  if (toolbarExportCommentsButton) toolbarExportCommentsButton.disabled = false;
  if (toolbarSummarizeCommentsButton) toolbarSummarizeCommentsButton.disabled = false;
  setStatus(`Open: ${path}`);
  addToRecentFiles(path);
  renderRecentFiles();
  updateWindowTitle(app, path);

  attachAnnotationHooks(app);

  // Passive UI-state refresh, not part of the open itself — fire-and-forget
  // so a slow or failing directory read never delays showing the document.
  refreshFolderNavigation(path).catch((err) => {
    console.error("Could not refresh folder navigation:", err);
    titlebarPrevBtn.disabled = true;
    titlebarNextBtn.disabled = true;
  });
}

// ---- Previous/Next: scanning the current file's folder for sibling PDFs --
// Recomputed every time a file is opened (cheap: one directory read) rather
// than cached indefinitely, so it self-heals if files were added, removed,
// or renamed in the folder since the last navigation — no separate cache
// invalidation needed.
function updateFolderNavButtons() {
  titlebarPrevBtn.disabled = folderPdfIndex <= 0;
  titlebarNextBtn.disabled = folderPdfIndex < 0 || folderPdfIndex >= folderPdfList.length - 1;
}

async function refreshFolderNavigation(path) {
  const dir = await dirname(path);
  const entries = await readDir(dir);
  const list = entries
    .filter((entry) => entry.isFile && entry.name?.toLowerCase().endsWith(".pdf"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

  const name = await basename(path);
  const index = list.findIndex((entry) => entry.toLowerCase() === name.toLowerCase());

  folderPdfDir = dir;
  folderPdfList = list;
  folderPdfIndex = index;
  updateFolderNavButtons();
}

async function navigateFolder(delta) {
  const targetIndex = folderPdfIndex + delta;
  if (targetIndex < 0 || targetIndex >= folderPdfList.length) return;
  const targetPath = await join(folderPdfDir, folderPdfList[targetIndex]);
  await openPath(targetPath);
}

// ---- Deciding where a PDF is actually read from / saved back to ----------
// Thrown only when a file we expected to exist (the requested path, or a
// remembered copy) has actually gone missing — as opposed to some other
// failure (disk full/permission denied writing a new copy, a native Save
// dialog erroring) that has nothing to do with the requested path and must
// NOT prune it from Recent Files or claim it "moved or was deleted".
class FileMissingError extends Error {}

async function readIfExists(path) {
  if (!(await exists(path))) throw new FileMissingError("file no longer exists");
  return readFile(path);
}

// Suggests "<original's folder>/<name> (copy).pdf" as the native Save
// dialog's starting point — never used silently (the destination is always
// picked via an explicit native dialog, per design), just saves retyping
// the original's own folder/name in the common case.
async function computeDefaultCopyPath(originalPath) {
  const dir = await dirname(originalPath);
  const base = await basename(originalPath, ".pdf"); // strips a trailing ".pdf" if present
  return join(dir, `${base} (copy).pdf`);
}

// Shared by both places a copy destination needs choosing: the "Create a
// Copy…" button in the ask-dialog, and the immediate native-only path taken
// when the global open mode is "copy". Never touches copyMappings itself —
// callers decide whether/how to remember the choice. Returns the chosen
// path, or null if the native dialog was cancelled.
async function createCopyOfOriginal(originalPath, bytes) {
  const defaultPath = await computeDefaultCopyPath(originalPath);
  const copyPath = await save({
    title: "Save Copy As",
    defaultPath,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!copyPath) return null;
  await writeFile(copyPath, bytes);
  return copyPath;
}

// The overwrite-vs-copy policy itself. Every real entry point funnels
// through openPath() (below), so this is the one place it needs to live.
// Returns { targetPath, bytes } (bytes already read — callers never need a
// second readFile), or null if the user cancelled somewhere (the custom
// dialog, or a native Save dialog), which openPath treats as a silent
// no-op — no error, nothing opens.
async function resolveOpenTarget(originalPath) {
  // Opening a copy this app already created for some other original,
  // directly (e.g. its own Recent Files entry) — treat exactly like an
  // unmapped file under "overwrite": just open it, never copy it again.
  if (isKnownCopyPath(originalPath)) {
    return { targetPath: originalPath, bytes: await readIfExists(originalPath) };
  }

  const mapping = getCopyMapping(originalPath);
  if (mapping?.mode === "overwrite") {
    return { targetPath: originalPath, bytes: await readIfExists(originalPath) };
  }
  if (mapping?.mode === "copy") {
    if (await exists(mapping.copyPath)) {
      const decision = await promptContinueOrStartOver(originalPath, mapping.copyPath);
      if (!decision) return null; // cancelled — abort the whole open
      if (decision === "continue") {
        return { targetPath: mapping.copyPath, bytes: await readFile(mapping.copyPath) };
      }
      // "startOver" — forget the copy's association with this original,
      // but give the copy file its own independent mapping (keyed by its
      // own path, mode "overwrite") so it isn't left as a dangling
      // reference: opening that copy file directly later behaves like any
      // other plain overwrite-mode file — no re-prompt, no copy-of-a-copy.
      // Then fall through and re-decide originalPath exactly like a file
      // that was never opened before (same settings-driven ask/overwrite/
      // copy flow below).
      clearCopyMapping(originalPath);
      setCopyMapping(mapping.copyPath, { mode: "overwrite" });
    } else {
      // The remembered copy was moved/deleted since — don't silently fall
      // back to clobbering the original; forget the stale mapping and
      // re-decide from scratch below, same as a file never opened before.
      clearCopyMapping(originalPath);
    }
  }

  const bytes = await readIfExists(originalPath);
  const openMode = getOpenMode();

  if (openMode === "overwrite") {
    return { targetPath: originalPath, bytes };
  }
  if (openMode === "copy") {
    const copyPath = await createCopyOfOriginal(originalPath, bytes);
    if (!copyPath) return null;
    setCopyMapping(originalPath, { mode: "copy", copyPath });
    return { targetPath: copyPath, bytes };
  }

  // openMode === "ask"
  const decision = await promptOverwriteOrCopy(originalPath);
  if (!decision) return null;
  if (decision.action === "overwrite") {
    if (decision.remember) setCopyMapping(originalPath, { mode: "overwrite" });
    return { targetPath: originalPath, bytes };
  }
  const copyPath = await createCopyOfOriginal(originalPath, bytes);
  if (!copyPath) return null; // native dialog cancelled — abort the whole open, don't re-show the ask-dialog
  if (decision.remember) setCopyMapping(originalPath, { mode: "copy", copyPath });
  return { targetPath: copyPath, bytes };
}

// ---- Opening a file by path, with graceful failure -----------------------
// The one thing every entry point funnels through once a *path* is known
// (as opposed to pickAndOpenPdf() below, which is how a path is chosen in
// the first place). resolveOpenTarget() applies the overwrite/copy policy
// and reports whether the file (or a copy of it) still exists; on any
// other failure while opening, prunes that entry so it doesn't keep
// showing a dead link, then reports the error onto whichever screen is
// actually visible.
//
// Serialized via openInFlight so at most one open — and at most one
// custom/native dialog from within resolveOpenTarget — is ever in flight
// at a time; promptOverwriteOrCopy's <dialog> is reused across calls and
// would throw if showModal() were called on it while already open (e.g.
// two rapid Recent Files clicks).
let openInFlight = Promise.resolve();
async function openPath(path) {
  const previous = openInFlight;
  let release;
  openInFlight = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const resolved = await resolveOpenTarget(path);
    if (!resolved) return; // cancelled somewhere; no error, no toast
    const { targetPath, bytes } = resolved;
    const app = await waitForViewer();
    // Snapshot before handing bytes off to app.open() — pdf.js may transfer
    // the underlying buffer to its worker, which would detach it.
    sessionOriginalBytes = bytes.slice();
    // Now redirected to a copy — drop the stale original-path entry so it
    // doesn't keep sitting in Recent Files alongside the copy's own entry.
    if (targetPath !== path) removeFromRecentFiles(path);
    await loadPdfIntoViewer(app, targetPath, bytes);
    showViewer();
  } catch (err) {
    console.error("Could not open PDF:", err);
    if (err instanceof FileMissingError) {
      removeFromRecentFiles(path);
      renderRecentFiles();
      reportError(`Could not open ${filenameFromPath(path)} — it may have moved or been deleted`);
    } else {
      reportError(`Could not open ${filenameFromPath(path)}`);
    }
  } finally {
    release();
  }
}

async function pickAndOpenPdf() {
  const path = await open({
    multiple: false,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!path) return; // user cancelled
  await openPath(path);
}

// ---- Drag-and-drop to open a PDF -----------------------------------------
// pdf.js's own DOM-level drop handling is unsafe here (see
// blockInternalFileOpen above, which still blocks it defensively) — and
// separately, doesn't actually fire for a real OS file drop in the first
// place: Tauri's native window-level drag-drop (dragDropEnabled defaults
// to true, unset in tauri.conf.json so that default applies) intercepts
// the drag before the WebView's own HTML5 "drop" event ever sees it.
// Tauri's own event carries the real absolute filesystem path though,
// unlike the browser File API pdf.js's handler is stuck with — exactly
// what was missing to make drag-and-drop safe — so this routes through
// openPath(), same as every other safe entry point, never through pdf.js.
//
// dropInFlight guards against an open upstream issue where
// onDragDropEvent can fire twice for a single user drop
// (tauri-apps/tauri#14134, unconfirmed/unfixed as of this writing) — a
// plain synchronous flag is enough since both events go through this one
// listener and JS runs event handlers one at a time, so the flag is
// already set before a near-simultaneous second event's handler runs.
let dropInFlight = false;
async function attachDragDropOpen() {
  const webview = getCurrentWebview();
  await webview.onDragDropEvent((event) => {
    // enter/over/leave only drive the landing screen's hover styling
    // (invisible whenever it's hidden behind the viewer screen); the
    // actual open logic below is unchanged and only acts on "drop".
    if (event.payload.type === "enter") {
      const hasPdf = event.payload.paths.some((p) => p.toLowerCase().endsWith(".pdf"));
      landingScreen.classList.toggle("drag-active", hasPdf);
      landingScreen.classList.toggle("drag-invalid", !hasPdf);
      return;
    }
    if (event.payload.type === "leave") {
      landingScreen.classList.remove("drag-active", "drag-invalid");
      return;
    }
    if (event.payload.type !== "drop") return;

    landingScreen.classList.remove("drag-active", "drag-invalid");
    if (dropInFlight) return;
    const path = event.payload.paths.find((p) => p.toLowerCase().endsWith(".pdf"));
    if (!path) {
      reportError("Dropped file is not a PDF");
      return;
    }
    dropInFlight = true;
    openPath(path)
      .catch((err) => {
        console.error(err);
        reportError("Failed to open file");
      })
      .finally(() => {
        dropInFlight = false;
      });
  });
}

// ---- App-wide viewer setup (runs once, independent of any open file) ---
// attachCommentSaveHook/attachUndoRedoHook listen on the persistent
// app.eventBus, injectSaveButton just creates a toolbar button, and
// blockInternalFileOpen/attachKeyboardShortcuts/attachDragDropOpen must be
// active *before* the user ever opens a file through us — closing off
// pdf.js's own "Open File" paths, taking over Ctrl+O/Ctrl+S, and accepting
// a dropped file are all reachable from the very first landing screen
// (Tools-menu entry, drag-and-drop, the keys themselves) with no
// dependency on a file ever having been opened through us. None of this
// belongs gated behind our own Open button.
//
// Deliberately does NOT auto-reopen the most recent file — the landing
// screen (Open button + recent-files list) is always what greets you on
// launch; picking a file, from either place, is always an explicit click.
async function initializeViewer() {
  const app = await waitForViewer();
  // Re-apply now that the iframe has actually finished loading pdf.js.
  // applyTheme(currentTheme) already ran once at module init (below), but
  // that happens synchronously right after frame.src is assigned — long
  // before this promise resolves — so frame.contentWindow was still the
  // placeholder document at that point and every contentWindow?.-guarded
  // line in applyPdfjsColorScheme() silently no-opped. pdf.js's own
  // initialize() does seed the *plain* color-scheme property correctly on
  // its own (from the localStorage preference configurePdfjsPreferences()
  // wrote), but it has no idea our --app-color-scheme custom property
  // exists, so without this, that property — and the memoized-color-cache
  // refresh — would stay unset until the user's first manual theme click,
  // leaving comment popups/markers wrong on a document opened before then.
  applyPdfjsColorScheme();
  attachCommentSaveHook(app);
  attachUndoRedoHook(app);
  // Call order determines left-to-right toolbar order (each injector
  // appends/inserts relative to what's already there) — see the comment
  // above each injector for its cluster. Final layout:
  // [editor tools] | Undo All, Export Comments, Summarize Comments, Print | Save
  // Open/Previous/Next/Activity Log/Settings moved to the titlebar (see
  // #titlebarDocActions in index.html) — not injected here at all.
  injectUndoAllButton();
  injectExportCommentsButton();
  injectSummarizeCommentsButton();
  injectSaveButton();
  blockInternalFileOpen(frame.contentDocument);
  blockReloadKeys(frame.contentDocument);
  attachKeyboardShortcuts(frame.contentDocument);
  attachQuickCommentMenu(frame.contentDocument);
  attachDragDropOpen();
  disableInternalBeforeUnloadPrompt(app);
  addShortcutHints(frame.contentDocument);
  seedDefaultCommenterName();
}

// Landing-screen population is pure localStorage state with no dependency
// on the pdf.js iframe — call immediately so the landing screen is fully
// populated at first paint instead of jumping once initializeViewer()'s
// waitForViewer() resolves (pdf.js's SPA boot can take a few hundred ms).
renderRecentFiles();
updateLandingOpenModeWarning();
renderAiModelDatalist();

// This is a fresh process, so if long path support was enabled last run it
// is now actually in effect — drop the "restart to apply" note.
if (localStorage.getItem(LONG_PATH_RESTART_PENDING_KEY)) {
  invoke("long_paths_enabled")
    .then((enabled) => {
      if (enabled === true) localStorage.removeItem(LONG_PATH_RESTART_PENDING_KEY);
    })
    .catch(() => {});
}

initializeViewer();

// ---- Open a file passed on the command line ------------------------------
// Covers double-clicking a PDF (once file associations are registered by
// an installed build — see tauri.conf.json's bundle.fileAssociations),
// "Open with" from Explorer's context menu, and a plain
// `daag.exe file.pdf` shell invocation — Windows passes the path
// as argv[1] in all three cases. Routed through openPath(), same as every
// other entry point, so it goes straight to the viewer (skipping the
// landing screen) and gets the same session-snapshot/autosave wiring.
invoke("get_launch_path").then((path) => {
  if (path) openPath(path);
});

// ---- Startup update check ---------------------------------------------
// One quiet pass shortly after launch so it never competes with opening a
// document. Only surfaces UI (a toast + #updateDialog) if an update is
// actually available; any failure is logged to the activity log only.
setTimeout(() => {
  checkForUpdate({ silent: true });
}, UPDATE_STARTUP_CHECK_DELAY_MS);

// ---- Hooking comment edits for autosave --------------------------------
// pdf.js's comment-popup Save button (web/viewer.mjs CommentDialog#save)
// does `editor.comment = text`, which only mutates the already-stored
// editor object in place (pdf.mjs AnnotationEditor#comment setter) — it
// never calls annotationStorage.setValue() again, so annotationStorage's
// own onSetModified never fires for a comment-only edit (this looks like a
// gap in pdf.js's own change-tracking, not something specific to us: even
// pdf.js's internal "*" title / beforeunload logic relies on that same
// onSetModified callback and misses comment edits too). The only signal
// that actually distinguishes "comment dialog was closed with changed
// text" is a `reporttelemetry` event CommentDialog#finish dispatches on
// the app's eventBus with `details: { type: "comment", data: { edited } }`
// — fired on Cancel too, so `edited` can be a false positive if the user
// types then cancels, but that just costs a harmless redundant save.
// Deleting a comment outright (the trash icon in the comment popup, as
// opposed to editing its text down to empty) is a separate code path —
// CommentPopup's delete handler in viewer.mjs — that never opens
// CommentDialog at all, so #finish() never runs; it dispatches its own
// `reporttelemetry` with `details: { type: "comment", data: { deleted:
// true } }` instead, which we also treat as dirty.
// app.eventBus is created once during app init (long before any document
// is opened) and stays the same object across file opens, so this must be
// wired up exactly once — not per-document like attachAnnotationHooks.
let commentSaveHookAttached = false;
function attachCommentSaveHook(app) {
  if (commentSaveHookAttached) return;
  commentSaveHookAttached = true;
  app.eventBus.on("reporttelemetry", ({ details }) => {
    if (details?.type === "comment" && (details?.data?.edited || details?.data?.deleted)) {
      markDirty();
    }
  });
}

// ---- Hooking undo/redo (and the edits they undo/redo) for autosave -----
// A whole class of edits — recoloring, resizing, moving, changing
// thickness/opacity/font size — go through
// AnnotationEditorUIManager.addCommands({cmd, undo, mustExec}) (pdf.mjs),
// whose cmd/undo closures mutate the editor object's own fields directly
// (e.g. `this.color = col`) rather than calling
// annotationStorage.setValue() again. Since the editor instance IS the
// value already sitting in annotationStorage for that id, that mutation is
// invisible to the storage's own change-tracking — same root cause as the
// comment-edit gap, just a different call path, and it affects the
// original action AND every future undo/redo of it identically, since
// CommandManager.undo()/redo() (also pdf.mjs) just replay those same
// closures. So we patch both ends: addCommands (covers the original
// action, whenever it actually executes) and undo/redo (covers reverting
// or reapplying it, whatever it was).
//
// uiManager.undo/redo/addCommands are plain (non-private) instance
// methods, so wrapping them is safe. But the uiManager instance itself
// isn't: pdf.js constructs a *new* AnnotationEditorUIManager (app.js,
// PDFViewerApplication's `annotationEditorMode` setter) on every editor
// tool-mode switch, not just once per document — a fixed-point patch
// attached right after open() would go stale the first time the user
// changes tools. `annotationeditoruimanager` is the eventBus event pdf.js
// itself dispatches each time it creates one, so we re-patch every time.
//
// Also patches addToAnnotationStorage(editor) — the uiManager method that
// registers an editor into annotationStorage, whether that editor is
// genuinely new or not. Entering *any* editing mode — including
// AnnotationEditorType.POPUP, the read-only "Comment" sidebar listing
// every comment in the file — makes updateMode() call #enableAll(), which
// lazily converts each pre-existing annotation on the page into an
// editable editor object the first time editing mode is entered this
// session, via this exact same addToAnnotationStorage()/setValue() path
// (tools.js #enableAll → annotation_editor_layer.js enable/add →
// addToAnnotationStorage → setValue → #setModified) — so without this
// patch, just opening and closing the comment sidebar with zero actual
// edits fires our chained onSetModified and marks the document dirty.
//
// An earlier version of this fix suppressed markDirty for the entire span
// of updateMode() instead, which was too broad: updateMode() *also* opens
// by synchronously committing whatever drawing/edit session was already
// in progress (`this.#currentDrawingSession?.commitOrRemove()`, pdf.mjs)
// — e.g. finishing a freehand Ink stroke and then switching tools, or
// away from Highlight after drawing via the toolbar button rather than
// the inline popup. That commit is a genuine edit, and it happens inside
// the very updateMode() call we were suppressing, so it silently
// swallowed real saves — reported as "freehand drawing doesn't autosave
// unless I also touch the color/linewidth popup" and "sometimes" with the
// toolbar-button highlight flow, both timing-dependent on whether a mode
// switch intervened.
//
// The precise distinguisher pdf.js gives us is editor.annotationElementId
// — set only when an editor corresponds to an annotation that already
// existed in the original PDF, never for one the user just created. Since
// addToAnnotationStorage/setValue/#setModified/onSetModified is a fully
// synchronous chain with no internal awaits, bracketing suppressDirty
// around just this one call is exact — no timing assumptions about *when*
// within a broader async operation the false-positive call happens to
// land, unlike the updateMode-wide version above.
//
// removeEditor(editor) needs the exact same annotationElementId-gated
// suppression, for a different false positive: opening/closing ANY
// toolbar tool popup (not just the Comment sidebar) churns every
// pre-existing editor through an internal detach/reattach, and
// AnnotationEditorUIManager.removeEditor() (pdf.mjs) unconditionally
// calls annotationStorage.remove(editor.id) as part of that housekeeping
// — one call per pre-existing annotation in the file, all in the same
// synchronous burst, each tripping the patched storage.remove() below and
// firing markDirty(). Confirmed by a temporary diagnostic build: a single
// popup open/close on a 29-annotation file produced exactly 29
// back-to-back "Unsaved changes" log entries, none of them from
// setValue()/onSetModified (which pdf.js itself only fires once per dirty
// session — it can't produce a 29-wide burst on its own). Safe to
// suppress here: a *genuine* deletion of a pre-existing annotation goes
// through AnnotationEditorUIManager.delete() → addCommands({mustExec:
// true}) first (pdf.mjs), which the addCommands patch above already
// marks dirty for — so the removeEditor()-triggered storage.remove() for
// an annotationElementId-tagged editor is always redundant with an
// already-correct signal, never the only one.
let undoRedoHookAttached = false;
let suppressDirty = false;
function withDirtySuppressed(fn) {
  const wasSuppressed = suppressDirty;
  suppressDirty = true;
  try {
    fn();
  } finally {
    suppressDirty = wasSuppressed;
  }
}
function attachUndoRedoHook(app) {
  if (undoRedoHookAttached) return;
  undoRedoHookAttached = true;
  app.eventBus.on("annotationeditoruimanager", ({ uiManager }) => {
    if (!uiManager) return;
    const originalAddCommands = uiManager.addCommands.bind(uiManager);
    uiManager.addCommands = (params) => {
      originalAddCommands(params);
      if (params?.mustExec) markDirty();
    };
    const originalUndo = uiManager.undo.bind(uiManager);
    uiManager.undo = () => {
      originalUndo();
      markDirty();
    };
    const originalRedo = uiManager.redo.bind(uiManager);
    uiManager.redo = () => {
      originalRedo();
      markDirty();
    };
    const originalAddToAnnotationStorage = uiManager.addToAnnotationStorage.bind(uiManager);
    uiManager.addToAnnotationStorage = (editor) => {
      if (editor?.annotationElementId) {
        withDirtySuppressed(() => originalAddToAnnotationStorage(editor));
      } else {
        originalAddToAnnotationStorage(editor);
      }
    };
    const originalRemoveEditor = uiManager.removeEditor.bind(uiManager);
    uiManager.removeEditor = (editor) => {
      if (editor?.annotationElementId) {
        withDirtySuppressed(() => originalRemoveEditor(editor));
      } else {
        originalRemoveEditor(editor);
      }
    };
  });
}

// ---- Hooking annotation changes for autosave --------------------------
async function attachAnnotationHooks(app) {
  const { pdfDocument } = app;
  const storage = pdfDocument && pdfDocument.annotationStorage;
  if (!storage) {
    setStatus("Warning: no annotationStorage found on this document", "error", { toast: true });
    return;
  }

  // pdf.js's own viewer ALSO sets annotationStorage.onSetModified /
  // onResetModified (see web/viewer.mjs, _initializeAnnotationStorageCallbacks
  // — used to drive its "*" title marker / beforeunload prompt). These are
  // plain settable properties, not a multi-listener event bus, so whichever
  // assignment runs last wins. pdf.js wires its own callback inside
  // `pdfViewer.firstPagePromise.then(...)`, i.e. asynchronously, *after*
  // `app.open()` already resolved — so if we attach ours right away (as this
  // used to), pdf.js's later assignment silently clobbers it, markDirty()
  // never fires again, and autosave goes dead forever (manual Save still
  // works because it bypasses the dirty check with force:true). Waiting on
  // the same firstPagePromise guarantees we attach *after* pdf.js, and we
  // chain onto its existing callback instead of overwriting it so its own
  // dirty-tracking keeps working too.
  await app.pdfViewer.firstPagePromise;
  if (app.pdfDocument !== pdfDocument) return; // a different doc was opened meanwhile

  const previousOnSetModified = storage.onSetModified;
  storage.onSetModified = () => {
    previousOnSetModified?.();
    // Only onSetModified means "something changed" — onResetModified fires
    // after pdf.js's own saveDocument() finishes (it resets the modified
    // flag in a `finally`, success or failure), so wiring it to markDirty()
    // would immediately re-flag the document dirty right after every save
    // and cause the AUTOSAVE_MAX_WAIT_MS safety net to keep re-saving an
    // unchanged document forever.
    markDirty();
  };

  // AnnotationStorage.remove() (pdf.mjs) — called when you delete a whole
  // highlight/annotation — deletes the entry and, unlike setValue(), never
  // calls #setModified()/onSetModified at all (it only calls
  // resetModified(), which fires the *opposite* callback, and only once
  // the storage becomes fully empty). So deleting the last remaining
  // annotation on a page never marks the document dirty, same underlying
  // "pdf.js's own change-tracking has gaps" story as the comment hooks
  // above. There's no onRemove callback to hook, so we wrap the method
  // itself instead — safe because `remove` is a plain (non-private, not
  // arrow-bound) prototype method, so every caller that does
  // `annotationStorage.remove(id)`, wherever in pdf.js it lives, goes
  // through this instance-level override.
  const originalRemove = storage.remove.bind(storage);
  storage.remove = (key) => {
    const existed = storage.has(key);
    originalRemove(key);
    if (existed) markDirty();
  };

  // Stamp the global commenter name onto every serialized annotation so
  // saveDocument() writes it into the PDF's standard "T"/author field.
  // pdf.js's worker-side writers already know how to do this — see
  // createNewDict() for FreeText/Ink/Highlight/Stamp in build/pdf.worker.mjs,
  // each of which does `dict.setIfDefined("T", ...user)` — but nothing on
  // the display side ever populates `user` on a freshly created editor's
  // serialize() output; there's no UI for it at all in this pdf.js build.
  // `serializable` is a getter defined on AnnotationStorage.prototype, not
  // an own property, so it can't be reassigned like `remove` above (no
  // setter — a plain `storage.serializable = ...` would throw in strict
  // mode); shadow it per-instance with defineProperty instead. Only fills
  // in `user` when the serialized object doesn't already have one, so this
  // never overwrites an author baked into an annotation from elsewhere
  // (e.g. re-saving a PDF someone else annotated in Acrobat).
  const originalSerializableDescriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(storage),
    "serializable"
  );
  Object.defineProperty(storage, "serializable", {
    configurable: true,
    get() {
      const serializable = originalSerializableDescriptor.get.call(storage);
      const name = getCommenterName();
      if (name && serializable.map) {
        for (const value of serializable.map.values()) {
          if (value && typeof value === "object" && value.user === undefined) {
            value.user = name;
          }
        }
      }
      return serializable;
    },
  });
}

function markDirty() {
  if (suppressDirty) return;
  dirty = true;
  setStatus("Unsaved changes…", "dirty");
  scheduleAutosave();
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => saveNow(), AUTOSAVE_DEBOUNCE_MS);
}

// ---- Writing back to disk ----------------------------------------------
// `force` bypasses the dirty check — used by the manual Save button, so
// clicking it always does something observable (and re-saves rather than
// silently no-op'ing) instead of only working when it happens to race
// ahead of the autosave debounce. Also gates the "Saved" toast: a manual
// click gets a confirmation, an unattended autosave tick doesn't (it'd
// fire on every debounce window, autosaving every few seconds while
// actively editing — the toolbar status dot and activity log still see
// every one, just without interrupting with a popup for each).
//
// Returns the saved bytes on success (undefined on no-op/failure) — used
// by revertToSessionStart's strip-all-annotations path to reload the
// viewer from exactly what was just written to disk, without a second
// disk read.
async function saveNow({ force = false } = {}) {
  if (!currentPath || saveInFlight) return undefined;
  if (!force && !dirty) return undefined;
  const app = getViewerApp();
  if (!app || !app.pdfDocument) return undefined;

  saveInFlight = true;
  setStatus("Saving…", "saving");

  try {
    // pdfDocument.saveDocument() bakes the current annotationStorage
    // values into the PDF bytes and returns a Uint8Array — this is the
    // same call the built-in viewer's download button uses internally.
    const bytes = await app.pdfDocument.saveDocument();

    // Write-then-rename instead of overwriting directly, so a crash or
    // power loss mid-write can't corrupt the original file.
    const tmpPath = currentPath + ".autosave.tmp";
    await writeFile(tmpPath, bytes);
    await rename(tmpPath, currentPath);

    dirty = false;
    setStatus(`${force ? "Saved" : "Autosaved"} ${new Date().toLocaleTimeString()}`, "", { toast: force });
    return bytes;
  } catch (err) {
    console.error("Autosave failed:", err);
    setStatus("Autosave failed", "error", { toast: true });
    // Keep `dirty` true so the next edit or manual Save retries.
    return undefined;
  } finally {
    saveInFlight = false;
  }
}

// ---- "Undo All": reverting to the file's state at session start --------
// Deliberately does NOT walk pdf.js's undo stack (CommandManager.undo(),
// see attachUndoRedoHook) — that only covers edits made through
// addCommands, and even that path needed real patching to autosave
// correctly (recolor/resize/move, comment edits/deletions, and whole-
// annotation removal all have their own gaps — see Known rough edges in
// CLAUDE.md). Reverting to the exact bytes read from disk when this file
// was opened this session (sessionOriginalBytes, captured in openPath)
// sidesteps all of that: it's the same "reopen the document" path as any
// other open, so it uniformly undoes every kind of edit at once,
// regardless of what pdf.js call path produced it.
//
// Force-saves immediately afterward rather than just marking dirty and
// letting the normal debounce handle it — this app's whole premise is
// that the file on disk should never lag behind what's on screen for
// longer than necessary, and if autosave already wrote this session's
// annotations to disk before Undo All was clicked, leaving the reverted
// state unsaved would mean a crash right after clicking it loses nothing
// visible but silently leaves the old annotations sitting in the file.
async function revertToSessionStart({ stripAllAnnotationsToo = false } = {}) {
  if (!currentPath || !sessionOriginalBytes) return;
  const app = getViewerApp();
  if (!app) return;

  await loadPdfIntoViewer(app, currentPath, sessionOriginalBytes.slice());

  if (stripAllAnnotationsToo) {
    await stripAllAnnotations(app);
    const savedBytes = await saveNow({ force: true });
    // stripAllAnnotations writes deletion markers straight into
    // annotationStorage rather than going through pdf.js's editor UI (see
    // the comment there) — a real, UI-driven deletion removes its own
    // rendered DOM element as part of that flow, but a storage-only
    // mutation on an already-rendered page never touches the DOM. Without
    // this reload, the file on disk is correct immediately, but the
    // screen keeps showing the "deleted" annotations until the file is
    // closed and reopened (confirmed: annotations were gone on reopen,
    // but stayed rendered in the same session beforehand).
    if (savedBytes) {
      await loadPdfIntoViewer(app, currentPath, savedBytes);
    }
    setStatus("Undo All: removed every annotation in this file", "", { toast: true });
  } else {
    setStatus("Undo All: removed all annotations made this session", "", { toast: true });
    await saveNow({ force: true });
  }
}

// pdf.js's own internal storage-key convention for an annotation-editor
// entry — NOT part of its public API (globalThis.pdfjsLib), so this is
// hardcoded rather than imported. Verified against the bundled
// src/pdfjs/build/pdf.worker.mjs's getNewAnnotationsMap(), which silently
// ignores any annotationStorage entry whose key does NOT start with this
// exact prefix (used to select which entries even get considered for the
// save/delete path below) — and against src/pdfjs/build/pdf.mjs's
// AnnotationLayer's commentText setter, which stores a comment edit for a
// non-editor annotation the same way: this prefix + the annotation's own
// id as the key. Re-verify against the bundled source if this ever stops
// working after a pdf.js upgrade.
const PDFJS_ANNOTATION_EDITOR_PREFIX = "pdfjs_internal_editor_";

// ---- "Undo All" checkbox: stripping every annotation, not just this
// session's --------------------------------------------------------------
// Goes further than revertToSessionStart alone: after that reload, every
// remaining annotation is unambiguously pre-existing (this session's own
// edits are already gone), whether from an earlier session of this app or
// a different one entirely (Acrobat, etc.) — this deletes all of those
// too.
//
// Deliberately does NOT go through pdf.js's editor/AnnotationEditorUIManager
// machinery (no AnnotationEditor instances are created, no editing mode is
// entered) — annotationStorage happily stores a plain object as a value
// (its `serializable` getter only calls `.serialize()` on values that are
// actual AnnotationEditor instances; anything else is used as-is), and the
// exact minimal shape needed is the same one pdf.js's own internal
// AnnotationEditor#serializeDeleted()/FakeEditor produce (the mechanism it
// already uses whenever a user deletes ONE pre-existing annotation through
// the normal editor UI): `{ id: <the annotation's own ref-derived id>,
// deleted: true, pageIndex, popupRef }`, stored under a key built from
// PDFJS_ANNOTATION_EDITOR_PREFIX (see above — using the bare id as the key
// looks reasonable but silently drops the deletion with no error).
//
// getAnnotations() is called per-page rather than relying on any
// AnnotationEditorUIManager state (e.g. "select all" + delete) precisely
// because it doesn't require a page to have ever been rendered/scrolled
// into view — the editor-layer approach would miss annotations on
// off-screen pages of a long document.
//
// Link, Popup, and Widget (form field) annotations are deliberately left
// alone — those aren't "annotations" in the sense a reviewer adds by hand,
// and removing them would break in-document navigation or a fillable
// form. Markup annotation types (Highlight, FreeText, Ink, Stamp, Text,
// etc.) never override the base Annotation.save() used by saveDocument()'s
// other, unconditional per-page save pass (only Widget subclasses do, for
// form field values), so there's no conflict between that pass and the
// deletion handled here.
async function stripAllAnnotations(app) {
  const { pdfDocument } = app;
  const storage = pdfDocument.annotationStorage;
  const { AnnotationType } = frame.contentWindow.pdfjsLib;
  const preserveTypes = new Set([AnnotationType.LINK, AnnotationType.POPUP, AnnotationType.WIDGET]);

  const pages = await Promise.all(
    Array.from({ length: pdfDocument.numPages }, (_, i) => pdfDocument.getPage(i + 1))
  );
  const annotationsByPage = await Promise.all(pages.map((page) => page.getAnnotations()));

  // Temporary diagnostics: this path leans on undocumented pdf.js
  // internals (see the block comment above), so when something doesn't
  // get removed, this pinpoints whether it's because getAnnotations()
  // found nothing, the type filter excluded it, or it lacked a usable
  // `.id` (e.g. a directly-embedded, non-indirect-reference annotation
  // dict, which pdf.js can't target for deletion this way at all).
  let found = 0,
    marked = 0,
    skippedType = 0,
    skippedNoId = 0;

  annotationsByPage.forEach((annotations, pageIndex) => {
    for (const annotation of annotations) {
      found++;
      if (!annotation.id) {
        skippedNoId++;
        console.warn("[stripAllAnnotations] no usable id, skipping:", annotation);
        continue;
      }
      if (preserveTypes.has(annotation.annotationType)) {
        skippedType++;
        continue;
      }
      storage.setValue(`${PDFJS_ANNOTATION_EDITOR_PREFIX}${annotation.id}`, {
        id: annotation.id,
        deleted: true,
        pageIndex,
        popupRef: annotation.popupRef || "",
      });
      marked++;
    }
  });

  console.log(
    `[stripAllAnnotations] pages=${pdfDocument.numPages} found=${found} marked=${marked} skippedType=${skippedType} skippedNoId=${skippedNoId}`
  );
}

// ---- Quick comments (right-click / Q in the viewer) --------------------
// A frequency-ranked list of short review phrases ("not clear", "make it
// brief", "does not make sense") the user reaches for again and again.
// Right-clicking anywhere on a page — or pressing Q — opens a small menu of
// them, most-used first; a pick drops that phrase onto the document as a
// pdf.js comment with no dialog in between. The list is never seeded:
// entries appear when the user first types one into the menu's input, and
// when exporting/summarizing surfaces a phrase that repeats within a single
// document (harvestRepeatedComments).
//
// pdf.js 6.x has no standalone/sticky-note comment editor — every comment
// rides a host editor. So each of the three placement cases ends with the
// same operation the real comment dialog performs, `editor.comment = text`
// (web/viewer.mjs CommentDialog#save), on a freshly created Highlight
// editor:
//   1. text is selected            -> uiManager.commentSelection() over it
//   2. no selection, pointer over page text
//                                  -> synthesize a one-character selection
//                                     there, then (1)
//   3. pointer over blank page area -> build a ~1-glyph Highlight box at the
//                                     pointer via layer.createAndAddNewEditor()
// (1) and (2) reuse pdf.js's own vetted selection->boxes->layer path
// wholesale; only (3) pokes at layer internals, via the public getLayer()
// and createAndAddNewEditor() (same tier as the commentSelection() call the
// C shortcut already leans on). An empty comment never reaches the document
// because the phrase is always chosen *before* the annotation is created —
// there's no create-then-cancel window to leave an orphan highlight.

function getQuickComments() {
  try {
    const parsed = JSON.parse(localStorage.getItem(QUICK_COMMENTS_KEY));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e) => e && typeof e.text === "string" && e.text.trim())
      .map((e) => ({
        text: e.text.trim(),
        count: Number.isFinite(e.count) && e.count > 0 ? e.count : 1,
        lastUsedAt: Number.isFinite(e.lastUsedAt) ? e.lastUsedAt : 0,
      }))
      .sort((a, b) => b.count - a.count || b.lastUsedAt - a.lastUsedAt);
  } catch {
    return [];
  }
}

function saveQuickComments(list) {
  localStorage.setItem(QUICK_COMMENTS_KEY, JSON.stringify(list));
}

// Bump an existing phrase's frequency (case-insensitive, trimmed match) or
// add it fresh at count 1. Called on every menu pick and by
// harvestRepeatedComments().
function recordQuickComment(rawText) {
  const text = (rawText || "").trim();
  if (!text) return;
  const list = getQuickComments();
  const key = text.toLowerCase();
  const existing = list.find((e) => e.text.toLowerCase() === key);
  if (existing) {
    existing.count += 1;
    existing.lastUsedAt = Date.now();
  } else {
    list.push({ text, count: 1, lastUsedAt: Date.now() });
  }
  saveQuickComments(list);
  if (settingsDialogEl.open) renderQuickCommentsManageList();
}

// Fold a document's own repeated comments into the quick list — a comment
// that appears two or more times in the same export/summary is, by
// definition, a phrase the user reuses. One increment per distinct repeated
// phrase per call (exporting the same file twice bumps it twice; acceptable
// — menu picks are the primary ranking signal). Length is not a filter.
function harvestRepeatedComments(entries) {
  const counts = new Map();
  for (const entry of entries || []) {
    const text = (entry.comment || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    const cur = counts.get(key);
    if (cur) cur.count += 1;
    else counts.set(key, { text, count: 1 });
  }
  for (const { text, count } of counts.values()) {
    if (count >= 2) recordQuickComment(text);
  }
}

// ---- Quick comment menu (parent-document overlay) ---------------------
// Built lazily and reused. Lives in the parent document (not the iframe) so
// it gets the app's theme tokens for free and dodges pdf.js's viewer.html
// CSP, which drops inline styles. Positions are computed in the iframe
// document's client coordinates (both entry points — the capture-phase
// contextmenu listener and the Q shortcut — originate there); the frame's
// own offset is added when placing the menu.
let quickCommentMenuEl = null;
let quickCommentInputEl = null;
let quickCommentMenuPointer = null; // {x, y} in iframe client coords, for the pending insert
let quickCommentMenuOpenedAt = 0;
// Last pointer position seen inside the iframe, in its client coords. Q
// uses this; a Q with no pointer yet falls back to the iframe centre.
let lastIframePointer = null;

function buildQuickCommentMenu() {
  if (quickCommentMenuEl) return;
  const menu = document.createElement("div");
  menu.id = "quickCommentMenu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");

  const list = document.createElement("div");
  list.id = "quickCommentMenuList";

  const divider = document.createElement("div");
  divider.className = "qcDivider";

  const input = document.createElement("input");
  input.id = "quickCommentInput";
  input.type = "text";
  input.autocomplete = "off";
  input.placeholder = "Add comment…";
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      const value = input.value.trim();
      if (value) chooseQuickComment(value);
    } else if (event.key === "Escape") {
      closeQuickCommentMenu();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const items = list.querySelectorAll(".qcItem");
      if (items.length) items[items.length - 1].focus();
    }
  });

  menu.append(list, divider, input);
  document.body.append(menu);
  quickCommentMenuEl = menu;
  quickCommentInputEl = input;
}

function renderQuickCommentMenuItems() {
  const listEl = quickCommentMenuEl.querySelector("#quickCommentMenuList");
  const entries = getQuickComments().slice(0, MAX_QUICK_COMMENT_MENU_ITEMS);
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "qcEmpty";
    empty.textContent = "No saved phrases yet — type one below.";
    listEl.replaceChildren(empty);
    return;
  }
  listEl.replaceChildren(
    ...entries.map((entry) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "qcItem";
      item.setAttribute("role", "menuitem");

      const text = document.createElement("span");
      text.className = "qcText";
      text.textContent = entry.text;
      text.title = entry.text;

      // Frequency (entry.count) only drives the sort order above — never
      // shown in the menu.
      item.append(text);
      item.addEventListener("click", () => chooseQuickComment(entry.text));
      item.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          const next = item.nextElementSibling;
          if (next && next.classList.contains("qcItem")) next.focus();
          else quickCommentInputEl.focus();
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          const prev = item.previousElementSibling;
          if (prev && prev.classList.contains("qcItem")) prev.focus();
        } else if (event.key === "Escape") {
          closeQuickCommentMenu();
        }
      });
      return item;
    })
  );
}

function openQuickCommentMenu(clientX, clientY) {
  if (!getViewerApp()?.pdfDocument || !currentPath) return;
  buildQuickCommentMenu();
  quickCommentMenuPointer = { x: clientX, y: clientY };
  renderQuickCommentMenuItems();
  quickCommentInputEl.value = "";

  const menu = quickCommentMenuEl;
  menu.hidden = false;
  quickCommentMenuOpenedAt = Date.now();

  const frameRect = frame.getBoundingClientRect();
  let x = frameRect.left + clientX;
  let y = frameRect.top + clientY;
  const rect = menu.getBoundingClientRect();
  if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - 8 - rect.width;
  if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - 8 - rect.height;
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;

  quickCommentInputEl.focus();
}

function closeQuickCommentMenu() {
  if (!quickCommentMenuEl || quickCommentMenuEl.hidden) return;
  // Opening the menu parked focus on its input, which lives in the *parent*
  // document. Hiding the menu drops that focus onto the parent <body>, out
  // of the iframe — so attachKeyboardShortcuts (bound on
  // frame.contentDocument) and pdf.js's own key handling both go deaf until
  // something inside the iframe is clicked. Hand focus back to the iframe
  // whenever the menu had it.
  const menuHadFocus = quickCommentMenuEl.contains(document.activeElement);
  quickCommentMenuEl.hidden = true;
  if (menuHadFocus) frame.contentWindow?.focus();
}

function chooseQuickComment(text) {
  const pointer = quickCommentMenuPointer;
  closeQuickCommentMenu();
  recordQuickComment(text);
  insertQuickComment(text, pointer).catch((err) => {
    console.error("Quick comment failed:", err);
    setStatus("Couldn't add the comment", "error", { toast: true });
  });
}

// ---- Placing a quick comment on the document -------------------------
async function insertQuickComment(text, pointer) {
  const phrase = (text || "").trim();
  if (!phrase) return;
  const app = getViewerApp();
  const uiManager = app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
  if (!uiManager || !app?.pdfDocument) return;
  const iwin = frame.contentWindow;
  const idoc = frame.contentDocument;

  const selection = iwin.getSelection();
  const hasRealSelection =
    selection &&
    selection.rangeCount > 0 &&
    !selection.isCollapsed &&
    selection.toString().trim().length > 0;

  // Case 1: comment on whatever text is selected.
  if (hasRealSelection) {
    applyCommentOverSelection(uiManager, phrase);
    return;
  }

  if (!pointer) {
    setStatus("Select text, or right-click on a page, to add a comment", "error", {
      toast: true,
    });
    return;
  }

  // Case 2: no selection, but there's page text under the pointer — anchor
  // a one-character selection to it and fall through to the same path.
  const range = caretRangeAtPoint(idoc, pointer.x, pointer.y);
  const anchorNode = range?.startContainer;
  const inTextLayer =
    anchorNode?.nodeType === 3 && anchorNode.parentElement?.closest(".textLayer");
  if (range && inTextLayer && widenRangeToOneChar(range)) {
    selection.removeAllRanges();
    selection.addRange(range);
    applyCommentOverSelection(uiManager, phrase);
    return;
  }

  // Case 3: genuinely blank page area — synthetic Highlight box.
  await applyCommentAtBlankPoint(uiManager, idoc, iwin, pointer, phrase);
}

function caretRangeAtPoint(doc, x, y) {
  if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    if (!pos) return null;
    const r = doc.createRange();
    r.setStart(pos.offsetNode, pos.offset);
    r.collapse(true);
    return r;
  }
  return null;
}

// caretRangeFromPoint returns a collapsed range at a character boundary;
// widen it to cover one glyph so highlightSelection() has a non-empty
// selection to work with. Returns false if the node has no text to cover.
function widenRangeToOneChar(range) {
  const node = range.startContainer;
  const len = node.textContent?.length ?? 0;
  if (len === 0) return false;
  const off = range.startOffset;
  if (off < len) range.setEnd(node, off + 1);
  else range.setStart(node, off - 1);
  return !range.collapsed;
}

// Wrap uiManager.editComment just long enough to catch the editor pdf.js
// creates for the current selection and set its text directly, so the
// comment dialog never actually opens. commentSelection() ->
// highlightSelection() does the selection->boxes->layer work and, when
// starting from NONE mode, an async switchToMode() first — hence the
// generous restore timeout. If it bails (selection not inside a text
// layer, etc.) the wrapper is never called and the timeout restores the
// original method.
function applyCommentOverSelection(uiManager, phrase) {
  const originalEditComment = uiManager.editComment.bind(uiManager);
  let settled = false;
  const settle = (editor) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    uiManager.editComment = originalEditComment;
    if (editor) {
      try {
        editor.comment = phrase;
        markDirty();
      } catch (err) {
        console.error("Couldn't attach quick comment, removing host highlight:", err);
        try {
          editor.remove();
        } catch {
          /* best effort */
        }
      }
    }
  };
  const timer = setTimeout(() => settle(null), 3000);
  uiManager.editComment = (editor) => settle(editor);
  try {
    uiManager.commentSelection("context_menu");
  } catch (err) {
    settle(null);
    throw err;
  }
}

async function applyCommentAtBlankPoint(uiManager, idoc, iwin, pointer, phrase) {
  const AET = iwin.pdfjsLib.AnnotationEditorType;
  const pageEl = idoc.elementFromPoint(pointer.x, pointer.y)?.closest(".page");
  if (!pageEl?.dataset.pageNumber) {
    setStatus("Point inside a page to add a comment", "error", { toast: true });
    return;
  }
  const pageIndex = Number(pageEl.dataset.pageNumber) - 1;
  if (uiManager.getMode() !== AET.HIGHLIGHT) await uiManager.updateMode(AET.HIGHLIGHT);

  const layer = uiManager.getLayer(pageIndex);
  if (!layer) return;

  // boxes are normalised [0,1] to the page rect (pdf.mjs
  // AnnotationEditorUIManager#getSelectionBoxes); width/height here is
  // roughly one glyph at a typical zoom.
  const rect = pageEl.getBoundingClientRect();
  const nx = Math.min(0.985, Math.max(0, (pointer.x - rect.left) / rect.width));
  const ny = Math.min(0.985, Math.max(0, (pointer.y - rect.top) / rect.height));
  const editor = layer.createAndAddNewEditor({ x: 0, y: 0 }, false, {
    methodOfCreation: "context_menu",
    boxes: [{ x: nx, y: ny, width: 0.012, height: 0.016 }],
    anchorNode: null,
    anchorOffset: 0,
    focusNode: null,
    focusOffset: 0,
    text: "",
  });
  if (editor) {
    try {
      editor.comment = phrase;
      markDirty();
    } catch (err) {
      console.error("Couldn't attach quick comment, removing host highlight:", err);
      try {
        editor.remove();
      } catch {
        /* best effort */
      }
    }
  }
}

// Wired once from initializeViewer(). Capture-phase so it beats pdf.js's
// own listeners, same technique as blockInternalFileOpen/
// attachKeyboardShortcuts.
let quickCommentMenuAttached = false;
function attachQuickCommentMenu(doc) {
  if (quickCommentMenuAttached) return;
  quickCommentMenuAttached = true;

  doc.addEventListener(
    "mousemove",
    (event) => {
      lastIframePointer = { x: event.clientX, y: event.clientY };
    },
    { capture: true, passive: true }
  );

  doc.addEventListener(
    "contextmenu",
    (event) => {
      if (!getViewerApp()?.pdfDocument || !currentPath) return; // no doc — native menu
      if (!event.target?.closest?.(".page")) return; // gutter / toolbar — native menu
      event.preventDefault();
      event.stopPropagation();
      lastIframePointer = { x: event.clientX, y: event.clientY };
      openQuickCommentMenu(event.clientX, event.clientY);
    },
    { capture: true }
  );

  // Dismiss on any interaction outside the menu, or when focus/layout moves.
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!quickCommentMenuEl || quickCommentMenuEl.hidden) return;
      if (event.composedPath?.().includes(quickCommentMenuEl)) return;
      closeQuickCommentMenu();
    },
    { capture: true }
  );
  doc.addEventListener("pointerdown", () => closeQuickCommentMenu(), { capture: true });
  doc.addEventListener("scroll", () => closeQuickCommentMenu(), { capture: true });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeQuickCommentMenu();
  });
  window.addEventListener("blur", () => {
    // Ignore the transient blur that opening + focusing the menu can cause.
    if (Date.now() - quickCommentMenuOpenedAt > 250) closeQuickCommentMenu();
  });
  window.addEventListener("resize", () => closeQuickCommentMenu());
}

// ---- Quick comments management list (Settings) -----------------------
function renderQuickCommentsManageList() {
  if (!quickCommentsManageListEl) return;
  const list = getQuickComments();
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "qcManageEmpty";
    li.textContent = "None yet.";
    quickCommentsManageListEl.replaceChildren(li);
    return;
  }
  quickCommentsManageListEl.replaceChildren(
    ...list.map((entry) => {
      const li = document.createElement("li");

      const text = document.createElement("span");
      text.className = "qcManageText";
      text.textContent = entry.text;
      text.title = entry.text;

      const count = document.createElement("span");
      count.className = "qcManageCount";
      count.textContent = `×${entry.count}`;

      const del = document.createElement("button");
      del.type = "button";
      del.className = "qcManageDelete";
      del.textContent = "Remove";
      del.addEventListener("click", () => {
        const key = entry.text.toLowerCase();
        saveQuickComments(getQuickComments().filter((e) => e.text.toLowerCase() !== key));
        renderQuickCommentsManageList();
      });

      li.append(text, count, del);
      return li;
    })
  );
}

// ---- Exporting comments to Markdown --------------------------------------
// Pulls every commented annotation (Highlight/Underline/StrikeOut/Squiggly/
// Ink/Stamp/FreeText — anything with actual comment text, see below) out of
// the document into a standalone Markdown file: page number, the
// highlighted source text it's attached to (when the annotation type has
// one), and the comment text itself.

// Reads annotations from a throwaway, standalone PDFDocumentProxy rather
// than the live app.pdfDocument, and rather than reloading the live viewer
// the way revertToSessionStart's strip-all branch does. Both matter:
// page.getAnnotations() only reflects the worker's already-parsed
// structure, not live annotationStorage edits, so *some* fresh serialize is
// required to see this session's unsaved comments — but reloading the
// *live* document (loadPdfIntoViewer) would wipe pdf.js's own in-editor
// undo/redo stack and visibly reset scroll position, neither of which is
// acceptable for a read-only export action. app.pdfDocument.saveDocument()
// already gives fresh bytes with no other observable side effect on the
// live document (it's the same call saveNow() uses; the only internal
// state it touches, annotationStorage's #modified flag via
// resetModified(), is exactly what every normal autosave tick already
// resets today) — so those bytes are fed into a second, independent
// pdfjsLib.getDocument() instead of back into the live viewer.
async function collectCommentedAnnotations(app) {
  // saveDocument() itself warns to the console ("annotationStorage is
  // empty, please use the getData-method instead") whenever nothing was
  // edited THIS session — a common case here, since exporting doesn't
  // require having just edited anything. getData() returns the document's
  // already-loaded bytes as-is, which is exactly equivalent when there's
  // nothing live in annotationStorage to bake in.
  const bytes =
    app.pdfDocument.annotationStorage.size > 0
      ? await app.pdfDocument.saveDocument()
      : await app.pdfDocument.getData();
  // PDFDocumentProxy (the resolved value) has no destroy() of its own —
  // cleanup lives on the PDFDocumentLoadingTask getDocument() returns
  // synchronously, so that's what must be kept and destroyed, not the
  // resolved document.
  const loadingTask = frame.contentWindow.pdfjsLib.getDocument({ data: bytes });

  try {
    const tempDoc = await loadingTask.promise;
    const pages = await Promise.all(
      Array.from({ length: tempDoc.numPages }, (_, i) => tempDoc.getPage(i + 1))
    );
    const annotationsByPage = await Promise.all(pages.map((page) => page.getAnnotations()));
    const { AnnotationType } = frame.contentWindow.pdfjsLib;

    const entries = [];
    annotationsByPage.forEach((annotations, pageIndex) => {
      for (const annotation of annotations) {
        // Every markup annotation with a comment also produces a separate
        // Popup annotation that mirrors the exact same /Contents text (see
        // PopupAnnotation in pdf.worker.mjs) but never carries
        // overlaidText — without this it duplicates every comment, once
        // with context and once without.
        if (annotation.annotationType === AnnotationType.POPUP) continue;
        const comment = annotation.contentsObj?.str?.trim();
        if (!comment) continue; // bare highlights/annotations with no note are skipped
        entries.push({
          pageNumber: pageIndex + 1,
          context: typeof annotation.overlaidText === "string" ? annotation.overlaidText.trim() : "",
          comment,
          author: annotation.titleObj?.str?.trim() || "",
          // PDF rect is [x1,y1,x2,y2] in bottom-up coordinates — higher y2 is higher on the page.
          rectTop: Array.isArray(annotation.rect) ? annotation.rect[3] : 0,
        });
      }
    });

    entries.sort((a, b) => a.pageNumber - b.pageNumber || b.rectTop - a.rectTop);
    return entries;
  } finally {
    await loadingTask.destroy();
  }
}

function renderCommentsMarkdown(entries, docTitle) {
  const lines = [`# Comments — ${docTitle}`, ``, `_Exported ${new Date().toLocaleString()}_`, ``];
  let currentPage = null;
  for (const entry of entries) {
    if (entry.pageNumber !== currentPage) {
      currentPage = entry.pageNumber;
      lines.push(`## Page ${currentPage}`, ``);
    }
    if (entry.context) {
      lines.push(`> ${escapeMarkdown(entry.context).replace(/\n/g, "\n> ")}`, ``);
    }
    lines.push(escapeMarkdown(entry.comment));
    if (entry.author) lines.push(``, `— *${escapeMarkdown(entry.author)}*`);
    lines.push(``, `---`, ``);
  }
  return lines.join("\n");
}

// Suggests "<original's folder>/<name> comments.md" as the native Save
// dialog's starting point, same convention as computeDefaultCopyPath above.
async function computeDefaultExportPath(originalPath) {
  const dir = await dirname(originalPath);
  const base = await basename(originalPath, ".pdf");
  return join(dir, `${base} comments.md`);
}

async function exportComments() {
  const app = getViewerApp();
  if (!app || !app.pdfDocument || !currentPath) return;

  setStatus("Preparing comment export…");
  const entries = await collectCommentedAnnotations(app);
  harvestRepeatedComments(entries);
  if (entries.length === 0) {
    setStatus("No comments found in this document", "", { toast: true });
    return;
  }

  const docTitle = currentTitleBase || filenameFromPath(currentPath);
  const markdown = renderCommentsMarkdown(entries, docTitle);

  const defaultPath = await computeDefaultExportPath(currentPath);
  const exportPath = await save({
    title: "Export Comments As",
    defaultPath,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!exportPath) return; // user cancelled

  // writeTextFile needs its own fs:allow-write-text-file permission this
  // app doesn't grant; writeFile (already used for autosave/Save Copy As)
  // only needs the fs:allow-write-file permission already in
  // src-tauri/capabilities/default.json, so encode instead of adding a
  // new capability for a one-off text write.
  await writeFile(exportPath, new TextEncoder().encode(markdown));
  setStatus(
    `Exported ${entries.length} comment${entries.length === 1 ? "" : "s"} to ${exportPath}`,
    "",
    { toast: true }
  );
}

// ---- Summarize comments with AI ---------------------------------------
// Reuses exportComments()'s collection path (collectCommentedAnnotations),
// but hands the comments to a configurable OpenAI-compatible endpoint via
// the summarize_comments Tauri command (src/main.rs) and shows the reply
// in #summaryDialog. The webview never calls the endpoint itself — that
// keeps the request clear of CORS and any API key out of the renderer.
// The system prompt lives in src/summary-system-prompt.txt (imported as
// DEFAULT_SUMMARY_SYSTEM_PROMPT); getAiSystemPrompt() applies the
// experimental in-dialog override on top of it.

// Some models (Mistral especially) ignore the "no code fence" instruction
// and wrap the entire reply in ```markdown … ``` anyway. If the whole
// response is a single fenced block, unwrap it; a response that merely
// *contains* a fenced block partway through is left untouched.
function stripOuterCodeFence(text) {
  const trimmed = (text || "").trim();
  const match = trimmed.match(/^```[^\n`]*\n([\s\S]*?)\n?```$/);
  return match ? match[1].trim() : trimmed;
}

// Flat, token-frugal rendering of the same entries exportComments() writes
// to Markdown — one block per comment, whitespace collapsed.
function renderCommentsForPrompt(entries, docTitle) {
  const lines = [`Document: ${docTitle}`, `Comment count: ${entries.length}`, ``];
  for (const entry of entries) {
    lines.push(`--- Page ${entry.pageNumber}${entry.author ? ` — ${entry.author}` : ""}`);
    if (entry.context) lines.push(`Highlighted text: ${entry.context.replace(/\s+/g, " ")}`);
    lines.push(`Comment: ${entry.comment.replace(/\s+/g, " ")}`, ``);
  }
  return lines.join("\n");
}

// Suggests "<original's folder>/<name> summary.md" for the summary's Save
// dialog, matching computeDefaultExportPath's convention.
async function computeDefaultSummaryPath(originalPath) {
  const dir = await dirname(originalPath);
  const base = await basename(originalPath, ".pdf");
  return join(dir, `${base} summary.md`);
}

// Markdown of the last successful summary — drives Copy / Save. "" while
// loading or after an error.
let lastSummaryMarkdown = "";
// Result of the last successful run for the currently open document, so a
// second button press (or reopening the dialog) is instant. Shape:
// { path, promptKey, model, systemPrompt, markdown }. promptKey is the
// full user-prompt string, which already encodes every
// comment/context/author/page — so a mismatch means the comments changed
// since the summary was made; model/systemPrompt catch a Settings change.
// Cleared on document change (loadPdfIntoViewer) and by Regenerate.
let summaryCache = null;
let summaryInFlight = false;
// Bumped whenever a run is superseded or stopped. runSummary() captures it
// and ignores its own late-arriving result if the value has moved on — so
// the Rust request finishing (or erroring) after Stop can't clobber the UI.
let summaryRunId = 0;
let stopButtonArmTimer = null; // see STOP_BUTTON_ARM_MS

function refreshSummaryControls() {
  // Regenerate ⇄ Stop swap in place; the model field stays editable while a
  // request runs so a new model can be queued up before stopping.
  summaryDialogRegenerateButtonEl.hidden = summaryInFlight;
  summaryDialogStopButtonEl.hidden = !summaryInFlight;
  const hasResult = !summaryInFlight && lastSummaryMarkdown.length > 0;
  summaryDialogCopyButtonEl.disabled = !hasResult;
  summaryDialogSaveButtonEl.disabled = !hasResult;
}

function setSummaryNotice(text) {
  summaryDialogNoticeEl.textContent = text || "";
  summaryDialogNoticeEl.hidden = !text;
}

function renderSummaryLoading() {
  lastSummaryMarkdown = "";
  setSummaryNotice("");
  summaryDialogBodyEl.className = "is-loading";
  const spinner = document.createElement("div");
  spinner.className = "summarySpinner";
  const label = document.createElement("span");
  label.textContent = "Summarizing…";
  summaryDialogBodyEl.replaceChildren(spinner, label);
  refreshSummaryControls();
}

function renderSummaryResult(markdown) {
  lastSummaryMarkdown = markdown;
  setSummaryNotice("");
  summaryDialogBodyEl.className = "";
  summaryDialogBodyEl.textContent = markdown;
  refreshSummaryControls();
}

function renderSummaryError(message) {
  lastSummaryMarkdown = "";
  setSummaryNotice("");
  summaryDialogBodyEl.className = "is-error";
  summaryDialogBodyEl.textContent = message;
  refreshSummaryControls();
}

// Called after Stop. If there's a completed summary for this document, keep
// it on screen (with a note that the new run was abandoned); otherwise fall
// back to a plain prompt.
function renderSummaryStopped() {
  const cached =
    summaryCache && summaryCache.path === currentPath ? summaryCache.markdown : null;
  if (cached) {
    renderSummaryResult(cached);
    setSummaryNotice("Run stopped — showing the last completed summary.");
    return;
  }
  lastSummaryMarkdown = "";
  setSummaryNotice("");
  summaryDialogBodyEl.className = "is-loading"; // reuse the centered muted layout, minus the spinner
  const label = document.createElement("span");
  label.textContent = "Stopped. Adjust the model above, then press Regenerate.";
  summaryDialogBodyEl.replaceChildren(label);
  refreshSummaryControls();
}

// Abort an in-flight summary. The Rust side drops the HTTP request (so a
// local model stops generating and the endpoint is immediately free for a
// new request); bumping summaryRunId makes runSummary() discard whatever
// its awaited invoke() eventually returns.
function stopSummary() {
  if (!summaryInFlight) return;
  clearTimeout(stopButtonArmTimer);
  summaryRunId++;
  summaryInFlight = false;
  invoke("cancel_summarize").catch((err) => console.error("cancel_summarize failed:", err));
  renderSummaryStopped();
  setStatus("Summary stopped", "", { toast: true });
}

// Toolbar button: open the dialog immediately, show the cached summary if
// there is a still-valid one, otherwise kick off a generation. Never
// blocks on the network before the dialog is visible.
async function onSummarizeButtonClick() {
  const app = getViewerApp();
  if (!app || !app.pdfDocument || !currentPath) return;

  if (!getAiEndpoint()) {
    setStatus("Set an AI summary endpoint in Settings first", "error", { toast: true });
    return;
  }

  summaryModelInputEl.value = getAiModel();
  renderAiModelDatalist();
  summaryDialogEl.showModal();

  // A run kicked off earlier is still going (the dialog was closed and
  // reopened — closing doesn't abort it). Show its progress; don't start
  // another or touch the cache.
  if (summaryInFlight) {
    renderSummaryLoading();
    return;
  }

  const cacheValid =
    summaryCache &&
    summaryCache.path === currentPath &&
    summaryCache.model === getAiModel() &&
    summaryCache.systemPrompt === getAiSystemPrompt();

  if (cacheValid) {
    renderSummaryResult(summaryCache.markdown);
    // Re-check against the live comments in the background; if they've
    // changed since the cached run, regenerate silently.
    const cachedPromptKey = summaryCache.promptKey;
    collectCommentedAnnotations(app)
      .then((entries) => {
        const promptKey = renderCommentsForPrompt(
          entries,
          currentTitleBase || filenameFromPath(currentPath)
        );
        if (
          summaryDialogEl.open &&
          !summaryInFlight &&
          summaryCache &&
          summaryCache.path === currentPath &&
          promptKey !== cachedPromptKey
        ) {
          runSummary();
        }
      })
      .catch(() => {});
    return;
  }

  runSummary();
}

// Always generates: collects the comments fresh, calls the endpoint, and
// updates the cache. Used for the first run and for the Regenerate button.
async function runSummary() {
  if (summaryInFlight) return;
  const app = getViewerApp();
  if (!app || !app.pdfDocument || !currentPath) return;

  const endpoint = getAiEndpoint();
  if (!endpoint) {
    renderSummaryError("No AI endpoint is set. Add one in Settings.");
    return;
  }

  // While the dialog is open its Model field is the source of truth; keep
  // the persisted setting in step so Settings and the dialog agree.
  const model = summaryModelInputEl.value.trim() || AI_MODEL_DEFAULT;
  if (model !== getAiModel()) localStorage.setItem(AI_MODEL_KEY, model);

  // System prompt comes from Settings (or the bundled default).
  const systemPrompt = getAiSystemPrompt();

  const runId = ++summaryRunId;
  summaryInFlight = true;
  renderSummaryLoading();
  // Briefly ignore Stop clicks so a double-click on Regenerate (now sitting
  // where Stop appeared) can't instantly cancel this run.
  summaryDialogStopButtonEl.disabled = true;
  clearTimeout(stopButtonArmTimer);
  stopButtonArmTimer = setTimeout(() => {
    if (summaryInFlight) summaryDialogStopButtonEl.disabled = false;
  }, STOP_BUTTON_ARM_MS);
  setStatus("Summarizing comments with AI…");

  try {
    const entries = await collectCommentedAnnotations(app);
    if (runId !== summaryRunId) return; // stopped while collecting
    harvestRepeatedComments(entries);
    if (entries.length === 0) {
      summaryCache = null;
      renderSummaryError("This document has no comments to summarize.");
      setStatus("No comments found in this document", "", { toast: true });
      return;
    }

    const docTitle = currentTitleBase || filenameFromPath(currentPath);
    const userPrompt = renderCommentsForPrompt(entries, docTitle);

    const raw = await invoke("summarize_comments", {
      baseUrl: endpoint,
      apiKey: getAiApiKey() || null,
      model,
      systemPrompt,
      userPrompt,
    });
    if (runId !== summaryRunId) return; // Stop was pressed — ignore this result
    const markdown = stripOuterCodeFence(raw);

    summaryCache = { path: currentPath, promptKey: userPrompt, model, systemPrompt, markdown };
    addAiModelToHistory(model);
    renderSummaryResult(markdown);
    setStatus(
      `Summarized ${entries.length} comment${entries.length === 1 ? "" : "s"}`,
      "",
      { toast: true }
    );
  } catch (err) {
    if (runId !== summaryRunId) return; // Stop already reset the UI; this is the cancelled request rejecting
    const message = String(err && err.message ? err.message : err);
    console.error("Summarize comments failed:", err);
    renderSummaryError(message);
    setStatus(`Summarize failed: ${message}`, "error", { toast: true });
  } finally {
    if (runId === summaryRunId) {
      clearTimeout(stopButtonArmTimer);
      summaryInFlight = false;
      refreshSummaryControls();
    }
  }
}

summaryDialogRegenerateButtonEl.addEventListener("click", () => {
  runSummary();
});
summaryDialogStopButtonEl.addEventListener("click", () => stopSummary());
summaryDialogCloseButtonEl.addEventListener("click", () => summaryDialogEl.close());
summaryDialogEl.addEventListener("click", (event) => {
  if (event.target === summaryDialogEl) summaryDialogEl.close();
});
// Closing the dialog does NOT abort a run in progress — it finishes in the
// background and its result is cached, so reopening shows it immediately.
summaryDialogCopyButtonEl.addEventListener("click", async () => {
  if (!lastSummaryMarkdown) return;
  try {
    await navigator.clipboard.writeText(lastSummaryMarkdown);
    setStatus("Summary copied to clipboard", "", { toast: true });
  } catch (err) {
    console.error("Could not copy summary:", err);
    setStatus("Couldn't copy summary", "error", { toast: true });
  }
});
summaryDialogSaveButtonEl.addEventListener("click", async () => {
  if (!lastSummaryMarkdown) return;
  try {
    const defaultPath = currentPath
      ? await computeDefaultSummaryPath(currentPath)
      : "summary.md";
    const exportPath = await save({
      title: "Save Summary As",
      defaultPath,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!exportPath) return; // user cancelled
    await writeFile(exportPath, new TextEncoder().encode(lastSummaryMarkdown));
    setStatus(`Saved summary to ${exportPath}`, "", { toast: true });
  } catch (err) {
    console.error("Could not save summary:", err);
    setStatus("Couldn't save summary", "error", { toast: true });
  }
});

// Safety net: even mid-typing, don't let unsaved changes sit forever.
setInterval(() => {
  if (dirty && !saveInFlight) saveNow();
}, AUTOSAVE_MAX_WAIT_MS);

// ---- Wiring up buttons --------------------------------------------------
openBtn.addEventListener("click", () => pickAndOpenPdf().catch((err) => {
  console.error(err);
  reportError("Failed to open file");
}));
landingSettingsBtn.addEventListener("click", openSettingsDialog);

// Warn before quitting with unsaved changes (best-effort; not all
// platforms surface this dialog from a webview the same way).
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
