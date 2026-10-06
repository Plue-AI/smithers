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
        // The coding host's exact socket writes already carry its run. Only
        // agent PTY commands participate in the outside-write CPU heuristic.
        if entry.user.uid == 19999 && entry.kind != crate::broker::sessions::Kind::Pty {
            continue;
        }
        samples.push(Sample {
            session: entry.id,
            actor: actor(entry),
            participant: if entry.user.uid == 19999 {
                entry.run.clone().map(crate::attrib::Participant::Run)
            } else {
                Some(crate::attrib::Participant::Person(entry.user.uid))
            },
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
    fn participant_candidates_exclude_coding_host_but_include_agent_commands() {
        let mut registry = Sessions::new(Control);
        registry
            .set_roster(
                &[User {
                    login: "maya".into(),
                    uid: 20000,
                }],
                Instant::now(),
            )
            .unwrap();
        for (id, login, uid, kind) in [
            (1, "maya", 20000, Kind::Pty),
            (2, "maya", 20000, Kind::Exec),
            (3, "agent", 19999, Kind::Exec),
            (4, "agent", 19999, Kind::Pty),
        ] {
            registry
                .insert(
                    id,
                    User {
                        login: login.into(),
                        uid,
                    },
                    kind,
                )
                .unwrap();
        }
        registry.register_run(3, "run-1").unwrap();
        registry.register_run(4, "run-1").unwrap();
        let baseline = [(1, 0, true), (2, 0, true), (3, 0, true), (4, 0, true)];
        let initial = samples(registry.entries(), &baseline, actor).unwrap();
        assert_eq!(initial.len(), 3, "coding host is not an outside candidate");
        // The wire actor remains a session reference for host resolution;
        // two different session references still identify one participant.
        let wire_initial = samples(registry.entries(), &baseline, |entry| {
            Some(crate::hooks::Actor::Session(entry.id))
        })
        .unwrap();
        let mut wire_window = Window::new(&wire_initial);
        wire_window.observe(
            &samples(
                registry.entries(),
                &[(1, 10, true), (2, 20, true), (3, 100, true), (4, 0, true)],
                |entry| Some(crate::hooks::Actor::Session(entry.id)),
            )
            .unwrap(),
        );
        assert_eq!(
            wire_window.actor(),
            Some((1, crate::hooks::Actor::Session(1)))
        );

        let mut window = Window::new(&initial);
        window.observe(
            &samples(
                registry.entries(),
                &[(1, 10, true), (2, 20, true), (3, 100, true), (4, 0, true)],
                actor,
            )
            .unwrap(),
        );
        assert_eq!(window.actor(), Some((1, "maya".into())));
        window.observe(
            &samples(
                registry.entries(),
                &[(1, 10, true), (2, 20, true), (3, 200, true), (4, 10, true)],
                actor,
            )
            .unwrap(),
        );
        assert_eq!(window.actor(), None, "person and agent commands overlap");
        let mut agent_only = Window::new(&initial);
        agent_only.observe(
            &samples(
                registry.entries(),
                &[(1, 0, true), (2, 0, true), (3, 200, true), (4, 10, true)],
                actor,
            )
            .unwrap(),
        );
        assert_eq!(agent_only.actor(), Some((4, "run-1".into())));
        // Even excluded hosts must have a valid authenticated cgroup counter.
        assert!(samples(registry.entries(), &baseline[..2], actor).is_err());
    }
    #[test]
    fn registered_run_and_closed_surviving_session_use_the_broker_registry() {
        let mut s = Sessions::new(Control);
        s.set_roster(
            &[User {
                login: "maya".into(),
                uid: 20000,
            }],
            Instant::now(),
        )
        .unwrap();
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
            Kind::Pty,
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
