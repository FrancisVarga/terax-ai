use std::process::Command;

#[cfg(windows)]
pub fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
#[inline]
pub fn hide_console(_cmd: &mut Command) {}

// ──────────────────────────────────────────────────────────────────────────
// Process-tree kill.
//
// A background task like `bun run dev:app` spawns a deep tree:
//   powershell ─▶ bun ─▶ turbo ─▶ N node dev servers
// Killing only the top process (`Child::kill` / `SharedChild::kill`) orphans the
// descendants — they keep running and holding ports. To stop the *whole* tree we
// group the children at spawn time and tear the group down on kill:
//   • Windows: a Job Object with KILL_ON_JOB_CLOSE; one TerminateJobObject (or
//     dropping the last handle) kills every member + descendant atomically.
//   • Unix: a new session/process-group (setsid in the child); kill(-pgid, …)
//     signals every member of the group.
// ──────────────────────────────────────────────────────────────────────────

/// Configures `cmd` so the spawned child becomes the root of an isolatable
/// process group. Must be paired with [`ProcGroup::attach`] after spawn (Windows)
/// and a [`ProcGroup`]-based kill. Call BEFORE spawning.
#[cfg(unix)]
pub fn group_on_spawn(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: `setsid` is async-signal-safe and is the only call made between
    // fork and exec. It makes the child a new session + process-group leader so
    // its descendants share the child's PID as their pgid, and a later
    // kill(-pgid) cannot reach Terax's own group.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(windows)]
pub fn group_on_spawn(_cmd: &mut Command) {
    // On Windows the grouping is a Job Object assigned AFTER spawn; nothing to
    // configure on the Command itself. See `ProcGroup::for_child`.
}

/// A handle to the OS-level process group rooted at a spawned child, used to
/// kill the entire tree. Construct with [`ProcGroup::for_child`] right after the
/// child is spawned; call [`ProcGroup::kill`] to terminate the whole group.
#[cfg(unix)]
pub struct ProcGroup {
    pgid: libc::pid_t,
}

#[cfg(unix)]
impl ProcGroup {
    /// Capture the group for an already-spawned child. The child must have been
    /// spawned with [`group_on_spawn`] so it leads its own group; the pgid
    /// equals the child's pid.
    pub fn for_child(pid: u32) -> Self {
        Self { pgid: pid as libc::pid_t }
    }

    /// Hard-kill the entire process group (SIGKILL). Negative pid targets the
    /// whole group. Best-effort: a missing group (already exited) is fine.
    pub fn kill(&self) {
        // SAFETY: FFI call with a valid signal; failure (ESRCH = group gone) is
        // ignored.
        unsafe {
            libc::kill(-self.pgid, libc::SIGKILL);
        }
    }
}

#[cfg(windows)]
pub struct ProcGroup {
    job: windows_sys::Win32::Foundation::HANDLE,
}

// The job HANDLE is owned by this struct and only used for Terminate/Close; it
// is safe to move across threads.
#[cfg(windows)]
unsafe impl Send for ProcGroup {}
#[cfg(windows)]
unsafe impl Sync for ProcGroup {}

#[cfg(windows)]
impl ProcGroup {
    /// Create a Job Object configured to kill all members when closed, then
    /// assign the child process (identified by `pid`) to it. The process handle
    /// is opened from the pid with just the rights the Job assignment needs, then
    /// closed. Returns `None` if any OS call fails, in which case the caller
    /// falls back to a single-process kill.
    pub fn for_child(pid: u32) -> Option<Self> {
        use std::ptr;
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
            JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };

        // SAFETY: standard Win32 job-object setup. Each handle/return is checked;
        // on any failure we close what we created and return None.
        unsafe {
            // Rights required to put the process into a job and to let the job's
            // KILL_ON_JOB_CLOSE / TerminateJobObject terminate it.
            let proc_handle: HANDLE =
                OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if proc_handle.is_null() {
                return None;
            }

            let job: HANDLE = CreateJobObjectW(ptr::null(), ptr::null());
            if job.is_null() {
                close(proc_handle);
                return None;
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                close(job);
                close(proc_handle);
                return None;
            }

            if AssignProcessToJobObject(job, proc_handle) == 0 {
                close(job);
                close(proc_handle);
                return None;
            }

            close(proc_handle);
            Some(Self { job })
        }
    }

    /// Terminate every process in the job (the child and all descendants).
    pub fn kill(&self) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        // SAFETY: `self.job` is a valid job handle for this process's lifetime.
        unsafe {
            TerminateJobObject(self.job, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for ProcGroup {
    fn drop(&mut self) {
        // Closing the last handle to a KILL_ON_JOB_CLOSE job also kills its
        // members, so this doubles as a safety net if `kill` was never called.
        close(self.job);
    }
}

#[cfg(windows)]
fn close(handle: windows_sys::Win32::Foundation::HANDLE) {
    use windows_sys::Win32::Foundation::CloseHandle;
    // SAFETY: closing a handle we created.
    unsafe {
        CloseHandle(handle);
    }
}
