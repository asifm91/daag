# Daag

A local-first PDF annotator built on Tauri + pdf.js: open a PDF, annotate
it using pdf.js's own built-in annotation editors (highlight, freetext,
ink, comments), and it autosaves the annotated bytes back into the
original file every few seconds — so a sleep/wake tab reload (the
original motivation: Firefox's built-in PDF viewer loses everything on
that) can never wipe your work again.

**Website:** https://asifm91.github.io/daag/ — source in [`docs/`](docs/).

Primarily a Windows app — developed and used on native Windows, which is
the only platform it's actually been tested on. It's *meant* to build
and run on Linux and macOS too (the few Windows-only bits — the
long-path setting, opening help links in a browser — degrade gracefully
elsewhere), and the release workflow produces those builds, but they're
untested: treat them as best-effort. Built and run interactively
throughout development — this isn't a from-a-spec skeleton, the rough
edges below are things that were actually hit and fixed.

## Features

- **Crash-safe autosave** — annotations are baked into the actual PDF
  file on disk within seconds of the last edit (write-then-rename, so a
  crash mid-write can't corrupt the file), not just held in memory until
  a manual save.
- **Full pdf.js annotation editors** — highlight, freetext, ink/drawing,
  and comments, all pdf.js's own built-in tooling embedded directly.
- **Status dot + activity log** — a small titlebar indicator shows
  idle/dirty/saving/error/saved at a glance; clicking it opens a
  timestamped log of every save/status event.
- **Undo All** — reverts to the file's state at the start of the current
  session (with a confirmation dialog), including an option to strip
  every annotation in the file outright, not just the ones made this
  session.
- **Export Comments** — pulls every comment annotation out to a separate
  Markdown file for sharing or review outside the PDF.
- **Summarize Comments** — sends the document's comments to any
  OpenAI-compatible `/chat/completions` endpoint (a local Ollama server by
  default, so nothing leaves the machine unless you point it elsewhere) and
  shows the summary. Endpoint, model, API key, and system prompt are in
  Settings.
- **Quick comments** — right-click a page (or press `Q`) for a small menu
  of short review phrases you reuse ("not clear", "make it brief", …),
  most-used first; picking one drops it onto the page as a comment with no
  dialog. The list starts empty and fills itself as you use phrases and as
  exporting/summarizing surfaces comments that repeat within a document.
- **Safe, real drag-and-drop and Ctrl+O** — both open a file through the
  app's own path-tracking instead of pdf.js's built-in (and unsafe, in
  this embedding) file-open handling.
- **Overwrite vs. copy on open** — choose whether opening a PDF edits it
  in place or works on an autosaved copy instead, per file, with the
  choice remembered for next time.
- **Recent files** on the landing screen, and a custom titlebar (no
  native OS chrome) that shows the PDF's own title metadata, with the
  full file path available as a hover tooltip.
- **Light / Dark / Default theme toggle** — one button cycles the whole
  app (landing screen, titlebar, and the pdf.js viewer itself) through
  three themes; Default keeps a dark landing screen with a light
  document viewer, matching pdf.js's own conventional look.
- **Multiple windows, not tabs** — opening another file (via the Open
  button, "Open with", double-clicking a `.pdf`, or a command-line
  argument) opens it in its own window rather than replacing what
  you're currently reviewing, so interrupting your place in one
  document to annotate another never loses it.

## Setup

1. Install prerequisites: Node.js, Rust + cargo, [bun](https://bun.sh),
   and the [Tauri v2 system dependencies](https://v2.tauri.app/start/prerequisites/)
   for your OS.
2. `bun install`
3. Download a pdf.js **generic** prebuilt release from
   https://github.com/mozilla/pdf.js/releases (the `pdfjs-<version>-dist.zip`
   asset, not the source zip) and unzip its contents into `src/public/pdfjs/`,
   so that `src/public/pdfjs/web/viewer.html` exists. It must live under
   `src/public/` (Vite's `publicDir`) — anywhere else in `src/` is served
   fine by the dev server but silently omitted from `vite build`'s output,
   since the iframe points at it via a runtime string (`frame.src =
   "pdfjs/web/viewer.html"` in main.js), not a static import Vite's build
   can trace. (Already vendored/committed in this repo — only needed if
   you're setting this up somewhere without that history.)
4. `bun run tauri dev`

## Releases

Prebuilt binaries come from the `Release` GitHub Actions workflow
(`.github/workflows/release.yml`), which runs on manual dispatch or when
a `v*` tag is pushed — never on an ordinary push:

- **Windows** — NSIS installer plus a standalone portable `.exe`
- **Linux** — AppImage *(untested)*
- **macOS** — universal (Intel + Apple Silicon) `.dmg` *(untested)*

Only the Windows build has actually been run; the Linux and macOS
artifacts compile in CI but haven't been verified on a real machine.
The builds are unsigned, so Windows SmartScreen and macOS Gatekeeper
warn on first run. To cut a release, bump the version in `package.json`,
`src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` so they match,
then push a `v<version>` tag; a manual run instead produces a draft
release you publish by hand.

## How it works

- `src/index.html` has two screens: a landing screen (Open button +
  recent-files list, shown until a file is open) and a viewer screen
  (the pdf.js iframe), both sharing one custom titlebar (the app runs
  with `decorations:false` — no native OS titlebar at all). Opening a
  file — from the landing screen, the titlebar's own Open button, "Open
  with", double-clicking a `.pdf`, or a `daag.exe file.pdf`
  command line — switches to the viewer; Open/Previous/Next/Activity
  Log/Settings live in the titlebar itself (hidden on the landing
  screen), not inside pdf.js's own toolbar.
- This is a multi-window app by design, not single-instance: each file
  you open gets its own window, matching a "review one document at a
  time via Previous/Next, occasionally interrupt for another file"
  workflow better than tabs would.
- **Ctrl+W** closes the current document back to the landing screen (a
  real close — it flushes a save first, doesn't reload the window).
  Browser reload — **F5 / Ctrl+R / Ctrl+Shift+R** — is disabled outright,
  since an accidental reload mid-annotation would drop the pdf.js editing
  session; on Windows this also disables the Ctrl+P / Ctrl+F / zoom / F12
  browser accelerators, but pdf.js provides its own find/print/zoom and
  DevTools stays on the right-click menu.
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
- Status/error feedback has three channels: the window title itself, a
  colored-dot button in the titlebar that opens a full timestamped
  activity log, and toast notifications for errors and manual-save
  confirmations.
- The window title itself reflects the open PDF's own title metadata
  (falling back to filename), with the full path available as a hover
  tooltip — set directly via Tauri's window API, since pdf.js's own
  title-setting logic is a no-op when embedded in an iframe.
- Theming is a single three-way toggle (Default/Light/Dark) that drives
  the outer chrome via a CSS class swap and the pdf.js viewer itself via
  a live `color-scheme` property change (no iframe reload needed) — see
  `CLAUDE.md` for why that alone isn't enough for comment popups/markers
  specifically.

## Known rough edges

- **pdf.js's own Save/Download toolbar button doesn't work here** — it's
  actually Save-As via a browser download flow Tauri's WebView2 doesn't
  wire up, so it's hidden and replaced with a working one.
- **Don't use pdf.js's own "Open File" (Tools menu)** — it's blocked
  outright, because it bypasses this app's file-path tracking in a way
  that would silently corrupt the *previous* file on next autosave. Use
  the Open button (landing screen or titlebar), Ctrl+O, or drag-and-drop —
  all three are intercepted and redirected to the same safe picker path,
  never through pdf.js's own handling.
- **`saveDocument()` on documents with no annotations** — if a PDF has no
  AcroForm/annotation structures pdf.js can serialize, this may return
  the original bytes unchanged. Expected, not a bug.
- **A highlight's comment-marker background color can be "stuck" from an
  earlier theme** — it's set once when that page first renders each
  session and isn't live-updated on a later theme switch (the comment
  popup's own text and background, and the rest of the app's chrome, all
  DO update live — this is specific to the small marker button drawn on
  the highlight itself). Reopening the document repaints it correctly.
  See `CLAUDE.md` for the investigation into why.
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
- Multiple open documents are handled via separate windows, not tabs —
  see "Multiple windows, not tabs" above. Tabs/split-view *within* one
  window would need the current single-document module-level state
  (`currentPath`, `dirty`, etc.) to become per-document state first — a
  real refactor — for what would likely be a downgrade for the
  Previous/Next review workflow this app is built around anyway.
- If you want cross-device sync later, the autosave path in
  `saveNow()`/`loadPdfIntoViewer()` is the natural place to also push
  bytes to a cloud folder.
