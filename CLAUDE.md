# Daag (PDF Annotator) — Claude Code context

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
  open. Has no chrome of its own beyond the shared titlebar — document
  actions split across two places: Open/Previous/Next/Activity Log/
  Settings live in the custom titlebar (see below), hidden until a
  document is open; Save/Undo All/Export Comments stay injected *into
  pdf.js's own toolbar* (see further below) since they're specific to
  the open document's editing session.

The iframe stays `display:none` (not unloaded) while the landing screen
shows, so pdf.js and all the hooks below are already warm by the time a
file is picked. `showViewer()` calls `frame.contentWindow.focus()` after
un-hiding it — an iframe doesn't take focus just by becoming visible, and
without it the iframe-scoped shortcut keys (`attachKeyboardShortcuts`) and
pdf.js's own key handling stay dead until the first click inside it.

**Ctrl+W closes the open document** back to the landing screen
(`closeCurrentPdf()`): flush a save if dirty, `PDFViewerApplication.close()`,
null out the session state (`currentPath`, `sessionOriginalBytes`,
`folderPdf*`, `summaryCache`, `currentTitleBase`), disable the injected
toolbar buttons, reset the window title to `DEFAULT_WINDOW_TITLE`, show the
landing screen. It is **not** a window reload — an earlier version just did
`location.reload()`, which only *looked* like closing because startup
doesn't auto-reopen the last file, but a file opened via `get_launch_path`
(CLI arg / Explorer "Open with") was passed on `argv[1]` again on the fresh
process and reopened itself. No-op on the landing screen.

**Ctrl+R / F5 / Ctrl+Shift+R reload is blocked.** An accidental reload
mid-annotation drops the pdf.js editing session, and (via `get_launch_path`)
can silently reopen a file you just closed. The real block is Rust-side —
`disable_browser_accelerator_keys()` in `src-tauri/src/main.rs` sets
WebView2's `AreBrowserAcceleratorKeysEnabled` to `false` in the Tauri
`setup` hook (via `with_webview` → `ICoreWebView2Settings3`). That also
disables the other browser accelerators (Ctrl+P, Ctrl+F, Ctrl +/-/0 zoom,
F12) — pdf.js has its own find/print/zoom and DevTools is still on the
right-click menu, so this is fine, arguably better. `blockReloadKeys()` in
`main.js` is a capture-phase `preventDefault` fallback for `vite` dev (no
Tauri webview there) and old WebView2 runtimes lacking
`ICoreWebView2Settings3`.

### Custom titlebar
`app.windows[0].decorations` is `false` in `tauri.conf.json` — no native
Windows titlebar at all. `#titlebar` in `index.html`
(`data-tauri-drag-region`) replaces it entirely:
- **Window controls** — minimize/maximize/close call straight into
  `@tauri-apps/api/window`'s `getCurrentWindow()`. The maximize button's
  icon (two-square ⇄ single-square) is kept in sync via
  `getCurrentWindow().onResized()` + `isMaximized()`
  (`syncMaximizeButtonState`) rather than just toggled on click, since
  the window can also un/maximize via OS gestures (double-clicking the
  titlebar — `data-tauri-drag-region`'s own built-in behavior — window
  snap, keyboard shortcuts) that never go through our click handler.
- **`data-tauri-drag-region` checks the exact `event.target`**, not
  `.closest()` — confirmed before relying on it: a button placed inside
  a draggable container is safe from accidentally starting a drag as
  long as the button itself (not just an ancestor) lacks the attribute.
- **`#titlebarDocActions`** — Open, Previous, Next, Activity Log
  (status dot), Settings. Relocated here from pdf.js's own toolbar
  (where they lived as injected DOM — see below) specifically so they
  could be hidden on the landing screen and shown only once a document
  is open (`showViewer()` un-hides `#titlebarDocActions`) — not possible
  while pdf.js's own toolbar was the only place to put them, since that
  toolbar only exists inside the iframe. Being hand-authored in
  `index.html` (which we own outright) rather than injected DOM (only
  needed for elements living *inside* pdf.js's own vendored toolbar),
  they're wired with plain top-level `addEventListener` calls — no
  `waitForViewer()` gating, no CSS-injection dance.
- Square buttons with reduced padding for this cluster specifically
  (`#titlebarDocActions .titlebarButton`) — the titlebar's default
  button sizing (built for the window-controls cluster) felt too small/
  cramped once these five moved out of pdf.js's own toolbar chrome. A
  `.titlebarSeparator` divider sits between this cluster and the
  theme/window-controls cluster.
- The Settings gear icon (`#titlebarSettingsBtn`) is inline SVG: a
  filled circle, a `<mask>` cutout hole, and 8 rotated tooth rectangles
  — matched against the landing page's own gear button so both read as
  the same icon. Tooth proportions matter more than they look: too
  little of each tooth rectangle overlapping the body circle reads as a
  spiky asterisk, not a gear.
- **Window-control layout is switchable** (`#windowControlsSelect` in
  Settings → General, key `pdfAnnotator.windowControlStyle`):
  Windows-style min/max/close on the right (default), or macOS-style
  traffic lights on the left. Seeded once from the OS on first run —
  `detectPlatform()` sniffs the webview (`navigator.userAgentData.
  platform`, falling back to `navigator.platform` since WKWebView lacks
  the former) rather than pulling `@tauri-apps/plugin-os` for one string,
  same "don't add a plugin for one thing" call as `open_external`. It's
  purely a CSS reskin: `applyWindowControlStyle()` toggles
  `#titlebar.titlebar-controls-mac`, and the *same* three buttons and
  click handlers serve both looks — `decorations` stays `false`, there
  are never real native controls. In the mac layout the three buttons
  become 12px colored circles (glyphs revealed only on cluster hover,
  matching macOS), reordered close/min/zoom via CSS `order`, and the
  whole `#titlebarControls` is pulled to the far left with `order: -1`.
  For that reorder to work `#titlebarThemeBtn` had to move *out* of
  `#titlebarControls` to be a direct sibling (it's app chrome, not a
  window control) so it can stay on the right while the cluster moves.
  The maximize button carries a third SVG (`.icon-mac-zoom`, the
  outward-triangle glyph) shown only in this mode; its normal
  maximize/restore glyphs are hidden, and it does *not* swap on
  maximize state (macOS shows the same zoom glyph either way).
- **Inactive-window state** — `getCurrentWindow().onFocusChanged()`
  toggles `#titlebar.titlebar-unfocused`; in the mac layout that greys
  all three lights (a hover still re-colorizes them), mirroring macOS.
  The class is harmless/unused in the Windows layout. `isFocused()` is
  read once at startup for the initial state, `.catch()`-guarded for
  plain `vite` dev where it throws.

### Theming
One user-facing toggle (`#titlebarThemeBtn`, cycles default → light →
dark → default, persisted in `localStorage`) drives three independent
things, computed differently:
1. **Outer chrome** (landing screen, dialogs, titlebar's own base
   styling) — a `body.theme-light` class swap against CSS custom
   properties defined in `index.html`'s `:root`.
2. **Titlebar light/dark state specifically** — `updateTitlebarChrome()`,
   kept separate from the chrome swap above because it depends on *both*
   the chosen theme *and* whether the viewer is currently showing (the
   default theme is dark landing / light viewer, so the titlebar itself
   needs to flip to a light background once a document is open even
   though nothing else did) — rerun from both `applyTheme()` and
   `showViewer()`.
3. **The pdf.js viewer itself** (`applyPdfjsColorScheme`) —
   `pdfjsColorSchemeMode()` maps our three-way toggle down to pdf.js's
   two-way light/dark, via two mechanisms layered together, because
   pdf.js only reads its own theme preference once, at its own startup:
   - `configurePdfjsPreferences()` seeds the `viewerCssTheme`
     `OptionKind.PREFERENCE` AppOption (1=light, 2=dark) via the same
     `localStorage["pdfjs.preferences"]` trick used for
     `enableComment`/`enableHighlightFloatingButton` — read by pdf.js's
     own `initialize()` on first load.
   - `applyPdfjsColorScheme()` pokes `color-scheme` directly onto
     `frame.contentWindow.document.documentElement.style` — the exact
     call pdf.js's own `initialize()` makes internally
     (`docStyle.setProperty("color-scheme", mode)`) — for instant
     mid-session switching without reloading the iframe. Called from
     three places with different warmth guarantees: once synchronously
     at module init right after `frame.src` is assigned (iframe still
     on its placeholder document — a deliberate no-op, guarded by
     optional chaining throughout), once for real once
     `initializeViewer()`'s `waitForViewer()` resolves (this is what
     actually seeds things for a document opened before ever touching
     the theme button), and again on every subsequent theme-button
     click.
   - Also sets a plain `--app-color-scheme` custom property alongside
     `color-scheme` itself, and refreshes a memoized pdf.js color cache
     (`refreshPdfjsCommentForegroundColorCache`) — both specifically for
     comment popup/marker theming, which needed much more than the
     plain `color-scheme` poke above. See "Comment popups/markers have
     their own `color-scheme`" under Known rough edges for the full
     story, including a known unfixed gap (marker background color
     frozen at first paint).

### Buttons injected into pdf.js's toolbar
pdf.js's own Save button is broken in this embedding (see Known rough
edges), so it's hidden via `src/public/custom-viewer.css` and replaced
with our own, injected as DOM from `main.js` (never hand-edited into
`viewer.html` — that file gets dropped in wholesale on a pdf.js upgrade,
silently erasing any hand patch). Open, Previous/Next, Activity Log, and
Settings *used to* live here too but were relocated to the custom
titlebar (see above) so they could be hidden on the landing screen —
what's left injected into pdf.js's own toolbar is specific to the open
document's editing session, not general app chrome:
- **Save** (`injectSaveButton`) — force-saves via the same path as
  autosave. Last button in this group.
- **Undo All** (`injectUndoAllButton`) — reverts to the file's state at
  session start; see Undo All flow below. Has no broken pdf.js
  counterpart to hide, it's purely additive.
