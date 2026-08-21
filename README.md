# PDF Annotator

A local-first PDF annotator built on Tauri + pdf.js: open a PDF, annotate
it using pdf.js's own built-in annotation editors (highlight, freetext,
ink, comments), and it autosaves the annotated bytes back into the
original file every few seconds — so a sleep/wake tab reload (the
original motivation: Firefox's built-in PDF viewer loses everything on
that) can never wipe your work again.

Runs on native Windows. Built and run interactively throughout
development — this isn't a from-a-spec skeleton, the rough edges below
are things that were actually hit and fixed.

## Setup

1. Install prerequisites: Node.js, Rust + cargo, [bun](https://bun.sh),
   and the [Tauri v2 system dependencies](https://v2.tauri.app/start/prerequisites/)
   for your OS.
2. `bun install`
3. Download a pdf.js **generic** prebuilt release from
   https://github.com/mozilla/pdf.js/releases (the `pdfjs-<version>-dist.zip`
   asset, not the source zip) and unzip its contents into `src/pdfjs/`, so
   that `src/pdfjs/web/viewer.html` exists. (Already vendored/committed in
   this repo — only needed if you're setting this up somewhere without
   that history.)
4. `bun run tauri dev`

## How it works

- `src/index.html` has two screens: a landing screen (Open button +
  recent-files list, shown until a file is open) and a viewer screen
  (the pdf.js iframe). Opening a file, from either the landing screen or
  the Open button injected into pdf.js's own toolbar, switches to the
  viewer.
- The PDF is read via Tauri's `fs` plugin and handed to
  `PDFViewerApplication.open({ data: bytes })`. Because the iframe is
  served same-origin by Vite/Tauri, `main.js` reaches directly into
  `iframe.contentWindow.PDFViewerApplication` — no postMessage or
  blob-URL handoff needed.
- Every edit eventually reaches `annotationStorage.setValue()`/`remove()`,
  which — via a chain of hooks on pdf.js's own callbacks and a few
  monkey-patched methods (see `CLAUDE.md` for the full list; pdf.js's own
  change-tracking has real gaps) — starts a debounce timer: ~4s after the
  last edit, or a hard 20s ceiling if you keep editing continuously.
- `pdfDocument.saveDocument()` then bakes the annotations into fresh PDF
  bytes, written to `<file>.autosave.tmp` and renamed over the original —
  write-then-rename so a crash mid-write can't corrupt your file.
- Status/error feedback has three channels: a `●` marker on the native
  window title while there are unsaved changes, a colored-dot button in
  pdf.js's toolbar that opens a full timestamped activity log, and toast
  notifications for errors and manual-save confirmations.
- The window title itself reflects the open PDF's own title metadata
  (falling back to filename) — set directly via Tauri's window API, since
  pdf.js's own title-setting logic is a no-op when embedded in an iframe.

## Known rough edges

- **pdf.js's own Save/Download toolbar button doesn't work here** — it's
  actually Save-As via a browser download flow Tauri's WebView2 doesn't
  wire up, so it's hidden and replaced with a working one.
- **Don't use pdf.js's own "Open File" (Tools menu)** — it's blocked
  outright, because it bypasses this app's file-path tracking in a way
  that would silently corrupt the *previous* file on next autosave. Use
  the Open button (landing screen or toolbar), Ctrl+O, or drag-and-drop —
  all three are intercepted and redirected to the same safe picker path,
  never through pdf.js's own handling.
- **`saveDocument()` on documents with no annotations** — if a PDF has no
  AcroForm/annotation structures pdf.js can serialize, this may return
  the original bytes unchanged. Expected, not a bug.
- Frontend JS errors don't show up in the terminal running `tauri dev` —
  check the webview's own DevTools (right-click → Inspect Element).
- See `CLAUDE.md` for the full, more technical list — CSP quirks, Tauri
  capability strings, icon/build requirements, and the specific pdf.js
  internals each autosave-related fix depends on.

## Extending this

- The comments-sidebar panel currently reuses pdf.js's floating-popup
  styling rather than being a real docked/fixed sidebar — a real UI
  change, not yet done.
- Keep a rolling backup (`file.pdf.bak-<timestamp>`) instead of a single
  `.tmp`, so you can recover from a bad autosave too.
- Tabs / multiple open documents / split view are all plain frontend
  concerns (not blocked by Tauri) but would need the current
  single-document module-level state (`currentPath`, `dirty`, etc.) to
  become per-document state first — a real refactor.
- If you want cross-device sync later, the autosave path in
  `saveNow()`/`loadPdfIntoViewer()` is the natural place to also push
  bytes to a cloud folder.
