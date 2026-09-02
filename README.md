# Daag

A local-first PDF annotator built on Tauri + pdf.js: open a PDF, annotate
it using pdf.js's own built-in annotation editors (highlight, freetext,
ink, comments), and it autosaves the annotated bytes back into the
original file every few seconds — so a sleep/wake tab reload (the
original motivation: Firefox's built-in PDF viewer loses everything on
that) can never wipe your work again.

**Website:** https://asifm91.github.io/daag/ — source in [`docs/`](docs/).

Primarily a Windows app — developed and used on native Windows, which is
the only platform it's actually been tested on. It's _meant_ to build
and run on Linux and macOS too (the few Windows-only bits — the
long-path setting, opening help links in a browser — degrade gracefully
elsewhere), and the release workflow produces those builds, but they're
untested: treat them as best-effort. Built and run interactively
throughout development — this isn't a from-a-spec skeleton, the rough
edges below are things that were actually hit and fixed.

## Features

The editing tools you already know from a browser PDF viewer, in an app
that writes every change back to the file on disk on its own. (The
website's [feature list](https://asifm91.github.io/daag/#features) is the
same, with screenshots.)

- **Highlight, comment, draw** — highlighting, sticky comments, free-text
  notes, and free-hand ink, all pdf.js's own built-in editors embedded
  directly.
