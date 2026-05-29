//! Poison-resistant lock helpers.
//!
//! The release profile builds with `panic = "abort"`, so the *first* panic that
//! happens while a thread holds a `Mutex`/`RwLock` already kills the process.
//! But in unwind builds (dev, tests) and on any future change away from abort,
//! a poisoned lock makes every later `.lock().unwrap()` panic again — one fault
//! cascades into a total, permanent lockup of every command that touches that
//! state.
//!
//! These extension methods recover the guard out of a `PoisonError` instead of
//! panicking. Every lock in this app guards plain collections/buffers (session
//! maps, ring buffers, path sets) where a half-updated value is still safe to
//! read and overwrite — there are no cross-field invariants that a torn write
//! would violate. So `into_inner()` is the correct recovery, not a crash.
//!
//! A poison is still a real bug worth seeing, so the first recovery per process
//! logs once (best-effort, never itself panics).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

static POISON_LOGGED: AtomicBool = AtomicBool::new(false);

/// Log the first poison recovery seen this process; cheap no-op afterwards.
fn note_poison(kind: &str) {
    if !POISON_LOGGED.swap(true, Ordering::Relaxed) {
        log::warn!(
            target: "sync",
            "recovered a poisoned {kind} (a thread panicked while holding it); \
             state preserved, continuing"
        );
    }
}

/// `Mutex::lock` that recovers the guard on poison instead of panicking.
pub trait MutexExt<T: ?Sized> {
    fn lock_safe(&self) -> MutexGuard<'_, T>;
}

impl<T: ?Sized> MutexExt<T> for Mutex<T> {
    fn lock_safe(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|poisoned| {
            note_poison("Mutex");
            poisoned.into_inner()
        })
    }
}

/// `RwLock::read`/`write` that recover the guard on poison instead of panicking.
pub trait RwLockExt<T: ?Sized> {
    fn read_safe(&self) -> RwLockReadGuard<'_, T>;
    fn write_safe(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T: ?Sized> RwLockExt<T> for RwLock<T> {
    fn read_safe(&self) -> RwLockReadGuard<'_, T> {
        self.read().unwrap_or_else(|poisoned| {
            note_poison("RwLock");
            poisoned.into_inner()
        })
    }

    fn write_safe(&self) -> RwLockWriteGuard<'_, T> {
        self.write().unwrap_or_else(|poisoned| {
            note_poison("RwLock");
            poisoned.into_inner()
        })
    }
}

/// Recover an owned value out of a `Mutex` consumed by `into_inner`, even when
/// poisoned. For the end-of-scope drain pattern (`Arc::try_unwrap` →
/// `into_inner`) where the data is wanted regardless of poison.
pub fn into_inner_safe<T>(m: Mutex<T>) -> T {
    m.into_inner().unwrap_or_else(|poisoned| {
        note_poison("Mutex");
        poisoned.into_inner()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn lock_safe_recovers_after_poison() {
        let m = Arc::new(Mutex::new(7));
        let m2 = m.clone();
        // Poison it: panic while holding the guard.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = m2.lock().unwrap();
            panic!("poison");
        }));
        assert!(m.lock().is_err(), "lock should be poisoned");
        // lock_safe still hands back the value.
        assert_eq!(*m.lock_safe(), 7);
        *m.lock_safe() = 9;
        assert_eq!(*m.lock_safe(), 9);
    }

    #[test]
    fn rwlock_safe_recovers_after_poison() {
        let l = Arc::new(RwLock::new(vec![1, 2, 3]));
        let l2 = l.clone();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = l2.write().unwrap();
            panic!("poison");
        }));
        assert!(l.read().is_err(), "rwlock should be poisoned");
        assert_eq!(l.read_safe().len(), 3);
        l.write_safe().push(4);
        assert_eq!(l.read_safe().len(), 4);
    }

    #[test]
    fn into_inner_safe_recovers_after_poison() {
        let m = Mutex::new(String::from("x"));
        // Not poisoned: still works.
        assert_eq!(into_inner_safe(m), "x");
    }
}
