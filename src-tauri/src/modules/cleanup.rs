//! Startup self-heal for stale parallel installs (Windows).
//!
//! Terax shipped under several product identities across releases
//! (`terax-ai-camelot`, `Terax-Camelot`, `Terax`) and across two bundle
//! formats (MSI in `Program Files`, NSIS in `%LOCALAPPDATA%`). Because Tauri
//! derives the WiX `UpgradeCode` and the NSIS shortcut/install dir from
//! `productName`, every rename produced a brand-new product the installer
//! treated as unrelated — so updates installed *alongside* the old copy
//! instead of replacing it. The user ended up with 3-4 parallel installs and
//! launched a stale one from Start search.
//!
//! This module runs on every launch: it scans the Windows uninstall registry
//! for any Terax/Camelot install whose files live somewhere OTHER than the
//! currently-running executable's directory, and silently uninstalls them.
//! Running it post-relaunch means an update that *again* drifts identity still
//! self-heals — the new copy removes the one it replaced.
//!
//! Non-Windows targets compile this to a no-op.

#[cfg(target_os = "windows")]
mod imp {
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    // Suppress the console window children would otherwise flash in a GUI app.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// Registry roots that hold per-machine and per-user uninstall entries.
    /// 32-bit (WOW6432Node) is listed explicitly because `reg query` does not
    /// reflect it from the 64-bit view.
    const UNINSTALL_ROOTS: &[&str] = &[
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    ];

    struct Install {
        display_name: String,
        install_location: Option<PathBuf>,
        /// QuietUninstallString preferred; falls back to UninstallString.
        uninstall: String,
        quiet: bool,
    }

    /// Best-effort: returns true if this DisplayName is one of our products.
    /// Kept narrow so we never touch an unrelated app that merely contains
    /// "terax" in some field.
    fn is_ours(display_name: &str) -> bool {
        let n = display_name.to_ascii_lowercase();
        n == "terax"
            || n == "terax-camelot"
            || n == "terax-ai-camelot"
            || n.starts_with("terax ")
            || n.starts_with("terax-")
    }

