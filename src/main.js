import { open } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile, rename, exists } from "@tauri-apps/plugin-fs";

// ---- State -----------------------------------------------------------
let currentPath = null; // absolute path of the PDF currently open
let dirty = false; // true if there are unsaved annotation changes
let saveInFlight = false;
let autosaveTimer = null;

const AUTOSAVE_DEBOUNCE_MS = 4000; // save 4s after the last edit
const AUTOSAVE_MAX_WAIT_MS = 20000; // ...but never wait longer than this
const RECENT_FILES_KEY = "pdfAnnotator.recentFiles";
const MAX_RECENT_FILES = 8;

const landingScreen = document.getElementById("landingScreen");
const viewerScreen = document.getElementById("viewerScreen");
const openBtn = document.getElementById("openBtn");
const saveBtn = document.getElementById("saveBtn");
const statusEl = document.getElementById("status");
const landingStatusEl = document.getElementById("landingStatus");
const recentFilesListEl = document.getElementById("recentFilesList");
const frame = document.getElementById("viewerFrame");

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = kind;
}

// Mirrors an error onto whichever screen is actually visible — openPath()
// can fail while either one is showing (a stale recent-files entry is
// clicked on the landing screen; a startup auto-reopen fails before the
// viewer screen is ever shown), and #status lives inside viewerScreen so
// it's invisible while landingScreen is up.
function reportError(message) {
  setStatus(message, "error");
  landingStatusEl.textContent = message;
  landingStatusEl.className = "error";
}

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
  button.title = "Save annotations into the original PDF file on disk";
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
  button.title = "Open a different PDF file";
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
let internalFileOpenBlocked = false;
function blockInternalFileOpen(doc) {
  if (internalFileOpenBlocked) return;
  internalFileOpenBlocked = true;
  const block = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.type !== "dragover") {
      setStatus("Use the Open button in the toolbar to open a file", "error");
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
      if (isOpenShortcut) block(event);
    },
    { capture: true }
  );
}

// ---- Recent-files list ---------------------------------------------------
// Persisted as a plain array of paths, most-recent-first, in localStorage
// (outer page's storage, unrelated to the iframe's own pdfjs.preferences
// key above). The first entry doubles as "the last-opened file" for the
// startup auto-reopen in initializeViewer() below — no separate key to
// keep in sync.
function getRecentFiles() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_FILES_KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function addToRecentFiles(path) {
  const files = [path, ...getRecentFiles().filter((p) => p !== path)].slice(0, MAX_RECENT_FILES);
  localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(files));
}

function removeFromRecentFiles(path) {
  localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(getRecentFiles().filter((p) => p !== path)));
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

  for (const path of files) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = filenameFromPath(path);
    button.title = path;
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

// ---- Loading a document into the viewer ---------------------------------
// Shared by every way a document can end up open — the outer/toolbar Open
// buttons, a recent-files click, and the startup auto-reopen below — so
// all of them end up in the exact same state: currentPath set, save
// buttons enabled, annotation hooks attached, recent-files list updated.
async function loadPdfIntoViewer(app, path, bytes) {
  // `open()` accepts a plain Uint8Array under `data`. Some pdf.js versions
  // want { data: bytes } directly, older ones wrap it differently —
  // check your bundled version if this throws.
  await app.open({ data: bytes });

  currentPath = path;
  dirty = false;
  saveBtn.disabled = false;
  if (toolbarSaveButton) toolbarSaveButton.disabled = false;
  setStatus(`Open: ${path}`);
  addToRecentFiles(path);
  renderRecentFiles();

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

// ---- App-wide viewer setup (runs once, independent of any open file) ---
// attachCommentSaveHook/attachUndoRedoHook listen on the persistent
// app.eventBus, injectSaveButton/injectOpenButton just create toolbar
// buttons, and blockInternalFileOpen must be active *before* the user
// ever opens a file through us — its whole point is closing off pdf.js's
// own "Open File" paths, which are reachable from the very first landing
// screen (Tools-menu entry, drag-and-drop) with no dependency on a file
// ever having been opened through us. None of this belongs gated behind
// our own Open button.
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
  blockInternalFileOpen(frame.contentDocument);

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
let undoRedoHookAttached = false;
let suppressDirty = false;
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
        const wasSuppressed = suppressDirty;
        suppressDirty = true;
        try {
          originalAddToAnnotationStorage(editor);
        } finally {
          suppressDirty = wasSuppressed;
        }
      } else {
        originalAddToAnnotationStorage(editor);
      }
    };
  });
}

// ---- Hooking annotation changes for autosave --------------------------
async function attachAnnotationHooks(app) {
  const { pdfDocument } = app;
  const storage = pdfDocument && pdfDocument.annotationStorage;
  if (!storage) {
    setStatus("Warning: no annotationStorage found on this document", "error");
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
// ahead of the autosave debounce.
async function saveNow({ force = false } = {}) {
  if (!currentPath || saveInFlight) return;
  if (!force && !dirty) return;
  const app = getViewerApp();
  if (!app || !app.pdfDocument) return;

  saveInFlight = true;
  setStatus("Saving…", "dirty");

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
    setStatus(`Saved ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error("Autosave failed:", err);
    setStatus("Autosave failed — see console", "error");
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

saveBtn.addEventListener("click", () => saveNow({ force: true }));

// Warn before quitting with unsaved changes (best-effort; not all
// platforms surface this dialog from a webview the same way).
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
