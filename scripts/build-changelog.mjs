// Regenerate docs/changelog.html from CHANGELOG.md.
//
//   bun run changelog            write docs/changelog.html
//   bun run changelog -- --check exit 1 if it's stale (for CI)
//
// CHANGELOG.md is the single source of truth: the release workflow slices
// the current version's section into the GitHub release body, and this
// script renders the whole file into the styled site page. Keep the format
// (Keep a Changelog):
//   ## [x.y.z] — YYYY-MM-DD      one per release ([Unreleased] is skipped here)
//   ### Added / ### Changed …    section groups
//   - item text                  Markdown **bold**, `code`, [links](url) and
//                                inline HTML such as <kbd>…</kbd> are allowed;
//                                wrapped continuation lines are indented
//   [x.y.z]: <url>               reference-style link → the "see release →" link
//
// Deliberately dependency-free — the format is small and fully controlled,
// so a focused parser beats pulling in a Markdown library.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "CHANGELOG.md");
const OUT = join(ROOT, "docs", "changelog.html");
const REPO = "https://github.com/asifm91/daag";
const SKIP = new Set(["unreleased"]);

const md = readFileSync(SRC, "utf8");

// Reference-style link definitions: [label]: url
const refs = new Map();
for (const m of md.matchAll(/^\[([^\]]+)\]:\s*(\S+)\s*$/gm)) {
  refs.set(m[1].toLowerCase(), m[2]);
}

const escAttr = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Inline Markdown → HTML. Content is trusted, so raw < > are left as-is
// (that's what lets <kbd>/<code> through); only bare ampersands are fixed.
function inline(s) {
  return s
    .replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, "&amp;")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .trim();
}

// Parse into [{ name, date, groups: [{ title, items: [] }] }]
const releases = [];
let rel = null;
let group = null;
let item = null;

const flushItem = () => {
  if (item != null && group) group.items.push(inline(item));
  item = null;
};
const flushGroup = () => {
  flushItem();
  if (group && rel) rel.groups.push(group);
  group = null;
};
const flushRelease = () => {
  flushGroup();
  if (rel) releases.push(rel);
  rel = null;
};

for (const line of md.split(/\r?\n/)) {
  const h2 = line.match(/^##\s+\[([^\]]+)\](?:\s+[—-]\s+(.+?))?\s*$/);
  if (h2) {
    flushRelease();
    rel = { name: h2[1].trim(), date: (h2[2] || "").trim(), groups: [] };
    continue;
  }
  if (!rel) continue; // title / preamble

  const h3 = line.match(/^###\s+(.+?)\s*$/);
  if (h3) {
    flushGroup();
    group = { title: h3[1].trim(), items: [] };
    continue;
  }

  const li = line.match(/^[-*]\s+(.+)$/);
  if (li) {
    flushItem();
    item = li[1];
    continue;
  }

  if (item != null && /^\s+\S/.test(line)) {
    item += " " + line.trim(); // wrapped continuation of the current item
    continue;
  }

  if (line.trim() === "") flushItem();
  // reference-def block and anything else: ignored
}
flushRelease();

const shown = releases.filter((r) => !SKIP.has(r.name.toLowerCase()));

const blocks = shown
  .map((r) => {
    const url = refs.get(r.name.toLowerCase()) || `${REPO}/releases/tag/v${r.name}`;
    const date = r.date ? `\n            <span class="date">${escText(r.date)}</span>` : "";
    const groups = r.groups
      .map(
        (g) =>
          `          <h3>${escText(g.title)}</h3>\n` +
          `          <ul>\n` +
          g.items.map((it) => `            <li>${it}</li>`).join("\n") +
          `\n          </ul>`
      )
      .join("\n");
    return (
      `        <div class="release">\n` +
      `          <h2>\n` +
      `            v${escText(r.name)}${date}\n` +
      `            <a class="gh" href="${escAttr(url)}">see release →</a>\n` +
      `          </h2>\n` +
      `${groups}\n` +
      `        </div>`
    );
  })
  .join("\n\n");

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Daag — Changelog</title>
    <meta
      name="description"
      content="Release history for Daag, the local-first PDF annotator."
    />
    <link rel="icon" type="image/png" href="icon.png" />
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <header>
      <div class="wrap nav">
        <a class="brand" href="index.html">
          <img src="icon.png" alt="Daag icon" />
          <span class="name">Daag</span>
        </a>
        <span class="spacer"></span>
        <a class="ghlink" href="index.html#features">Features</a>
        <a class="ghlink" href="index.html#download">Download</a>
        <a class="ghlink" href="guide.html">Guide</a>
        <a class="ghlink" href="changelog.html" aria-current="page">Changelog</a>
        <a class="ghlink" href="${REPO}">GitHub</a>
      </div>
    </header>

    <main>
      <div class="wrap page-head">
        <h1>Changelog</h1>
        <p class="lead">
          Notable changes per release. Each version links to its full notes on
          GitHub; installed copies also show the notes in the update dialog.
        </p>
      </div>

      <section class="wrap">
${blocks}
      </section>
    </main>

    <footer>
      <div class="wrap row">
        <span>Daag — local-first PDF annotation. MIT licensed.</span>
        <span><a href="${REPO}">github.com/asifm91/daag</a></span>
      </div>
    </footer>
  </body>
</html>
`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    /* missing counts as stale */
  }
  if (current !== html) {
    console.error("docs/changelog.html is out of date — run: bun run changelog");
    process.exit(1);
  }
  console.log("docs/changelog.html is up to date.");
} else {
  writeFileSync(OUT, html);
  console.log(`Wrote docs/changelog.html — ${shown.length} releases.`);
}
