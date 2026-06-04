pub mod modules;

use modules::sync::MutexExt;
use modules::{
    agent, agentscan, bunqueue, ccusage, cleanup, crash, docker, fs, git, gpu, kv, net, otel, pty,
    s3, secrets, shell, ssh, workspace,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::StateFlags;

/// Drained on first read so HMR / re-mounts can't replay the launch dir.
#[derive(Default)]
struct LaunchDir(Mutex<Option<String>>);

/// Set when the app is launched with a *file* argument ("Open with Terax
/// Camelot"). Holds the canonical file path; the workspace cwd is its parent
/// dir (stored in `LaunchDir`). Drained on first read like `LaunchDir`.
#[derive(Default)]
struct LaunchFile(Mutex<Option<String>>);

#[tauri::command]
fn get_launch_dir(state: State<'_, LaunchDir>) -> Option<String> {
    state.0.lock_safe().take()
}

#[tauri::command]
fn get_launch_file(state: State<'_, LaunchFile>) -> Option<String> {
    state.0.lock_safe().take()
}

// Durable sink for uncaught renderer errors / unhandled promise rejections and
// React error-boundary crashes. The frontend redacts secrets before sending,
// so the message is safe to write to the plugin log.
#[tauri::command]
fn log_renderer_error(message: String) {
    tauri_plugin_log::log::error!(target: "renderer", "{message}");
}

/// Parse the first positional path argument into a launch target. A directory
/// becomes the workspace cwd. A file ("Open with Terax Camelot") resolves to
/// its parent dir as the cwd plus the file path to open in the editor.
fn parse_launch_target() -> (Option<String>, Option<String>) {
    for arg in std::env::args().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        let Ok(canon) = std::fs::canonicalize(&arg) else {
            continue;
        };
        if canon.is_dir() {
            return (Some(crate::modules::fs::to_canon(&canon)), None);
        }
        if canon.is_file() {
            let file = crate::modules::fs::to_canon(&canon);
            let dir = canon
                .parent()
                .map(crate::modules::fs::to_canon)
                .filter(|d| !d.is_empty());
            return (dir, Some(file));
        }
    }
    (None, None)
}

#[tauri::command]
async fn open_settings_window(app: tauri::AppHandle, tab: Option<String>) -> Result<(), String> {
    let url_path = match tab.as_deref() {
        Some(t) if !t.is_empty() => format!("settings.html?tab={}", t),
        _ => "settings.html".to_string(),
    };

    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        if let Some(t) = tab.as_deref().filter(|s| !s.is_empty()) {
            // emit() serializes via JSON — no string-escape footgun, unlike
            // eval() with format!(). Frontend listens via Tauri event API.
            let _ = window.emit("terax:settings-tab", t);
        }
        return Ok(());
    }

    // Match the dev title suffix applied to the main window in setup().
    let settings_title = if cfg!(debug_assertions) {
        "Settings Dev"
    } else {
        "Settings"
    };
    let mut builder = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App(url_path.into()))
        .title(settings_title)
        .inner_size(900.0, 700.0)
        .min_inner_size(820.0, 620.0)
        .resizable(true)
        .visible(false)
        // Keep settings above the main app window so it doesn't get hidden
        // when the user clicks back into the editor or terminal (#33).
        .always_on_top(true);

    // Tie lifecycle to the main window so settings minimizes/closes with it.
    if let Some(main) = app.get_webview_window("main") {
        builder = builder.parent(&main).map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    // On Linux/Windows we render our own titlebar, so drop native chrome
    // and make the window transparent.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let builder = builder.decorations(false).transparent(true);

    let window = builder.build().map_err(|e| e.to_string())?;

    // Some Linux compositors (GNOME/Mutter with CSD-by-default) ignore the
    // builder-time decorations flag — re-assert it after realize.
    #[cfg(target_os = "linux")]
    {
        let _ = window.set_decorations(false);
    }
    let _ = window;
    Ok(())
}

/// Monotonic counter for unique secondary-window labels. The first app window
/// is "main"; spawned windows are "main-2", "main-3", … Tauri rejects duplicate
/// labels, so a process-wide counter guarantees uniqueness across the session.
static WINDOW_SEQ: AtomicU32 = AtomicU32::new(2);

