//! Attribution projection of the existing broker registry; no second session
//! registry, spawning, cgroup path selection or actor authorization lives here.
use crate::{attrib::Sample, broker::sessions::Entry};
use std::{collections::BTreeMap, io};
/// The sole authenticated actor provider maps a person session or registered
/// run. An unregistered agent session maps to None and can never claim a run.
pub fn samples<'a, A>(
    entries: impl Iterator<Item = &'a Entry>,
    counters: &[(u32, u64, bool)],
    mut actor: impl FnMut(&Entry) -> Option<A>,
) -> io::Result<Vec<Sample<A>>> {
    let count = counters.len();
    let mut counters: BTreeMap<_, _> = counters
        .iter()
        .map(|(id, cpu, populated)| (*id, (*cpu, *populated)))
        .collect();
    if counters.len() != count {
        return Err(io::Error::other("duplicate session counters"));
    }
    let mut samples = vec![];
    for entry in entries {
        let (usage_usec, populated) = counters
            .remove(&entry.id)
            .ok_or_else(|| io::Error::other("missing session cgroup"))?;
        samples.push(Sample {
            session: entry.id,
            actor: actor(entry),
            usage_usec,
            populated,
        });
    }
    if !counters.is_empty() {
        return Err(io::Error::other("unregistered session cgroup"));
    }
    Ok(samples)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        attrib::Window,
        broker::sessions::{Controls, Kind, Sessions, User},
    };
    use std::time::Instant;
    struct Control;
    impl Controls for Control {
        fn close(&mut self, _: u32, _: Kind) -> io::Result<()> {
            Ok(())
        }
        fn kill(&mut self, _: u32, _: Instant) -> io::Result<()> {
            Ok(())
        }
    }
    fn actor(e: &Entry) -> Option<String> {
        if e.user.uid == 19999 {
            e.run.clone()
        } else {
            Some(e.user.login.clone())
        }
    }
    #[test]
    fn registered_run_and_closed_surviving_session_use_the_broker_registry() {
        let mut s = Sessions::new(Control);
        s.insert(
            1,
            User {
                login: "maya".into(),
                uid: 20000,
            },
            Kind::Pty,
        )
        .unwrap();
        s.insert(
            2,
            User {
                login: "agent".into(),
                uid: 19999,
            },
            Kind::Exec,
        )
        .unwrap();
        assert!(s.register_run(9, "run").is_err());
        let initial = samples(s.entries(), &[(1, 0, true), (2, 0, true)], actor).unwrap();
        let mut window = Window::new(&initial);
        window.observe(&samples(s.entries(), &[(1, 0, true), (2, 10, true)], actor).unwrap());
        assert_eq!(window.actor(), None);
        s.register_run(2, "run-1").unwrap();
        let initial = samples(s.entries(), &[(1, 0, true), (2, 10, true)], actor).unwrap();
        let mut window = Window::new(&initial);
        window.observe(&samples(s.entries(), &[(1, 0, true), (2, 20, true)], actor).unwrap());
        assert_eq!(window.actor(), Some((2, "run-1".into())));
        s.close(1).unwrap();
        let mut window = Window::new(&initial);
        window.observe(&samples(s.entries(), &[(1, 30, true), (2, 10, true)], actor).unwrap());
        assert_eq!(window.actor(), Some((1, "maya".into())));
        assert!(samples(s.entries(), &[(1, 0, true)], actor).is_err());
        assert!(samples(
            s.entries(),
            &[(1, 0, true), (2, 0, true), (3, 0, true)],
            actor
        )
        .is_err());
    }
}