- **Export Comments** (`injectExportCommentsButton`) — exports the
  file's comments; purely additive, no pdf.js counterpart.
- **Summarize Comments** (`injectSummarizeCommentsButton`) — sends the
  file's comments to a configurable OpenAI-compatible endpoint and shows
  the reply in `#summaryDialog`; see AI comment summary below. Purely
  additive.

Injector call order in `initializeViewer()` determines left-to-right
placement among what's injected; final toolbar layout is [editor tools]
| Undo All, Export Comments, Summarize Comments, Print (pdf.js's own,
untouched) | Save.

All four share one externally-loaded stylesheet
(`ensureCustomStylesheetLoaded` → `public/custom-viewer.css`) — **must**
be a real `<link>`, not a JS-inserted `<style>` tag; see Known rough
edges for why.

### AI comment summary
The toolbar's Summarize Comments button (`onSummarizeButtonClick`) reuses
`exportComments()`'s exact collection path (`collectCommentedAnnotations`),
flattens the entries into a prompt (`renderCommentsForPrompt`), and calls
the **`summarize_comments` Tauri command** (Rust side), which POSTs an
OpenAI-compatible `/chat/completions` request and returns
`choices[0].message.content`. The reply shows in `#summaryDialog` — a
plain `white-space:pre-wrap` box, no Markdown renderer in the app.
- **The dialog opens immediately, before the request.** Generation
  latency is unbounded (a slow local model can take minutes), so
  `onSummarizeButtonClick` shows the dialog first, then `runSummary()`
  fills the body: a CSS spinner (`.summarySpinner`, body class
  `is-loading`) while the request is in flight, the result on success, or
  the error text (body class `is-error`) on failure. Never disable the
  toolbar button for the duration — the modal dialog already blocks a
  second trigger, and `summaryInFlight` guards `runSummary()`.
- **Single-flight, with a real Stop.** Only one summary runs at a time
  (`summaryInFlight`). The Regenerate button swaps to **Stop** while a
  request is in flight; Stop calls the **`cancel_summarize`** command,
  which `abort()`s the spawned Rust task so the in-flight `reqwest` future
  is *dropped* — the HTTP connection closes and a local model stops
  generating, freeing the endpoint for an immediate re-run with a
  different model. `summarize_comments` runs the request on its own
  `async_runtime::spawn` task and awaits the result over a channel
  precisely so this abort works (a plain `.await` in the command couldn't
  be cancelled). `summaryRunId` is bumped on Stop so a result that lands
  anyway (abort lost the race) is discarded by `runSummary()` instead of
  clobbering the UI. Stop is `disabled` for `STOP_BUTTON_ARM_MS` after a
  run starts, so a double-click on Regenerate (now sitting where Stop
  appeared) can't instantly kill the run it just began.
- **Stop keeps the last good result on screen.** `renderSummaryStopped()`
  re-renders `summaryCache.markdown` (when it's for the current document)
  with a muted `#summaryDialogNotice` line — "showing the last completed
  summary" — instead of blanking the pane; only with no cache does it show
  the plain "Stopped, press Regenerate" prompt. The notice is cleared by
  every other render path; the status toast stays a plain "Summary
  stopped" either way.
- **Closing the dialog does *not* abort.** A run in progress finishes in
  the background and `renderSummaryResult` still caches it; reopening the
  dialog while it's running (`onSummarizeButtonClick` sees
  `summaryInFlight`) just re-shows the spinner.
- **Result is cached per document** (`summaryCache =
  { path, promptKey, model, systemPrompt, markdown }`). A second button
  press with a matching `path` + `model` + `systemPrompt` renders the
  cached markdown with no network call, then re-collects the comments in
  the background and silently regenerates only if `promptKey` (the full
  user-prompt string, which
  encodes every comment/context/author/page) no longer matches. Cleared
  on document change (`loadPdfIntoViewer`) and bypassed by the dialog's
  **Regenerate** button, which always does a fresh run.
- **The dialog has its own Model field** (`#summaryModelInput`), seeded
  from `getAiModel()` on open. It's the source of truth while the dialog
  is open; `runSummary()` writes it back to `AI_MODEL_KEY` so Settings
  and the dialog stay in step. (Endpoint, API key, and system prompt are
  Settings-only.)
- **Model fields are comboboxes.** Both `#summaryModelInput` and Settings'
  `#aiModelInput` point a shared `<datalist id="aiModelHistoryList">` at
  `AI_MODEL_HISTORY_KEY` (most-recent-first, capped at
  `MAX_AI_MODEL_HISTORY`), so switching models is a pick, not a retype.
  `addAiModelToHistory()` runs on a successful summary and on Settings
  save; `renderAiModelDatalist()` always also offers `AI_MODEL_DEFAULT`.
- **The system prompt lives in `src/summary-system-prompt.txt`**, imported
  into `main.js` as `DEFAULT_SUMMARY_SYSTEM_PROMPT` (`?raw`, inlined at
  build). Settings has a `#aiSystemPromptInput` textarea (+ **Restore
  default** button) whose value persists to `AI_SYSTEM_PROMPT_KEY`;
  `getAiSystemPrompt()` returns it, or the bundled default when blank. The
  Settings save handler stores nothing when the field is blank *or* equals
  the current default, so a later edit to the `.txt` still reaches users
  who never customized it. `summaryCache.systemPrompt` invalidates a
  cached summary when the prompt changes.
- **Fenced-reply guard.** Some models (Mistral) wrap the whole reply in
  ```` ```markdown … ``` ```` despite the system prompt telling them not
  to. `stripOuterCodeFence()` unwraps a response that is *entirely* one
  fenced block; one that merely contains a fenced block partway through
  is left alone.
- **Errors are made concise Rust-side.** `concise_http_error()` pulls a
  human line out of the OpenAI (`{"error":{"message"}}`) / Ollama
  (`{"error":"…"}`) / `{"message"|"detail"}` error shapes, truncates to
  300 chars, and otherwise falls back to a terse status sentence — the
  raw JSON body never reaches the toast. `send()` failures are mapped to
  connect / timeout / unreachable messages naming the endpoint.
- **The HTTP call is Rust-side on purpose** — the webview never touches
  the endpoint, so there's no CORS to satisfy and the API key never
  enters the renderer. Same reasoning as `open_external` preferring
  `rundll32` over a plugin: one small `reqwest` command beats wiring up
  `@tauri-apps/plugin-http`'s capability/scope system. `reqwest` uses
  `rustls-tls` (no system OpenSSL needed for a Windows build).
- **Config lives in Settings** (`#aiSummaryRow`): endpoint, model,
  optional API key — three `localStorage` keys
  (`AI_ENDPOINT_KEY`/`AI_MODEL_KEY`/`AI_API_KEY_KEY`). Endpoint/model
  getters fall back to `AI_ENDPOINT_DEFAULT`
  (`http://localhost:11434/v1`) / `AI_MODEL_DEFAULT` (`llama3.2`) when
  blank, so it works against a local Ollama with zero setup and nothing
  leaves the machine unless the user repoints it. Any OpenAI-compatible
  provider (LM Studio, OpenRouter, OpenAI) works by changing those
  fields.
- **Provider preset dropdown** (`#aiProviderPresetSelect`) sits above the
  endpoint field — a convenience over the two text fields, nothing about
  the choice is persisted on its own. `AI_PROVIDER_PRESETS` (main.js) maps
  an id (`ollama`/`lmstudio`/`openai`/`openrouter`/`groq`) to an
  `{ endpoint, model }`; `aiPresetIdForEndpoint()` matches the current
  endpoint back to one (trailing-slash/case tolerant) or `"custom"` — this
  drives which option shows selected, re-synced on dialog open and on
  every keystroke in the endpoint field. Picking a preset overwrites the
  endpoint field and swaps the model field to that preset's own model.
- **Model is remembered per preset** (`AI_MODEL_BY_PRESET_KEY`, a
  `{ presetId: modelName }` object, `"custom"` included) so switching
  providers never leaves an incompatible model in the field (an Ollama tag
  against an OpenAI endpoint, say). The preset `change` handler saves the
  outgoing preset's model, then loads `aiModelForPreset(nextId)` (its
  remembered pairing, else the built-in default). Written on Settings save
  and on a model change made from the summary dialog too; `AI_MODEL_KEY`
  stays the single "current model" the summary request actually reads.

### Quick comments (right-click / Q)
A frequency-ranked list of short review phrases ("not clear", "make it
brief", …) the user reuses across documents. Right-clicking anywhere on a
page — or pressing **Q** — opens a small menu of them, most-used first; a
pick drops that phrase onto the document as a pdf.js comment with **no
dialog**. All in `main.js`'s "Quick comments" section.
- **Storage** — `localStorage["pdfAnnotator.quickComments"]`, an array of
  `{ text, count, lastUsedAt }` sorted `count desc, lastUsedAt desc`. Menu
  shows the top `MAX_QUICK_COMMENT_MENU_ITEMS` (12) phrase texts only —
  `count` drives the sort but is never shown there (it does show, as `×N`,
  in the Settings list). **Never seeded.**
  Entries appear three ways: typing one into the menu's own input, the
  Settings tab's "Add a phrase" field (`#quickCommentAddInput` /
  `addQuickCommentPhrase()` — a plain add that no-ops on a duplicate,
  never bumps a count, unlike `recordQuickComment()`), and
  `harvestRepeatedComments()` — called from `exportComments()` and
  `runSummary()` — which folds in any comment that appears **≥ 2 times**
  within that one document (length is not a filter). `recordQuickComment()`
  does the case-insensitive-trimmed dedupe/increment. Settings has a
  management list (`#quickCommentsManageList`) with per-entry Remove; edits
  there (add and remove both) apply immediately, not on Save.