/// Maps a normalized project directory → the window label opened for it, so
/// re-opening a project focuses the existing window instead of spawning a
/// duplicate. Entries are pruned when their window closes (CloseRequested) and
/// validated on lookup (a dead label is treated as no match).
#[derive(Default)]
struct ProjectWindows(Mutex<HashMap<String, String>>);

/// Tracks the *current* project dir of every live app window, keyed by window
/// label (the `main` window plus each spawned `main-N`). The frontend reports
/// its window's dir whenever the active project changes (see `report_window_dir`).
/// Persisted on quit and replayed on next launch so reopening the app restores
/// the same set of windows. Empty-string dir = a window with no pinned project.
#[derive(Default)]
struct OpenWindows(Mutex<HashMap<String, String>>);

/// Store file holding the last session's open-window dirs. Lives alongside the
/// other Tauri-store JSON in the app data dir.
const WINDOW_SESSION_STORE: &str = "terax-window-session.json";
const WINDOW_SESSION_KEY: &str = "dirs";

/// Read the persisted `kvPort` pref (the embedded KV server port). `None` keeps
/// the lifecycle default (6379, dev-offset applied there).
fn read_kv_port_pref<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<u16> {
    use tauri_plugin_store::StoreExt;
    app.store("terax-settings.json")
        .ok()
        .and_then(|s| s.get("kvPort"))
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .filter(|p| *p >= 1024)
}

/// Read the persisted `kvRequirePass` pref. Empty/absent -> no auth.
fn read_kv_pass_pref<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<String> {
    use tauri_plugin_store::StoreExt;
    app.store("terax-settings.json")
        .ok()
        .and_then(|s| s.get("kvRequirePass"))
        .and_then(|v| v.as_str().map(str::to_owned))
        .filter(|s| !s.is_empty())
}

/// Ensure the opened project's `.gitignore` ignores `.t-camelot/` so the cache
/// data dir is never committed. Idempotent; best-effort. `kv_data_dir` is
/// `<project>/.t-camelot/kv_data`, so the project root is two parents up.
fn ensure_kv_gitignore(kv_data_dir: &std::path::Path) {
    let Some(project_root) = kv_data_dir.parent().and_then(|p| p.parent()) else {
        return;
    };
    let gitignore = project_root.join(".gitignore");
    let entry = ".t-camelot/";
    let existing = std::fs::read_to_string(&gitignore).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == entry || l.trim() == ".t-camelot") {
        return;
    }
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str("\n# Terax embedded KV server data (machine-local, never commit).\n");
    next.push_str(entry);
    next.push('\n');
    let _ = std::fs::write(&gitignore, next);
}

/// Snapshot the open-window dirs to the store so the next launch can restore
/// them. Called on `ExitRequested`. Best-effort: any store error is logged and
/// swallowed — failing to persist the layout must never block shutdown.
fn persist_window_session<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri_plugin_store::StoreExt;
    let dirs: Vec<String> = {
        let state = app.state::<OpenWindows>();
        let map = state.0.lock_safe();
        map.values().cloned().collect()
    };
    match app.store(WINDOW_SESSION_STORE) {
        Ok(store) => {
            store.set(WINDOW_SESSION_KEY, serde_json::json!(dirs));
            if let Err(e) = store.save() {
                log::warn!("failed to save window session: {e}");
            }
        }
        Err(e) => log::warn!("failed to open window-session store: {e}"),
    }
}

/// Read the last session's open-window dirs. Absent/unreadable → empty (first
/// run or a wiped store falls back to the single config-declared window).
fn read_window_session<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<String> {
    use tauri_plugin_store::StoreExt;
    let Ok(store) = app.store(WINDOW_SESSION_STORE) else {
        return Vec::new();
    };
    store
        .get(WINDOW_SESSION_KEY)
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default()
}

/// Frontend reports its window's current project dir whenever the active
/// project changes, so the on-quit snapshot reflects live state. An empty
/// `dir` records a window with no pinned project (still restored, just at the
/// default cwd).
#[tauri::command]
fn report_window_dir(label: String, dir: Option<String>, state: State<'_, OpenWindows>) {
    let normalized = dir
        .as_deref()
        .filter(|d| !d.is_empty())
        .map(normalize_dir_key)
        .unwrap_or_default();
    state.0.lock_safe().insert(label, normalized);
}

