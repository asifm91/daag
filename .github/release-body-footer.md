### Downloads

- **Windows** — `*_x64-setup.exe` (installer) or `Daag-portable-x64.exe` (no install needed)
- **Linux** — `*_amd64.AppImage` or `*_amd64.deb`
- **macOS** — `*_universal.dmg`

Once installed, Daag checks this releases page for newer versions on launch and can update itself in place (Settings → Check for updates).

**macOS first launch:** the app is unsigned, so Gatekeeper will block it. Right-click the app → Open (macOS 14 and earlier), or open it once then go to System Settings → Privacy & Security → "Open Anyway" (macOS 15+). If that still refuses with a "can't be opened"/"could not verify" prompt (only Move to Bin/Done, no way through), clear the quarantine attribute from a terminal instead: `xattr -cr /Applications/Daag.app`

**Linux AppImage first launch:** the AppImage is unsigned too, so GNOME-based file managers (Ubuntu, Zorin, Fedora, …) show an "untrusted launcher" warning every time you double-click it — the trust flag they set doesn't reliably persist. Run it from a terminal instead (`chmod +x Daag_*.AppImage && ./Daag_*.AppImage`), or install [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) to integrate it into your app menu and stop the prompt for good.
