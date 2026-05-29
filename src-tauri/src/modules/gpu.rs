//! GPU / hardware-acceleration forcing for the embedded webview.
//!
//! The terminal renders cells through xterm's WebGL2 addon, but WebGL paints
//! into a `<canvas>` that the *host webview* must then composite to screen with
//! the GPU. On Windows, WebView2 (Chromium) ships a conservative GPU blocklist
//! and silently drops to **software compositing** on integrated GPUs with older
//! drivers, inside RDP sessions, or on blocklisted driver/GPU pairs. When that
//! happens the WebGL canvas is read back on the CPU every frame and rendering
//! turns janky despite WebGL "working".
//!
//! These switches must be applied **before** the webview runtime initializes —
//! Chromium reads `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` once at startup, and
//! WebKitGTK reads its env once per process. So `configure()` runs at the very
//! top of `run()`, before `tauri::Builder::default()`.

/// Chromium switches handed to WebView2 to force hardware compositing.
///
/// - `--ignore-gpu-blocklist`: bypass Chromium's conservative driver/GPU
///   blocklist so integrated-GPU laptops use hardware instead of SwiftShader.
/// - `--enable-gpu-rasterization`: rasterize layers on the GPU.
/// - `--enable-zero-copy`: upload GPU tiles without a CPU staging copy.
/// - `--disable-frame-rate-limit`: let the compositor run above the default
///   cap so fast scrollback paints smoothly.
#[cfg(target_os = "windows")]
const WEBVIEW2_GPU_ARGS: &str = "--ignore-gpu-blocklist \
--enable-gpu-rasterization \
--enable-zero-copy \
--disable-frame-rate-limit";

/// Apply platform GPU forcing. Idempotent and best-effort: if a user has
/// already set the override env var we respect it and don't clobber it.
pub fn configure() {
    #[cfg(target_os = "windows")]
    configure_windows();

    #[cfg(target_os = "linux")]
    configure_linux();

    // macOS WKWebView is GPU-composited by Core Animation already; nothing to do.
}

#[cfg(target_os = "windows")]
fn configure_windows() {
    const KEY: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
    // Don't override an operator-supplied value (e.g. a user debugging a driver
    // bug by forcing software). Only set it when unset/empty.
    match std::env::var(KEY) {
        Ok(v) if !v.trim().is_empty() => {}
        _ => {
            // SAFETY: single-threaded startup, runs before any webview/thread spawn.
            unsafe {
                std::env::set_var(KEY, WEBVIEW2_GPU_ARGS);
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn configure_linux() {
    // WebKitGTK disables its accelerated (GPU) compositing path when
    // WEBKIT_DISABLE_COMPOSITING_MODE is set. Some distros/containers export it
    // by default, which forces the slow CPU path. Clear it unless the operator
    // explicitly opted into software rendering via TERAX_FORCE_SOFTWARE=1.
    if std::env::var("TERAX_FORCE_SOFTWARE").as_deref() == Ok("1") {
        return;
    }
    if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_ok() {
        // SAFETY: single-threaded startup, runs before any webview/thread spawn.
        unsafe {
            std::env::remove_var("WEBKIT_DISABLE_COMPOSITING_MODE");
        }
    }
}
