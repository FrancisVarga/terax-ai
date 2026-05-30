use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, MasterPty, PtySize};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter};

use super::agent_detect::AgentDetector;
use super::da_filter::DaFilter;
use super::shell_init;
#[cfg(windows)]
use crate::modules::sync::MutexExt;
use crate::modules::workspace::WorkspaceEnv;

const AGENT_EVENT: &str = "terax:agent-signal";

// The reader coalesces a short window for bursts so we send chunks, not single
// bytes (see the inline `flush` closure in `spawn`).
const FLUSH_COALESCE: Duration = Duration::from_millis(4);
// Latency-first adaptive flush: a pending buffer at/under this size is treated
// as interactive echo (a keystroke the shell bounced back) and flushed
// immediately with no coalesce sleep, so keypress→glyph isn't padded by 4ms.
// Above it, output is a burst (program writing many lines) and we coalesce for
// throughput. 512 B comfortably covers an echoed line + its prompt redraw.
const FLUSH_ECHO_THRESHOLD: usize = 512;
const READ_BUF: usize = 16 * 1024;
// Cap on buffered-but-not-yet-flushed bytes. On overflow we discard the
// entire pending buffer and emit an SGR-reset + notice in its place.
// Dropping a partial prefix would slice a CSI sequence in half and corrupt
// xterm's screen state. 4 MiB is ~1000 full 80x24 screens.
const MAX_PENDING: usize = 4 * 1024 * 1024;
// Hard reset (ESC c) + dim notice. Written verbatim into the stream when
// we're forced to discard backlog.
const OVERFLOW_NOTICE: &[u8] =
    b"\x1bc\x1b[2m[terax: dropped output due to backpressure]\x1b[0m\r\n";

pub struct Session {
    // Field drop order is intentional. Rust drops fields top-to-bottom:
    //   1. `_job` — on Windows, closing the Job HANDLE fires
    //      KILL_ON_JOB_CLOSE, terminating the pwsh tree before the master
    //      pipe drops. Without this, ClosePseudoConsole in `master`'s Drop
    //      can block waiting for conhost to drain pending output, freezing
    //      the Tauri worker thread that triggered the close.
    //   2. `killer` — best-effort kill (redundant on Windows once Job
    //      closed, but harmless and required on Unix where there is no Job).
    //   3. `writer` — closes the input side of the master pipe.
    //   4. `master` — last; ClosePseudoConsole on Windows. By now the child
    //      is dead and conhost has nothing left to drain.
    #[cfg(windows)]
    _job: Option<super::job::PtyJob>,
    pub killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub master: Mutex<Box<dyn MasterPty + Send>>,
}

impl Drop for Session {
    fn drop(&mut self) {
        // If the session Arc is dropped without an explicit pty_close (e.g.
        // frontend disconnected, window crashed, dev HMR), the reader/flusher
        // threads would otherwise stay alive forever holding the child. Kill
        // the child here so the reader hits EOF and the threads unwind.
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }
}
// Serializes ConPTY create and close: overlapping pseudoconsole lifecycle
// calls corrupt the new console so its shell never pumps output (issue #356).
#[cfg(windows)]
static CONPTY_LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn drop_session(session: Arc<Session>) {
    #[cfg(windows)]
    let _guard = CONPTY_LIFECYCLE_LOCK.lock_safe();
    drop(session);
}

struct ChildKillGuard {
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
}

impl ChildKillGuard {
    fn new(killer: Box<dyn ChildKiller + Send + Sync>) -> Self {
        Self { killer: Some(killer) }
    }

    fn disarm(&mut self) {
        self.killer = None;
    }
}

