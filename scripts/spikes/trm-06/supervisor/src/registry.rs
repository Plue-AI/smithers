//! Owned session lifecycle, independent of SSH channel and first-process exit.
use std::collections::BTreeMap;
use std::io;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Pty,
    Exec,
    Sftp,
    Tcp,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Owner {
    Ben,
    Agent,
}
#[derive(Debug, PartialEq)]
pub enum Selector {
    User(Owner),
    Run(String),
}

/// Kernel adapter holds cgroup descriptors and process-group/stdin handles.
/// drain must issue all kills then observe every populated=0 with one deadline.
pub trait Resources {
    fn startup(&mut self) -> io::Result<()>;
    fn close(&mut self, id: &str, kind: Kind) -> io::Result<()>;
    fn drain(&mut self, ids: &[String]) -> io::Result<()>;
}
struct Entry {
    owner: Owner,
    kind: Kind,
    run: Option<String>,
    detached: Option<Instant>,
    closed: bool,
}
pub struct Registry<R> {
    resources: R,
    sessions: BTreeMap<String, Entry>,
    next: u64,
    admitting: bool,
    ben_revoked: bool,
}
fn refused() -> io::Error {
    io::Error::other("session ownership or startup barrier refused")
}
impl<R: Resources> Registry<R> {
    pub fn start(mut resources: R) -> io::Result<Self> {
        resources.startup()?;
        let mut seed = [0; 8];
        getrandom::fill(&mut seed)
            .map_err(|_| io::Error::other("session identity entropy unavailable"))?;
        Ok(Self {
            resources,
            sessions: BTreeMap::new(),
            // A new daemon must not reuse IDs an old stream can reattach to.
            next: u64::from_ne_bytes(seed) & 0x7fff_ffff_ffff_ffff,
            admitting: true,
            ben_revoked: false,
        })
    }
    /// Reserve before spawn, so failures can never lose a populated group.
    pub fn reserve(&mut self, owner: Owner, kind: Kind, run: Option<String>) -> io::Result<String> {
        if self.sessions.len() >= 256
            || !self.admitting
            || (owner == Owner::Ben && self.ben_revoked)
            || (owner == Owner::Ben && run.is_some())
            || run.as_ref().is_some_and(|r| {
                r.is_empty()
                    || r.len() > 64
                    || !r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
        {
            return Err(refused());
        }
        self.next = self.next.checked_add(1).ok_or_else(refused)?;
        let id = format!("s-{:016x}", self.next);
        self.sessions.insert(
            id.clone(),
            Entry {
                owner,
                kind,
                run,
                detached: None,
                closed: false,
            },
        );
        Ok(id)
    }
    /// Only for a failed spawn. Resources must drain any group that was made;
    /// a failed reservation with no group is a no-op in the kernel adapter.
    pub fn abort(&mut self, id: &str) -> io::Result<()> {
        if !self.sessions.contains_key(id) {
            return Err(refused());
        }
        self.resources.drain(&[id.to_owned()])?;
        self.sessions.remove(id);
        Ok(())
    }
    pub fn resources(&mut self) -> &mut R {
        &mut self.resources
    }
    fn owned(&mut self, owner: Owner, id: &str) -> io::Result<&mut Entry> {
        self.sessions
            .get_mut(id)
            .filter(|s| s.owner == owner)
            .ok_or_else(refused)
    }
    pub fn close(&mut self, owner: Owner, id: &str) -> io::Result<()> {
        let entry = self.owned(owner, id)?;
        if entry.closed {
            return Ok(());
        }
        let kind = entry.kind;
        self.resources.close(id, kind)?;
        self.sessions.get_mut(id).unwrap().closed = true;
        Ok(()) // keep owned cgroup until an acknowledged drain, including exec exit
    }
    pub fn detach(&mut self, owner: Owner, id: &str, now: Instant) -> io::Result<()> {
        let entry = self.owned(owner, id)?;
        // Duplicate disconnect cannot extend the grace window.
        entry.detached.get_or_insert(now);
        Ok(())
    }
    /// Transport teardown can race a successful kill/restart. A removed entry
    /// is already drained; an entry still present must retain its owner check.
    pub fn detach_if_present(&mut self, owner: Owner, id: &str, now: Instant) -> io::Result<()> {
        if self.sessions.contains_key(id) {
            self.detach(owner, id, now)?;
        }
        Ok(())
    }
    pub fn attach(&mut self, owner: Owner, id: &str, now: Instant) -> io::Result<()> {
        let entry = self.owned(owner, id)?;
        if entry.closed
            || entry
                .detached
                .is_none_or(|at| now.saturating_duration_since(at) >= Duration::from_secs(30))
        {
            return Err(refused());
        }
        entry.detached = None;
        Ok(())
    }
    pub fn expire(&mut self, now: Instant) -> io::Result<()> {
        let ids: Vec<_> = self
            .sessions
            .iter()
            .filter(|(_, s)| {
                !s.closed
                    && s.detached.is_some_and(|at| {
                        now.saturating_duration_since(at) >= Duration::from_secs(30)
                    })
            })
            .map(|(id, s)| (id.clone(), s.owner))
            .collect();
        for (id, owner) in ids {
            self.close(owner, &id)?;
        }
        Ok(())
    }
    /// Fence before draining. A parsed open waiting on the supervisor mutex
    /// must not create a new Ben process after a revocation receipt.
    pub fn revoke_ben(&mut self) -> io::Result<()> {
        self.ben_revoked = true;
        self.kill(Selector::User(Owner::Ben))
    }
    pub fn kill(&mut self, selector: Selector) -> io::Result<()> {
        let ids: Vec<_> = self
            .sessions
            .iter()
            .filter(|(_, s)| match &selector {
                Selector::User(owner) => s.owner == *owner,
                Selector::Run(run) => s.run.as_ref() == Some(run),
            })
            .map(|(id, _)| id.clone())
            .collect();
        // Keep all ownership on error: no successful reply or forgotten orphan.
        self.resources.drain(&ids)?;
        for id in ids {
            self.sessions.remove(&id);
        }
        Ok(())
    }
    pub fn restart(&mut self) -> io::Result<()> {
        self.admitting = false;
        self.resources.startup()?;
        self.sessions.clear();
        self.admitting = true;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Kernel {
        events: Vec<String>,
        fail: bool,
    }
    impl Resources for Kernel {
        fn startup(&mut self) -> io::Result<()> {
            self.events.push("startup".into());
            if self.fail { Err(refused()) } else { Ok(()) }
        }
        fn close(&mut self, id: &str, kind: Kind) -> io::Result<()> {
            self.events.push(format!("close {id} {kind:?}"));
            if self.fail { Err(refused()) } else { Ok(()) }
        }
        fn drain(&mut self, ids: &[String]) -> io::Result<()> {
            self.events.push(format!("drain {}", ids.join(",")));
            if self.fail { Err(refused()) } else { Ok(()) }
        }
    }
    #[test]
    fn closed_exec_and_background_children_remain_owned_until_drain() {
        let mut r = Registry::start(Kernel::default()).unwrap();
        let ben = r.reserve(Owner::Ben, Kind::Exec, None).unwrap();
        let agent = r
            .reserve(Owner::Agent, Kind::Pty, Some("run-1".into()))
            .unwrap();
        assert!(r.close(Owner::Agent, &ben).is_err());
        r.close(Owner::Ben, &ben).unwrap();
        r.close(Owner::Ben, &ben).unwrap();
        assert_eq!(r.resources.events.len(), 2);
        r.resources.fail = true;
        assert!(r.kill(Selector::User(Owner::Ben)).is_err());
        assert_eq!(r.sessions.len(), 2);
        r.resources.fail = false;
        r.kill(Selector::User(Owner::Ben)).unwrap();
        assert!(!r.sessions.contains_key(&ben));
        assert!(r.sessions.contains_key(&agent));
        r.kill(Selector::Run("run-1".into())).unwrap();
        assert!(r.sessions.is_empty());
    }
    #[test]
    fn restart_failure_closes_admission_without_forgetting_ownership() {
        let mut r = Registry::start(Kernel::default()).unwrap();
        let old = r.reserve(Owner::Ben, Kind::Pty, None).unwrap();
        r.resources.fail = true;
        assert!(r.restart().is_err());
        assert_eq!(r.sessions.len(), 1);
        assert!(r.reserve(Owner::Ben, Kind::Exec, None).is_err());
        r.resources.fail = false;
        r.restart().unwrap();
        assert!(r.sessions.is_empty());
        assert_ne!(r.reserve(Owner::Ben, Kind::Exec, None).unwrap(), old);
        assert!(
            Registry::start(Kernel {
                fail: true,
                ..Default::default()
            })
            .is_err()
        );
    }
    #[test]
    fn transport_teardown_after_drain_does_not_recreate_ownership() {
        let mut r = Registry::start(Kernel::default()).unwrap();
        let id = r.reserve(Owner::Ben, Kind::Exec, None).unwrap();
        assert!(
            r.detach_if_present(Owner::Agent, &id, Instant::now())
                .is_err()
        );
        r.kill(Selector::User(Owner::Ben)).unwrap();
        r.detach_if_present(Owner::Ben, &id, Instant::now())
            .unwrap();
        assert!(r.sessions.is_empty());
    }
    #[test]
    fn thirty_second_grace_has_exact_boundary_and_cannot_be_extended() {
        let mut r = Registry::start(Kernel::default()).unwrap();
        let now = Instant::now();
        let id = r.reserve(Owner::Ben, Kind::Tcp, None).unwrap();
        r.detach(Owner::Ben, &id, now).unwrap();
        r.detach(Owner::Ben, &id, now + Duration::from_secs(20))
            .unwrap();
        assert!(r.attach(Owner::Agent, &id, now).is_err());
        r.attach(Owner::Ben, &id, now + Duration::from_millis(29999))
            .unwrap();
        r.detach(Owner::Ben, &id, now).unwrap();
        assert!(
            r.attach(Owner::Ben, &id, now + Duration::from_secs(30))
                .is_err()
        );
        r.expire(now + Duration::from_secs(30)).unwrap();
        assert!(r.sessions[&id].closed);
        assert!(
            r.attach(Owner::Ben, &id, now + Duration::from_secs(31))
                .is_err()
        );
        assert_eq!(r.sessions.len(), 1);
    }
    #[test]
    fn fresh_daemons_do_not_reuse_prior_session_ids() {
        let mut first = Registry::start(Kernel::default()).unwrap();
        let mut second = Registry::start(Kernel::default()).unwrap();
        let old = first.reserve(Owner::Ben, Kind::Exec, None).unwrap();
        let new = second.reserve(Owner::Ben, Kind::Exec, None).unwrap();
        assert_ne!(old, new);
        assert!(second.attach(Owner::Ben, &old, Instant::now()).is_err());
    }
}