- **Crash-safe autosave** — every edit is baked into the actual PDF file
  within seconds of the last change (write-then-rename, so a crash
  mid-write can't corrupt it), not held in memory until a manual save.
- **AI comment summary** — send the document's comments to any
  OpenAI-compatible `/chat/completions` endpoint (a local Ollama by
  default, so nothing leaves the machine unless you point it elsewhere)
  and get a written recap in one click. Endpoint, model, API key, and
  system prompt are in Settings.
- **Quick comments** — right-click a page or press `Q` for a menu of the
  short review phrases you reuse most ("not clear", "make it brief", …),
  ranked by use and dropped in with no dialog. Starts empty; fills itself
  from use and from comments that repeat within a document.
- **Edit in place, or on a copy** — choose per file whether opening a PDF
  edits the original or an autosaved copy; the choice is remembered for
  next time.
- **Work through a folder** — open one PDF and step through the rest of
  its folder with Previous / Next, like an image viewer, without leaving
  the app.
- **Nothing leaves your machine** — fully offline and local-first: no
  account, no sync, no network at all. A safe fit for confidential
  documents.
- **Fast and lightweight** — a small download (< 20 MB) that launches
  instantly and stays easy on memory with a long PDF open.
- **Keyboard-first** — the tools you reach for most are a single key
  away, and the usual viewer shortcuts (`Ctrl+F` to search, etc.) work
  too.

Also:

- **Light / dark / default theme** — one button flips the whole app, the
  document view included, with no reload. Default keeps a dark landing
  screen with a light document viewer, matching pdf.js's own look.
- **A window per file, not tabs** — opening another PDF (Open button,
  "Open with", double-clicking a `.pdf`, a command-line argument) never
  disturbs the one you're already reviewing.
- **Undo All** — roll the file back to how it was when you opened it, or
  clear every annotation in it outright, from one confirmation dialog.
- **Built-in updates** — checks GitHub for a newer release on launch and
  from Settings; downloads and installs only on your confirmation, then
  restarts.
- **Export comments** — pull every comment out into a separate Markdown
  file to share or review outside the PDF.
- **Resume where you left off** — reopening a file from the recent-files
  list jumps straight back to the page and scroll position you left at.
- **Custom titlebar** — no native OS chrome; shows the PDF's own title
  metadata, with the full file path available on hover. Window controls
  come in two styles, switchable in Settings and seeded from your OS:
  Windows-style minimize / maximize / close on the right, or macOS-style
  traffic lights on the left.
- **Status dot & activity log** — a titlebar dot shows saved / saving /
  unsaved / error at a glance; click it for a timestamped history.
- **Open it any way** — drag a PDF in, press `Ctrl+O`, use "Open with",
  double-click a `.pdf`, or pass it on the command line. Every route is
  intercepted and opened through the app's own safe path handling
  instead of pdf.js's built-in (and unsafe, in this embedding) file-open,
  and none of them take over as the system default viewer.
- **Long path support** — opens deeply nested files past Windows' old
  260-character limit (drag-and-drop past it needs a one-time Settings
  toggle).
- **Find, navigate, zoom** — full-text search with match highlighting,
  go-to-page, thumbnail and outline panels, zoom / fit / rotate, and
  single-page / two-page / full-screen layouts (all pdf.js's own).
- **Fill in PDF forms** — type into fields and tick checkboxes; values
  save into the file like any annotation.
- **Insert an image** — drop a picture onto the page, e.g. to stamp a
  scanned signature where one's needed.
- **Print** — directly from the app, annotations included, with a preview
  and page selection.

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
- **Linux** — AppImage plus `.deb` _(untested)_
- **macOS** — universal (Intel + Apple Silicon) `.dmg` _(untested)_

Only the Windows build has actually been run; the Linux and macOS
artifacts compile in CI but haven't been verified on a real machine.
The builds are unsigned, so Windows SmartScreen and macOS Gatekeeper
warn on first run.

**Built-in updater.** Once installed, the app checks its GitHub releases
page on launch (and on demand from Settings → _Check for updates_) and
can download and install a newer release in place, then restart. It's
`tauri-plugin-updater` pointed at
`releases/latest/download/latest.json`; the updater artifacts are signed
in CI with a minisign key (see `UPDATER.md`). Only the _latest published_
release ever feeds the updater — a manual workflow run produces a draft,
which doesn't count until you publish it.

**Cutting a release:**

1. `bun run release-prep <x.y.z>` (`scripts/prepare-release.mjs`) does the
   local prep and stops before pushing:
   - moves the `## [Unreleased]` entries in `CHANGELOG.md` into a new
     `## [x.y.z] — YYYY-MM-DD` section and updates the reference links;
   - regenerates `docs/changelog.html` (committed — GitHub Pages serves
     `docs/` as-is; CI fails the release if it's stale);
   - bumps the version in `package.json`, `src-tauri/tauri.conf.json`,
     `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`;
   - stages exactly those files, commits as `Release v<x.y.z>`, and tags
     `v<x.y.z>`.

   `--dry-run` shows the plan and changes nothing; `--no-git` edits the
   files but skips the commit and tag. `--revert <x.y.z>` undoes a prep
   that hasn't been pushed yet (deletes the tag, drops the `Release`
   commit, back to the previous version) — it aborts if the tag or commit
   already reached a remote.
2. Review the commit, then `git push` and `git push origin v<x.y.z>`. The
   tag push triggers the workflow; a manual dispatch instead produces a
   draft release you publish by hand. CI fails fast unless the tag, the
   `tauri.conf.json` version, and a matching `CHANGELOG.md` section all
   agree.

## Changelog

`CHANGELOG.md` ([Keep a Changelog](https://keepachangelog.com/) format)
is the single source for both the GitHub release notes and the website's
changelog page — don't hand-edit either output:

- **Website** — `scripts/build-changelog.mjs` (via `bun run changelog`)
  renders `CHANGELOG.md` into `docs/changelog.html`, which is committed.
  The `verify` CI job runs the same script with `--check` and fails the
  release if the committed HTML is out of date.
- **GitHub release** — the workflow's `finalize` job slices out the
  releasing version's section, appends the shared download footer
  (`.github/release-body-footer.md`), and sets that as the release body.
  It also patches the same section into `latest.json`'s `notes` field —
  that's the text the in-app update dialog shows.

The `## [Unreleased]` section stays at the top of the file between
releases and is left off the website.

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
  that would silently corrupt the _previous_ file on next autosave. Use
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
  see "A window per file, not tabs" above. Tabs/split-view _within_ one
  window would need the current single-document module-level state
  (`currentPath`, `dirty`, etc.) to become per-document state first — a
  real refactor — for what would likely be a downgrade for the
  Previous/Next review workflow this app is built around anyway.
- If you want cross-device sync later, the autosave path in
  `saveNow()`/`loadPdfIntoViewer()` is the natural place to also push
  bytes to a cloud folder.