/// Normalize a project dir for use as a window-registry key: backslashes →
/// forward slashes and trailing slashes stripped, matching how the frontend
/// stores project paths. Keeps `ssh://` and other paths comparable too.
fn normalize_dir_key(dir: &str) -> String {
    let s = dir.replace('\\', "/");
    let trimmed = s.trim_end_matches('/');
    if trimmed.is_empty() {
        s
    } else {
        trimmed.to_string()
    }
}

/// Percent-encode a string for safe inclusion in a URL query component.
/// Keeps the RFC 3986 unreserved set (`A-Z a-z 0-9 - _ . ~`) verbatim and
/// `%XX`-escapes everything else — enough to carry an arbitrary filesystem path
/// through `?dir=` without pulling in a urlencoding crate.
fn encode_query_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[tauri::command]
async fn open_main_window(app: tauri::AppHandle, dir: Option<String>) -> Result<(), String> {
    spawn_main_window(&app, dir)
}

/// Spawn (or focus) a project window. Shared by the `open_main_window` command
/// and the on-launch session restore in `setup()`. Sync so it can run in the
/// non-async setup hook; window construction is synchronous anyway.
fn spawn_main_window(app: &tauri::AppHandle, dir: Option<String>) -> Result<(), String> {
    // Re-opening a project should focus its existing window rather than spawn a
    // duplicate. We track dir → label at spawn time; on lookup, validate the
    // label still maps to a live window (a closed one leaves a stale entry).
    let dir_key = dir
        .as_deref()
        .filter(|d| !d.is_empty())
        .map(normalize_dir_key);
    if let Some(key) = dir_key.as_deref() {
        let registry = app.state::<ProjectWindows>();
        let existing = registry.0.lock_safe().get(key).cloned();
        if let Some(label) = existing {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                return Ok(());
            }
            // Stale entry (window gone) — drop it and fall through to spawn.
            registry.0.lock_safe().remove(key);
        }
    }

    let n = WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("main-{n}");

    // Match the dev title suffix applied to the main window in setup().
    let title = if cfg!(debug_assertions) {
        "Terax Dev"
    } else {
        "Terax"
    };

    // A target directory is carried to the new window as a `?dir=` query param;
    // the frontend reads it (preferring it over the process-global launch dir)
    // so the window's default tab opens there. Authorize it for fs access too.
    let url_path = match dir.as_deref().filter(|d| !d.is_empty()) {
        Some(d) => {
            let _ = app.state::<workspace::WorkspaceRegistry>().authorize(d);
            format!("/?dir={}", encode_query_component(d))
        }
        None => "/".to_string(),
    };

    // Mirror the main window defined in tauri.conf.json. WebviewWindowBuilder
    // does not inherit the config window defaults, so size/chrome are restated.
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url_path.into()))
        .title(title)
        .inner_size(800.0, 600.0)
        .min_inner_size(420.0, 280.0)
        .resizable(true)
        // New windows open maximized; the primary window keeps its restored
        // size from the window-state plugin (it isn't built here).
        .maximized(true)
        .visible(false);

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    // On Linux/Windows we render our own titlebar, so drop native chrome
    // and make the window transparent.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let builder = builder.decorations(false).transparent(true);

    let window = builder.build().map_err(|e| e.to_string())?;

    #[cfg(target_os = "linux")]
    {
        let _ = window.set_decorations(false);
    }

    // Seed the open-window registry with this window's initial dir so an
    // immediate quit (before the frontend reports) still restores it. The
    // frontend later overwrites this entry via `report_window_dir` whenever the
    // active project changes.
    app.state::<OpenWindows>()
        .0
        .lock_safe()
        .insert(label.clone(), dir_key.clone().unwrap_or_default());

    // Prune both registries when the window closes. `OpenWindows` is pruned for
    // every spawned window; `ProjectWindows` only for dir-keyed ones.
    let key_for_close = dir_key.clone();
    let label_for_close = label.clone();
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { .. } = event {
            if let Some(open) = app_handle.try_state::<OpenWindows>() {
                open.0.lock_safe().remove(&label_for_close);
            }
            if let Some(key) = key_for_close.as_deref() {
                if let Some(reg) = app_handle.try_state::<ProjectWindows>() {
                    let mut map = reg.0.lock_safe();
                    if map.get(key).map(|l| l == &label_for_close).unwrap_or(false) {
                        map.remove(key);
                    }
                }
            }
        }
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Capture Rust panics before anything else can panic. The release profile
    // aborts on panic (no unwind, no message), so this hook is the only chance
    // to write a crash report to the log dir. Must precede every other init.
    crash::install_hook();

    // Force the webview onto the GPU compositing path before the runtime boots.
    // Chromium/WebKitGTK read these knobs once at startup, so this must precede
    // tauri::Builder. Without it WebView2 silently falls back to software
    // compositing on integrated GPUs / RDP / blocklisted drivers, which makes
    // the WebGL-rendered terminal janky despite WebGL "working". See gpu.rs.
    gpu::configure();

    let (cli_dir, cli_file) = parse_launch_target();
    workspace::init_launch_cwd(cli_dir.as_deref());

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Skip restoring VISIBLE — frontend calls window.show() after first
        // paint so the user never sees a transparent window-shadow flash on
        // Windows/Linux.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                // Durable, rotating file in the OS log dir (where crash.rs also
                // writes crash.log) plus stdout for dev and the webview so the
                // frontend's attachConsole() sees backend logs. KeepAll keeps
                // the prior file on rotation so a crash log isn't overwritten by
                // the next launch.
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("terax".into()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .max_file_size(5_000_000 /* 5 MB */)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyState::default())
        .manage(shell::ShellState::default())
        .manage(secrets::SecretsState::default())
        .manage(fs::watch::FsWatchState::default())
        .manage({
            let registry = workspace::WorkspaceRegistry::default();
            workspace::bootstrap_registry(&registry);
            if let Some(ref launch_dir) = cli_dir {
                let _ = registry.authorize(launch_dir);
            }
            registry
        })
        .manage(LaunchDir(Mutex::new(cli_dir)))
        .manage(LaunchFile(Mutex::new(cli_file)))
        .manage(bunqueue::BunqueueState::default())
        .manage(ssh::SshFsState::default())
        .manage(ssh::SshBgState::default())
        .manage(s3::S3State::default())
        .manage(ProjectWindows::default())
        .manage(OpenWindows::default())
        .manage(otel::OtelState::default())
        .manage(kv::KvState::default())
        .setup(|app| {
            // Window titles (incl. the dev-distinguishing " Dev" suffix and the
            // active project name) are owned by the frontend — see the title
            // effect in App.tsx. The webview overwrites the title on mount, so a
            // Rust-side dev suffix here would just be clobbered.

            // Restore the previous session's window layout: reopen one window per
            // project dir that was open at last quit. The config-declared `main`
            // window already exists, so we seed it in the open-window registry and
            // skip re-spawning the saved dir it already covers. A CLI launch dir
            // takes precedence as `main`'s dir.
            {
                let handle = app.handle();
                let main_dir = workspace::launch_cwd_snapshot()
                    .map(|p| normalize_dir_key(&modules::fs::to_canon(&p)))
                    .unwrap_or_default();
                app.state::<OpenWindows>()
                    .0
                    .lock_safe()
                    .insert("main".to_string(), main_dir.clone());

                let saved = read_window_session(handle);
                let mut skipped_main = false;
                for dir in saved {
                    let key = normalize_dir_key(&dir);
                    // Skip the first saved entry that matches `main`'s dir — that
                    // window already exists. Duplicates beyond the first are
                    // legitimately separate windows on the same project.
                    if !skipped_main && key == main_dir {
                        skipped_main = true;
                        continue;
                    }
                    let arg = if key.is_empty() { None } else { Some(key) };
                    if let Err(e) = spawn_main_window(handle, arg) {
                        log::warn!("failed to restore window: {e}");
                    }
                }
            }

            // Raise the OS timer resolution so the PTY flusher's sub-tick
            // coalesce sleep is honored instead of rounding to ~15ms (Windows).
            pty::raise_timer_resolution();

            // Self-heal: remove any stale parallel install of an older/renamed
            // product identity (Windows). Runs detached so it never blocks
            // startup. See modules/cleanup.rs for the why.
            cleanup::sweep_stale_installs();

            // Resolve a persistent SQLite path under the app data dir so the
            // queue survives restarts (bunqueue defaults to in-memory). Dev
            // builds use a separate DB file so a `tauri dev` instance and an
            // installed release (which run on different ports — see bunqueue.rs)
            // never share one SQLite file and corrupt each other's queue.
            let db_file = if cfg!(debug_assertions) {
                "queue-dev.db"
            } else {
                "queue.db"
            };
            let data_path = app
                .path()
                .app_data_dir()
                .ok()
                .map(|dir| dir.join("bunqueue").join(db_file));

            // Start the bunqueue job-queue server on boot (HTTP API + no auth,
            // persistent SQLite) — but only if the user opted in via the
            // `bunqueueEnabled` pref. Off by default. Non-fatal if Bun is
            // unavailable.
            let state = app.state::<bunqueue::BunqueueState>();
            bunqueue::set_data_path(&state, data_path);
            bunqueue::init_from_pref(app.handle(), &state);
            // Supervise: a background watchdog restarts the server/workers if
            // they die — gated on the same enabled flag, so it stays idle while
            // bunqueue is disabled.
            bunqueue::start_watchdog(app.handle().clone());

            // Start the local OTEL collector so apps can export
            // traces/logs/metrics to the in-app observability dashboard. In a
            // packaged build this spawns the `otel-collector` sidecar (which
            // owns the SQLite store + OTLP ingest + a query HTTP API) and the
            // `otel_*` commands proxy to it; in dev (no sidecar staged) it falls
            // back to an in-process store + ingest server. Non-fatal: any
            // failure degrades to an in-memory in-process store.
            let otel_state = app.state::<otel::OtelState>();
            otel::start(app.handle(), &otel_state);

            // Start the embedded Redis/Valkey-protocol KV server so the user can
            // point any standard Redis client (ioredis, redis-py, redis-cli) at
            // a local cache + pub/sub during development. Packaged: spawns the
            // `kv-server` sidecar; dev (no sidecar staged): runs in-process.
            // Off by default - only starts if the `kvEnabled` pref is set.
            // Data persists under the opened project's `.t-camelot/kv_data` dir
            // so the cache is per-project and survives restarts.
            let kv_state = app.state::<kv::KvState>();
            let kv_data_dir = workspace::launch_cwd_snapshot()
                .or_else(|| app.path().app_data_dir().ok().map(|d| d.join("kv")))
                .map(|base| base.join(".t-camelot").join("kv_data"));
            if let Some(ref dir) = kv_data_dir {
                ensure_kv_gitignore(dir);
            }
            let kv_port = read_kv_port_pref(app.handle());
            let kv_pass = read_kv_pass_pref(app.handle());
            kv::lifecycle::set_config(&kv_state, kv_port, kv_data_dir, kv_pass);
            kv::lifecycle::init_from_pref(app.handle(), &kv_state);
            kv::lifecycle::start_watchdog(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            pty::pty_close_all,
            fs::tree::list_subdirs,
            fs::tree::fs_read_dir,
            fs::file::fs_read_file,
            fs::file::fs_write_file,
            fs::file::fs_stat,
            fs::file::fs_canonicalize,
            fs::data::data_sqlite_tables,
            fs::data::data_sqlite_rows,
            fs::data::data_csv_preview,
            fs::data::data_parquet_preview,
            fs::data::data_query,
            fs::data::data_export,
            fs::mutate::fs_create_file,
            fs::mutate::fs_create_dir,
            fs::mutate::fs_rename,
            fs::mutate::fs_copy,
            fs::mutate::fs_delete,
            fs::watch::fs_watch_add,
            fs::watch::fs_watch_remove,
            fs::search::fs_search,
            fs::search::fs_list_files,
            fs::grep::fs_grep,
            fs::grep::fs_glob,
            fs::grep::fs_glob_rg,
            git::commands::git_resolve_repo,
            git::commands::git_panel_snapshot,
            git::commands::git_status,
            git::commands::git_diff,
            git::commands::git_diff_content,
            git::commands::git_stage,
            git::commands::git_unstage,
            git::commands::git_discard,
            git::commands::git_commit,
            git::commands::git_fetch,
            git::commands::git_pull_ff_only,
            git::commands::git_push,
            git::commands::git_log,
            git::commands::git_show_commit,
            git::commands::git_commit_files,
            git::commands::git_commit_file_diff,
            git::commands::git_remote_url,
            shell::shell_run_command,
            shell::shell_session_open,
            shell::shell_session_run,
            shell::shell_session_close,
            shell::shell_bg_spawn,
            shell::shell_bg_logs,
            shell::shell_bg_kill,
            shell::shell_bg_list,
            ssh::ssh_list_hosts,
            ssh::ssh_fs_connect,
            ssh::ssh_fs_read_dir,
            ssh::ssh_fs_read_file,
            ssh::ssh_fs_write_file,
            ssh::ssh_fs_create_file,
            ssh::ssh_fs_create_dir,
            ssh::ssh_fs_rename,
            ssh::ssh_fs_copy,
            ssh::ssh_fs_delete,
            ssh::ssh_fs_glob,
            ssh::ssh_fs_search,
            ssh::ssh_fs_grep,
            ssh::ssh_git_panel_snapshot,
            ssh::ssh_git_status,
            ssh::ssh_git_diff,
            ssh::ssh_git_diff_content,
            ssh::ssh_git_stage,
            ssh::ssh_git_unstage,
            ssh::ssh_git_discard,
            ssh::ssh_git_commit,
            ssh::ssh_git_log,
            ssh::ssh_git_show_commit,
            ssh::ssh_git_resolve_repo,
            ssh::ssh_git_remote_url,
            ssh::ssh_bg_spawn,
            ssh::ssh_bg_logs,
            ssh::ssh_bg_kill,
            ssh::ssh_bg_list,
            ssh::ssh_fs_disconnect,
            docker::docker_list_containers,
            docker::docker_inspect_container,
            docker::docker_logs,
            docker::docker_stats,
            workspace::wsl_list_distros,
            workspace::wsl_default_distro,
            workspace::wsl_home,
            workspace::workspace_authorize,
            workspace::workspace_current_dir,
            get_launch_dir,
            get_launch_file,
            log_renderer_error,
            open_settings_window,
            open_main_window,
            report_window_dir,
            agent::agent_enable_claude_hooks,
            agent::agent_claude_hooks_status,
            agentscan::agentscan_collect,
            ccusage::ccusage_collect,
            secrets::secrets_get,
            secrets::secrets_set,
            secrets::secrets_delete,
            secrets::secrets_get_all,
            s3::s3_list_connections,
            s3::s3_save_connection,
            s3::s3_delete_connection,
            s3::s3_list,
            s3::s3_get_object_bytes,
            s3::s3_download_to_cache,
            s3::s3_parquet_preview,
            net::lm_ping,
            net::ai_http_request,
            net::ai_http_stream,
            bunqueue::bunqueue_status,
            bunqueue::bunqueue_logs,
            bunqueue::bunqueue_restart,
            bunqueue::bunqueue_ensure,
            bunqueue::bunqueue_set_enabled,
            bunqueue::bunqueue_workers,
            otel::otel_ingest_port,
            otel::otel_counts,
            otel::otel_services,
            otel::otel_traces,
            otel::otel_trace_spans,
            otel::otel_logs,
            otel::otel_metric_names,
            otel::otel_metric_series,
            otel::otel_service_map,
            otel::otel_db_queries,
            otel::otel_attribute_keys,
            otel::otel_attr_breakdown,
            otel::otel_query,
            otel::otel_clear,
            kv::lifecycle::kv_status,
            kv::lifecycle::kv_logs,
            kv::lifecycle::kv_ensure,
            kv::lifecycle::kv_set_enabled,
            kv::lifecycle::kv_restart,
            kv::lifecycle::kv_set_port,
            kv::data::kv_data_scan,
            kv::data::kv_data_get,
            kv::data::kv_data_set,
            kv::data::kv_data_expire,
            kv::data::kv_data_del,
            kv::data::kv_data_flushdb,
            kv::data::kv_data_dbsize,
            kv::data::kv_data_publish,
            kv::data::kv_data_subscribe,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Kill the bunqueue child on shutdown so it doesn't outlive the app.
            // ServerProc::Drop also covers this, but ExitRequested fires before
            // state teardown — kill eagerly to avoid an orphaned port hold.
            if let RunEvent::ExitRequested { .. } = event {
                // Snapshot the open-window layout before teardown so the next
                // launch restores the same set of project windows.
                persist_window_session(app);
                bunqueue::shutdown(&app.state::<bunqueue::BunqueueState>());
                // Reap the otel-collector sidecar so it doesn't outlive the app
                // and keep its loopback ports bound. No-op in in-process mode.
                app.state::<otel::OtelState>().shutdown();
                // Kill the kv-server sidecar; it snapshots on its SIGTERM/Ctrl-C
                // path before exiting. No-op in in-process mode.
                kv::lifecycle::on_exit(&app.state::<kv::KvState>());
            }
        });
}
