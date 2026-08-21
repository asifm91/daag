# PDF Annotator — Claude Code context

## What this is
A local-first Tauri desktop app for annotating PDFs, built to solve a
specific problem: Firefox's built-in PDF viewer loses all annotations if
the tab reloads (e.g. after sleep/wake) before you manually save. This
app autosaves annotations *into the actual PDF file on disk* every few
seconds, so there's no window where work can be silently lost.

Moved from WSL (Ubuntu) with WSLg for GUI display on Windows to native Windows.

## Architecture
- **Not a from-scratch PDF viewer.** We embed Mozilla's own prebuilt
  pdf.js "generic" viewer (`src/pdfjs/web/viewer.html`) inside an
  `<iframe>` in `src/index.html`. This gives us pdf.js's full built-in
  annotation editors (highlight, freetext, ink, etc.) for free instead
  of reimplementing an annotation UI.
- `src/main.js` (the parent page) reaches directly into
  `iframe.contentWindow.PDFViewerApplication` — this works because
  everything is served same-origin by Vite/Tauri, so no postMessage or
  blob-URL handoff is needed.
- **Autosave flow:** `pdfDocument.annotationStorage.onSetModified` fires
  on every edit → debounce timer (4s idle / 20s hard ceiling) →
  `pdfDocument.saveDocument()` bakes annotations into fresh PDF bytes →
  written to `<file>.autosave.tmp` → renamed over the original (so a
  crash mid-write can't corrupt the file).
- Rust side (`src-tauri/`) is intentionally thin — just wires up the
  `dialog` and `fs` plugins. All real logic is in the frontend.

## Known rough edges / things that have already bitten us
- **`vite.config.js` has `appType: "mpa"` for a reason** — don't remove
  it. Without it, if the iframe's `src` ever 404s (e.g. pdf.js not yet
  extracted), Vite's SPA fallback serves `index.html` instead of a 404,
  which recursively reloads the whole app inside its own iframe
  infinitely. Keep this fallback disabled.
- `src-tauri/Cargo.toml` should **not** have a `[lib]` section — an
  earlier version of this file did and broke `cargo metadata` (no
  `src/lib.rs` existed to back it). Only add one back if this evolves
  into a proper lib+bin split.
- `src-tauri/icons/icon.png` needs to exist for `tauri::generate_context!()`
  to compile — currently a placeholder flat-color PNG. Replace with a
  real icon via `bunx tauri icon <source.png>` when there's a real logo.
- **Windows also needs `src-tauri/icons/icon.ico` specifically** (not just
  `.png`) — `tauri-build`'s build script uses it to generate the Windows
  Resource file, and its absence fails `cargo build` before any real code
  compiles (`icons/icon.ico not found; required for generating a Windows
  Resource file`). Regenerate the whole icon set (including the `.ico`)
  with `bunx tauri icon <source.png>` any time the source icon changes.
- On this Windows/Git-Bash setup, `npx`/`bunx` have sometimes failed to
  resolve the local Tauri CLI (`could not determine executable to run`)
  even though it's present in `node_modules`. If that happens, call the
  binary directly instead: `./node_modules/.bin/tauri.exe icon ...`.
- pdf.js's `web/` folder must live at `src/pdfjs/web/...` (i.e. inside
  Vite's `root: "src"`), not at the project root — it was extracted to
  the wrong place once already.
- Frontend JS errors (import failures, thrown exceptions) do **not**
  show up in the terminal running `tauri dev` — they only appear in the
  webview's own DevTools (right-click → Inspect Element on Linux/WSLg).
  Always check there first when something silently does nothing.
- The `PDFViewerApplication.open()` argument shape and Tauri v2's
  capability/permission identifier strings (`src-tauri/capabilities/default.json`)
  were written without being able to run/verify them — if either throws
  or gets permission-denied, check the exact version installed
  (`bunx tauri info`, and whatever pdf.js version is in
  `src/pdfjs/build/pdf.mjs`) against current docs rather than assuming
  the config here is exactly right.
- Package manager is **bun**. Use `bun install` / `bun run <script>` /
  `bunx tauri ...`, not npm/npx.

## Conventions
- Debounce/timing constants live at the top of `src/main.js`
  (`AUTOSAVE_DEBOUNCE_MS`, `AUTOSAVE_MAX_WAIT_MS`) — tune there, not
  inline.
- Write-then-rename is the pattern for any future feature that writes
  to the original PDF path — never write directly over it.