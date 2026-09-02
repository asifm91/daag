// Prepare a release locally — "Cutting a release" in README.md, minus the
// push. It commits and tags, but never pushes: you review the result and
// run `git push && git push origin v<version>` yourself (the tag push is
// what triggers the Release workflow).
//
//   node scripts/prepare-release.mjs 1.5.0
//   node scripts/prepare-release.mjs 1.5.0 --dry-run   # show plan, change nothing
//   node scripts/prepare-release.mjs 1.5.0 --no-git    # edit files only, no commit/tag
//   node scripts/prepare-release.mjs 1.5.0 --revert    # undo a prepare that wasn't pushed
//   bun run release-prep 1.5.0
//
// What it does, in order:
//   1. CHANGELOG.md — move everything under `## [Unreleased]` into a new
//      `## [x.y.z] — YYYY-MM-DD` section, leave a fresh empty
//      `## [Unreleased]` on top, and update the reference-style links at
//      the bottom (`[Unreleased]` now compares from the new tag; a
//      `[x.y.z]` link is added).
//   2. Regenerate docs/changelog.html (runs scripts/build-changelog.mjs).
//   3. Bump the version in package.json, src-tauri/tauri.conf.json,
//      src-tauri/Cargo.toml and src-tauri/Cargo.lock so they all match.
//   4. Stage exactly those files, commit as "Release v<version>", and tag
//      v<version>. No push.
//
// All file edits are computed and validated in memory first, so a bad
// version or an unexpected file layout writes nothing. The changelog
// regen and the git step run afterwards; the git step stages only the
// files above, keeping unrelated working-tree changes out of the commit.
//
// --revert <x.y.z> undoes the above: it deletes the local v<x.y.z> tag and
// `git reset --hard`s the "Release v<x.y.z>" commit away, landing back on
// the previous release. It aborts if that tag or commit is already on a
// remote (revert it there yourself), if HEAD isn't that release commit, or
// if the working tree is dirty. <x.y.z> must be the version currently in
// package.json and the newest section in CHANGELOG.md.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "https://github.com/asifm91/daag";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const noGit = args.includes("--no-git");
const revert = args.includes("--revert");
const version = args.find((a) => !a.startsWith("-"));

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function git(gitArgs, opts = {}) {
  return execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf8", ...opts });
}
// git that returns "" instead of throwing (no remote, offline, bad ref…).
function gitSafe(gitArgs) {
  try {
    return git(gitArgs, { stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

if (!version) {
  die("usage: node scripts/prepare-release.mjs <x.y.z> [--dry-run] [--no-git] [--revert]");
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  die(`version must look like 1.2.3, got "${version}"`);
}
if (revert && noGit) die("--revert and --no-git don't combine");

// Local date, YYYY-MM-DD (avoids a UTC off-by-one late in the day).
const now = new Date();
const date = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, "0"),
  String(now.getDate()).padStart(2, "0"),
].join("-");

const rd = (rel) => readFileSync(join(ROOT, rel), "utf8");
// Read a file, but hand transforms LF-normalized text and remember whether
// it was CRLF so the write can restore it — this repo is LF today, but with
// core.autocrlf=true a fresh checkout isn't, and the regexes below assume LF.
const read = (rel) => {
  const raw = rd(rel);
  return { lf: raw.replace(/\r\n/g, "\n"), crlf: /\r\n/.test(raw) };
};
const write = (rel, lfText, crlf) =>
  writeFileSync(join(ROOT, rel), crlf ? lfText.replace(/\n/g, "\r\n") : lfText, "utf8");
const pkgVersion = (s) => s.match(/"version":\s*"(\d+\.\d+\.\d+)"/)?.[1];
// Every "## [x.y.z]" release heading in file order (skips "## [Unreleased]").
const releaseHeadings = (s) => [...s.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);

// ---- current version (package.json is the reference) -----------------
const current = pkgVersion(read("package.json").lf);
if (!current) die("could not find a version in package.json");

const tag = `v${version}`;

// ---- --revert: undo the most recent prepare-release ------------------
if (revert) {
  revertRelease();
  process.exit(0);
}

if (current === version) die(`already at ${version} — nothing to bump`);
console.log(`Preparing release: ${current} -> ${version}  (${date})`);

// ---- git preflight (skipped with --no-git) --------------------------
if (!noGit) {
  try {
    git(["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
  } catch {
    die("not inside a git work tree (use --no-git to only edit files)");
  }
  if (git(["tag", "--list", tag]).trim()) {
    die(`tag ${tag} already exists`);
  }
  if (git(["diff", "--cached", "--name-only"]).trim()) {
    die("you have staged changes — commit or unstage them before releasing");
  }
}

// ---- 1. CHANGELOG.md --------------------------------------------------
function rewriteChangelog(md) {
  if (md.includes(`## [${version}]`)) {
    die(`CHANGELOG.md already has a "## [${version}]" section`);
  }

  const unreleased = md.match(/^## \[Unreleased\][^\n]*\n/m);
  if (!unreleased) die('CHANGELOG.md has no "## [Unreleased]" heading');

  // Body between "## [Unreleased]" and the next "## [" heading.
  const after = md.slice(unreleased.index + unreleased[0].length);
  const nextHeading = after.search(/^## \[/m);
  const body = (nextHeading === -1 ? after : after.slice(0, nextHeading)).trim();
  if (!body) {
    die("nothing under [Unreleased] to release — add changelog entries first");
  }

  // Insert the new version heading right after [Unreleased], keeping the
  // entries beneath it.
  let out = md.replace(
    /^## \[Unreleased\][^\n]*\n/m,
    `## [Unreleased]\n\n## [${version}] — ${date}\n`,
  );

  // Reference-style links at the bottom.
  const unrefLine = out.match(/^\[Unreleased\]:.*$/m);
  if (!unrefLine) die("CHANGELOG.md has no [Unreleased]: link definition");
  out = out.replace(
    /^\[Unreleased\]:.*$/m,
    `[Unreleased]: ${REPO}/compare/v${version}...HEAD\n` +
      `[${version}]: ${REPO}/releases/tag/v${version}`,
  );

  return out;
}

// ---- 3. version bumps ----------------------------------------------------
// [file, human-readable what, regex matching the OLD version, replacement].
// The regex must match exactly once; $1/$2 keep the surrounding text.
const bumps = [
  ["package.json", "npm version", /("version":\s*")\d+\.\d+\.\d+(")/],
  ["src-tauri/tauri.conf.json", "Tauri config version", /("version":\s*")\d+\.\d+\.\d+(")/],
  ["src-tauri/Cargo.toml", "crate version", /(^version\s*=\s*")\d+\.\d+\.\d+(")/m],
  ["src-tauri/Cargo.lock", "Cargo.lock daag entry", /(name = "daag"\nversion = ")\d+\.\d+\.\d+(")/],
];

function bumpOne(text, [file, what, re]) {
  if (!re.test(text)) die(`${file}: could not find the ${what} to bump`);
  // re has no `g` flag, so this replaces the first match only.
  return text.replace(re, (_m, p1, p2) => `${p1}${version}${p2}`);
}

// ---- validate everything in memory ------------------------------------
// Each entry: [file, new LF content, wasCRLF].
const planned = [];
{
  const { lf, crlf } = read("CHANGELOG.md");
  planned.push(["CHANGELOG.md", rewriteChangelog(lf), crlf]);
}
for (const bump of bumps) {
  const { lf, crlf } = read(bump[0]);
  planned.push([bump[0], bumpOne(lf, bump), crlf]);
}

// Files the git step will stage — the planned writes plus the generated page.
const touched = [...planned.map(([file]) => file), "docs/changelog.html"];

if (dryRun) {
  console.log("\n--dry-run: would update:");
  for (const file of touched) console.log(`  ${file}`);
  if (!noGit) console.log(`\n  then: git commit -m "Release ${tag}" && git tag ${tag}  (no push)`);
  process.exit(0);
}

// ---- write -----------------------------------------------------------
for (const [file, content, crlf] of planned) {
  write(file, content, crlf);
  console.log(`  updated ${file}`);
}

// ---- 2. regenerate the website changelog page -----------------------
console.log("  running scripts/build-changelog.mjs …");
execFileSync(process.execPath, [join(ROOT, "scripts", "build-changelog.mjs")], {
  stdio: "inherit",
});
console.log("  updated docs/changelog.html");

// ---- 4. commit + tag (no push) -------------------------------------
if (noGit) {
  console.log(`
Files updated (--no-git: nothing committed). To finish:

  git add ${touched.join(" ")}
  git commit -m "Release ${tag}"
  git tag ${tag}
`);
  process.exit(0);
}

git(["add", "--", ...touched], { stdio: "inherit" });
git(["commit", "-m", `Release ${tag}`], { stdio: "inherit" });
git(["tag", tag], { stdio: "inherit" });

console.log(`
Committed and tagged ${tag}. Nothing pushed. When you're ready:

  git push
  git push origin ${tag}      # this is what triggers the Release workflow
`);

// ---------------------------------------------------------------------
function revertRelease() {
  try {
    git(["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
  } catch {
    die("not inside a git work tree");
  }

  // <x.y.z> must be what's currently checked out and the newest changelog
  // section — i.e. exactly what a prepare-release run just produced.
  if (version !== current) {
    die(`--revert ${version}, but package.json is at ${current} — nothing to revert`);
  }
  const headings = releaseHeadings(read("CHANGELOG.md").lf);
  if (headings[0] !== version) {
    die(`CHANGELOG.md's newest release is ${headings[0] ?? "(none)"}, not ${version}`);
  }
  const prev = headings[1];
  if (!prev) die("no previous release in CHANGELOG.md to revert to");

  if (!git(["tag", "--list", tag]).trim()) {
    die(`no local tag ${tag} — nothing to revert`);
  }
  const subject = git(["log", "-1", "--format=%s"]).trim();
  if (subject !== `Release ${tag}`) {
    die(`HEAD is "${subject}", not "Release ${tag}" — revert by hand`);
  }
  if (git(["status", "--porcelain"]).trim()) {
    die("working tree not clean — commit or stash before reverting (this does git reset --hard)");
  }

  // Abort if the tag or its commit already left this machine.
  const onRemoteTag = gitSafe(["ls-remote", "--tags", "origin", tag]);
  const onRemoteBranch = gitSafe(["branch", "-r", "--contains", "HEAD"]);
  if (onRemoteTag || onRemoteBranch) {
    die(`${tag} or its commit is already on a remote — revert it there yourself`);
  }

  if (dryRun) {
    console.log(
      `--dry-run: would delete tag ${tag} and 'git reset --hard HEAD~1', landing on v${prev}`,
    );
    return;
  }

  git(["tag", "-d", tag], { stdio: "inherit" });
  git(["reset", "--hard", "HEAD~1"], { stdio: "inherit" });

  // Post-conditions: everything should now read the previous version.
  const gotPkg = pkgVersion(read("package.json").lf);
  const gotChangelog = releaseHeadings(read("CHANGELOG.md").lf)[0];
  if (gotPkg !== prev || gotChangelog !== prev) {
    die(
      `revert landed on package=${gotPkg} changelog=${gotChangelog}, expected ${prev}. ` +
        `Recover with: git reset --hard ORIG_HEAD && git tag ${tag} <its old commit>`,
    );
  }

  console.log(`
Reverted ${tag}: tag deleted, "Release ${tag}" commit dropped, now at v${prev}.
The pre-revert state is still at ORIG_HEAD (git reset --hard ORIG_HEAD to undo).
`);
}
