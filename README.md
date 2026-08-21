# PDF Annotator (Tauri starter)

A minimal local-first PDF annotator: open a PDF, annotate it using pdf.js's
own built-in annotation editors (highlight, freetext, ink, etc.), and it
autosaves the annotated bytes back into the original file every few
seconds — so a sleep/wake tab reload can never wipe your work again,
because there's no "unsaved in-memory state" left sitting around for long.

**This was written and reviewed by hand, but not run — I don't have a
sandbox with network/build access to test it. Treat it as a solid
starting skeleton, not a finished app.** The parts most likely to need
small fixes are called out below.

## Setup

1. Install prerequisites: Node.js (18+), Rust + cargo, and the [Tauri v2
   system dependencies](https://v2.tauri.app/start/prerequisites/) for
   your OS.
2. `npm install`
3. Download a pdf.js **generic** prebuilt release from
   https://github.com/mozilla/pdf.js/releases (the `pdfjs-<version>-dist.zip`
   asset, not the source zip) and unzip its contents into `src/pdfjs/`,
   so that `src/pdfjs/web/viewer.html` exists.
4. `npm run tauri dev`

## How it works

- `src/index.html` hosts the pdf.js viewer in an iframe. Because
  everything is served from the same origin by Tauri/Vite, `main.js` can
  reach directly into `iframe.contentWindow.PDFViewerApplication` — no
  postMessage or blob-URL handoff needed.
- On "Open PDF", the file is read via the `fs` plugin and handed to
  `PDFViewerApplication.open({ data: bytes })`.
- `pdfDocument.annotationStorage` exposes `onSetModified` /
  `onResetModified` callbacks — every edit fires one of these, which
  starts a debounce timer.
- After ~4s of no further edits (or a hard 20s ceiling if you keep
  typing), `pdfDocument.saveDocument()` bakes the annotations into fresh
  PDF bytes, which get written to `<file>.autosave.tmp` and then renamed
  over the original — so a crash mid-write can't corrupt your file.

## Known rough edges to check once you have it running

- **`PDFViewerApplication.open()` signature** varies a bit release to
  release. If it throws, open your dropped-in `web/viewer.mjs` and check
  what shape it expects (`{ data }` vs `{ url }` vs a raw ArrayBuffer).
- **Tauri v2 permission strings** in `src-tauri/capabilities/default.json`
  — the exact permission identifiers (`fs:allow-write-file`, etc.) have
  shifted across Tauri 2.x betas/releases. If you get a permission-denied
  error, run `npx tauri info` and cross-check against your installed
  `@tauri-apps/plugin-fs` version's docs.
- **File scope**: picking a file via the dialog plugin should
  automatically extend fs scope to that path in Tauri v2, but if writes
  get rejected, you may need an explicit scope entry for the picked
  file's directory.
- **`saveDocument()` on documents with no supported annotations** —
  if a PDF has no AcroForm/annotation structures pdf.js can serialize,
  this may return the original bytes unchanged. That's expected, not a
  bug.

## Extending this

- Add a visible "last saved" timestamp / dirty-dot in the titlebar.
- Keep a rolling backup (`file.pdf.bak-<timestamp>`) instead of a single
  `.tmp`, so you can recover from a bad autosave too.
- If you want cross-device sync later, the autosave hook is the natural
  place to also push bytes to a cloud folder.
