// Debug-only binary. Identical entry point to the prod `terax` bin, but built
// as a separate exe so it doesn't fight the running prod binary for the
// target\debug file lock — and so it can be killed independently by name
// (`terax-dbg.exe`). Run with: `cargo run --bin terax-dbg`.
//
// Keep the console attached in debug so log::info! lands in the dev terminal.
fn main() {
    terax_lib::run()
}
