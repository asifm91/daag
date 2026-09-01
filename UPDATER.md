# Auto-update setup

Daag updates itself from its GitHub releases. Once installed, it checks
`https://github.com/asifm91/daag/releases/latest/download/latest.json` a
few seconds after launch (and on demand from **Settings → Check for
updates…**), and can download + install a newer signed build in place,
then relaunch.

Almost all of this is wired up in the repo already. The one thing that
isn't — and can't be, because it's a secret — is the signing key on the
CI side.

## One-time: add the signing key to GitHub Actions

The updater only installs builds signed with the private half of a
minisign keypair whose public half is baked into
`src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). The keypair was
generated with:

```sh
bunx tauri signer generate --ci -p "" -w daag_updater.key
```

The generated files are in the **gitignored** `.secrets/` directory:

- `.secrets/daag_updater.key` — the private key (keep secret)
- `.secrets/daag_updater.key.pub` — the public key (already in the config)

In the GitHub repo, go to **Settings → Secrets and variables → Actions →
New repository secret** and add just one:

| Secret name | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | the entire contents of `.secrets/daag_updater.key` |

There is **no password secret**. The key was generated with an empty
passphrase, and GitHub doesn't allow empty secret values anyway — so
`release.yml` sets `TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ""` as a literal
in the workflow. The variable still has to be *set* to something (an
absent one makes the Tauri bundler fall through to an interactive
password prompt, which hangs a CI job with no terminal); a literal `""`
satisfies that and decrypts the empty-passphrase key.

Once the secret is set, the next tagged release (`git tag v1.x.y &&
git push --tags`, or a published `workflow_dispatch` run) will produce
signed bundles plus a `latest.json`, and existing installs will offer the
update.

## If you lose the private key

Generate a new keypair, replace `plugins.updater.pubkey` in
`src-tauri/tauri.conf.json`, and update the `TAURI_SIGNING_PRIVATE_KEY`
secret. Anyone already on an older build will **not** be offered updates
signed with the new key — they have to reinstall from the `.dmg` /
`-setup.exe` / `.AppImage` on the releases page once, after which
self-update resumes.

## Notes

- **`workflow_dispatch` runs produce a draft release.** GitHub's
  `/releases/latest/` only points at published, non-prerelease releases,
  so a draft never reaches the updater until you publish it.
- **The `.deb` is not an updater target.** A `.deb` install is managed by
  `dpkg`/`apt`; the in-app updater covers the NSIS installer (Windows),
  the AppImage (Linux), and the `.app` (macOS) only.
- **macOS `.app.tar.gz`** is kept on the release on purpose — it's the
  artifact the updater pulls on macOS. Fresh installs still use the
  `.dmg`.