- **The context-menu override** — a capture-phase `contextmenu` listener on
  `frame.contentDocument` (same technique as `blockInternalFileOpen` /
  `attachKeyboardShortcuts`), in `attachQuickCommentMenu()`, wired from
  `initializeViewer()`. Only fires over `.page` (right-clicking the gutter
  or toolbar leaves the native menu alone) and only with a document open.
  The menu itself is a **parent-document** overlay (`#quickCommentMenu` in
  `index.html`), not injected into the iframe — so it uses the app's theme
  tokens directly and isn't subject to viewer.html's inline-style CSP.
  Positions come from the iframe document's client coords (both entry
  points originate there); the frame's own offset is added when placing.
  Because the menu's input is in the parent document, opening the menu
  pulls keyboard focus out of the iframe — so `closeQuickCommentMenu()`
  calls `frame.contentWindow.focus()` on every dismissal path (Escape,
  click-away, pick, scroll) or the iframe-scoped shortcuts and pdf.js's own
  key handling stay dead until the iframe is clicked. Native `<dialog>`s
  (Settings, etc.) have the same problem via a different, simpler fix —
  see "Closing any native `<dialog>` drops focus..." under pdf.js
  embedding specifics below.
- **pdf.js 6.x has no standalone/sticky-note comment** — every comment
  rides a host editor. So all three placement cases end with
  `editor.comment = text` (the exact op `web/viewer.mjs`
  `CommentDialog#save` performs) on a freshly created Highlight editor:
  1. **text selected** → `uiManager.commentSelection("context_menu")` over
     it, with `uiManager.editComment` transiently wrapped so our wrapper
     catches the editor pdf.js creates and sets its text directly — the
     dialog never opens. A 3s timeout restores the original method if
     `highlightSelection()` bails (selection not in a text layer, etc.).
  2. **no selection, pointer over page text** → synthesize a
     one-character `Range` at the pointer (`caretRangeFromPoint`, widened),
     install it as the iframe selection, then fall through to (1).
  3. **pointer over blank page area** → `uiManager.getLayer(pageIndex)` +
     `layer.createAndAddNewEditor({ boxes: [{x,y,width:0.012,height:0.016}],
     anchorNode: null, … })` after `await uiManager.updateMode(HIGHLIGHT)`.
     `boxes` are normalised `[0,1]` to the page rect (matching pdf.mjs's
     own `#getSelectionBoxes`). `#createOutlines()` only reads `boxes`;
     `anchorNode` is only ever touched in a null-guarded `#setCaret`, so
     `null` is safe. This is the one case that pokes layer internals.
  `commentSelection`/`highlightSelection`/`createAndAddNewEditor`/
  `getLayer`/`updateMode`/`getMode` are all plain public methods (same tier
  as the `commentSelection()` the C shortcut already uses). If a pdf.js
  upgrade breaks this, re-verify those against the new bundled source.
- **No empty-comment cleanup path is needed** — the phrase is always
  chosen *before* the annotation is created (menu picks are non-empty; the
  input's Enter handler checks), so there's no create-then-cancel window
  that could leave an orphan highlight. The `editor.remove()` calls in the
  `catch` blocks only fire if `editor.comment =` itself throws.
- **A quick comment leaves pdf.js in HIGHLIGHT mode** (case 1/2 via
  `commentSelection`'s own `switchToMode`; case 3 via our explicit
  `updateMode(HIGHLIGHT)`), same as pdf.js's own floating comment button
  and this app's `C` shortcut. Do **not** switch back to NONE afterwards:
  `AnnotationEditorUIManager.keydown` only routes Ctrl+Z/Ctrl+Y to
  undo/redo while `#mode !== NONE`, so an eager restore silently kills undo
  for the annotation just created.

### Status/feedback: three channels, not a status bar
There used to be a simple status bar; it's gone. `setStatus(text, kind,
{toast})` in main.js now drives three things at once:
1. **Window title** — reflects the open PDF's own metadata title (XMP
   `dc:title`, falling back to Info `Title`, falling back to filename;
   `applyWindowTitleBar`/`currentTitleBase`) via Tauri's window API, not
   pdf.js's own `setTitle()` (see gotchas). Also carries the full
   absolute path as a native tooltip on hover (`title` attribute on
   `#titlebarTitle`). No longer carries a `● ` dirty-prefix — removed
   once the titlebar's own Activity Log button started carrying a
   color-coded status dot, making a second, redundant dirty indicator
   unnecessary.
2. **Activity log** — every single status update, no exceptions, gets a
   timestamped entry (`appendLogEntry`, capped at 200), viewable via the
   titlebar's Activity Log button (color-coded dot:
   idle/dirty/saving/error/saved).
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
- Patch `addToAnnotationStorage()` and `removeEditor()`, both gated on
  `editor.annotationElementId` — needed to avoid a false-positive dirty
  flag when merely opening the read-only Comment sidebar, or any toolbar
  popup at all (see Known rough edges below).
- Listen for pdf.js's own `reporttelemetry` eventBus events — the only
  signal for comment edits/deletions, which don't touch
  `annotationStorage` at all.

