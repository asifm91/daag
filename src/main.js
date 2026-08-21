import { open } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile, rename, exists } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";

// ---- State -----------------------------------------------------------
let currentPath = null; // absolute path of the PDF currently open
let dirty = false; // true if there are unsaved annotation changes
let saveInFlight = false;
let autosaveTimer = null;

const AUTOSAVE_DEBOUNCE_MS = 4000; // save 4s after the last edit
const AUTOSAVE_MAX_WAIT_MS = 20000; // ...but never wait longer than this
const RECENT_FILES_KEY = "pdfAnnotator.recentFiles";
const MAX_RECENT_FILES = 8;
const MAX_LOG_ENTRIES = 200;

const landingScreen = document.getElementById("landingScreen");
const viewerScreen = document.getElementById("viewerScreen");
const openBtn = document.getElementById("openBtn");
const landingStatusEl = document.getElementById("landingStatus");
const recentFilesListEl = document.getElementById("recentFilesList");
const toastContainerEl = document.getElementById("toastContainer");
const logDialogEl = document.getElementById("logDialog");
const logDialogCloseButtonEl = document.getElementById("logDialogCloseButton");
const logListEl = document.getElementById("logList");
const frame = document.getElementById("viewerFrame");

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

function showViewer() {
  landingScreen.classList.add("hidden");
  viewerScreen.classList.remove("hidden");
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

  group.appendChild(button);

  toolbarSaveButton = button;
}

// ---- Adding our own Open button to pdf.js's toolbar ---------------------
// Once a document is open, the outer landing screen's Open button and
// recent-files list are hidden (see showViewer()) — this is how you open
// a different file without pdf.js's own broken/blocked internal paths
// (see blockInternalFileOpen below) while already viewing something.
// Injected the same way and for the same reason as injectSaveButton
// above: DOM, not a viewer.html edit, so a pdf.js upgrade can't silently
// erase it. Never disabled — unlike Save, opening doesn't depend on a
// document already being loaded.
let toolbarOpenButton = null;
function injectOpenButton() {
  if (toolbarOpenButton) return;
  const doc = frame.contentDocument;
  const downloadButton = doc.getElementById("downloadButton");
  const group = downloadButton && downloadButton.closest(".toolbarHorizontalGroup");
  if (!group) return;

  ensureCustomStylesheetLoaded(doc);

  const button = doc.createElement("button");
  button.id = "customOpenButton";
  button.className = "toolbarButton";
  button.type = "button";
  button.title = "Open a different PDF file (Ctrl+O)";
  button.addEventListener("click", () =>
    pickAndOpenPdf().catch((err) => {
      console.error(err);
      reportError("Failed to open file — see console");
    })
  );

  const label = doc.createElement("span");
  label.textContent = "Open File";
  button.appendChild(label);

  // Before Save (falls back to appending if injectSaveButton hasn't run
  // yet for some reason) so the toolbar reads left-to-right as Open, Save.
  group.insertBefore(button, toolbarSaveButton || null);

  toolbarOpenButton = button;
}

// ---- Adding a status indicator to pdf.js's toolbar -----------------------
// A small colored dot (idle/dirty/saving/saved/error — see custom-viewer
// .css) reflecting the latest setStatus() call, doubling as the button
// that opens the full activity log (openLogDialog, above). Injected the
// same way and for the same reasons as injectSaveButton/injectOpenButton.
let toolbarStatusButton = null;
function injectStatusButton() {
  if (toolbarStatusButton) return;
  const doc = frame.contentDocument;
  const downloadButton = doc.getElementById("downloadButton");
  const group = downloadButton && downloadButton.closest(".toolbarHorizontalGroup");
  if (!group) return;

  ensureCustomStylesheetLoaded(doc);

  const button = doc.createElement("button");
  button.id = "customStatusButton";
  button.className = "toolbarButton status-saved";
  button.type = "button";
  button.title = "View activity log";
  button.addEventListener("click", openLogDialog);

  const label = doc.createElement("span");
  label.textContent = "Activity Log";
  button.appendChild(label);

  group.appendChild(button); // after Open, Save

  toolbarStatusButton = button;
}

