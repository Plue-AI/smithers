use smithers_machined::broker::sessions::*;
use std::{
    io,
    time::{Duration, Instant},
};
#[derive(Default)]
struct ControlsFixture {
    closes: Vec<(u32, Kind)>,
    kills: Vec<(u32, Instant)>,
    fail: Option<u32>,
}
impl Controls for ControlsFixture {
    fn close(&mut self, id: u32, kind: Kind) -> io::Result<()> {
        self.closes.push((id, kind));
        Ok(())
    }
    fn kill(&mut self, id: u32, deadline: Instant) -> io::Result<()> {
        self.kills.push((id, deadline));
        if self.fail == Some(id) {
            return Err(io::Error::other("populated 1"));
        }
        Ok(())
    }
}
fn user() -> User {
    User {
        login: "ben".into(),
        uid: 20001,
    }
}
#[test]
fn identity_registry_and_run_binding() {
    let mut s = Sessions::new(ControlsFixture::default());
    for (login, uid) in [
        ("root", 20001),
        ("ben", 0),
        ("ben", 19999),
        ("agent", 20001),
        ("../x", 20001),
    ] {
        assert!(s
            .insert(
                1,
                User {
                    login: login.into(),
                    uid
                },
                Kind::Exec
            )
            .is_err());
    }
    s.insert(1, user(), Kind::Pty).unwrap();
    assert!(s.insert(1, user(), Kind::Pty).is_err());
    assert!(s.register_run(1, "r").is_err());
    s.insert(
        2,
        User {
            login: "agent".into(),
            uid: 19999,
        },
        Kind::Exec,
    )
    .unwrap();
    assert!(s.local_run(19999, 2).is_err());
    s.register_run(2, "r").unwrap();
    s.register_run(2, "r").unwrap();
    assert!(s.register_run(2, "other").is_err());
    assert!(s.local_run(20001, 2).is_err());
    assert!(s.local_run(19999, 1).is_err());
    assert_eq!(s.local_run(19999, 2).unwrap(), "r");
    s.exited(2).unwrap();
    assert!(s.register_run(2, "r").is_err());
    assert_eq!(s.entries().count(), 2);
    assert_eq!(
        s.entries().next().unwrap().cgroup(),
        "/sys/fs/cgroup/smithers/sessions/1"
    );
    assert_eq!(s.kill_run("r", Instant::now()).unwrap(), 1);
    assert_eq!(s.entries().count(), 1);
}
#[test]
fn close_and_exit_retain_lingering_attribution_until_confirmed_kill() {
    let mut s = Sessions::new(ControlsFixture {
        fail: Some(1),
        ..Default::default()
    });
    s.insert(1, user(), Kind::Pty).unwrap();
    s.close(1).unwrap();
    s.close(1).unwrap();
    s.exited(1).unwrap();
    assert!(s.entries().next().unwrap().closed);
    assert!(s.before_restart(Instant::now()).is_err());
    assert_eq!(s.entries().count(), 1);
    assert!(s.kill_user(&user(), Instant::now()).is_err());
    assert_eq!(s.entries().count(), 1);
}
#[test]
fn reconnect_boundary_does_not_extend_grace_and_restart_clears_all_kinds() {
    let start = Instant::now();
    let mut s = Sessions::new(ControlsFixture::default());
    for (i, kind) in [Kind::Pty, Kind::Exec, Kind::Sftp, Kind::Tcp]
        .into_iter()
        .enumerate()
    {
        s.insert(i as u32 + 1, user(), kind).unwrap();
    }
    s.disconnected(start);
    s.disconnected(start + Duration::from_secs(20));
    s.attach(1, start + Duration::from_secs(29)).unwrap();
    assert!(s.attach(2, start + Duration::from_secs(30)).is_err());
    s.expire(start + Duration::from_secs(30)).unwrap();
    assert!(!s.entries().find(|e| e.id == 1).unwrap().closed);
    assert!(s.entries().filter(|e| e.id != 1).all(|e| e.closed));
    assert_eq!(s.entries().count(), 4);
    s.before_restart(start + Duration::from_secs(30)).unwrap();
    assert_eq!(s.entries().count(), 0);
    assert!(s.attach(1, start).is_err());
}

#[test]
fn allocator_bounds_capacity_and_stale_ids_are_refused() {
    let mut s = Sessions::new(ControlsFixture::default());
    for id in [0, 0x80000000, u32::MAX] {
        assert!(s.insert(id, user(), Kind::Exec).is_err());
    }
    for id in 1..=512 {
        s.insert(id, user(), Kind::Exec).unwrap();
    }
    assert!(s.insert(513, user(), Kind::Exec).is_err());
    assert!(s.close(513).is_err());
    assert!(s.exited(513).is_err());
    assert!(s.register_run(513, "r").is_err());
    assert!(s.kill_run("", Instant::now()).is_err());
    assert_eq!(
        s.kill_user(
            &User {
                login: "alice".into(),
                uid: 20002
            },
            Instant::now()
        )
        .unwrap(),
        0
    );
    assert_eq!(s.kill_user(&user(), Instant::now()).unwrap(), 512);
    assert!(s.attach(1, Instant::now()).is_err());
    assert_eq!(s.entries().count(), 0);
}

#[test]
fn partial_cleanup_retains_only_unconfirmed_groups_for_retry() {
    let mut s = Sessions::new(ControlsFixture {
        fail: Some(2),
        ..Default::default()
    });
    for id in 1..=3 {
        s.insert(id, user(), Kind::Exec).unwrap();
    }
    assert!(s.before_restart(Instant::now()).is_err());
    assert_eq!(s.entries().map(|e| e.id).collect::<Vec<_>>(), [2, 3]);
    // Cleanup of an unrelated selector cannot erase a failed group.
    assert_eq!(s.kill_run("unknown", Instant::now()).unwrap(), 0);
    assert_eq!(s.entries().map(|e| e.id).collect::<Vec<_>>(), [2, 3]);
}