Once *something* is actually dirty: 4s idle debounce / 20s hard ceiling →
`pdfDocument.saveDocument()` bakes annotations into fresh PDF bytes →
written to `<file>.autosave.tmp` → renamed over the original (so a crash
mid-write can't corrupt the file).

### Undo All flow
`revertToSessionStart()`, behind the toolbar's "Undo All" button (gated on
a confirmation `<dialog>` — it's destructive and writes to disk right
away). Deliberately does **not** walk pdf.js's undo stack
(`AnnotationEditorUIManager.undo()`/its `CommandManager`) — that only
covers edits made through `addCommands`, and even that path needed real
patching to autosave correctly at all (see Autosave flow above: recolor/
resize/move, comment edits/deletions, and whole-annotation removal each
have their own gaps). Instead:
- `openPath()` snapshots the file's pristine bytes into
  `sessionOriginalBytes` (a `.slice()` copy — `app.open()` may transfer
  the original buffer to pdf.js's worker, which would detach it) before
  ever handing them to pdf.js.
- Undo All reloads the document from that snapshot via the same
  `loadPdfIntoViewer()` path any other open uses — this is what makes it
  uniform across every kind of edit regardless of what pdf.js call path
  produced it, rather than needing its own patch per edit type the way
  autosave's dirty-tracking does.
- Then force-saves immediately (`saveNow({ force: true })`) rather than
  just marking dirty and letting the normal debounce handle it — if
  autosave had already written this session's annotations to disk before
  Undo All was clicked, leaving the revert unsaved would mean a crash
  right after clicking it silently leaves the old annotations in the
  file despite the UI showing them gone.

"Session" here means since *this file* was opened this time, not since
the app launched — closing and reopening the same file resets the
snapshot to whatever's on disk at that point.

The confirmation dialog also has an opt-in checkbox that goes further:
delete *every* remaining annotation after the revert above, regardless of
whether it came from an earlier session of this app or a different app
entirely (`stripAllAnnotations()`). This does NOT go through pdf.js's
editor/`AnnotationEditorUIManager` machinery at all — no editor instances,
no editing mode entered (which matters: entering edit mode only
materializes editors for *rendered* pages, so a "select all + delete"
approach would silently miss annotations on off-screen pages of a long
document). Instead it calls `page.getAnnotations()` for every page
(doesn't require the page to have ever rendered) and writes a deletion
marker straight into `annotationStorage` for each one, skipping Link/
Popup/Widget (links and form fields aren't "annotations" a reviewer
added, and Popup deletion is implicit via a markup annotation's
`popupRef`). The marker shape —
`{ id: <annotation's own ref-derived id>, deleted: true, pageIndex,
popupRef }` — mirrors pdf.js's own internal
`AnnotationEditor#serializeDeleted()`/`FakeEditor`, the exact mechanism it
already uses when a user deletes one pre-existing annotation through the
normal editor UI, found by reading the bundled `pdf.mjs`/`pdf.worker.mjs`
since none of this is public API. The one easy way to get this wrong: the
storage **key** matters, not just the value — `pdf.worker.mjs`'s
`getNewAnnotationsMap()` silently ignores any `annotationStorage` entry
whose key doesn't start with pdf.js's internal `"pdfjs_internal_editor_"`
prefix (hardcoded as `PDFJS_ANNOTATION_EDITOR_PREFIX` in main.js, since
it isn't exported on `globalThis.pdfjsLib`) — keying by the bare
annotation id instead drops the deletion with no error at all. If this
ever stops working after a pdf.js upgrade, re-verify both of these
against the new bundled source before assuming the approach itself is
wrong.

**Bit that actually bit us**: the deletion markers reach `saveDocument()`
and the file on disk is correct immediately — confirmed by closing and
reopening the file. But the *on-screen* pages don't update: since
`stripAllAnnotations()` mutates `annotationStorage` directly rather than
going through the editor UI, nothing tells the already-rendered
annotation layers to remove those DOM elements (a real, UI-driven
deletion carries its own DOM removal as part of that flow; a
storage-only mutation on an already-rendered page doesn't touch the DOM
at all). Fixed by reloading the viewer a second time from the bytes
`saveNow()` just wrote (`saveNow` now returns the saved bytes for exactly
this) — i.e. `revertToSessionStart()`'s strip-all branch does revert →
strip → save → **reload from what was just saved**, so the screen always
matches disk by the time the toast fires. The plain (non-strip) revert
doesn't need this: its `loadPdfIntoViewer()` call *is* a full document
reload already, so it renders correctly the first time.

### Rust side
Intentionally thin — just wires up the `dialog`, `fs`, and (for the
titlebar) `core:window:allow-set-title` capabilities, plus a few small
glue commands, none with real logic: `get_os_username` /
`get_launch_path` (see below), and — all Windows-only, `#[cfg(windows)]`
with no-op `#[cfg(not(windows))]` stubs so `generate_handler!` stays
valid off-Windows — `long_paths_enabled` / `enable_long_paths` /
`open_external` (see "Windows long paths" below) — plus two
cross-platform commands, `summarize_comments` / `cancel_summarize` (the
only ones that pull a non-trivial dependency, `reqwest`): a bare
OpenAI-compatible `/chat/completions` POST for the AI comment summary
feature, plus an abort path for it, backed by a small `SummaryTask`
managed-state slot holding the in-flight task handle (see "AI comment
summary" above). All real logic is in the frontend.

The one bit of Rust that isn't a command is a `setup` hook. It does two
things: `disable_browser_accelerator_keys()` (Windows-only): `with_webview`
→ `ICoreWebView2Settings3::SetAreBrowserAcceleratorKeysEnabled(false)` to
kill F5 / Ctrl+R reload and the other browser accelerators — see "Two-screen
UI" above (pulls `webview2-com` + `windows-core` as direct deps, both
already in the tree via wry and pinned to the versions it resolves) — and,
under `#[cfg(desktop)]`, registers the updater + process plugins at runtime
via `app.handle().plugin(...)` (see "Auto-update" below). Registering them
in the setup hook rather than the builder chain is the standard Tauri
pattern for desktop-only plugins.

### Auto-update
`tauri-plugin-updater` + `tauri-plugin-process`, driven entirely from the
frontend ("Auto-update (Settings + startup)" section in `main.js`). No Rust
commands of our own — the plugins expose everything.
- **Manifest** — `plugins.updater` in `tauri.conf.json` points `endpoints`
  at `https://github.com/asifm91/daag/releases/latest/download/latest.json`
  (GitHub's `/releases/latest/` redirect always resolves to the newest
  *published, non-draft, non-prerelease* release — so a manual
  `workflow_dispatch` run, which produces a **draft**, never feeds the
  updater until it's published). `pubkey` is the public half of the
  minisign keypair from `tauri signer generate`; the private half is the
  `TAURI_SIGNING_PRIVATE_KEY` GitHub Actions secret. There is no password
  secret — the key has an empty passphrase and GitHub rejects empty
  secret values, so `release.yml` hard-codes
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ""` (it must be *set* to something
  or the bundler drops to an interactive prompt that hangs CI). `bundle.
  createUpdaterArtifacts: true` makes the bundler emit and sign the
  updater artifacts; `tauri-action` with `includeUpdaterJson: true`
  (its default when signing keys are set — pinned in the workflow anyway)
  generates `latest.json` and uploads it to the release. `windows.
  installMode: "passive"` — the NSIS updater shows a bare progress UI, no
  prompts.
- **Per-platform update artifact**: NSIS `-setup.exe` on Windows, the
  `.AppImage` on Linux (the `.deb` is *not* an updater target — a fresh
  `.deb` install can't self-update, that's expected), the
  `Daag_universal.app.tar.gz` on macOS. That last one is why the workflow
  no longer deletes the macOS `.app.tar.gz` + `.sig` (it used to, back
  when "this app has no updater" held).
- **Keypair regen**: `bunx tauri signer generate --ci -p "" -w <path>`.
  Losing the private key means published updates stop verifying for
  everyone already on an older build — they'd have to reinstall from the
  `.dmg`/`.exe`/`.AppImage` by hand. The working copy lives in the
  gitignored `.secrets/` dir (see `UPDATER.md`).
- **Frontend flow** (`checkForUpdate({ silent })` in `main.js`): a quiet
  pass `UPDATE_STARTUP_CHECK_DELAY_MS` after launch that only surfaces UI
  if there's genuinely an update — a failed check (offline, no release
  yet) goes to the activity log only, never a toast. On that silent pass
  the modal `#updateDialog` opens **only if no PDF is open** (`currentPath`
  is null, i.e. still on the landing screen); if a document was opened
  while the check was in flight, the user gets just the toast plus the
  Settings-gear notification dot (`reflectPendingUpdateBadge()`), so the
  check can't interrupt an editing session. Settings' "Check for updates…"
  button (`#updateRow`) runs the same check non-silently, always reports
  back ("Up to date — v…" / the error), and always opens the dialog when
  there's an update. `#updateDialog` shows the version + release notes and
  a progress bar; the actual `downloadAndInstall()` + `relaunch()` only
  ever runs on an explicit Install click — the app never updates itself
  unattended. `updateInstalling` blocks the dialog's close paths
  (including Escape, via a `cancel` handler) while a download is in
  flight. `getVersion()` from `@tauri-apps/api/app` fills the current
  version (shown in the Settings Updates row even when an update is
  pending — "দাগ v1.2.0 — v1.3.0 available"); it throws outside a Tauri
  context (plain `vite` dev), handled.

### Changelog & release notes
`CHANGELOG.md` (repo root, Keep a Changelog format) is the **single
source** for both the GitHub release body and the website's changelog
page — don't hand-edit either output.
- **Format** — one `## [x.y.z] — YYYY-MM-DD` heading per release, `###
  Added`/`### Changed` groups, `- ` list items (Markdown `**bold**` /
  `` `code` `` / `[links](url)` plus inline HTML like `<kbd>` are
  rendered). A `## [Unreleased]` section stays at the top (each release
  bump renames it and adds a fresh empty one); it's kept in the file but
  left off the website. Reference-style `[x.y.z]: <url>` definitions at
  the bottom become the "see release →" links.
- **Website** — `scripts/build-changelog.mjs` (run via `bun run
  changelog`) renders `CHANGELOG.md` into `docs/changelog.html` using the
  same page chrome as the other `docs/` pages. Dependency-free parser (the
  format is small and controlled). `--check` mode exits non-zero if the
  committed HTML is stale — the `verify` job runs it, so a release fails if
  you edited `CHANGELOG.md` without rerunning the script. **The generated
  `docs/changelog.html` is committed** (GitHub Pages serves `docs/` as-is,
  no build step).
- **Release body** — `release.yml`'s `finalize` job (`needs: build`, runs
  once after every platform) `awk`-slices the current version's section
  out of `CHANGELOG.md`, appends `.github/release-body-footer.md` (the
  evergreen download list + macOS Gatekeeper note), and sets it with `gh
  release edit`. `tauri-action`'s inline `releaseBody` is just a
  `"Publishing release notes…"` placeholder — each matrix job would
  otherwise race to set it. **`finalize` also patches `latest.json`** —
  `tauri-action` bakes that file's `notes` field (what the in-app update
  dialog shows) from the same placeholder `releaseBody`, so `finalize`
  downloads it, `jq`s `.notes` to the changelog section (no footer — the
  download links mean nothing to an already-running app), and re-uploads
  with `--clobber`; skip this and the updater keeps showing "Publishing
  release notes…". The `verify` job fails early if `CHANGELOG.md` has no
  section matching `tauri.conf.json`'s version, same spirit as the
  tag/version check.
- **Every release is created as a draft, published only once `finalize`
  finishes.** Used to be that a pushed tag's release published immediately
  (`releaseDraft` only true for `workflow_dispatch`) — but the release is
  created by the *first* matrix job to reach that step, well before the
  other platforms finish (or fail), and before `finalize` gets a turn to
  patch the notes above. That left `/releases/latest/` — and thus the
  in-app updater — able to see a real, live release missing platform
  assets and/or still showing the placeholder body for the entire build
  window, or indefinitely if a platform build failed (which is exactly
  what happened releasing v1.5.1: Linux and macOS hit transient CI
  failures, so `finalize` — needs: build, i.e. the whole matrix — never
  ran, and the published release sat there Windows-only with placeholder
  notes). Fixed by making `releaseDraft: true` unconditional and adding a
  `finalize` step, gated on `github.event_name == 'push'`, that does
  `gh release edit v$version --draft=false` as the very last thing —
  after the notes are patched. A `workflow_dispatch` run still needs a
  human to publish it by hand (see UPDATER.md).

### Windows long paths (> MAX_PATH)
Dragging a PDF whose absolute path exceeds ~259 chars onto the window is
*silently refused by Explorer* — the shell rejects the drop before any
event reaches wry, so `onDragDropEvent` never fires (no hover overlay, no
open). The file picker has no such limit; it just returns such paths with
a `\\?\` prefix, which `std::fs` (and thus every `@tauri-apps/plugin-fs`
call) handles fine — which is why manual open always worked.

Fixing drag-drop needs the process to be **long-path aware**, which is
two independent switches, *both* required (Microsoft's rule):
1. **App manifest** — `src-tauri/build.rs` supplies a custom Windows
   manifest (`WindowsAttributes::new().app_manifest(...)` →
   `try_build`) with `<ws2:longPathAware>true</ws2:longPathAware>`.
   `app_manifest()` *replaces* Tauri's default, so the Common-Controls
   v6 `<dependency>` (required by the native file dialogs) is repeated
   verbatim in that string — copied from
   `tauri-build`'s own `windows-app-manifest.xml`. See Tooling/build
   note below.
2. **Machine registry** —
   `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled`
   must be `1`. Reading it needs no elevation (`long_paths_enabled` →
   `reg query`); writing it does (`enable_long_paths` → PowerShell
   `Start-Process -Verb RunAs` on `reg add`, which raises the UAC
   prompt). The NSIS installer runs `installMode: currentUser` so it
   *can't* set this — instead the Settings dialog shows the current
   state and an "Enable long path support…" button
   (`refreshLongPathStatus`/`enableLongPathButton` in `main.js`), with a
   link ("Learn how to enable it manually") — opened via `open_external`
   (`rundll32 url.dll,…`, no `tauri-plugin-opener` dependency) — to
   Microsoft's MAX_PATH page. After a successful enable,
   `localStorage["pdfAnnotator.longPathRestartPending"]` gates a
   "restart to apply" note; it's cleared on the next app start (a fresh
   process picks the setting up). The whole Settings row (`#longPathRow`,
   `hidden` by default) only un-hides when `long_paths_enabled` returns a
   real bool — on a non-Windows build the `#[cfg(not(windows))]` stub
   returns `None`/`null` and the row stays hidden.

