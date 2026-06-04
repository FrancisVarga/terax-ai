//! Phase 0 spike spawner (#109 Goal A — survival).
//!
//! Launches the daemon DETACHED, then exits immediately. This models Terax
//! starting the rmux daemon: when Terax (this spawner) dies, the daemon must
//! survive. The survival test kills this process and asserts the daemon + its
//! shell are still alive.
//!
//! Usage: rmux-spike-spawner <daemon-exe> <rendezvous-file>

use std::process::Command;

#[cfg(windows)]
fn spawn_detached(daemon: &str, rendezvous: &str) -> std::process::Child {
    use std::os::windows::process::CommandExt;
    // DETACHED_PROCESS: no inherited console.
    // CREATE_NEW_PROCESS_GROUP: child not killed by parent's Ctrl-C.
    // CREATE_BREAKAWAY_FROM_JOB: if the spawner itself lives in a Job Object
    //   (e.g. launched by a parent that job-wrapped it, like terax's PTY
    //   children), the child would inherit that job and die with it. Breakaway
    //   detaches the daemon from any inherited job so it can outlive the
    //   spawner. This is the crux of the survival inversion.
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    const BASE: u32 = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;

    // Breakaway is only PERMITTED when the parent's job sets
    // JOB_OBJECT_LIMIT_BREAKAWAY_OK. If it does not (many sandboxes, and the
    // dev harness here, forbid it) CreateProcess returns ERROR_ACCESS_DENIED
    // (os error 5). Fall back to a plain detached spawn: a child in a job
    // WITHOUT kill-on-close survives parent death regardless; breakaway is only
    // needed to escape a kill-on-close job. The real daemon launcher must do
    // this same try/fallback.
    match Command::new(daemon)
        .arg(rendezvous)
        .creation_flags(BASE | CREATE_BREAKAWAY_FROM_JOB)
        .spawn()
    {
        Ok(child) => {
            eprintln!("[spawner] detached WITH breakaway-from-job");
            child
        }
        Err(e) if e.raw_os_error() == Some(5) => {
            eprintln!("[spawner] breakaway denied (parent job forbids it); retrying detached-only");
            Command::new(daemon)
                .arg(rendezvous)
                .creation_flags(BASE)
                .spawn()
                .expect("spawn detached daemon (no breakaway)")
        }
        Err(e) => panic!("spawn detached daemon: {e}"),
    }
}

#[cfg(unix)]
fn spawn_detached(daemon: &str, rendezvous: &str) -> std::process::Child {
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new(daemon);
    cmd.arg(rendezvous);
    // setsid() in the child before exec: new session + process group with no
    // controlling terminal, so it is not reaped when the spawner's session
    // ends. Equivalent of the Windows breakaway.
    unsafe {
        cmd.pre_exec(|| {
            if libc_setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd.spawn().expect("spawn detached daemon")
}

#[cfg(unix)]
fn libc_setsid() -> i32 {
    // Avoid a libc dependency for the spike: setsid is syscall-stable.
    extern "C" {
        fn setsid() -> i32;
    }
    unsafe { setsid() }
}

fn main() {
    let daemon = std::env::args()
        .nth(1)
        .expect("usage: rmux-spike-spawner <daemon-exe> <rendezvous-file>");
    let rendezvous = std::env::args().nth(2).expect("missing rendezvous arg");

    let child = spawn_detached(&daemon, &rendezvous);
    println!("[spawner] launched daemon pid={} detached; exiting", child.id());
    // Drop the Child handle WITHOUT waiting. On Unix this leaves a zombie only
    // until the parent exits; since we exit right away, init reparents the
    // (already setsid'd) daemon. The point is: no wait(), no kill-on-drop.
    std::mem::forget(child);
}
