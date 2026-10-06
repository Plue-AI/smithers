//! CPU-window attribution. Actors are the sole codec's type, supplied by the
//! authenticated session provider, never decoded here or chosen by a writer.
use std::{
    collections::{BTreeMap, BTreeSet},
    io,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Participant {
    Person(u32),
    Run(String),
}
#[derive(Clone, Debug)]
pub struct Sample<A> {
    pub session: u32,
    pub actor: Option<A>,
    pub participant: Option<Participant>,
    pub usage_usec: u64,
    pub populated: bool,
}
#[derive(Clone, Debug)]
pub struct Window<A> {
    baseline: BTreeMap<u32, u64>,
    active: BTreeMap<u32, (Option<Participant>, Option<A>)>,
    uncertain: bool,
}
impl<A: Clone + Eq> Window<A> {
    pub fn new(samples: &[Sample<A>]) -> Self {
        Self {
            baseline: samples.iter().map(|s| (s.session, s.usage_usec)).collect(),
            active: BTreeMap::new(),
            uncertain: false,
        }
    }
    pub fn observe(&mut self, samples: &[Sample<A>]) {
        let present: BTreeSet<_> = samples.iter().map(|s| s.session).collect();
        if self.baseline.keys().any(|id| !present.contains(id)) {
            self.uncertain = true;
        }
        for s in samples {
            match self.baseline.get(&s.session) {
                Some(old) if s.usage_usec < *old => self.uncertain = true,
                Some(old) if s.usage_usec > *old => {
                    if self
                        .active
                        .get(&s.session)
                        .is_some_and(|(p, a)| p != &s.participant || a != &s.actor)
                    {
                        self.uncertain = true;
                    }
                    self.active
                        .insert(s.session, (s.participant.clone(), s.actor.clone()));
                }
                None => {
                    self.uncertain = true;
                }
                _ => (),
            }
            self.baseline.insert(s.session, s.usage_usec);
        }
    }
    /// None means outside. Aggregate CPU-active sessions by authenticated
    /// participant. The first session is retained only as a location hint;
    /// it is not an attribution or authorization identity.
    pub fn actor(&self) -> Option<(u32, A)> {
        if self.uncertain {
            return None;
        }
        let mut candidates = self.active.iter();
        let (id, (participant, actor)) = candidates.next()?;
        let participant = participant.as_ref()?;
        let actor = actor.as_ref()?;
        if candidates.any(|(_, (p, a))| p.as_ref() != Some(participant) || a.is_none()) {
            return None;
        }
        Some((*id, actor.clone()))
    }
}
/// Parse bounded reads from broker-held cgroup descriptors, including closed
/// sessions with surviving children. Missing/malformed counters fail closed.
pub fn usage(bytes: &[u8]) -> io::Result<u64> {
    if bytes.len() > 4096 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| io::ErrorKind::InvalidData)?;
    let mut values = text.lines().filter_map(|l| l.strip_prefix("usage_usec "));
    let value = values
        .next()
        .ok_or(io::ErrorKind::InvalidData)?
        .parse()
        .map_err(|_| io::ErrorKind::InvalidData)?;
    if values.next().is_some() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(value)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn s(id: u32, cpu: u64) -> Sample<&'static str> {
        Sample {
            session: id,
            actor: Some(if id == 1 { "maya" } else { "ben" }),
            participant: Some(Participant::Person(if id == 1 { 20000 } else { 20001 })),
            usage_usec: cpu,
            populated: true,
        }
    }
    #[test]
    fn counts_cpu_not_idle_or_closed_state() {
        let mut w = Window::new(&[s(1, 10), s(2, 10)]);
        assert_eq!(w.actor(), None);
        w.observe(&[s(1, 12), s(2, 10)]);
        assert_eq!(w.actor(), Some((1, "maya")));
        w.observe(&[s(1, 12), s(2, 11)]);
        assert_eq!(w.actor(), None);
    }
    #[test]
    fn two_sessions_of_one_person_are_one_candidate() {
        let mut shell = s(1, 10);
        let mut editor = s(2, 10);
        editor.actor = shell.actor;
        editor.participant = shell.participant.clone();
        let mut w = Window::new(&[shell.clone(), editor.clone()]);
        shell.usage_usec = 20;
        editor.usage_usec = 30;
        w.observe(&[shell.clone(), editor.clone()]);
        assert_eq!(w.actor(), Some((1, "maya")));
        // A later actor switch cannot retroactively credit the earlier bytes.
        editor.actor = Some("ben");
        editor.participant = Some(Participant::Person(20001));
        editor.usage_usec = 40;
        w.observe(&[shell, editor]);
        assert_eq!(w.actor(), None);
    }
    #[test]
    fn unknown_active_session_prevents_credit() {
        let mut unknown = s(2, 0);
        unknown.actor = None;
        let mut w = Window::new(&[s(1, 0), unknown.clone()]);
        unknown.usage_usec = 1;
        w.observe(&[s(1, 1), unknown]);
        assert_eq!(w.actor(), None);
    }
    #[test]
    fn missing_reset_and_new_sessions_are_uncertain() {
        for samples in [vec![s(1, 9)], vec![], vec![s(1, 12), s(2, 1)]] {
            let mut w = Window::new(&[s(1, 10)]);
            w.observe(&samples);
            assert_eq!(w.actor(), None);
        }
        assert_eq!(
            usage(b"user_usec 2\nusage_usec 123\nsystem_usec 3\n").unwrap(),
            123
        );
        for b in [
            b"usage_usec x\n".as_slice(),
            b"usage_usec 1\nusage_usec 2\n",
            b"user_usec 1\n",
        ] {
            assert!(usage(b).is_err());
        }
    }
}
