//! Phase 0 spike bench (#109 Goal B — transport latency).
//!
//! Measures end-to-end byte latency for Transport A's primitive: pty output ->
//! daemon reader -> loopback TCP -> client. Floods the shell with a large
//! output burst and times first-byte and total-drain latency. This is the
//! signal for "is loopback streaming fast enough, or do we need native pipes".
//!
//! Self-contained: opens its own pty + loopback stream in-process (same code
//! path as the daemon's reader fan-out) so it runs without the spawner.
//!
//! Usage: rmux-spike-bench [flood_lines]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread;
use std::time::Instant;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

fn shell() -> CommandBuilder {
    #[cfg(windows)]
    {
        for exe in ["pwsh.exe", "powershell.exe"] {
            if std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                .any(|d| d.join(exe).is_file())
            {
                let mut c = CommandBuilder::new(exe);
                c.args(["-NoLogo", "-NoProfile"]);
                return c;
            }
        }
        CommandBuilder::new("cmd.exe")
    }
    #[cfg(unix)]
    {
        CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()))
    }
}

fn main() {
    let flood_lines: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(50_000);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty");
    let mut child = pair.slave.spawn_command(shell()).expect("spawn");
    let mut reader = pair.master.try_clone_reader().expect("reader");
    let mut writer = pair.master.take_writer().expect("writer");

    // Loopback fan-out, identical shape to daemon.rs.
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    let mut client = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    client.set_nodelay(true).ok();
    let (server_stream, _) = listener.accept().expect("accept");
    let server_stream = std::sync::Arc::new(std::sync::Mutex::new(server_stream));

    let pump = server_stream.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let mut s = pump.lock().unwrap();
                    if s.write_all(&buf[..n]).and_then(|_| s.flush()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Marker-delimited flood. Write a sentinel, then the flood, then a sentinel.
    // Measure from flood-start to last-sentinel-received.
    let (tx, rx) = mpsc::channel::<(Instant, usize)>();
    thread::spawn(move || {
        let mut buf = [0u8; 64 * 1024];
        let mut total = 0usize;
        let mut first: Option<Instant> = None;
        loop {
            match client.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if first.is_none() {
                        first = Some(Instant::now());
                    }
                    total += n;
                    let slice = &buf[..n];
                    if slice.windows(13).any(|w| w == b"RMUX_END_4242") {
                        tx.send((first.unwrap(), total)).ok();
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // The shell ECHOES the typed command back over the PTY, so the END
    // sentinel must NOT appear verbatim in the command text or the reader
    // matches the echo and stops before the flood runs. Build it from two
    // halves the echo can't reassemble into the contiguous match string.
    #[cfg(windows)]
    let flood = format!(
        "$line='x'*80; 1..{flood_lines} | ForEach-Object {{ $line }}; ('RMUX_END'+'_4242')\r"
    );
    #[cfg(unix)]
    let flood = format!(
        "L=$(printf 'x%.0s' $(seq 1 80)); for i in $(seq 1 {flood_lines}); do echo \"$L\"; done; echo \"RMUX_END\"\"_4242\"\n"
    );

    let start = Instant::now();
    writer.write_all(flood.as_bytes()).expect("write flood");
    writer.flush().ok();

    let (first_byte_at, total_bytes) = rx
        .recv_timeout(std::time::Duration::from_secs(60))
        .expect("flood did not complete in 60s");
    let elapsed = start.elapsed();
    let first_latency = first_byte_at.duration_since(start);

    let _ = child.kill();

    let mib = total_bytes as f64 / (1024.0 * 1024.0);
    let secs = elapsed.as_secs_f64();
    println!("--- rmux-spike transport-A bench ---");
    println!("flood_lines   : {flood_lines}");
    println!("bytes_received: {total_bytes} ({mib:.2} MiB)");
    println!("first_byte    : {:.2} ms", first_latency.as_secs_f64() * 1000.0);
    println!("total_drain   : {:.2} ms", secs * 1000.0);
    println!("throughput    : {:.1} MiB/s", mib / secs);
}
