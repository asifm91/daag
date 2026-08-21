# PDF Annotator — Claude Code context

## What this is
A local-first Tauri desktop app for annotating PDFs, built to solve a
specific problem: Firefox's built-in PDF viewer loses all annotations if
the tab reloads (e.g. after sleep/wake) before you manually save. This
app autosaves annotations *into the actual PDF file on disk* every few
seconds, so there's no window where work can be silently lost.

Runs on native Windows (not WSL — an earlier version of this project ran
under WSL/WSLg, since migrated off).

## Architecture

### Embedding pdf.js
Not a from-scratch PDF viewer. We embed Mozilla's own prebuilt pdf.js
"generic" viewer (`src/pdfjs/web/viewer.html`) inside an `<iframe>`. This
gives us pdf.js's full built-in annotation editors (highlight, freetext,
ink, comments, etc.) for free instead of reimplementing an annotation UI.
`src/main.js` (the parent page) reaches directly into
`iframe.contentWindow.PDFViewerApplication` — same-origin, served by
Vite/Tauri, so no postMessage or blob-URL handoff is needed.

### Two-screen UI
`src/index.html` has two top-level screens, toggled via `.hidden`
(`showViewer()` in main.js):
- `#landingScreen` — shown by default and whenever no file is open. Just
  an Open button and a recent-files list (`localStorage`, most-recent-
  first, capped at 8). Startup deliberately does **not** auto-reopen the
  last file — landing always greets you first.
- `#viewerScreen` — wraps the pdf.js iframe, shown once a document is
  open. Has no chrome of its own any more (the old outer toolbar with a
  Save button and status text was removed) — Open/Save/status-log all
  live as buttons injected *into pdf.js's own toolbar* (see below).

The iframe stays `display:none` (not unloaded) while the landing screen
shows, so pdf.js and all the hooks below are already warm by the time a
file is picked.

### Buttons injected into pdf.js's toolbar
pdf.js's own toolbar buttons for Save and Open are broken or dangerous in
this embedding (see Known rough edges), so they're hidden via
`src/public/custom-viewer.css` and replaced with our own, injected as DOM
from `main.js` (never hand-edited into `viewer.html` — that file gets
dropped in wholesale on a pdf.js upgrade, silently erasing any hand
patch):
- **Open** (`injectOpenButton`) — the *only* safe way to open a different
  file once already viewing one (see the internal-open-paths gotcha).
- **Save** (`injectSaveButton`) — force-saves via the same path as
  autosave.
- **Status dot** (`injectStatusButton`) — small colored dot
  (idle/dirty/saving/error/saved) that opens a full activity-log
  `<dialog>` on click.

All three share one externally-loaded stylesheet
(`ensureCustomStylesheetLoaded` → `public/custom-viewer.css`) — **must**
be a real `<link>`, not a JS-inserted `<style>` tag; see Known rough
edges for why.