    /// Run `reg query <root> /s` and split into per-subkey blocks. Each block
    /// starts with the full key path line. Returns raw block text.
    fn query_root(root: &str) -> Vec<String> {
        let out = Command::new("reg")
            .args(["query", root, "/s"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let Ok(out) = out else { return Vec::new() };
        if !out.status.success() {
            return Vec::new();
        }
        let text = String::from_utf8_lossy(&out.stdout);
        // Subkey paths begin with the root prefix; blocks are separated by them.
        let mut blocks = Vec::new();
        let mut current = String::new();
        for line in text.lines() {
            if line.starts_with(root) {
                if !current.is_empty() {
                    blocks.push(std::mem::take(&mut current));
                }
            }
            current.push_str(line);
            current.push('\n');
        }
        if !current.is_empty() {
            blocks.push(current);
        }
        blocks
    }

    /// Pull a REG_SZ value out of a `reg query` block. Lines look like:
    /// `    DisplayName    REG_SZ    Terax`
    fn value(block: &str, name: &str) -> Option<String> {
        for line in block.lines() {
            let trimmed = line.trim_start();
            if let Some(rest) = trimmed.strip_prefix(name) {
                let rest = rest.trim_start();
                // Expect a type token (REG_SZ / REG_EXPAND_SZ) then the data.
                if let Some(after_type) = rest
                    .strip_prefix("REG_SZ")
                    .or_else(|| rest.strip_prefix("REG_EXPAND_SZ"))
                {
                    let v = after_type.trim();
                    if !v.is_empty() {
                        return Some(v.to_string());
                    }
                }
            }
        }
        None
    }

    fn parse_block(block: &str) -> Option<Install> {
        let display_name = value(block, "DisplayName")?;
        if !is_ours(&display_name) {
            return None;
        }
        let quiet_str = value(block, "QuietUninstallString");
        let raw = value(block, "UninstallString");
        let (uninstall, quiet) = match (quiet_str, raw) {
            (Some(q), _) => (q, true),
            (None, Some(r)) => (r, false),
            _ => return None,
        };
        let install_location = value(block, "InstallLocation")
            .map(|s| PathBuf::from(s.trim_matches('"')))
            .filter(|p| !p.as_os_str().is_empty());
        Some(Install {
            display_name,
            install_location,
            uninstall,
            quiet,
        })
    }

    /// Normalize a dir for comparison: lowercased, trailing separators stripped.
    fn norm(p: &Path) -> String {
        p.to_string_lossy()
            .to_ascii_lowercase()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_string()
    }

    /// Does this install point at the same directory we're running from?
    /// If so it's the current install — never uninstall ourselves.
    fn is_self(install: &Install, self_dir: &Path) -> bool {
        let Some(loc) = install.install_location.as_ref() else {
            // No InstallLocation — can't prove it's foreign, so play safe and
            // skip it rather than risk removing the live install.
            return true;
        };
        let a = norm(loc);
        let b = norm(self_dir);
        a == b || a.starts_with(&b) || b.starts_with(&a)
    }

    /// Build the silent uninstall command. MSI strings look like
    /// `MsiExec.exe /X{GUID}` → append `/qn /norestart`. NSIS strings are a
    /// path to `uninstall.exe` → append `/S`.
    fn silent_command(install: &Install) -> Option<(String, Vec<String>)> {
        if install.quiet {
            // QuietUninstallString is already silent; run it via cmd so any
            // embedded args/quotes are honored.
            return Some(("cmd".into(), vec!["/C".into(), install.uninstall.clone()]));
        }
        let lower = install.uninstall.to_ascii_lowercase();
        if lower.contains("msiexec") {
            // Extract the `/X{GUID}` (or `/I{GUID}`) product token.
            let guid = install
                .uninstall
                .split_whitespace()
                .find(|t| t.starts_with("/X") || t.starts_with("/x") || t.starts_with("/I"));
            if let Some(tok) = guid {
                let product = tok[2..].to_string();
                return Some((
                    "msiexec".into(),
                    vec!["/X".into(), product, "/qn".into(), "/norestart".into()],
                ));
            }
            None
        } else if lower.contains("uninstall.exe") || lower.contains("uninst") {
            // NSIS uninstaller — path may be quoted.
            let path = install.uninstall.trim_matches('"').to_string();
            Some((path, vec!["/S".into()]))
        } else {
            None
        }
    }

    pub fn sweep() {
        let self_exe = match std::env::current_exe() {
            Ok(p) => p,
            Err(_) => return,
        };
        let self_dir = match self_exe.parent() {
            Some(d) => d.to_path_buf(),
            None => return,
        };

        let mut seen = std::collections::HashSet::new();
        for root in UNINSTALL_ROOTS {
            for block in query_root(root) {
                let Some(install) = parse_block(&block) else {
                    continue;
                };
                if is_self(&install, &self_dir) {
                    continue;
                }
                // Dedup by uninstall string (HKLM 64/32 views can repeat).
                if !seen.insert(install.uninstall.clone()) {
                    continue;
                }
                let Some((program, args)) = silent_command(&install) else {
                    continue;
                };
                tauri_plugin_log::log::info!(
                    target: "cleanup",
                    "removing stale install '{}' at {:?}",
                    install.display_name,
                    install.install_location
                );
                let status = Command::new(&program)
                    .args(&args)
                    .creation_flags(CREATE_NO_WINDOW)
                    .status();
                match status {
                    Ok(s) if s.success() => tauri_plugin_log::log::info!(
                        target: "cleanup",
                        "removed stale install '{}'",
                        install.display_name
                    ),
                    Ok(s) => tauri_plugin_log::log::warn!(
                        target: "cleanup",
                        "uninstall of '{}' exited with {:?} (machine-scope MSI may need elevation)",
                        install.display_name,
                        s.code()
                    ),
                    Err(e) => tauri_plugin_log::log::warn!(
                        target: "cleanup",
                        "uninstall of '{}' failed to launch: {e}",
                        install.display_name
                    ),
                }
            }
        }
    }
}

/// Remove stale parallel installs of older/renamed product identities. Runs in
/// a detached background thread so it never blocks startup or window paint.
/// No-op on non-Windows targets.
pub fn sweep_stale_installs() {
    #[cfg(target_os = "windows")]
    {
        std::thread::spawn(|| {
            imp::sweep();
        });
    }
}
