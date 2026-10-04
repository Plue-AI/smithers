//! Shared deadline and kill-before-observe ordering for held cgroup handles.
//! Replaces the inline startup polling loop; no path, process or root effects here.
use std::io;
use std::time::Duration;

pub(crate) trait Observation {
    fn count(&self) -> usize;
    fn kill(&mut self, index: usize) -> io::Result<()>;
    fn empty(&mut self, index: usize) -> io::Result<bool>;
    fn elapsed(&self) -> Duration;
    fn wait(&mut self);
}

/// Callers start the clock before resolving handles. Never report success from
/// an observation made at/after the deadline, even when the last group is empty.
pub(crate) fn drain(groups: &mut impl Observation, bound: Duration) -> io::Result<()> {
    let timeout = || io::Error::new(io::ErrorKind::TimedOut, "session cgroups did not drain");
    for index in 0..groups.count() {
        groups.kill(index)?;
    }
    loop {
        let mut all_empty = true;
        for index in 0..groups.count() {
            if groups.elapsed() >= bound {
                return Err(timeout());
            }
            // No short circuit: sample every child on each polling round.
            all_empty &= groups.empty(index)?;
        }
        if groups.elapsed() >= bound {
            return Err(timeout());
        }
        if all_empty {
            return Ok(());
        }
        groups.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    // Deterministic kernel/clock fault injection for ordering and deadline
    // tests on Mac. Not a substitute for the real C-SPK-08 cgroup observations.
    struct Script {
        count: usize,
        samples: VecDeque<io::Result<bool>>,
        events: Vec<String>,
        now: Duration,
        kill_cost: Duration,
        read_cost: Duration,
        kill_failure: Option<usize>,
    }
    impl Script {
        fn new(count: usize, samples: Vec<io::Result<bool>>) -> Self {
            Self {
                count,
                samples: samples.into(),
                events: vec![],
                now: Duration::ZERO,
                kill_cost: Duration::ZERO,
                read_cost: Duration::ZERO,
                kill_failure: None,
            }
        }
    }
    impl Observation for Script {
        fn count(&self) -> usize {
            self.count
        }
        fn elapsed(&self) -> Duration {
            self.now
        }
        fn kill(&mut self, index: usize) -> io::Result<()> {
            self.events.push(format!("kill {index}"));
            self.now += self.kill_cost;
            if self.kill_failure == Some(index) {
                Err(io::Error::other("kill denied"))
            } else {
                Ok(())
            }
        }
        fn empty(&mut self, index: usize) -> io::Result<bool> {
            self.events.push(format!("read {index}"));
            self.now += self.read_cost;
            self.samples
                .pop_front()
                .expect("unexpected kernel observation")
        }
        fn wait(&mut self) {
            self.events.push("wait".into());
            self.now += Duration::from_millis(10);
        }
    }
    #[test]
    fn startup_kills_every_child_before_observing_any_and_polls_all() {
        let mut script = Script::new(2, vec![Ok(false), Ok(true), Ok(true), Ok(true)]);
        drain(&mut script, Duration::from_secs(2)).unwrap();
        assert_eq!(
            script.events,
            [
                "kill 0", "kill 1", "read 0", "read 1", "wait", "read 0", "read 1"
            ]
        );
    }
    #[test]
    fn one_deadline_includes_handle_resolution_kills_and_reads() {
        let mut script = Script::new(3, vec![]);
        script.now = Duration::from_millis(1990); // time spent resolving descriptors
        script.kill_cost = Duration::from_millis(10);
        assert_eq!(
            drain(&mut script, Duration::from_secs(2))
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(script.events, ["kill 0", "kill 1", "kill 2"]);
        let mut script = Script::new(1, vec![Ok(true)]);
        script.read_cost = Duration::from_secs(2);
        assert_eq!(
            drain(&mut script, Duration::from_secs(2))
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(script.events, ["kill 0", "read 0"]);
    }
    #[test]
    fn kill_and_observation_errors_refuse_admission_without_retry() {
        let mut script = Script::new(2, vec![]);
        script.kill_failure = Some(1);
        assert_eq!(
            drain(&mut script, Duration::from_secs(2))
                .unwrap_err()
                .to_string(),
            "kill denied"
        );
        assert_eq!(script.events, ["kill 0", "kill 1"]);
        let mut script = Script::new(
            2,
            vec![Ok(false), Err(io::Error::other("malformed events"))],
        );
        assert_eq!(
            drain(&mut script, Duration::from_secs(2))
                .unwrap_err()
                .to_string(),
            "malformed events"
        );
        assert_eq!(script.events, ["kill 0", "kill 1", "read 0", "read 1"]);
    }
    #[test]
    fn persistent_population_times_out_and_empty_parent_needs_no_kill() {
        let mut script = Script::new(1, (0..200).map(|_| Ok(false)).collect());
        assert_eq!(
            drain(&mut script, Duration::from_secs(2))
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(script.now, Duration::from_secs(2));
        assert_eq!(script.events.iter().filter(|s| *s == "kill 0").count(), 1);
        assert_eq!(script.events.iter().filter(|s| *s == "read 0").count(), 200);
        let mut script = Script::new(0, vec![]);
        drain(&mut script, Duration::from_secs(2)).unwrap();
        assert!(script.events.is_empty());
        script.now = Duration::from_secs(2);
        assert_eq!(
            drain(&mut script, Duration::from_secs(2))
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
    }
}
