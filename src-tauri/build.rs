fn main() {
    // Custom Windows application manifest. This is Tauri's own default
    // manifest (the Common-Controls v6 dependency — required for the native
    // file dialogs from tauri-plugin-dialog) plus a `longPathAware` opt-in.
    //
    // Without `longPathAware`, Windows Explorer silently refuses to drop
    // files whose full path exceeds 259 chars onto the window (the drop is
    // rejected by the shell before any event reaches the webview), and the
    // file picker hands back such paths with a `\\?\` prefix. Marking the
    // exe long-path aware fixes both — but only takes effect when the
    // machine-wide HKLM\...\FileSystem\LongPathsEnabled registry value is
    // also 1 (see the `enable_long_paths` command in src/main.rs, surfaced
    // in the app's Settings dialog).
    //
    // Supplying app_manifest() *replaces* Tauri's default, so the
    // Common-Controls dependency has to be repeated here verbatim.
    let manifest = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings xmlns:ws2="http://schemas.microsoft.com/SMI/2016/WindowsSettings">
      <ws2:longPathAware>true</ws2:longPathAware>
    </windowsSettings>
  </application>
</assembly>
"#;

    let windows = tauri_build::WindowsAttributes::new().app_manifest(manifest);
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri-build");
}