// setStatus's `kind` doubles as the indicator's visual state, except ""
// (used for routine info like "Open: <path>" and "Saved <time>") maps to
// the "saved" (green/idle-good) dot rather than getting its own class.
function updateStatusIndicator(kind) {
  if (!toolbarStatusButton) return;
  toolbarStatusButton.className = `toolbarButton status-${kind || "saved"}`;
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
        reportError("Failed to open file — see console");
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
        reportError("Failed to open file — see console");
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
// PDF's own title once metadata resolves) separately from the "unsaved"
// marker, so markDirty()/saveNow() can flip just the marker via
// applyWindowTitleBar() without needing to know or re-derive the rest.
let currentTitleBase = null;

function applyWindowTitleBar() {
  if (!currentTitleBase) return;
  getCurrentWindow()
    .setTitle(`${dirty ? "● " : ""}${currentTitleBase} — PDF Annotator`)
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
        currentTitleBase = pdfTitle;
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
  if (toolbarSaveButton) toolbarSaveButton.disabled = false;
  setStatus(`Open: ${path}`);
  addToRecentFiles(path);
  renderRecentFiles();
  updateWindowTitle(app, path);

  attachAnnotationHooks(app);
}

// ---- Opening a file by path, with graceful failure -----------------------
// The one thing every entry point funnels through once a *path* is known
// (as opposed to pickAndOpenPdf() below, which is how a path is chosen in
// the first place). Checks the file still exists before trying to read
// it — covers a recent-files entry whose file has since been moved or
// deleted, and the startup auto-reopen of the most recent one — and on
// any failure, prunes that entry so it doesn't keep showing a dead link,
// then reports the error onto whichever screen is actually visible.
async function openPath(path) {
  try {
    if (!(await exists(path))) {
      throw new Error("file no longer exists");
    }
    const bytes = await readFile(path);
    const app = await waitForViewer();
    await loadPdfIntoViewer(app, path, bytes);
    showViewer();
  } catch (err) {
    console.error("Could not open PDF:", err);
    removeFromRecentFiles(path);
    renderRecentFiles();
    reportError(`Could not open ${filenameFromPath(path)} — it may have moved or been deleted`);
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
    if (event.payload.type !== "drop" || dropInFlight) return;
    const path = event.payload.paths.find((p) => p.toLowerCase().endsWith(".pdf"));
    if (!path) {
      reportError("Dropped file is not a PDF");
      return;
    }
    dropInFlight = true;
    openPath(path)
      .catch((err) => {
        console.error(err);
        reportError("Failed to open file — see console");
      })
      .finally(() => {
        dropInFlight = false;
      });
  });
}

// ---- App-wide viewer setup (runs once, independent of any open file) ---
// attachCommentSaveHook/attachUndoRedoHook listen on the persistent
// app.eventBus, injectSaveButton/injectOpenButton just create toolbar
// buttons, and blockInternalFileOpen/attachKeyboardShortcuts/
// attachDragDropOpen must be active *before* the user ever opens a file
// through us — closing off pdf.js's own "Open File" paths, taking over
// Ctrl+O/Ctrl+S, and accepting a dropped file are all reachable from the
// very first landing screen (Tools-menu entry, drag-and-drop, the keys
// themselves) with no dependency on a file ever having been opened
// through us. None of this belongs gated behind our own Open button.
//
// Deliberately does NOT auto-reopen the most recent file — the landing
// screen (Open button + recent-files list) is always what greets you on
// launch; picking a file, from either place, is always an explicit click.
async function initializeViewer() {
  const app = await waitForViewer();
  attachCommentSaveHook(app);
  attachUndoRedoHook(app);
  injectSaveButton();
  injectOpenButton();
  injectStatusButton();
  blockInternalFileOpen(frame.contentDocument);
  attachKeyboardShortcuts(frame.contentDocument);
  attachDragDropOpen();
  disableInternalBeforeUnloadPrompt(app);
  addShortcutHints(frame.contentDocument);

  renderRecentFiles();
}

initializeViewer();

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
}

function markDirty() {
  if (suppressDirty) return;
  dirty = true;
  applyWindowTitleBar();
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
async function saveNow({ force = false } = {}) {
  if (!currentPath || saveInFlight) return;
  if (!force && !dirty) return;
  const app = getViewerApp();
  if (!app || !app.pdfDocument) return;

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
    applyWindowTitleBar();
    setStatus(`${force ? "Saved" : "Autosaved"} ${new Date().toLocaleTimeString()}`, "", { toast: force });
  } catch (err) {
    console.error("Autosave failed:", err);
    setStatus("Autosave failed — see console", "error", { toast: true });
    // Keep `dirty` true so the next edit or manual Save retries.
  } finally {
    saveInFlight = false;
  }
}

// Safety net: even mid-typing, don't let unsaved changes sit forever.
setInterval(() => {
  if (dirty && !saveInFlight) saveNow();
}, AUTOSAVE_MAX_WAIT_MS);

// ---- Wiring up buttons --------------------------------------------------
openBtn.addEventListener("click", () => pickAndOpenPdf().catch((err) => {
  console.error(err);
  reportError("Failed to open file — see console");
}));

// Warn before quitting with unsaved changes (best-effort; not all
// platforms surface this dialog from a webview the same way).
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
