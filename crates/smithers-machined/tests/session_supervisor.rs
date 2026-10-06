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
fn rostered(controls: ControlsFixture) -> Sessions<ControlsFixture> {
    let mut sessions = Sessions::new(controls);
    sessions.set_roster(&[user()], Instant::now()).unwrap();
    sessions
}
#[test]
fn identity_registry_and_run_binding() {
    let mut s = rostered(ControlsFixture::default());
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
        "/sys/fs/cgroup/smithers/sessions/s1"
    );
    assert_eq!(s.kill_run("r", Instant::now()).unwrap(), 1);
    assert_eq!(s.entries().count(), 1);
}
#[test]
fn close_and_exit_retain_lingering_attribution_until_confirmed_kill() {
    let mut s = rostered(ControlsFixture {
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
    let mut s = rostered(ControlsFixture::default());
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
    let mut s = rostered(ControlsFixture::default());
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
    let mut s = rostered(ControlsFixture {
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

#[test]
fn roster_required_before_any_session_and_empty_roster_allows_only_agent() {
    let mut s = Sessions::new(ControlsFixture::default());
    let agent = User {
        login: "agent".into(),
        uid: 19999,
    };
    assert!(s.insert(1, user(), Kind::Exec).is_err());
    assert!(s.insert(2, agent.clone(), Kind::Exec).is_err());
    s.set_roster(&[], Instant::now()).unwrap();
    assert!(s.insert(1, user(), Kind::Exec).is_err());
    s.insert(2, agent, Kind::Exec).unwrap();
}

#[test]
fn roster_change_kills_all_revoked_kinds_and_retains_agent() {
    let now = Instant::now();
    let mut s = rostered(ControlsFixture::default());
    for (i, kind) in [Kind::Pty, Kind::Exec, Kind::Sftp, Kind::Tcp]
        .into_iter()
        .enumerate()
    {
        s.insert(i as u32 + 1, user(), kind).unwrap();
    }
    s.insert(
        5,
        User {
            login: "agent".into(),
            uid: 19999,
        },
        Kind::Exec,
    )
    .unwrap();
    s.disconnected(now);
    s.set_roster(&[], now).unwrap();
    assert_eq!(s.entries().map(|e| e.id).collect::<Vec<_>>(), [5]);
    assert!(s.attach(1, now).is_err());
    assert!(s.insert(6, user(), Kind::Pty).is_err());
    s.attach(5, now).unwrap();
}

#[test]
fn failed_roster_cleanup_revokes_admission_before_retry() {
    let now = Instant::now();
    let mut s = rostered(ControlsFixture {
        fail: Some(2),
        ..Default::default()
    });
    for id in 1..=3 {
        s.insert(id, user(), Kind::Exec).unwrap();
    }
    assert!(s.set_roster(&[], now).is_err());
    assert_eq!(s.entries().map(|e| e.id).collect::<Vec<_>>(), [2, 3]);
    assert!(s.attach(2, now).is_err());
    assert!(s.insert(4, user(), Kind::Exec).is_err());
    assert!(s.set_roster(&[], now).is_err());
    assert_eq!(s.entries().map(|e| e.id).collect::<Vec<_>>(), [2, 3]);
}

#[test]
fn malformed_roster_is_atomic_and_binding_is_exact() {
    let now = Instant::now();
    let mut s = rostered(ControlsFixture::default());
    s.insert(1, user(), Kind::Exec).unwrap();
    for bad in [
        vec![user(), user()],
        vec![
            user(),
            User {
                login: "alice".into(),
                uid: 20001,
            },
        ],
        vec![
            user(),
            User {
                login: "ben".into(),
                uid: 20002,
            },
        ],
        vec![User {
            login: "agent".into(),
            uid: 19999,
        }],
        vec![User {
            login: "machined".into(),
            uid: 20003,
        }],
        vec![User {
            login: "alice".into(),
            uid: 2147483648,
        }],
    ] {
        assert!(s.set_roster(&bad, now).is_err());
        s.authorize(&user()).unwrap();
        assert_eq!(s.entries().count(), 1);
    }
    assert!(s
        .authorize(&User {
            login: "alice".into(),
            uid: 20001
        })
        .is_err());
    assert!(s
        .authorize(&User {
            login: "ben".into(),
            uid: 20002
        })
        .is_err());
    s.set_roster(
        &[User {
            login: "alice".into(),
            uid: 20002,
        }],
        now,
    )
    .unwrap();
    assert_eq!(s.entries().count(), 0);
    s.insert(
        2,
        User {
            login: "alice".into(),
            uid: 20002,
        },
        Kind::Exec,
    )
    .unwrap();
}

#[test]
fn failed_cleanup_blocks_every_spawn_until_confirmed_retry() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    struct RetryControls {
        fail: Arc<AtomicBool>,
        kills: Vec<(u32, Instant)>,
    }
    impl Controls for RetryControls {
        fn close(&mut self, _: u32, _: Kind) -> io::Result<()> {
            Ok(())
        }
        fn kill(&mut self, id: u32, deadline: Instant) -> io::Result<()> {
            self.kills.push((id, deadline));
            if self.fail.load(Ordering::SeqCst) {
                Err(io::Error::other("populated 1"))
            } else {
                Ok(())
            }
        }
    }
    let fail = Arc::new(AtomicBool::new(false));
    let mut s = Sessions::new(RetryControls {
        fail: fail.clone(),
        kills: vec![],
    });
    let now = Instant::now();
    s.set_roster(&[user()], now).unwrap();
    s.insert(1, user(), Kind::Pty).unwrap();
    s.insert(2, user(), Kind::Tcp).unwrap();
    let agent = User {
        login: "agent".into(),
        uid: 19999,
    };
    s.insert(3, agent.clone(), Kind::Exec).unwrap();
    s.register_run(3, "trusted-run").unwrap();
    assert_eq!(s.local_run(19999, 3).unwrap(), "trusted-run");
    fail.store(true, Ordering::SeqCst);
    let alice = User {
        login: "alice".into(),
        uid: 20002,
    };
    assert!(s.set_roster(&[alice.clone()], now).is_err());
    assert!(s.authorize(&alice).is_err());
    assert!(s.authorize(&agent).is_err());
    assert!(s.local_run(19999, 3).is_err());
    assert_eq!(s.entries().count(), 3);
    fail.store(false, Ordering::SeqCst);
    s.set_roster(&[alice.clone()], now).unwrap();
    assert_eq!(s.entries().count(), 1);
    assert_eq!(s.local_run(19999, 3).unwrap(), "trusted-run");
    s.authorize(&alice).unwrap();
    s.authorize(&agent).unwrap();
    assert!(s.authorize(&user()).is_err());
}

#[test]
fn local_pty_inherits_only_the_authenticated_callers_run_atomically() {
    let mut s = rostered(ControlsFixture::default());
    s.insert(
        1,
        User {
            login: "agent".into(),
            uid: 19999,
        },
        Kind::Exec,
    )
    .unwrap();
    for uid in [0, 19998, 20001] {
        assert!(s.insert_local(2, uid, 1).is_err());
    }
    assert!(s.insert_local(2, 19999, 1).is_err()); // unregistered caller
    assert_eq!(s.entries().count(), 1);
    s.register_run(1, "run-a").unwrap();
    assert!(s.insert_local(2, 19999, 99).is_err());
    s.insert_local(2, 19999, 1).unwrap();
    let local = s.entries().find(|e| e.id == 2).unwrap();
    assert_eq!(local.kind, Kind::Pty);
    assert_eq!(local.run.as_deref(), Some("run-a"));
    assert_eq!(s.local_run(19999, 2).unwrap(), "run-a");
    assert!(s.register_run(2, "forged-run").is_err());
    assert!(s.insert_local(2, 19999, 1).is_err());
    assert_eq!(s.entries().count(), 2);
    assert_eq!(s.kill_run("run-a", Instant::now()).unwrap(), 2);
    assert!(s.insert_local(3, 19999, 2).is_err());
}

#[test]
fn cgroup_names_are_canonical_with_cleanup_compatibility() {
    for (name, id) in [
        ("s1", 1),
        ("s2147483647", 2147483647),
        ("1", 1),
        ("2147483647", 2147483647),
    ] {
        assert_eq!(cgroup_id(name).unwrap(), id);
    }
    for name in [
        "",
        "s",
        "s0",
        "0",
        "s01",
        "01",
        "s+1",
        "+1",
        "s2147483648",
        "../1",
        "s1/child",
        "s1\0",
    ] {
        assert!(cgroup_id(name).is_err(), "{name}");
    }
}