Once both are on, drag-drop *and* the file picker return long paths with
**no** `\\?\` prefix. Pre-existing `\\?\`-prefixed recent-files entries
still open fine (std handles them) — they just won't dedupe against a
fresh clean-form open of the same file; left as-is since the list is
capped at 8 and self-heals.

### Multiple windows & file-open entry points
Deliberately **not** a single-instance app, and **not** registered as
the default PDF viewer — both are intentional choices, not gaps. The
actual workflow this app is built around (reviewing homework/exam PDFs
one at a time via Previous/Next, occasionally interrupting to annotate a
different file) is better served by each file living in its own window
than by a single-window/single-instance model: interrupting to open
another file shouldn't lose your place in the one you were already
reviewing.
- `tauri.conf.json`'s `bundle.fileAssociations` registers `.pdf` for
  "Open with" (Explorer's context menu) without claiming the
  default-viewer role.
- `src-tauri/src/main.rs`'s `get_launch_path` command reads `argv[1]` —
  covers "Open with", a plain `daag.exe file.pdf` shell
  invocation, and (once installed) double-clicking a `.pdf` via the file
  association, all three of which pass the path as the first CLI arg on
  Windows. `main.js` calls it once at startup
  (`invoke("get_launch_path").then(...)`) and routes it straight through
  `openPath()` — same session-snapshot/autosave wiring as every other
  entry point, landing directly in the viewer rather than the landing
  screen.
- A non-PDF path passed this way surfaces as an error on the landing
  screen rather than failing silently or crashing — verified.
- `bundle.windows.nsis.installMode: "currentUser"` avoids an elevation
  prompt for what's fundamentally a personal-workflow tool.

## Known rough edges / things that have already bitten us

### Tooling / build
- **`vite.config.js` has `appType: "mpa"` for a reason** — don't remove
  it. Without it, if the iframe's `src` ever 404s, Vite's SPA fallback
  serves `index.html` instead of a 404, which recursively reloads the
  whole app inside its own iframe infinitely.
- `src-tauri/Cargo.toml` should **not** have a `[lib]` section — an
  earlier version did and broke `cargo metadata` (no `src/lib.rs` to back
  it). Only add one back if this evolves into a proper lib+bin split.
- **`src-tauri/build.rs` supplies a custom Windows app manifest** (for
  `longPathAware` — see "Windows long paths" above) via
  `WindowsAttributes::new().app_manifest(<xml string>)` +
  `try_build(Attributes::new().windows_attributes(...))` instead of the
  bare `tauri_build::build()`. `app_manifest()` **replaces** Tauri's
  default manifest wholesale, so that XML string must keep the
  Common-Controls v6 `<dependency>` block (the native file dialogs need
  it) — it's copied verbatim from `tauri-build`'s own bundled
  `windows-app-manifest.xml`. If a `tauri-build` upgrade changes that
  default, re-sync the copy.
- `src-tauri/icons/icon.png` **and** `icon.ico` both need to exist for
  `cargo build`/`tauri::generate_context!()` to compile on Windows
  specifically (`tauri-build` needs `.ico` to generate the Windows
  Resource file). Regenerate the whole icon set with
  `bunx tauri icon <source.png>` any time the source icon changes.
- On this Windows/Git-Bash setup, `npx`/`bunx` have sometimes failed to
  resolve the local Tauri CLI (`could not determine executable to run`)
  even though it's present in `node_modules`. Fallback: call the binary
  directly — `./node_modules/.bin/tauri.exe icon ...`.
- pdf.js's `web/` folder must live at `src/public/pdfjs/web/...` — inside
  Vite's `publicDir` (`src/public`), not merely inside `root: "src"`. The
  iframe points at it via a runtime string (`frame.src =
  "pdfjs/web/viewer.html"`), not a static import, so `vite build` can't
  trace it into the bundle — anything outside `publicDir` gets silently
  dropped from `dist/`. The dev server masks this completely: it serves
  the whole `src/` tree directly, so a misplaced `src/pdfjs` (one level up
  from `public/`) works perfectly under `tauri dev` and only breaks in a
  packaged build, where the iframe 404s, `waitForViewer()` hangs with no
  error, and the app just sits on the landing screen after Open. If pdf.js
  ever needs re-vendoring from a fresh release zip, unzip it into
  `src/public/pdfjs/`, not `src/pdfjs/`.
- **A packaged build can silently run stale code if `CARGO_TARGET_DIR` is
  set** (as it is on this machine: `D:\cargo-target`) — the real output
  lands there, not `src-tauri/target/release/`. Launching the exe from the
  in-tree `target/release` path runs whatever was last built before that
  env var took effect, with no warning that it's out of date. Always
  check `bun tauri build`'s own "Built application at: ..." output line
  for the actual path rather than assuming the in-tree default.
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
  blocked from ever reaching pdf.js's own handling
  (`blockInternalFileOpen` — Tools-menu button hidden via CSS,
  drag-and-drop and Ctrl+O intercepted via a capture-phase listener on
  the iframe's document, which fires before pdf.js's own bubble-phase
  listeners see the event regardless of registration order). Ctrl+O is
  then redirected to `pickAndOpenPdf()` (the same safe picker as the
  toolbar Open button) rather than just erroring, and drag-and-drop is
  made to actually work too — see the next bullet.
- **Real drag-and-drop needs Tauri's native event, not the DOM one.**
  Once dropping a PDF was blocked at the DOM level above, it did nothing
  at all — which turned out to be because it was never reaching the DOM
  in the first place: with `dragDropEnabled` at its Tauri default of
  `true` (unset in `tauri.conf.json`), the native window layer intercepts
  an OS file drop before the WebView's own HTML5 `drop` event ever fires,
  so `blockInternalFileOpen`'s DOM listener was dead code for this path
  all along (still there as defense-in-depth; genuinely live for Ctrl+O).
  The actual fix (`attachDragDropOpen`) listens for Tauri's own
  `getCurrentWebview().onDragDropEvent()` instead — which, unlike the
  browser File API, *does* carry the real absolute filesystem path
  (`event.payload.paths`), the one thing missing to make drag-and-drop
  safe at all — and routes it through `openPath()`, same as every other
  entry point. Guards against a still-open upstream bug where this event
  can fire twice for one drop (tauri-apps/tauri#14134) with a plain
  synchronous in-flight flag. Note this event still never fires for a
  file whose path is longer than ~259 chars unless the exe is long-path
  aware — see "Windows long paths" above.
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
- **Opening/closing *any* toolbar tool popup churns every pre-existing
  annotation through storage, not just the Comment sidebar.**
  Second instance of the false-positive above, found later: toggling any
  editor-mode toolbar button (Highlight, Text, Draw, not just Comment)
  makes `AnnotationEditorUIManager.removeEditor()` (pdf.mjs) unconditionally
  call `annotationStorage.remove(editor.id)` as part of its internal
  detach/reattach housekeeping — once per pre-existing annotation in the
  file, all in the same synchronous burst. Confirmed via a temporary
  diagnostic build: one popup open/close on a 29-annotation file produced
  29 back-to-back "Unsaved changes" log entries, none from
  `setValue()`/`onSetModified` (pdf.js only fires that once per dirty
  session — it can't produce a burst that wide on its own; the tell that
  it must be `storage.remove()` instead, which we call `markDirty()` for
  unconditionally on every invocation). Fixed the same way as
  `addToAnnotationStorage`: gate suppression on `editor.annotationElementId`
  around the `removeEditor()` call specifically. Safe to suppress — a
  *genuine* deletion of a pre-existing annotation goes through
  `AnnotationEditorUIManager.delete()` → `addCommands({mustExec: true})`
  first, which the `addCommands` patch already marks dirty for, so the
  `removeEditor()`-triggered `storage.remove()` is always redundant with
  an already-correct signal for that case, never the only one. If a
  *third* instance of this pattern turns up, suspect any pdf.js internal
  method that iterates `#allEditors`/`#allLayers` first.
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
- **Comment popups/markers have their own `color-scheme`, separate from
  ours, and it doesn't fully solve.** viewer.css scopes `.commentPopup` and
  `.annotationCommentButton` with their own `color-scheme:light dark`,
  which makes every `light-dark()` value inside them (text color, marker
  icon color) resolve against the *OS's* actual dark-mode setting, ignoring
  whatever single value `applyPdfjsColorScheme()` forces on `<html>` for
  our light/dark/default toggle — confirmed with an isolated repro. Fixing
  it needed two layers: (1) `custom-viewer.css` overrides both rules to
  `color-scheme:var(--app-color-scheme,inherit) !important` — plain
  `inherit` alone isn't enough, because both elements render *inside*
  `.annotationLayer`/`.annotationEditorLayer`, which viewer.css *also*
  forces to `color-scheme:only light`, and `inherit` grabs that nearer
  ancestor instead of `<html>`; a custom property cascades independently of
  `color-scheme` itself and skips right past it. (2) `applyPdfjsColorScheme()`
  must actually run once the iframe has *really* finished loading, not just
  once at module init right after `frame.src` is assigned (still the
  placeholder document at that point, so that call silently no-ops) — see
  `initializeViewer()`'s call to it.
  A popup's *background* is a separate bug on top of that: it's tinted
  once via `CSSConstants.commentForegroundColor`, a `shadow()`-memoized
  getter that's never recomputed after first read — see
  `refreshPdfjsCommentForegroundColorCache()`'s comment in `main.js` for the
  fix. **Known remaining gap**: the small marker button drawn directly on a
  highlight has the exact same memoized-background problem, but its color
  is applied by a *different*, more private code path (`PopupElement`'s
  `#updateColor()`, in the plain non-editor annotation-layer rendering —
  not `AnnotationEditorUIManager`, whose `getEditors()` was confirmed via a
  live console check to find nothing for these) with no public registry to
  reach it from outside. Left unfixed: each marker keeps whatever
  background matched the theme active the first time its page rendered
  this session, permanently, even across later theme switches. Reopening
  the document repaints every marker fresh and picks up the current theme.
  If ever revisited, start by finding how `PopupElement` instances (or
  their owning `HighlightAnnotationElement`) are reachable from outside —
  they weren't obviously exposed anywhere during this investigation.
