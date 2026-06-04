//! Output sink abstraction for a PTY session (#110).
//!
//! `session::spawn` historically wrote straight to two Tauri `Channel`s and
//! called `app.emit` for agent signals. That hard-wires the in-process Tauri
//! transport into the spawn hot path and blocks reusing the same shell-spawning
//! code from the out-of-process rmux daemon.
//!
//! `PtyOutputSink` is the seam. The reader/waiter threads push through it; the
//! caller chooses the impl. `TauriChannelSink` reproduces the original behavior
//! exactly (it IS the production path); the rmux daemon supplies its own SSE
//! sink. Mirrors the `otel::IngestSink` pattern (modules/otel/ingest.rs:56).

use super::agent_detect::AgentSignal;

/// Three outbound channels of a live PTY: raw output bytes, agent-detector
/// transitions, and the final exit code. Implementors must be cheap to call
/// from the reader thread's hot loop.
///
/// NOTE: this is strictly the OUTBOUND path. The DA-filter's reply (the
/// terminal answering a device-attributes query) is written back into the PTY
/// *writer* inside `spawn` and is intentionally NOT routed here.
pub trait PtyOutputSink: Send + Sync + 'static {
    /// A chunk of shell output, already DA-filtered and coalesced.
    fn data(&self, bytes: Vec<u8>);
    /// An agent-detector state transition (OSC 133/777 driven).
    fn agent(&self, signal: AgentSignal);
    /// The child exited; `code` is its exit status (-1 if unknowable). Called
    /// once, after the reader has drained its tail.
    fn exit(&self, code: i32);
}

/// Production sink: the original in-process Tauri transport. Output and exit go
/// to the two `Channel`s `pty_open` was handed; agent signals are emitted as the
/// `terax:agent-signal` app event. Constructing this in `pty_open` makes the
/// flag-off path byte-identical to the pre-refactor code.
pub struct TauriChannelSink {
    app: tauri::AppHandle,
    on_data: tauri::ipc::Channel<tauri::ipc::Response>,
    on_exit: tauri::ipc::Channel<i32>,
}

impl TauriChannelSink {
    pub fn new(
        app: tauri::AppHandle,
        on_data: tauri::ipc::Channel<tauri::ipc::Response>,
        on_exit: tauri::ipc::Channel<i32>,
    ) -> Self {
        Self { app, on_data, on_exit }
    }
}

impl PtyOutputSink for TauriChannelSink {
    fn data(&self, bytes: Vec<u8>) {
        if let Err(e) = self.on_data.send(tauri::ipc::Response::new(bytes)) {
            log::debug!("pty reader: data channel closed: {e}");
        }
    }

    fn agent(&self, signal: AgentSignal) {
        use tauri::Emitter;
        let _ = self.app.emit(super::session::AGENT_EVENT, signal);
    }

    fn exit(&self, code: i32) {
        if let Err(e) = self.on_exit.send(code) {
            log::debug!("pty exit send failed (channel closed): {e}");
        }
    }
}
