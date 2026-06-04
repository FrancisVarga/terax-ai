//! Phase 0 spike daemon (#109 Goal A — survival).
//!
//! Opens ONE pty shell, owns it (Windows: via its own Job Object), and serves
//! the shell's output bytes to any loopback TCP client. Writes `{port}\n{pid}`
//! to a rendezvous file so the spawner/test harness can find it and so a test
//! can read the shell PID to assert reaping.
//!
//! The point: this process is launched DETACHED by the spawner. When the
//! spawner dies, this daemon and its shell must keep running. When THIS daemon
//! is killed, the Job Object must reap the shell (no orphan).
//!
//! Usage: rmux-spike-daemon <rendezvous-file>

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

#[cfg(windows)]
mod job;

// Mirrors pty/session.rs drop order: `_job` (Windows) drops before `master` so
// KILL_ON_JOB_CLOSE fires before ClosePseudoConsole tries to drain conhost.
struct Shell {
    #[cfg(windows)]
    _job: Option<job::PtyJob>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
}

impl Drop for Shell {
    fn drop(&mut self) {
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }
}

fn default_shell() -> CommandBuilder {
    #[cfg(windows)]
    {
        // pwsh if present, else powershell, else cmd — matches terax priority.
        for exe in ["pwsh.exe", "powershell.exe"] {
            if which(exe).is_some() {
                let mut c = CommandBuilder::new(exe);
                c.args(["-NoLogo", "-NoProfile"]);
                return c;
            }
        }
        CommandBuilder::new("cmd.exe")
    }
    #[cfg(unix)]
    {
        let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        CommandBuilder::new(sh)
    }
}

#[cfg(windows)]
fn which(exe: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(exe))
        .find(|p| p.is_file())
}

fn main() {
    let rendezvous = std::env::args()
        .nth(1)
        .expect("usage: rmux-spike-daemon <rendezvous-file>");

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty");

    let child = pair
        .slave
        .spawn_command(default_shell())
        .expect("spawn shell");
    let child_pid = child.process_id();

    #[cfg(windows)]
    let job = child_pid.and_then(|pid| job::PtyJob::create_for(pid).ok());

    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().expect("clone reader");

    let shell = Arc::new(Shell {
        #[cfg(windows)]
        _job: job,
        killer: Mutex::new(killer),
        master: Mutex::new(pair.master),
    });

    // Drive the shell: write a marker command so there's observable output.
    {
        let mut w = shell.master.lock().unwrap().take_writer().expect("writer");
        let _ = w.write_all(b"echo RMUX_SPIKE_ALIVE\r");
        let _ = w.flush();
    }

    // Broadcast pty bytes to all connected TCP clients (the transport-A
    // primitive: a fan-out byte stream). A Mutex<Vec<TcpStream>> is enough for
    // a spike.
    let clients: Arc<Mutex<Vec<std::net::TcpStream>>> = Arc::new(Mutex::new(Vec::new()));

    {
        let clients = clients.clone();
        let shell_for_exit = shell.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // shell exited
                    Ok(n) => {
                        let chunk = &buf[..n];
                        let mut guard = clients.lock().unwrap();
                        guard.retain_mut(|c| c.write_all(chunk).and_then(|_| c.flush()).is_ok());
                    }
                    Err(_) => break,
                }
            }
            // Shell EOF: keep the shell handle so its Job survives until process
            // exit, but note exit for observers. The daemon stays up so the
            // survival window can be observed; a real daemon would mark the pane
            // dead and await kill-server.
            drop(shell_for_exit);
        });
    }

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().unwrap().port();

    // Rendezvous: {daemon_pid}\n{listen_port}\n{shell_pid}
    let me = std::process::id();
    let shell_pid = child_pid.unwrap_or(0);
    std::fs::write(&rendezvous, format!("{me}\n{port}\n{shell_pid}\n")).expect("write rendezvous");
    eprintln!("[daemon] pid={me} port={port} shell_pid={shell_pid}");

    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                clients.lock().unwrap().push(stream);
            }
            Err(_) => thread::sleep(Duration::from_millis(50)),
        }
    }
}