impl Drop for ChildKillGuard {
    fn drop(&mut self) {
        if let Some(mut k) = self.killer.take() {
            let _ = k.kill();
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn spawn(
    id: u32,
    app: AppHandle,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<(Arc<Session>, PtySize), String> {
    #[cfg(windows)]
    let _spawn_guard = CONPTY_LIFECYCLE_LOCK.lock_safe();

    let pty_system = native_pty_system();
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    let cmd = shell_init::build_command(cwd, workspace)?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    // Kill the child if any of the pipe setup below fails so the spawned shell
    // can't outlive an aborted pty_open.
    let mut guard = ChildKillGuard::new(child.clone_killer());
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(
        pair.master.take_writer().map_err(|e| e.to_string())?,
    ));
    guard.disarm();

    #[cfg(windows)]
    let job = match child.process_id() {
        Some(pid) => match super::job::PtyJob::create_for(pid) {
            Ok(j) => Some(j),
            Err(e) => {
                log::warn!("pty job-object setup failed for pid={pid}: {e}");
                None
            }
        },
        None => None,
    };

    let session = Arc::new(Session {
        #[cfg(windows)]
        _job: job,
        killer: Mutex::new(killer),
        writer: writer.clone(),
        master: Mutex::new(pair.master),
    });

    let spawn_at = Instant::now();

    // Single reader+flusher thread per shell. The reader owns its output buffer
    // as a thread-local `Vec` and flushes inline — no shared Mutex/Condvar and
    // no separate flusher thread (was 3 threads/shell, now 2). Removing the
    // cross-thread handoff also removes the head-of-line blocking that capped
    // throughput when many shells contended on the OS scheduler.
    let on_data_reader = on_data.clone();
    let writer_for_da = writer.clone();
    let app_reader = app.clone();
    let reader_thread = thread::Builder::new()
        .name("terax-pty-reader".into())
        .spawn(move || {
            let mut buf = [0u8; READ_BUF];
            let mut filtered: Vec<u8> = Vec::with_capacity(READ_BUF);
            // Thread-local accumulator. `flush` drains it via `mem::take`.
            let mut pending: Vec<u8> = Vec::with_capacity(READ_BUF);
            let mut da_filter = DaFilter::new();
            let mut agent_detect = AgentDetector::new();
            let mut dropped_bytes: u64 = 0;
            let mut logged_first = false;

            // Send whatever is buffered, applying the same latency-vs-throughput
            // policy the old flusher used: a small payload (interactive echo) is
            // sent immediately so keypress→glyph isn't padded; a burst pays the
            // coalesce window to batch more output into one Channel send.
            let flush = |pending: &mut Vec<u8>| -> bool {
                if pending.is_empty() {
                    return true;
                }
                if pending.len() > FLUSH_ECHO_THRESHOLD {
                    thread::sleep(FLUSH_COALESCE);
                }
                let chunk = std::mem::take(pending);
                match on_data_reader.send(Response::new(chunk)) {
                    Ok(()) => true,
                    Err(e) => {
                        log::debug!("pty reader exiting, channel closed: {e}");
                        false
                    }
                }
            };

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if !logged_first {
                            logged_first = true;
                            // Info level so the spawn-to-first-byte stopwatch is
                            // visible in shipped builds (logger runs at Info); it
                            // splits "Rust spawn slow" from "shell init slow" when
                            // diagnosing slow terminal opens.
                            log::info!("pty first byte after {}ms", spawn_at.elapsed().as_millis());
                        }
                        agent_detect.process(&buf[..n], |t| {
                            let _ = app_reader.emit(AGENT_EVENT, t.into_signal(id));
                        });
                        filtered.clear();
                        da_filter.process(&buf[..n], &mut filtered, |reply| {
                            if let Ok(mut w) = writer_for_da.lock() {
                                let _ = w.write_all(reply);
                            }
                        });
                        if filtered.is_empty() {
                            continue;
                        }
                        if pending.len() + filtered.len() > MAX_PENDING {
                            dropped_bytes += pending.len() as u64;
                            pending.clear();
                            pending.extend_from_slice(OVERFLOW_NOTICE);
                        }
                        pending.extend_from_slice(&filtered);
                        if !flush(&mut pending) {
                            break;
                        }
                    }
                    Err(e) => {
                        log::debug!("pty reader ended: {e}");
                        break;
                    }
                }
            }
            agent_detect.finish(|t| {
                let _ = app_reader.emit(AGENT_EVENT, t.into_signal(id));
            });
            // Final drain on EOF: the reader owns the buffer, so it sends the
            // tail itself. The waiter joins this thread before emitting the exit
            // code, so the last byte never races the Exit event.
            flush(&mut pending);
            if dropped_bytes > 0 {
                log::warn!("pty backpressure: dropped {dropped_bytes} bytes (cap {MAX_PENDING})");
            }
        })
        .map_err(|e| {
            // Session's Drop kills the child, so returning here can't leak it.
            format!("spawn pty reader thread: {e}")
        })?;

    thread::Builder::new()
        .name("terax-pty-waiter".into())
        .spawn(move || {
            let code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(e) => {
                    log::warn!("pty child wait failed: {e}");
                    -1
                }
            };
            // Wait for the reader to finish (it flushes its own tail on EOF)
            // before emitting the exit code, so the last line of output never
            // races the Exit event.
            #[cfg(windows)]
            {
                // On Windows the master pipe can lag the child exit, so we don't
                // block the waiter indefinitely on `join`; poll briefly instead.
                let deadline = Instant::now() + Duration::from_millis(50);
                while Instant::now() < deadline && !reader_thread.is_finished() {
                    thread::sleep(Duration::from_millis(5));
                }
            }
            #[cfg(not(windows))]
            if let Err(e) = reader_thread.join() {
                log::error!("pty reader thread panicked: {e:?}");
            }
            if let Err(e) = on_exit.send(code) {
                log::debug!("pty exit send failed (channel closed): {e}");
            }
        })
        .map_err(|e| format!("spawn pty waiter thread: {e}"))?;

    Ok((session, size))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use portable_pty::CommandBuilder;

    #[test]
    fn drop_kills_child_process() {
        let pty_system = native_pty_system();
        let size = PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system.openpty(size).expect("openpty");

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("sleep 30");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        let killer = child.clone_killer();
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(pair.master.take_writer().expect("writer")));

        let session = Arc::new(Session {
            killer: Mutex::new(killer),
            writer,
            master: Mutex::new(pair.master),
        });

        assert!(
            child.try_wait().unwrap().is_none(),
            "child must be alive before drop",
        );

        drop(session);

        let deadline = Instant::now() + Duration::from_secs(2);
        let mut exited = false;
        while Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                exited = true;
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(exited, "child still running 2s after Session drop");
    }

    #[test]
    fn drop_session_succeeds_after_child_already_exited() {
        let pty_system = native_pty_system();
        let size = PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system.openpty(size).expect("openpty");

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("exit 0");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let _ = child.wait();

        let killer = child.clone_killer();
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(pair.master.take_writer().expect("writer")));

        let session = Arc::new(Session {
            killer: Mutex::new(killer),
            writer,
            master: Mutex::new(pair.master),
        });

        drop_session(session);
    }
}
