# Changelog

All notable changes to Daag, per release. This file is the single source for
both the GitHub release notes (the release workflow slices out the matching
`## [x.y.z]` section) and the changelog page on the website (run
`bun run changelog` to regenerate `docs/changelog.html`). Format follows
[Keep a Changelog](https://keepachangelog.com/); the `[Unreleased]` section
stays in this file but is left off the website.

## [Unreleased]

### Added

- **View changelog** — a link in Settings (General tab, next to the update
  status, and the About tab) opens the full release history in place,
  without needing to check for an update first.

### Fixed

- **Update dialog showed raw Markdown** — the release notes shown when an
  update is available displayed literal Markdown syntax (`**bold**`,
  `-` list markers) instead of rendered text. Now renders properly,
  matching the GitHub release page.

## [1.5.1] — 2026-09-17

### Fixed

- **Keyboard shortcuts going dead after closing a dialog** — closing
  Settings, the Activity Log, or any other dialog (via its close button,
  clicking outside, or Escape) left keyboard shortcuts and pdf.js's own key
  handling unresponsive until you clicked back inside the document. Focus
  now returns to the viewer automatically.
- **Comment (C) and quick comment (Q) shortcuts now work on an
  already-selected highlight** — pressing either right after making a
  highlight (rather than before, over a text selection) used to do nothing,
  or for Q, create a redundant second highlight. Both now act on the
  highlight that's currently selected.
- **Select/Hand cursor-tool shortcuts (S/H) now work while a highlight,
  draw, or other editor tool is active** — previously they silently did
  nothing until you first turned the active tool off by hand. Turning a
  tool off with its own shortcut (e.g. pressing F again while Highlight is
  active) is fixed the same way when a highlight is currently selected.

## [1.5.0] — 2026-09-02

### Added

- **About tab in Settings** — shows the running version (with its release
  date), the author, and links out to the online guide, the source
  repository, and the issue tracker.

## [1.4.0] — 2026-09-01

### Added

- **macOS-style window controls** — an optional Settings toggle swaps the
  titlebar's Windows-style minimize/maximize/close for macOS-style traffic
  lights on the left, including a dimmed inactive-window state to match.
  Defaults to your operating system's own convention.

### Changed

- The startup update check no longer opens the update dialog while a PDF is
  open — it shows a toast and the Settings-button dot instead, and only opens
  the dialog on the landing screen.
- The Settings updates row now always shows the running version, even when an
  update is available.

## [1.3.0] — 2026-09-01

### Added

- **AI provider presets** — pick Ollama, LM Studio, OpenAI, OpenRouter, or
  Groq from a dropdown to fill in the endpoint; the model is remembered per
  provider, so switching back and forth doesn’t leave an incompatible model
  behind.
- **Update indicator** — a dot on the titlebar Settings button once a newer
  release is found, from either the startup check or Settings → Check for
  updates.
- **Add quick comment phrases in Settings** — type your own into the Quick
  comments tab instead of waiting for one to be picked up from use.

## [1.2.0] — 2026-09-01

### Changed

- **Settings is now tabbed** — General, AI summary, and Quick comments,
  instead of one long dialog.

### Added

- **Test connection** button in AI summary settings — checks the endpoint
  (and model) before you rely on it for a summary.

## [1.1.0] — 2026-09-01

### Added

- **AI comment summary** — send a document’s comments to an OpenAI-compatible
  model (a local Ollama by default, so nothing leaves your machine) and get a
  written recap, with regenerate / stop and a per-document cache.
- **Quick comments** — press <kbd>Q</kbd> or right-click a page for a menu of
  the review phrases you reuse most, ranked by use and dropped in with no
  dialog.
- **Built-in updates** — Daag checks GitHub for a newer release on launch and
  from Settings, and installs it on your confirmation before restarting.
- **<kbd>Ctrl</kbd>+<kbd>W</kbd>** closes the document and returns to the
  landing screen.
- A Linux `.deb` build alongside the AppImage.
- This website.

### Changed

- **Reload is blocked** — <kbd>F5</kbd>, <kbd>Ctrl</kbd>+<kbd>R</kbd>, and
  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> no longer drop the editing
  session by accident.

## [1.0.0] — 2026-08-30

### Added

- First tagged release, and the rename to **Daag**.
- **Custom titlebar** with a default / light / dark theme toggle; Open,
  Previous / Next, Activity Log, and Settings live in it.
- Open PDFs from the **command line**, a **file association**, and **“Open
  with”** — without taking over as the default viewer.
- **Drag-and-drop at Windows long paths**, with a Settings toggle to enable
  long-path support.
- **Cross-platform release workflow** — Windows, plus experimental Linux and
  macOS builds.

### Changed

- The window title tracks the PDF’s own metadata title and shows the full
  file path on hover.

[Unreleased]: https://github.com/asifm91/daag/compare/v1.5.1...HEAD
[1.5.1]: https://github.com/asifm91/daag/releases/tag/v1.5.1
[1.5.0]: https://github.com/asifm91/daag/releases/tag/v1.5.0
[1.4.0]: https://github.com/asifm91/daag/releases/tag/v1.4.0
[1.3.0]: https://github.com/asifm91/daag/releases/tag/v1.3.0
[1.2.0]: https://github.com/asifm91/daag/releases/tag/v1.2.0
[1.1.0]: https://github.com/asifm91/daag/releases/tag/v1.1.0
[1.0.0]: https://github.com/asifm91/daag/releases/tag/v1.0.0