### Status/feedback: three channels, not a status bar
There used to be a simple status bar; it's gone. `setStatus(text, kind,
{toast})` in main.js now drives three things at once:
1. **Titlebar dirty marker** — native OS window title gets a `● ` prefix
   while dirty (`applyWindowTitleBar`), cleared on save. The window title
   otherwise reflects the open PDF's own metadata title (XMP `dc:title`,
   falling back to Info `Title`, falling back to filename) — set via
   Tauri's window API, not pdf.js's own `setTitle()` (see gotchas).
2. **Activity log** — every single status update, no exceptions, gets a
   timestamped entry (`appendLogEntry`, capped at 200), viewable via the
   toolbar status dot.
3. **Toast** — opt-in per call site (`{ toast: true }`), reserved for
   errors and manual-save confirmations. Most status updates (dirty-
   marking on every edit, "Saving…") fire far too often to pop up a
   toast for each one.

### Autosave flow
Far more involved than "listen for one event." pdf.js's own
change-tracking (`annotationStorage.onSetModified`) has multiple gaps
that took real investigation to find — see Known rough edges below for
the full list. The net result, wired up in `attachAnnotationHooks`,
`attachCommentSaveHook`, and `attachUndoRedoHook`:
- Chain onto (not overwrite) `annotationStorage.onSetModified` — pdf.js
  sets its own callback on this too, and whichever assignment runs last
  wins.
- Patch `annotationStorage.remove()` — never fires `onSetModified` on its
  own.
- Patch `AnnotationEditorUIManager.addCommands`/`undo`/`redo` — covers
  recoloring, resizing, moving, and undo/redo of any of the above.
- Patch `addToAnnotationStorage()` specifically (gated on
  `editor.annotationElementId`) — needed to avoid a false-positive dirty
  flag when merely opening the read-only Comment sidebar.
- Listen for pdf.js's own `reporttelemetry` eventBus events — the only
  signal for comment edits/deletions, which don't touch
  `annotationStorage` at all.

Once *something* is actually dirty: 4s idle debounce / 20s hard ceiling →
`pdfDocument.saveDocument()` bakes annotations into fresh PDF bytes →
written to `<file>.autosave.tmp` → renamed over the original (so a crash
mid-write can't corrupt the file).

### Rust side
Intentionally thin — just wires up the `dialog`, `fs`, and (for the
titlebar) `core:window:allow-set-title` capabilities. All real logic is
in the frontend.

## Known rough edges / things that have already bitten us

### Tooling / build
- **`vite.config.js` has `appType: "mpa"` for a reason** — don't remove
  it. Without it, if the iframe's `src` ever 404s, Vite's SPA fallback
  serves `index.html` instead of a 404, which recursively reloads the
  whole app inside its own iframe infinitely.
- `src-tauri/Cargo.toml` should **not** have a `[lib]` section — an
  earlier version did and broke `cargo metadata` (no `src/lib.rs` to back
  it). Only add one back if this evolves into a proper lib+bin split.
- `src-tauri/icons/icon.png` **and** `icon.ico` both need to exist for
  `cargo build`/`tauri::generate_context!()` to compile on Windows
  specifically (`tauri-build` needs `.ico` to generate the Windows
  Resource file). Regenerate the whole icon set with
  `bunx tauri icon <source.png>` any time the source icon changes.
- On this Windows/Git-Bash setup, `npx`/`bunx` have sometimes failed to
  resolve the local Tauri CLI (`could not determine executable to run`)
  even though it's present in `node_modules`. Fallback: call the binary
  directly — `./node_modules/.bin/tauri.exe icon ...`.
- pdf.js's `web/` folder must live at `src/pdfjs/web/...` (inside Vite's
  `root: "src"`), not at the project root.
- Frontend JS errors do **not** show up in the terminal running
  `tauri dev` — only in the webview's own DevTools (right-click →
  Inspect Element). Check there first when something silently does
  nothing.
- Package manager is **bun**. Use `bun install` / `bun run <script>` /
  `bunx tauri ...`, not npm/npx. `bun audit` / `bun audit fix` work for
  vulnerability scanning (used once already to bump Vite 5→6 — bun
  picked the *minimum* satisfying version, not necessarily latest).
- Tauri v2 capability strings are real, version-specific identifiers —
  don't guess them. When one was needed (`core:window:allow-set-title`,
  for the titlebar feature), it was verified against this project's own
  generated `src-tauri/gen/schemas/*.json` (not part of git, regenerated
  by `tauri dev`/`build`) before adding it, and confirmed with `core:default`
  does *not* already include it (only the read-only `allow-title` counterpart).
  If a new one is needed, check the generated schemas the same way rather
  than assuming.

### pdf.js embedding specifics — the big one
This is a "generic" browser-oriented pdf.js build, embedded in a
non-browser (Tauri/WebView2) context. A lot of what looks like it should
just work doesn't, because pdf.js assumes either a real top-level browser
tab or an embedder that replicates browser behavior:

- **CSP blocks inline styles.** `viewer.html` ships its own
  `Content-Security-Policy` meta tag (`style-src 'self'`, no
  `'unsafe-inline'`). A JS-inserted `<style>` tag or `style=""` attribute
  is **silently dropped** — Chromium logs a console warning but nothing
  throws, and the element it was meant to style still renders with
  whatever default it already had, so this is very easy to miss. Any
  custom styling for injected elements **must** go through a real
  `<link rel="stylesheet">` pointing at a same-origin file
  (`public/custom-viewer.css`), never an inline `<style>`.
- **pdf.js's own Save/Download button is fake here.** It's actually
  Save-As: builds a `blob:` URL and clicks a synthetic `<a download>`
  (`DownloadManager#_triggerDownload`) — a browser-download pattern
  Tauri's WebView2 doesn't wire up on its own. Silently does nothing when
  clicked. Hidden (`#downloadButton`, `#secondaryDownload`), replaced
  with our own toolbar button that writes to the real path.
- **pdf.js's internal "Open File" paths are actively dangerous, not just
  broken.** Three of them: the Tools-menu "Open File…" entry
  (`#secondaryOpenFile`), dropping a PDF onto the viewer, and Ctrl+O/Cmd+O.
  All three read the file via the browser File API and call
  `app.open({ url: URL.createObjectURL(file), ... })` directly, which
  never touches our `currentPath` tracking — so the *next* autosave would
  silently overwrite the *previous* file with the new document's bytes,
  while the actually-opened file's real path is never touched at all.
  There's no fix that tracks the new path instead: the File API never
  exposes a real absolute filesystem path, only a filename. All three are
  now blocked (`blockInternalFileOpen` — button hidden via CSS,
  drag-and-drop and Ctrl+O intercepted via a capture-phase listener on
  the iframe's document, which fires before pdf.js's own bubble-phase
  listeners see the event regardless of registration order).
- **pdf.js's own `setTitle()`/`document.title` is a no-op when embedded.**
  `isViewerEmbedded: window.parent !== window` is always true for an
  iframe, and `setTitle()` early-returns without touching `document.title`
  whenever that's set — by design, an embedder is expected to own the
  outer chrome itself. We fetch PDF metadata ourselves
  (`pdfDocument.getMetadata()`, a public API) and set the *native* window
  title via `@tauri-apps/api/window`'s `getCurrentWindow().setTitle()`
  instead of trying to read pdf.js's internal `_title`/`_docTitle` state.
- **`annotationStorage.onSetModified` gets silently clobbered.** pdf.js's
  own viewer sets this same callback (for its own "*" title marker /
  beforeunload prompt) asynchronously, *after* `app.open()` already
  resolves (inside `pdfViewer.firstPagePromise.then(...)`). Attach your
  own callback too early and pdf.js's later assignment overwrites it —
  autosave goes dead silently. Fix: wait on the same `firstPagePromise`,
  then chain onto pdf.js's existing callback instead of overwriting it.
- **pdf.js's own change-tracking has real gaps beyond that clobbering.**
  Comment edits/deletions, whole-annotation deletion, and property
  changes (recolor/resize/move) applied via undo/redo all mutate state in
  ways that never call `annotationStorage.setValue()` again — invisible
  to the storage's own dirty-tracking. See the Autosave flow section
  above for the specific patches this needed. If a *new* kind of edit
  turns out not to autosave, this is the first place to suspect: find
  what pdf.js call path it actually takes and whether that path reaches
  `setValue()`/`onSetModified` at all.
- **Suppressing dirty-marking needs to be scoped precisely, not broadly.**
  An earlier fix for a false-positive (opening the read-only Comment
  sidebar alone shouldn't autosave) suppressed dirty-marking for the
  entire span of `updateMode()`. That was too broad: `updateMode()` also
  *synchronously commits whatever drawing/edit was already in progress*
  as its very first step, so the suppression ate real edits too (reported
  as "freehand drawing doesn't autosave unless I also touch the color
  popup"). Lesson: when suppressing a false-positive signal, bracket the
  suppression around the *exact* synchronous call that causes it (here,
  `addToAnnotationStorage` gated on `editor.annotationElementId`), not
  around a broader operation that happens to also trigger it.
- **pdf.js ships a bundled sample PDF as its default.**
  `compressed.tracemonkey-pldi-09.pdf`, auto-opened via `defaultUrl`
  whenever there's no `?file=` query string — always true for us. Not
  overridable via the `localStorage` preferences trick used for
  `enableComment`/`enableHighlightFloatingButton` (those are tagged
  `OptionKind.PREFERENCE`; `defaultUrl` isn't). Suppressed via pdf.js's
  own `"webviewerloaded"` CustomEvent, dispatched on the *parent*
  document right before `PDFViewerApplication.run()` — the intended
  embedding hook for exactly this, avoiding any DOMContentLoaded timing
  race.
- The `PDFViewerApplication.open()` argument shape and any other
  Tauri v2 capability/permission identifier strings were originally
  written without being able to run/verify them — if either throws or
  gets permission-denied, check the exact version installed
  (`bunx tauri info`, and whatever pdf.js version is in
  `src/pdfjs/build/pdf.mjs`) against current docs.

## Conventions
- Debounce/timing constants live at the top of `src/main.js`
  (`AUTOSAVE_DEBOUNCE_MS`, `AUTOSAVE_MAX_WAIT_MS`) — tune there, not
  inline.
- Write-then-rename is the pattern for any future feature that writes to
  the original PDF path — never write directly over it.
- Never hand-edit `src/pdfjs/web/**` — it's dropped in wholesale on a
  pdf.js upgrade. Any customization (buttons, styling, behavior patches)
  is injected from `main.js`/`custom-viewer.css` instead.
- When something in pdf.js's own UI is broken or unsafe in this embedding
  (Save, Open, ...), the pattern is: hide the native control via CSS, add
  a DOM-injected replacement into the same toolbar group, wire it to the
  Tauri-aware equivalent. `injectSaveButton`/`injectOpenButton`/
  `injectStatusButton` are all the same shape — copy that pattern for the
  next one rather than inventing a new mechanism.
- When patching a pdf.js method to observe something it doesn't expose an
  event for (`addCommands`, `undo`, `redo`, `addToAnnotationStorage`,
  `annotationStorage.remove`), the target methods are plain (non-private,
  non-`#`-prefixed) instance methods — safe to wrap by reassignment
  (`const original = obj.method.bind(obj); obj.method = (...args) => {
  original(...args); /* observe */ };`). Confirm the method isn't a
  private `#field` first; those can't be reassigned this way.