- **Closing any native `<dialog>` drops focus out of the iframe, same
  as the quick-comment menu above.** `showModal()` parks focus inside the
  dialog, which lives in the *parent* document; closing it (close button,
  backdrop click, or Escape — the last bypasses every click handler and
  is handled by the browser itself) drops focus onto the parent `<body>`,
  so `attachKeyboardShortcuts` (bound on `frame.contentDocument`) and
  pdf.js's own key handling go deaf until something inside the iframe is
  clicked again. Reported as "Settings steals keyboard shortcuts until I
  click the document." Unlike the quick-comment menu (an overlay `<div>`
  with several bespoke dismissal paths to each cover individually), every
  `<dialog>` fires a native `"close"` event no matter how it closed, so
  this only needed one listener per dialog
  (`restoreViewerFocusAfterDialogClose`, wired to all seven —
  Settings, Activity Log, Update, Summary, Undo All, Overwrite-or-Copy,
  Continue-or-Start-Over — right after their `const …El = document.
  getElementById(...)` declarations in `main.js`) rather than one per
  dismissal path. Guarded on `currentPath` so it's a no-op on the landing
  screen, where the iframe isn't the thing that should have focus. Any
  *new* dialog added later needs the same listener, or it will quietly
  reproduce this bug.
- The `PDFViewerApplication.open()` argument shape and any other
  Tauri v2 capability/permission identifier strings were originally
  written without being able to run/verify them — if either throws or
  gets permission-denied, check the exact version installed
  (`bunx tauri info`, and whatever pdf.js version is in
  `src/pdfjs/build/pdf.mjs`) against current docs.

## In progress: cross-device annotation identity (not on master)
Groundwork for a possible future feature: async collaborative annotation
— two reviewers each annotate different sections of the same file across
separate sessions, synced via a shared Drive/OneDrive/Dropbox folder, no
dedicated server, following draw.io's "dumb file-sync transport + local
merge" model rather than a Google-Docs-style live server. Not built —
this section exists purely so a later session doesn't repeat several
days of already-settled investigation.

**Why this needs annotation identity at all**: a future 3-way merge
(base/local/remote) needs to know which annotation in one copy of a file
is "the same" annotation in another independently-saved copy of it.
PDF object numbers can't serve as that identity — two reviewers who each
add annotations to their own copy of the same base file can end up with
new objects at the *same* object number purely by coincidence, since
numbering just increments locally from the base on each side. The PDF
spec's actual answer is the annotation dictionary's `/NM` (unique name)
key — stable and content-independent. pdf.js never writes one (confirmed:
zero matches for `"NM"` anywhere in the bundled `pdf.mjs`/`pdf.worker.mjs`),
so the first, foundational piece of this work is backfilling `/NM` onto
every markup annotation on save, via a Rust command
(`ensure_annotation_ids`) run on the temp file right before rename, same
timing as every other autosave step. Best-effort by design — a failure
here must never block the actual save, so it's wrapped to log-and-skip
rather than throw.

**Three PDF libraries tried, in that order, all against real annotated
PDFs from this app — not synthetic edge cases**:
- **lopdf** — can inject `/NM` fine at the raw-dict level (that part was
  never the problem), but `Document::save()` leaves a stale `/Prev`
  pointer on any document that already has pre-existing incremental-
  revision history before lopdf ever touches it (i.e. most real PDFs,
  including ones lopdf itself already wrote once) — the newly-written
  xref stream ends up pointing `/Prev` at a byte offset that no longer
  holds valid xref/object data in the file actually written.
  `Document::load()` then fails on the very next load with
  `Parse(InvalidTrailer)`, and lopdf's own reconstruction fallback can't
  rescue it either (`find_latest_trailer` only recognizes a literal
  `trailer` keyword, never present in a pure xref-stream file). Confirmed
  independent of pdf.js entirely — reproduces on a pure lopdf
  load→mutate→save round trip with no pdf.js involvement. Root-caused via
  a locally instrumented lopdf build; not yet confirmed filed upstream.
- **`pdf` (pdf-rs)** — fails to even *load* some of the same real-world
  files, a different internal error each time (a `ParseIntError` inside
  its own cross-reference-subsection parser).
- **pdf_oxide** — reads every real-world file thrown at it, including
  both of the above's casualties, and has a genuine incremental
  (append-only) save mode. But its typed `WriteAnnotation` builders have
  no field for a non-standard key like `/NM` — writing needed a small
  vendored patch exposing `DocumentEditor::set_object`, an object-override
  mechanism the crate already uses internally for form-field edits (see
  `vendor/pdf_oxide-0.3.78`, "DAAG PATCH" comments, on the branch below).
  Verified end-to-end (backfill → reload → confirm `/NM` present →
  backfill again → confirm no reassignment) on multiple real annotated
  PDFs.

**Superseded pdf_oxide attempt**: a working pdf_oxide-based implementation
(Rust-side, vendored patch) lives on the unmerged branch
`annotation-nm-backfill-pdf-oxide` (one commit, off v1.6.0) — not on
master, not shipped, not pushed. Kept around for reference but not the
preferred path once pdf-lib panned out (below): pdf-lib needs no vendored
patch and matches this project's own stated architecture ("all real logic
is in the frontend").

**pdf-lib tried next, in the frontend, and it works**: both open questions
from the earlier investigation were tested against the same real-world
fixtures that broke lopdf/pdf-rs
(`fresh_pdfjs_only.pdf`/`lopdf_own_first_revision.pdf`/
`repro_invalid_trailer.pdf`, gitignored — see below to regenerate) —
- `PDFDocument.save()` does a **full flatten to one fresh xref stream on
  every call**, not an incremental append — confirmed by grepping the
  output for `/Prev` (zero occurrences, vs. up to 51 in the originals,
  which do carry real incremental history) and by checking that
  `startxref` always lands exactly on a valid `N 0 obj … /Size …` xref
  stream. This sidesteps lopdf's whole bug class structurally: there's no
  `/Prev` chain for a rewrite to leave stale.
- It **loads every fixture that defeated pdf-rs** and round-trips 3
  generations of load → backfill → `save()` → reload with no corruption,
  stable annotation counts (327/325/327 before and after), and **no `/NM`
  ever reassigned** on a second or third pass over an already-backfilled
  file (idempotency holds).
- Performance on the worst fixture (46 pages, 327 annotations, 314KB):
  ~125ms load + ~1ms scan + ~85ms save ≈ 210ms total. Runs once per
  autosave debounce tick (several seconds apart), so this is acceptable,
  but it's a synchronous full-document parse/rewrite on the JS main
  thread — worth re-measuring against a much larger real document if one
  ever surfaces, since it'll scale with total object count, not just
  annotation count.

**Current state**: implemented directly in `src/main.js` —
`ensureAnnotationIds()` (mirrors `ensure_annotation_ids`'s exact
semantics: skip Link/Popup/Widget, skip annotations that already carry
`/NM`, else set `/NM` to `crypto.randomUUID()`) is called (via
`bakeCurrentDocumentBytes()`) on the bytes `pdfDocument.saveDocument()`
produces, before they're written to `tmpPath` — same best-effort/
log-and-skip contract as the pdf_oxide version. `pdf-lib` is now a normal
`package.json` dependency.

**Was silently broken from the start by a cross-realm `instanceof`
mismatch — found only once DevTools happened to be open during an
unrelated lock-detection repro.** `pdfDocument.saveDocument()` executes
inside the pdf.js iframe and hands back a `Uint8Array` built from *that
window's* `Uint8Array` constructor. `PDFDocument.load()` in pdf-lib (the
parent document's realm) type-checks its input with `instanceof
Uint8Array`, which fails across that boundary even though the bytes
are perfectly valid — every call threw pdf-lib's own generic `TypeError`
("... but was actually of type `NaN`", pdf-lib's validator's label for
"didn't match any known type"), caught by `ensureAnnotationIds`'s
best-effort try/catch and only `console.error`'d, never toasted. So every
save since this was written quietly fell back to "saving without it," and
the earlier "no errors" smoke test above only checked that saves
succeeded and files reopened cleanly — it never opened DevTools console,
where the failure was logging on every single save. Fixed by rewrapping
`await app.pdfDocument.saveDocument()` in a same-realm `new
Uint8Array(...)` inside `bakeCurrentDocumentBytes()` before it goes
anywhere else in the parent document. **Re-verify this is actually fixed
with a live save + DevTools console check** — not yet done since the fix
landed.

Still **not yet committed** (sitting as uncommitted changes on top of the
pdf_oxide-investigation commit) — open decision is whether this
supersedes the pdf_oxide branch outright (no vendored Rust patch, matches
the "logic lives in the frontend" architecture) or the two approaches are
kept side by side a while longer before picking one.

The real-world PDF fixtures used to test all of the libraries above
aren't in the repo (gitignored — `src-tauri/test-fixtures/`, since some
contained real student data) — regenerate equivalents by autosaving a
couple of comments onto any PDF, closing, reopening, and saving again
(the second save is what actually exercises the failure modes above).

**External change detection (step 1 of the merge, implemented)**: before
the actual merge can exist, the app needs to notice when a second
device/session has saved its own edits into the same synced file since
this session last touched it. Polling, not `@tauri-apps/plugin-fs`'s own
`watch`/`watchImmediate` (a native filesystem watcher) — cloud-sync
clients (OneDrive Files-on-Demand, Dropbox smart sync, Google Drive's
virtual placeholders) are known to be unreliable with native watch APIs
specifically, which is exactly the scenario this targets, not an edge
case for it. `checkForExternalChange()` in `src/main.js` polls every
`EXTERNAL_CHANGE_POLL_MS` (30s — a detection-latency knob, not a
data-safety one, since nothing is ever actually lost regardless of how
late the detection lands, by construction of the redirect design below.
Deliberately not on `AUTOSAVE_DEBOUNCE_MS`'s 4s scale — the feature this
serves is explicitly async collaboration, reviewers syncing via
Drive/OneDrive on their own schedule, not live co-editing, so there's no
real expectation of sub-minute notice, and every tick reads the whole
file across the IPC boundary, which is the actually expensive part):
reads the file (needed either way — to hash when size alone isn't
conclusive, and to have the bytes ready if it turns out to be a real
change — so there's no separate stat() pass first), comparing size
against the expected baseline and falling back to a SHA-256 hash only
when size alone isn't conclusive (same-length external edits are rare
but real). Keeps reading and comparing even once a redirect (below) is
already active — a full short-circuit there would mean a missing file
that later reappears, or a lock that clears, is never noticed again until
the document is closed and reopened, which would break exactly the
delete-restore and lock-release cases this whole mechanism needs to cover
eventually. It doesn't react to a *further* external change differently
while already redirected (nothing here can act on that yet — merge is
separate work), but it does let a redirect resolve itself in the one case
that needs no merge at all: canonical turning out to be back at exactly
what this session already expected, meaning the disruption was a false
alarm with nothing to reconcile.

**Content matching isn't itself proof of that for `file-locked`, though**
— a file merely opened elsewhere for viewing never changes its bytes at
all, so an earlier version of this logic (clear `redirect`, toast "back to
normal," rely on the next autosave tick to actually test writability)
declared a lock resolved on literally the very next poll tick after it
started, then flipped straight back to a failure toast moments later once
the real write it re-armed was attempted and failed — found via a live
Acrobat repro. Fixed: on a content match, the poll now attempts the real
write to canonical **immediately, right there** (tentatively clearing
`redirect` first, restored if `saveNow` bails without ever attempting a
write — e.g. another save already in flight — since only an actual
attempt is allowed to resolve or re-set it) and only announces success
once that write actually lands. This still doubles as the lock-retry
path exactly as before — a write that's still genuinely locked fails the
same way it always did, and `saveNow`'s own catch re-sets `redirect` (see
below) — it just no longer claims success before earning it. A real,
*different* result while redirected doesn't get auto-resolved, but does
get relabelled to `external-change` if it wasn't already, so whatever
eventually reconciles it has an accurate signal to work from.

**"Only announces success once that write actually lands" needed a second
fix once `saveNow` itself learned to fall back to the orphan
(`writeFileAtomicWithFallback` — see Conventions below).** The check here
used to read `saveNow`'s *return value* (`saved`) to decide "did it
actually land at canonical" — that stopped being true the moment `saveNow`
started returning the written bytes even when it fell back to the orphan
internally, not just when it landed at `currentPath`. Net effect, found
live: a still-locked file produced the "still locked" toast (from
`saveNow`'s own fallback announcing itself) immediately followed by a
*false* "back to normal" toast from this self-heal code misreading that
truthy return as full success — and worse, it then called
`deleteOrphanIfPresent`, deleting the orphan copy `saveNow`'s fallback had
just written this session's latest edits to, moments after writing it.
Fixed: check `redirect` itself after the call, not `saved` — `saveNow`
already re-sets `redirect` (and announces) itself whenever a write didn't
land at `currentPath`, fallback or outright failure alike, so `redirect`
staying `null` is the only signal that actually means "resolved." `saved`
is only consulted *within* that `redirect === null` case, to tell
"genuinely wrote to currentPath" apart from "bailed without attempting
anything at all" (an early guard clause, e.g. another save already in
flight) — only the latter restores `previousRedirect`.

**Resolution model: redirect, don't overwrite-then-backup.** An earlier
version of this backed up the external content *then* overwrote
`currentPath` with this session's own bytes shortly after (via
`markDirty()` arming the normal autosave debounce) — but two devices
both open and active at once could ping-pong: each side's own resave
would trigger the other's detection, which would resave again, and so
on. The current design instead redirects every subsequent write to a
per-process **orphan file** and never touches `currentPath` at all until
something explicitly reconciles the two — so there's nothing to fight
over, and nothing to lose either: `currentPath` still holds the external
content, completely untouched, which is itself a preservation of it with
no separate backup step needed.

Four conditions set the same `redirect` state
(`{ kind: 'external-change' | 'file-missing' | 'file-locked' | 'save-failed', name }`),
one variable rather than several, since they all need identical handling
from here on:
- **External change** (`handleExternalChange`, called from
  `checkForExternalChange` on a mismatch).
- **File missing** — moved/renamed/deleted out from under the open
  document, not just changed. Detected the same poll pass, via
  `readIfExists`/`FileMissingError` (the same helper `openPath` already
  uses) rather than a bare `readFile` — distinguishes "genuinely gone"
  from some other transient read failure (permission denied, a
  cloud-sync placeholder mid-hydration), which isn't reported to the
  user at all, just logged and skipped.
- **File locked** / **Save failed** — any failure writing to `currentPath`
  sets one of these two, distinguished only by whether the error text
  looks like a Windows sharing/lock violation (`looksLikeFileLock()`:
  matches "os error 32/33/5", "being used by another process", "sharing
  violation", "access is denied", case-insensitive — a best-effort
  heuristic, so this is presentation only, not a gate on whether to
  protect the save). Verified against a real repro: opening the file in
  Acrobat Reader makes our write-then-rename fail with plain
  `ERROR_ACCESS_DENIED` ("os error 5"), not `ERROR_SHARING_VIOLATION` as
  first guessed — Acrobat apparently opens the file without
  `FILE_SHARE_DELETE`, which is enough to block a rename-over-existing-file
  without producing a sharing-violation error specifically. The
  32/33/sharing-violation patterns are kept alongside it for whatever app
  *does* produce that shape instead.
  **Every other save failure used to just retry silently with nothing on
  disk to show for it in the meantime** — a real data-loss gap for
  whatever `looksLikeFileLock()` didn't happen to recognize, exactly what
  the "os error 5" case above turned out to be before it was added to the
  heuristic. Fixed: any write failure to `currentPath` now sets `redirect`
  (`'file-locked'` when the heuristic matches, `'save-failed'` — same
  handling, more honest wording — when it doesn't), so it always falls
  back to the orphan file rather than depending on the heuristic ever
  being complete. The one place this intentionally does *not* apply: a
  failure writing to the *orphan itself* (i.e. `redirect` was already
  set) still just retries with no further fallback — see "Explicitly not
  built yet" below.

Whichever kind sets it, the same two things happen: `markDirty()` (so
closing the document without having made any local edit since detection
still saves — `closeCurrentPdf` only force-saves `if (dirty)`, and
without this, closing would silently leave the redirect unresolved and
this session's state unsaved anywhere) and a toast via
`announceRedirect()`, worded per `kind`. Once `redirect` is set,
`saveNow()` (both the normal debounce and a manual/force save) targets a
per-process pending file instead of `currentPath`:
`<stem>.pending-<owner>-<sessionId>.daagbak`, where `sessionId` is a
short `crypto.randomUUID()` generated once at module load (reused for
every redirected save this process makes, across however many documents
get opened — *not* regenerated per save, which would spawn a new file
every autosave tick) and `owner` is `get_os_username()` (the existing
Tauri command). Both pieces of the name matter for disambiguation: the
random id covers two windows on one machine, the username covers two
different machines sharing a login — e.g. the same person's desktop and
laptop, which collide on username but not on session id, and vice versa
for two windows.

**Why `.daagbak`, not `.pdf`.** Every place in the app that recognizes a
PDF checks `.endsWith(".pdf")` — `refreshFolderNavigation`'s Prev/Next
listing, `pickAndOpenPdf`'s native file-picker filter,
`attachDragDropOpen`'s drop-path filter — and `tauri.conf.json`'s
`fileAssociations` only registers `.pdf` for the OS "Open with"/
double-click path. A pending or backup file that ends in anything else
automatically fails all of those, for free, with no new exclusion code
needed anywhere. Same instinct as the existing `<file>.autosave.tmp`
staging file, just for a longer-lived artifact — which is also why it
gets its own extension rather than reusing `.tmp`: that already means
"transient, safe to ignore" for the staging file, and reusing it for
something meant to persist until reconciled risks it getting swept up by
some unrelated cleanup convention.

The baseline (`expectedDiskSize`/`expectedDiskHash`) is only ever set
from a point that actually knows the true on-disk state at that instant —
`openPath`'s fresh read, or `saveNow`'s fresh write *when it actually
wrote to `currentPath`* (skipped while redirected, since canonical wasn't
touched) — deliberately never from `loadPdfIntoViewer` in general, since
Undo All's revert calls pass it in-memory bytes that aren't what's on
disk yet.

**Either warning's first toast is easy to miss if the window wasn't
focused when it fired** — `showToast` auto-dismisses after a few seconds,
and the titlebar status dot turning red is a subtle, easy-to-overlook
signal on its own. A second `getCurrentWindow().onFocusChanged()`
listener (independent of the one that already drives the titlebar's
inactive-window look) re-announces the active `redirect`, if any, every
time the window regains focus. Deliberately a re-announce on focus, not
a pause-while-unfocused for the poll itself — autosave doesn't check
window focus either, so it could clobber an undetected external change
at any time even while the window is in the background, which is exactly
the case this whole feature exists to catch.

**Edge-triggered on an actual blur→focus transition, not on every
`focused: true` event.** An earlier version reacted to every event the
listener received, on the assumption alt-tabbing back would fire exactly
one — live testing found otherwise: a genuine focus-regain sometimes
produced *two* reminder toasts back to back, and clicking anywhere on the
drag-region titlebar while the window was *already* focused produced a
spurious one on its own, with no real focus change at all (plausibly
WebView2 re-asserting activation on a drag-region mousedown). Fixed by
tracking `wasWindowFocused` and only reacting when it flips false→true —
a duplicate `true` event or a same-focus click both land as true→true and
are ignored.

Manually smoke-tested live in the running Tauri app across several
iterations of this design, most recently confirming the focus-toast fix
above and the redirect model as it stands today.

**Resolving a redirect manually, from the toolbar Save button (implemented,
`resolveRedirectAndSave`/`onSaveActivated` in `src/main.js`).** Every
*automatic* save path — the debounce timer, the safety-net interval,
closing the document, Undo All — keeps silently targeting the orphan for
as long as `redirect` is set, on purpose: a blocking dialog appearing in
the middle of any of those would be a bad surprise for something the user
didn't ask to resolve right now. Only the Save button and its Ctrl+S
shortcut route through `onSaveActivated`, the one place this app ever
asks "what should saving actually do right now?" instead of just doing
it. A small red dot on the Save button (`.has-redirect` in
`custom-viewer.css`, toggled by the only function allowed to assign
`redirect` — `setRedirect`) signals that clicking it now opens a dialog
instead of just saving, since otherwise the very first click after a
redirect starts would be a surprise.

The dialog (`resolveRedirectDialog` in `index.html`, one dialog with
content driven by `redirect.kind` rather than several separate ones — same
shape as Undo All's own confirmation) offers, per kind:
- **`file-missing`** → "Restore": recreates the file at `currentPath`
  with this session's current content. Nothing to back up — there's
  nothing there to lose.
- **`file-locked`** / **`save-failed`** → "Retry Save": attempts
  `currentPath` again (same wording either way — the two kinds only
  differ in whether `looksLikeFileLock()` recognized the error text). If
  it's still actually locked/failing, the write fails the same way it did
  the first time, and this click's bytes fall back to the orphan instead
  — so a retry attempt never loses the edits it was trying to save, it
  just doesn't resolve the redirect. Also no backup: nothing here
  indicates the content actually diverged (if it had, the poll's
  self-heal check above would already have relabelled this
  `external-change` instead).
- **`external-change`** → "Merge" (toasts "not available yet" and leaves
  the dialog open — previews the eventual three-way shape without
  pretending the capability exists) or "Overwrite": moves whatever's
  currently on `currentPath` aside — a plain `rename`, not a read-then-
  write, since that content isn't being modified at all, only relocated,
  and reading a potentially large file fully into memory just to write
  those same bytes straight back out unchanged a moment later has no
  upside — to `<stem>.external-<timestamp>.daagbak` (this one
  intentionally *not* using the orphan's session-id naming — it's a
  one-off snapshot of the *other* version, not this session's own ongoing
  work, so it doesn't need to disambiguate across processes), and only
  proceeds to overwrite once that rename succeeds — if it fails, the save
  is cancelled rather than risking the one truly unrecoverable outcome
  this whole design exists to avoid. One narrow trade from renaming
  first: `writeFileAtomic`'s own atomicity guarantee (the target never
  goes empty; a failed rename leaves it exactly as it was) only covers
  `currentPath` being *written*, not this earlier move — once the rename
  to the backup succeeds, `currentPath` is genuinely empty until the
  follow-up write of this session's bytes lands. If *that* write then
  fails (already an unexpected case — see below), `currentPath` ends up
  missing rather than holding the stale-but-valid external content the
  read-then-write version would have left behind. No content is actually
  lost either way — the external version is safely at the backup path,
  this session's edits are still recoverable via `save-unavailable`'s
  Save As — so this was judged an acceptable trade for how rare the
  compound failure already is, not an oversight.
- **`save-unavailable`** — see below; its only action is Save As.

All four success paths above end the same way: `expectedDiskSize`/`Hash`
updated, `redirect` cleared, the orphan deleted (`deleteOrphanIfPresent`,
best-effort — already redundant by that point, so a failure to remove it
is logged and otherwise ignored), `dirty` cleared.

**A fourth redirect kind, `save-unavailable`, and a "Save As…" action
(`resolveWithSaveAs`), for when even the orphan isn't a safe bet.**
`file-locked`/`save-failed`/`file-missing` all still have a disk-backed
fallback (the orphan) if their own primary action fails again — but the
orphan is deliberately a sibling of `currentPath` (same directory,
different name), so a failure severe enough to break *that* too (a
removed drive, an unmounted synced folder, a dead network share) usually
means the whole directory is the problem, not just one file in it.
Retrying anything in that same directory again would be no better
informed than it was a moment ago. Two places transition into this kind
once that happens: `saveNow`'s own catch, when a write that was already
targeting the orphan (i.e. `redirect` was already set) fails too; and
`resolveRedirectAndSave`'s retry-then-orphan-fallback branch, when the
orphan fallback write itself throws. Its outer catch also folds any other
unexpected failure into the same kind (e.g. `external-change`'s own
overwrite failing *after* its backup already succeeded) rather than
leaving a bespoke unhandled case.

**Save As is also offered as a secondary action alongside every other
kind's own primary action**, not only `save-unavailable`'s — a lock is
per-*path*, not per-folder, so saving under a new filename can plausibly
succeed immediately without waiting for the other app to let go; a
"missing" file's whole folder might be gone too, not just the file. It's
promoted to the *only* action for `save-unavailable`, where nothing else
is left to try.

Mechanically, `resolveWithSaveAs` doesn't try to repair the
currentPath/orphan relationship at all — it treats a chosen destination
as the document moving there, the same as opening a file, not a one-off
export the session goes on ignoring. Native `save()` dialog (already used
for "Save Copy As"/"Export Comments As"/"Save Summary As", same
write-then-rename pattern as every other write in this app) → on success,
`currentPath` itself is reassigned to the new path, `expectedDiskSize`/
`Hash` recomputed, `redirect` cleared, recent-files/window-title/Prev-Next
folder navigation all refreshed exactly as a fresh Open would (the old
folder's sibling-file listing no longer applies once the document has
moved), and the *old* orphan is best-effort deleted. Cancelling the native
picker leaves everything untouched — still redirected, as before the
click.

**Explicitly not built yet — separate work from the redirect mechanism
and the manual resolve dialog above**:
- **Automatic/mid-session reconciliation.** Right now the *only* way a
  redirect resolves is the user explicitly clicking Save and choosing an
  option in the dialog above — nothing detects a conflict and offers to
  reconcile on its own, and nothing runs on reopening a document that has
  an orphaned `.daagbak` sitting next to it from a previous session that
  closed before resolving. Both are still planned trigger points for
  whatever eventually does real merging.
- **The merge algorithm itself** — what the dialog's "Merge" button will
  eventually do instead of toasting. NM-keyed, processed as repeated
  pairwise merges (canonical + one orphan at a time — order doesn't
  matter for the safe case, and it's naturally idempotent/resumable if
  interrupted). Three buckets per `/NM`: unique to one source → auto-merge;
  identical everywhere → dedupe; differing → genuine conflict, flagged
  for review, never silently resolved. Deletions are explicitly out of
  scope for a first pass — telling "deleted" apart from "never existed in
  that source" needs each orphan to carry a pointer back to its own base
  snapshot, which nothing persists yet.
- **A lineage sanity-check before ever trusting NM-based merge at all**
  (page count, some overlapping existing NMs) — protects against the case
  where a "revision" is actually a wholesale fresh export from the source
  document (LaTeX/Word), sharing no object lineage with the old file at
  all; blindly merging in that case could anchor an old annotation to a
  nonsensical position in a structurally unrelated document.
- **Loop-termination by content, not bytes**, for whatever eventually
  runs *automatic* merge rounds (the manual dialog above doesn't loop, so
  this doesn't apply to it). Verified today's pipeline (pdf-lib's
  `save()` and pdf.js's own annotation timestamps) happens to be
  deterministic on a genuine no-op resave — `gen2.pdf`/`gen3.pdf` for
  every fixture in the pdf-lib investigation above are byte-identical,
  and pdf.js only stamps `/M`/`CreationDate` once, at actual edit time,
  not on every `saveDocument()` call — but that's not safe to depend on
  across future library upgrades. Whether an automatic round actually
  produced anything new should be decided by NM-keyed content equality,
  not by comparing raw bytes/hashes, so convergence is structural rather
  than incidental.

## Conventions
- Debounce/timing constants live at the top of `src/main.js`
  (`AUTOSAVE_DEBOUNCE_MS`, `AUTOSAVE_MAX_WAIT_MS`) — tune there, not
  inline.
- Write-then-rename is the pattern for any future feature that writes to
  the original PDF path — never write directly over it. Use the shared
  `writeFileAtomic(path, bytes)` (`src/main.js`) rather than writing the
  `<path>.autosave.tmp` + rename pair inline — every write-then-rename
  call site used to repeat that pair by hand, and a failed rename (the
  exact mechanism that first detects a locked file: the tmp write
  succeeds, replacing the locked target doesn't) left its tmp file
  orphaned forever, since nothing else ever targeted `*.autosave.tmp` for
  cleanup. Found live during lock testing — a stale `<file>.pdf.autosave.tmp`
  sat next to the file for as long as the session stayed redirected to the
  `.daagbak` orphan. `writeFileAtomic` best-effort removes the tmp file on
  a failed rename before the original error propagates, closing the leak
  at every call site (`saveNow`, `resolveRedirectAndSave`'s three writes,
  `resolveWithSaveAs`) at once.
- When a failed write to some primary path has a known fallback (the
  redirect model's currentPath → orphan relationship), use
  `writeFileAtomicWithFallback(primaryPath, getFallbackPath, bytes)`
  instead of catching the primary failure, discarding its tmp file, and
  writing fresh a second time — that shape has a real gap between "primary
  failed" and "a later attempt writes the fallback," during which this
  session's edits exist only in memory, in the exact scenario (a write
  already just failed) where that's least welcome. It redirects the
  *same* already-written tmp file straight to the fallback path instead,
  so the bytes stay continuously on disk with no such gap and no second
  write. `getFallbackPath` is a function, not an already-resolved path —
  deriving the orphan path costs a couple of IPC round trips, and the
  overwhelming majority of calls succeed at the primary on the first try,
  so it's only paid when a fallback is actually needed. Returns `{ path,
  primaryError }` — `primaryError` is set even on overall success,
  whenever that success happened at the fallback, and is what the caller
  should classify/log; only thrown if *both* the primary and the fallback
  fail. Used by `saveNow` (currentPath → orphan) and
  `resolveRedirectAndSave`'s file-missing/file-locked/save-failed retry
  path (same pair) — not by `external-change`'s overwrite (no fallback is
  attempted there on purpose; see its own comment) or by any one-shot
  write with nowhere else to go (`resolveWithSaveAs`, the external-change
  backup write).
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
  `removeEditor`, `annotationStorage.remove`), the target methods are plain (non-private,
  non-`#`-prefixed) instance methods — safe to wrap by reassignment
  (`const original = obj.method.bind(obj); obj.method = (...args) => {
  original(...args); /* observe */ };`). Confirm the method isn't a
  private `#field` first; those can't be reassigned this way.
