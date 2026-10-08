//! Production dispatcher with a test-only kernel. These are deterministic
//! admission/stream checks, not real-user or reference-host acceptance receipts.
use smithers_machined::{
    broker::{
        control::{self, Controls},
        request::{self, Request},
        sessions::{Admission, Kind, User},
        supervisor::{Kernel, Supervisor},
    },
    conn::{self, Frame},
    session_stream::Exit,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
#[derive(Default)]
struct State {
    spawns: Vec<(u32, User, Kind)>,
    inputs: BTreeMap<u32, Vec<u8>>,
    outputs: BTreeMap<(u32, u8), Vec<u8>>,
    exits: BTreeMap<u32, Exit>,
    closes: Vec<u32>,
    kills: Vec<u32>,
    eofs: Vec<u32>,
    resizes: Vec<(u32, u16, u16)>,
    signals: Vec<(u32, u8)>,
    missing: Option<&'static str>,
    blocked: bool,
    fail_kill: Option<u32>,
    fail_all_kills: bool,
    fail_spawn: bool,
    fail_before_fork: bool,
    ready_calls: usize,
    local_ready_calls: Vec<u32>,
    running: BTreeSet<u32>,
    identity: Option<smithers_machined::broker::sessions::ProcessIdentity>,
}
struct OS(Arc<Mutex<State>>);
impl Kernel for OS {
    fn process_identity(
        &mut self,
        _: u32,
    ) -> io::Result<Option<smithers_machined::broker::sessions::ProcessIdentity>> {
        Ok(self.0.lock().unwrap().identity.clone())
    }
    fn available(&mut self) -> io::Result<()> {
        Ok(())
    }
    fn recover(&mut self, _: Instant) -> io::Result<()> {
        Ok(())
    }
    fn ready(&mut self, u: &User) -> io::Result<()> {
        let mut state = self.0.lock().unwrap();
        state.ready_calls += 1;
        if state.missing.is_some() {
            return Err(io::ErrorKind::Unsupported.into());
        }
        if u.login != "agent" && !(u.login == "ben" && u.uid == 20001) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(())
    }
    fn ready_local(&mut self, u: &User, caller: u32) -> io::Result<()> {
        let mut state = self.0.lock().unwrap();
        if u.uid != 19999 || state.missing.is_some() {
            return Err(io::ErrorKind::Unsupported.into());
        }
        state.local_ready_calls.push(caller);
        Ok(())
    }
    fn spawn(
        &mut self,
        id: u32,
        u: &User,
        k: Kind,
        _: &[String],
        _: Option<(u16, u16)>,
        _: Option<u16>,
    ) -> io::Result<()> {
        let mut state = self.0.lock().unwrap();
        state.spawns.push((id, u.clone(), k));
        if state.fail_before_fork {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        state.running.insert(id);
        if state.fail_spawn {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        Ok(())
    }
    fn read(&mut self, id: u32, fd: u8, b: &mut [u8]) -> io::Result<usize> {
        let mut s = self.0.lock().unwrap();
        let Some(output) = s.outputs.get_mut(&(id, fd)) else {
            return Err(io::ErrorKind::WouldBlock.into());
        };
        let n = b.len().min(output.len());
        b[..n].copy_from_slice(&output[..n]);
        output.drain(..n);
        Ok(n)
    }
    fn write(&mut self, id: u32, b: &[u8]) -> io::Result<usize> {
        let mut s = self.0.lock().unwrap();
        if s.blocked {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        s.inputs.entry(id).or_default().extend(b);
        Ok(b.len())
    }
    fn eof(&mut self, id: u32) -> io::Result<()> {
        self.0.lock().unwrap().eofs.push(id);
        Ok(())
    }
    fn resize(&mut self, id: u32, rows: u16, cols: u16) -> io::Result<()> {
        self.0.lock().unwrap().resizes.push((id, rows, cols));
        Ok(())
    }
    fn signal(&mut self, id: u32, signal: u8) -> io::Result<()> {
        self.0.lock().unwrap().signals.push((id, signal));
        Ok(())
    }
    fn exited(&mut self, id: u32) -> io::Result<Option<Exit>> {
        Ok(self.0.lock().unwrap().exits.remove(&id))
    }
    fn close(&mut self, id: u32, _: Kind) -> io::Result<()> {
        self.0.lock().unwrap().closes.push(id);
        Ok(())
    }
    fn kill(&mut self, id: u32, _: Instant) -> io::Result<()> {
        let mut s = self.0.lock().unwrap();
        if s.fail_kill == Some(id) || s.fail_all_kills {
            return Err(io::ErrorKind::TimedOut.into());
        }
        s.kills.push(id);
        s.running.remove(&id);
        Ok(())
    }
    fn freeze(&mut self, _: Duration) -> io::Result<Option<u32>> {
        Ok(None)
    }
    fn thaw(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn setup() -> (Supervisor<OS>, Arc<Mutex<State>>) {
    let s = Arc::new(Mutex::new(State::default()));
    (Supervisor::new(OS(s.clone())), s)
}
fn user() -> User {
    User {
        login: "ben".into(),
        uid: 20001,
    }
}
fn roster(s: &mut Supervisor<OS>) {
    s.session(Request::Roster(vec![user()])).unwrap();
}
fn open(s: &mut Supervisor<OS>, u: User, k: Kind) -> u32 {
    let run = (u.uid == 19999).then_some("run");
    open_bound(s, u, k, run)
}
fn open_bound(s: &mut Supervisor<OS>, u: User, k: Kind, run: Option<&str>) -> u32 {
    let bytes = s
        .session(Request::Open {
            admission: Some(Admission {
                principal: [7; 16],
                run: run.map(str::to_owned),
            }),
            user: u,
            kind: k,
            argv: vec!["/bin/sh".into()],
            size: None,
        })
        .unwrap();
    u32::from_be_bytes(bytes[5..9].try_into().unwrap())
}
fn packet(op: u8, body: &[u8]) -> Vec<u8> {
    [9u32.to_be_bytes().as_slice(), &[op], body].concat()
}
fn frame(id: u32, payload: Vec<u8>) -> Frame {
    Frame {
        kind: 5,
        stream: id,
        payload,
    }
}
fn send(s: &mut Supervisor<OS>, f: Frame) {
    assert_eq!(
        control::handle(&packet(17, &f.encode().unwrap()), s).unwrap(),
        [0, 0, 0, 9, 17]
    );
}
fn poll(s: &mut Supervisor<OS>, id: u32) -> Option<Frame> {
    let bytes = control::handle(&packet(18, &id.to_be_bytes()), s).unwrap();
    assert_eq!(bytes[4], 18);
    if bytes.len() == 5 {
        None
    } else {
        Some(Frame::decode(&bytes[5..]).unwrap())
    }
}
fn host_open_bytes(login: &str, uid: u32) -> Vec<u8> {
    let body = open_bytes(login, uid);
    let mut fields = conn::fields("args6", &body)
        .unwrap()
        .iter()
        .map(|(tag, value)| conn::field(*tag, value))
        .collect::<Vec<_>>();
    fields.push(conn::field(5, [7; 16]));
    if uid == 19999 {
        fields.push(conn::field(6, [b"\0\x03".as_slice(), b"run"].concat()));
    }
    conn::structure_bytes(&fields)
}
fn open_bytes(login: &str, uid: u32) -> Vec<u8> {
    let name = [
        (login.len() as u16).to_be_bytes().as_slice(),
        login.as_bytes(),
    ]
    .concat();
    conn::structure_bytes(&[
        conn::field(
            1,
            conn::structure_bytes(&[conn::field(1, name), conn::field(2, uid.to_be_bytes())]),
        ),
        conn::field(2, [1]),
    ])
}
#[test]
#[allow(non_snake_case)]
fn TestSessionAdmissionFailsClosed() {
    for missing in [
        "authenticated machine",
        "wire",
        "measured protocol",
        "trusted startup",
        "account binding",
        "session environment",
        "credential",
    ] {
        let (mut s, state) = setup();
        roster(&mut s);
        state.lock().unwrap().missing = Some(missing);
        let reply = control::handle(&packet(6, &host_open_bytes("ben", 20001)), &mut s).unwrap();
        assert_eq!(reply[4], 255, "{missing}");
        assert!(s.entries().next().is_none());
        assert!(state.lock().unwrap().spawns.is_empty());
    }
    let (mut s, state) = setup();
    assert_eq!(
        control::handle(&packet(6, &host_open_bytes("ben", 20001)), &mut s).unwrap()[4],
        255,
        "roster absent"
    );
    roster(&mut s);
    for (login, uid) in [
        ("root", 0),
        ("ben", 20002),
        ("other", 20001),
        ("../ben", 20001),
        ("machined", 20001),
        ("agent", 20001),
    ] {
        assert_eq!(
            control::handle(&packet(6, &host_open_bytes(login, uid)), &mut s).unwrap()[4],
            255
        );
    }
    let args = open_bytes("agent", 19999);
    assert_eq!(
        control::handle(
            &packet(19, &[1u32.to_be_bytes().as_slice(), &args].concat()),
            &mut s
        )
        .unwrap()[4],
        255
    );
    assert!(state.lock().unwrap().spawns.is_empty());
    // The literal valid control reaches the real supervisor exactly once.
    assert_eq!(
        control::handle(&packet(6, &host_open_bytes("ben", 20001)), &mut s).unwrap()[4],
        6
    );
    assert_eq!(state.lock().unwrap().spawns.len(), 1);
}
#[test]
fn blocked_stdin_earns_no_credit_and_half_close_waits_for_delivery() {
    let (mut s, state) = setup();
    roster(&mut s);
    let id = open(&mut s, user(), Kind::Exec);
    state.lock().unwrap().blocked = true;
    send(&mut s, frame(id, vec![1, 0, b'a', b'b', b'c']));
    send(&mut s, frame(id, vec![2, 0]));
    assert!(poll(&mut s, 0).is_none());
    assert!(state.lock().unwrap().eofs.is_empty());
    state.lock().unwrap().blocked = false;
    assert_eq!(poll(&mut s, 0).unwrap().payload, [6, 0, 0, 0, 3]);
    assert_eq!(state.lock().unwrap().inputs[&id], b"abc");
    assert_eq!(state.lock().unwrap().eofs, [id]);
    assert!(poll(&mut s, 0).is_none());
    assert_eq!(state.lock().unwrap().eofs, [id]);
}
#[test]
fn exit_follows_both_outputs_and_marks_registry_once() {
    let (mut s, state) = setup();
    roster(&mut s);
    let id = open(&mut s, user(), Kind::Exec);
    {
        let mut state = state.lock().unwrap();
        state.outputs.insert((id, 1), b"out".to_vec());
        state.outputs.insert((id, 2), b"err".to_vec());
        state.exits.insert(id, Exit::Code(7));
    }
    let payloads: Vec<_> = (0..5).map(|_| poll(&mut s, 0).unwrap().payload).collect();
    assert_eq!(
        payloads,
        vec![
            vec![1, 1, b'o', b'u', b't'],
            vec![1, 2, b'e', b'r', b'r'],
            vec![2, 1],
            vec![2, 2],
            vec![5, 0, 0, 0, 0, 7]
        ]
    );
    assert!(s.entries().next().unwrap().exited);
    assert!(poll(&mut s, 0).is_none());
}
#[test]
fn replay_offsets_are_atomic_and_stalled_output_is_bounded() {
    let (mut s, state) = setup();
    roster(&mut s);
    let id = open(&mut s, user(), Kind::Pty);
    state
        .lock()
        .unwrap()
        .outputs
        .insert((id, 1), vec![42; 300_000]);
    let mut bytes = 0;
    while let Some(frame) = poll(&mut s, 0) {
        bytes += frame.payload.len() - 2;
    }
    assert_eq!(bytes, 262_144);
    assert_eq!(state.lock().unwrap().outputs[&(id, 1)].len(), 37_856);
    let now = Instant::now();
    s.disconnected(now);
    assert!(s
        .session(Request::Attach {
            session: id,
            received: 262_145
        })
        .is_err());
    let reply = s
        .session(Request::Attach {
            session: id,
            received: 262_140,
        })
        .unwrap();
    assert_eq!(&reply[5..], &0u64.to_be_bytes());
    assert_eq!(poll(&mut s, 0).unwrap().payload, vec![1, 1, 42, 42, 42, 42]);
    assert_eq!(poll(&mut s, 0).unwrap().payload.len(), 37_858);
}
#[test]
fn local_stream_is_scoped_to_kernel_registered_agent_run() {
    let (mut s, state) = setup();
    roster(&mut s);
    let agent = User {
        login: "agent".into(),
        uid: 19999,
    };
    let parent = open_bound(&mut s, agent, Kind::Exec, Some("run-one"));
    let args = open_bytes("agent", 19999);
    assert!(s.open_local(999, &args).is_err());
    assert!(state.lock().unwrap().local_ready_calls.is_empty());
    s.session(Request::Register {
        session: parent,
        run: "run-one".into(),
    })
    .unwrap();
    let child = s.open_local(parent, &args).unwrap();
    assert_eq!(state.lock().unwrap().ready_calls, 1);
    assert_eq!(state.lock().unwrap().local_ready_calls, vec![parent]);
    let child = u32::from_be_bytes(child[5..9].try_into().unwrap());
    assert_eq!(
        s.entries().find(|e| e.id == child).unwrap().run.as_deref(),
        Some("run-one")
    );
    assert!(s
        .session(Request::Register {
            session: child,
            run: "forged".into()
        })
        .is_err());
    assert_eq!(
        s.admission_of_cgroup(&format!("/smithers/sessions/s{child}")),
        Some(Admission {
            principal: [7; 16],
            run: Some("run-one".into())
        })
    );
    assert!(s.admission_of_cgroup("/smithers/sessions/../s1").is_none());
    assert!(s
        .session(Request::Attach {
            session: child,
            received: 0
        })
        .is_err());
    s.session(Request::KillRun("run-one".into())).unwrap();
    assert!(s.entries().next().is_none());
}
#[test]
fn revocation_retains_failed_cleanup_and_restart_retries() {
    let (mut s, state) = setup();
    roster(&mut s);
    let id = open(&mut s, user(), Kind::Pty);
    state.lock().unwrap().fail_kill = Some(id);
    assert!(s.session(Request::Roster(vec![])).is_err());
    assert_eq!(s.entries().count(), 1);
    assert!(s.frame(&frame(id, vec![1, 0, b'x'])).is_err());
    assert!(state.lock().unwrap().inputs.is_empty());
    assert!(s.before_restart(Instant::now()).is_err());
    state.lock().unwrap().fail_kill = None;
    s.before_restart(Instant::now()).unwrap();
    assert_eq!(state.lock().unwrap().kills, [id]);
    assert_eq!(s.entries().count(), 0);
}
#[test]
fn grace_expiry_closes_once_without_killing_lingering_processes() {
    let (mut s, state) = setup();
    roster(&mut s);
    let id = open(&mut s, user(), Kind::Pty);
    let now = Instant::now();
    s.disconnected(now);
    s.disconnected(now + Duration::from_secs(10));
    assert!(s
        .poll_one(None, now + Duration::from_secs(30))
        .unwrap()
        .is_none());
    assert_eq!(state.lock().unwrap().closes, [id]);
    assert!(state.lock().unwrap().kills.is_empty());
    assert_eq!(s.entries().count(), 1);
    s.poll_one(None, now + Duration::from_secs(31)).unwrap();
    assert_eq!(state.lock().unwrap().closes, [id]);
    s.session(Request::KillUser(user())).unwrap();
    assert_eq!(state.lock().unwrap().kills, [id]);
}
#[test]
fn malformed_internal_operations_never_touch_descriptors() {
    let (mut s, state) = setup();
    roster(&mut s);
    for (op, bytes) in [
        (17, vec![]),
        (18, vec![]),
        (19, vec![0; 4]),
        (20, b"../x".to_vec()),
        (21, vec![1]),
        (22, vec![1]),
        (23, vec![1]),
    ] {
        assert_eq!(
            control::handle(&packet(op, &bytes), &mut s).unwrap()[4],
            255
        );
    }
    assert!(state.lock().unwrap().spawns.is_empty());
    let id = open(&mut s, user(), Kind::Pty);
    assert!(s.frame(&frame(id, vec![3, 0, 0, 0, 80])).is_err());
    assert!(s.frame(&frame(id, vec![4, 0])).is_err());
    assert!(s.frame(&frame(999, vec![7])).is_err());
}
#[test]
fn roster_wire_uses_the_same_registry_as_session_dispatch() {
    let (mut s, _) = setup();
    let bytes = request::roster_bytes(&[user()]).unwrap();
    assert_eq!(
        control::handle(&packet(16, &bytes), &mut s).unwrap(),
        [0, 0, 0, 9, 16, 0, 0, 0, 0]
    );
    open(&mut s, user(), Kind::Sftp);
    assert_eq!(s.entries().next().unwrap().kind, Kind::Sftp);
}

#[cfg(target_os = "linux")]
#[test]
fn actual_socketpair_carries_credit_and_full_sized_frames() {
    use rustix::net::{socketpair, AddressFamily, SocketFlags, SocketType};
    use smithers_machined::{
        broker::control::SocketpairBroker,
        hooks::{Broker, Sessions},
    };
    let (mut supervisor, state) = setup();
    let (server, client) = socketpair(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC,
        None,
    )
    .unwrap();
    let serving = std::thread::spawn(move || control::serve(&server, &mut supervisor));
    let broker = SocketpairBroker::new(client).unwrap();
    Broker::set_roster(&broker, &[user()]).unwrap();
    let reply = Sessions::call(&broker, 6, &host_open_bytes("ben", 20001)).unwrap();
    let id = u32::from_be_bytes(reply[5..9].try_into().unwrap());
    let input = frame(id, [&[1, 0], vec![b'x'; 65_536].as_slice()].concat());
    assert_eq!(Sessions::frame(&broker, &input).unwrap(), None);
    assert_eq!(Sessions::poll(&broker).unwrap()[0].payload, [6, 0, 1, 0, 0]);
    assert_eq!(state.lock().unwrap().inputs[&id], vec![b'x'; 65_536]);
    state
        .lock()
        .unwrap()
        .outputs
        .insert((id, 1), vec![b'y'; 65_536]);
    let out = Sessions::poll(&broker).unwrap();
    assert_eq!(out[0].payload.len(), 65_538);
    assert_eq!(
        Sessions::frame(&broker, &frame(id, vec![6, 0, 1, 0, 0])).unwrap(),
        None
    );
    drop(broker);
    serving.join().unwrap().unwrap();
}

#[test]
fn close_is_delivered_once_and_closed_leader_is_still_reaped() {
    let (mut s, state) = setup();
    roster(&mut s);
    let id = open(&mut s, user(), Kind::Pty);
    send(&mut s, frame(id, vec![7]));
    s.session(Request::Close(id)).unwrap();
    assert_eq!(state.lock().unwrap().closes, [id]);
    state.lock().unwrap().exits.insert(id, Exit::Code(0));
    s.tick().unwrap();
    let entry = s.entries().next().unwrap();
    assert!(entry.closed && entry.exited);
    assert!(poll(&mut s, 0).is_none());
    assert!(state.lock().unwrap().kills.is_empty());
}
#[test]
fn busy_stdout_cannot_starve_another_session_or_local_output() {
    let (mut s, state) = setup();
    roster(&mut s);
    let first = open(&mut s, user(), Kind::Pty);
    let second = open(&mut s, user(), Kind::Pty);
    state
        .lock()
        .unwrap()
        .outputs
        .insert((first, 1), vec![1; 262_144]);
    state
        .lock()
        .unwrap()
        .outputs
        .insert((second, 1), vec![2; 1]);
    assert_eq!(poll(&mut s, 0).unwrap().stream, first);
    assert_eq!(poll(&mut s, 0).unwrap().stream, second);
    let parent = open(
        &mut s,
        User {
            login: "agent".into(),
            uid: 19999,
        },
        Kind::Exec,
    );
    s.session(Request::Register {
        session: parent,
        run: "run".into(),
    })
    .unwrap();
    let bytes = s.open_local(parent, &open_bytes("agent", 19999)).unwrap();
    let local = u32::from_be_bytes(bytes[5..9].try_into().unwrap());
    state
        .lock()
        .unwrap()
        .outputs
        .insert((local, 1), b"local".to_vec());
    for _ in 0..5 {
        if let Some(frame) = poll(&mut s, 0) {
            assert_ne!(frame.stream, local);
        }
    }
    assert_eq!(
        poll(&mut s, local).unwrap().payload,
        [&[1, 1], b"local".as_slice()].concat()
    );
}

#[test]
fn session_ids_share_document_object_reservations_and_never_reuse() {
    let (mut s, _) = setup();
    roster(&mut s);
    assert_eq!(
        control::handle(&packet(24, &[]), &mut s).unwrap(),
        [0, 0, 0, 9, 24, 0, 0, 0, 1]
    );
    let session = open(&mut s, user(), Kind::Pty);
    assert_eq!(session, 2);
    s.session(Request::KillUser(user())).unwrap();
    assert_eq!(s.allocate_stream().unwrap(), 3);
}

#[test]
fn literal_open_size_is_columns_then_rows_on_the_wire() {
    // ADR 0004: User ben/20001, PTY, Size {cols:80, rows:24}.
    let bytes = [
        0, 0, 0, 29, 1, 0, 0, 0, 11, 1, 0, 3, b'b', b'e', b'n', 2, 0, 0, 78, 33, 2, 1, 4, 0, 0, 0,
        6, 1, 0, 80, 2, 0, 24,
    ];
    let request = Request::decode(6, &bytes).unwrap();
    assert_eq!(
        request,
        Request::Open {
            user: user(),
            kind: Kind::Pty,
            argv: vec![],
            size: Some((24, 80)),
            admission: None
        }
    );
}

#[test]
fn broker_registry_projection_is_read_only_and_retains_lingering_ownership() {
    let (mut supervisor, state) = setup();
    roster(&mut supervisor);
    let id = open(&mut supervisor, user(), Kind::Pty);
    supervisor.session(Request::Close(id)).unwrap();
    let response = control::handle(&packet(25, &[]), &mut supervisor).unwrap();
    assert_eq!(&response[..5], &[0, 0, 0, 9, 25]);
    let entries: Vec<smithers_machined::broker::sessions::Entry> =
        serde_json::from_slice(&response[5..]).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].id, id);
    assert_eq!(entries[0].user.login, "ben");
    assert_eq!(entries[0].user.uid, 20001);
    assert_eq!(entries[0].kind, Kind::Pty);
    assert!(entries[0].closed);
    assert_eq!(entries[0].run, None);
    let forged = control::handle(&packet(25, br#"{"uid":0}"#), &mut supervisor).unwrap();
    assert_eq!(forged[4], 255);
    assert_eq!(supervisor.entries().count(), 1);
    assert_eq!(state.lock().unwrap().spawns.len(), 1);
    assert!(state.lock().unwrap().kills.is_empty());
}

#[test]
fn failed_spawn_is_removed_only_after_confirmed_cleanup_and_never_reuses_id() {
    for before_fork in [false, true] {
        let (mut s, state) = setup();
        roster(&mut s);
        {
            let mut state = state.lock().unwrap();
            state.fail_spawn = !before_fork;
            state.fail_before_fork = before_fork;
        }
        let result = s.session(Request::Open {
            admission: Some(Admission {
                principal: [7; 16],
                run: None,
            }),
            user: user(),
            kind: Kind::Exec,
            argv: vec!["/bin/sh".into()],
            size: None,
        });
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::BrokenPipe);
        assert!(s.entries().next().is_none());
        {
            let mut state = state.lock().unwrap();
            assert_eq!(state.kills, [1]);
            assert!(state.running.is_empty());
            state.fail_spawn = false;
            state.fail_before_fork = false;
        }
        assert_eq!(open(&mut s, user(), Kind::Pty), 2);
    }
}

#[test]
fn failed_spawn_cleanup_retains_owner_without_breaking_other_streams() {
    let (mut s, state) = setup();
    roster(&mut s);
    let healthy = open(&mut s, user(), Kind::Pty);
    {
        let mut state = state.lock().unwrap();
        state.fail_spawn = true;
        state.fail_kill = Some(2);
        state.outputs.insert((healthy, 1), b"still usable".to_vec());
    }
    let result = s.session(Request::Open {
        admission: Some(Admission {
            principal: [7; 16],
            run: None,
        }),
        user: user(),
        kind: Kind::Exec,
        argv: vec!["/bin/sh".into()],
        size: None,
    });
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
    let retained = s.entries().find(|e| e.id == 2).unwrap();
    assert_eq!(retained.user, user());
    assert_eq!(retained.kind, Kind::Exec);
    assert!(retained.closed);
    assert!(state.lock().unwrap().running.contains(&2));
    assert!(s
        .session(Request::Attach {
            session: 2,
            received: 0
        })
        .is_err());
    assert!(s.frame(&frame(2, vec![1, 0, b'x'])).is_err());
    assert!(!state.lock().unwrap().inputs.contains_key(&2));
    s.tick().unwrap();
    let output = poll(&mut s, 0).unwrap();
    assert_eq!(output.stream, healthy);
    assert_eq!(&output.payload[2..], b"still usable");
    assert!(s.session(Request::Roster(vec![])).is_err());
    assert_eq!(s.entries().count(), 1);
    assert_eq!(s.entries().next().unwrap().id, 2);
    state.lock().unwrap().fail_kill = None;
    s.session(Request::Roster(vec![])).unwrap();
    assert!(s.entries().next().is_none());
    assert!(state.lock().unwrap().running.is_empty());
}

#[test]
fn failed_local_spawn_retains_run_for_cleanup_without_granting_child_authority() {
    let (mut s, state) = setup();
    roster(&mut s);
    let parent = open_bound(
        &mut s,
        User {
            login: "agent".into(),
            uid: 19999,
        },
        Kind::Exec,
        Some("original-run"),
    );
    s.session(Request::Register {
        session: parent,
        run: "original-run".into(),
    })
    .unwrap();
    {
        let mut state = state.lock().unwrap();
        state.fail_spawn = true;
        state.fail_kill = Some(2);
    }
    let args = open_bytes("agent", 19999);
    assert_eq!(
        s.open_local(parent, &args).unwrap_err().kind(),
        io::ErrorKind::TimedOut
    );
    let entry = s.entries().find(|e| e.id == 2).unwrap();
    assert_eq!(entry.run.as_deref(), Some("original-run"));
    assert_eq!(entry.user.uid, 19999);
    assert!(entry.closed);
    assert!(s.admission_of_cgroup("/smithers/sessions/s2").is_none());
    assert!(s.open_local(2, &args).is_err());
    assert!(s
        .session(Request::Register {
            session: 2,
            run: "replacement".into()
        })
        .is_err());
    assert_eq!(state.lock().unwrap().spawns.len(), 2);
    assert!(s.session(Request::KillRun("original-run".into())).is_err());
    assert_eq!(s.entries().count(), 1);
    assert_eq!(
        s.entries().next().unwrap().run.as_deref(),
        Some("original-run")
    );
    state.lock().unwrap().fail_kill = None;
    s.session(Request::KillRun("original-run".into())).unwrap();
    assert!(s.entries().next().is_none());
    assert!(state.lock().unwrap().running.is_empty());
}

#[test]
fn failed_spawn_reservations_count_toward_limit_before_consuming_admission() {
    use smithers_machined::broker::sessions::MAX_SESSIONS;
    let (mut s, state) = setup();
    roster(&mut s);
    {
        let mut state = state.lock().unwrap();
        state.fail_spawn = true;
        state.fail_all_kills = true;
    }
    for _ in 0..MAX_SESSIONS {
        assert_eq!(
            s.session(Request::Tcp(
                8080,
                Some(Admission {
                    principal: [7; 16],
                    run: None
                })
            ))
            .unwrap_err()
            .kind(),
            io::ErrorKind::TimedOut
        );
    }
    assert_eq!(s.entries().count(), MAX_SESSIONS);
    assert_eq!(
        s.session(Request::Tcp(
            8080,
            Some(Admission {
                principal: [7; 16],
                run: None
            })
        ))
        .unwrap_err()
        .kind(),
        io::ErrorKind::InvalidInput
    );
    {
        let mut state = state.lock().unwrap();
        assert_eq!(state.spawns.len(), MAX_SESSIONS);
        assert_eq!(state.ready_calls, MAX_SESSIONS);
        assert_eq!(state.running.len(), MAX_SESSIONS);
        state.fail_all_kills = false;
        state.fail_spawn = false;
    }
    s.before_restart(Instant::now()).unwrap();
    assert!(s.entries().next().is_none());
    assert!(state.lock().unwrap().running.is_empty());
    assert_eq!(open(&mut s, user(), Kind::Pty), MAX_SESSIONS as u32 + 1);
}

#[test]
fn live_host_attribution_is_required_before_any_kernel_effect() {
    let (mut s, state) = setup();
    roster(&mut s);
    assert!(s
        .session(Request::decode(6, &open_bytes("ben", 20001)).unwrap())
        .is_err());
    for (user, admission) in [
        (
            user(),
            Admission {
                principal: [0; 16],
                run: None,
            },
        ),
        (
            user(),
            Admission {
                principal: [7; 16],
                run: Some("forged-run".into()),
            },
        ),
        (
            User {
                login: "agent".into(),
                uid: 19999,
            },
            Admission {
                principal: [7; 16],
                run: None,
            },
        ),
        (
            User {
                login: "agent".into(),
                uid: 19999,
            },
            Admission {
                principal: [7; 16],
                run: Some(" run ".into()),
            },
        ),
    ] {
        assert!(s
            .session(Request::Open {
                user,
                kind: Kind::Pty,
                argv: vec![],
                size: None,
                admission: Some(admission)
            })
            .is_err());
    }
    assert_eq!(state.lock().unwrap().ready_calls, 0);
    assert!(state.lock().unwrap().spawns.is_empty());
    assert!(s.entries().next().is_none());
}

#[test]
fn durable_reference_survives_close_and_local_children_cannot_replace_it() {
    let (mut s, state) = setup();
    roster(&mut s);
    let parent = open_bound(
        &mut s,
        User {
            login: "agent".into(),
            uid: 19999,
        },
        Kind::Exec,
        Some("first-run"),
    );
    assert_eq!(s.entries().next().unwrap().principal, [7; 16]);
    assert_eq!(
        s.entries().next().unwrap().run.as_deref(),
        Some("first-run")
    );
    // Closing the leader does not erase a surviving child's cgroup identity.
    s.session(Request::Close(parent)).unwrap();
    assert!(s
        .open_local(parent, &host_open_bytes("agent", 19999))
        .is_err());
    assert_eq!(state.lock().unwrap().spawns.len(), 1);
    let reply = s.open_local(parent, &open_bytes("agent", 19999)).unwrap();
    let id = u32::from_be_bytes(reply[5..9].try_into().unwrap());
    let child = s.entries().find(|e| e.id == id).unwrap();
    assert_eq!(child.principal, [7; 16]);
    assert_eq!(child.run.as_deref(), Some("first-run"));
    let snapshot = control::handle(&packet(25, &[]), &mut s).unwrap();
    let retained: Vec<smithers_machined::broker::sessions::Entry> =
        serde_json::from_slice(&snapshot[5..]).unwrap();
    assert!(retained
        .iter()
        .all(|e| e.principal == [7; 16] && e.run.as_deref() == Some("first-run")));
    assert!(s
        .session(Request::Register {
            session: id,
            run: "replacement".into()
        })
        .is_err());
    // A reconstructed broker may reuse transport 1. The durable reference does
    // not change in the old snapshot and is not derived from that numeric ID.
    let (mut replacement, _) = setup();
    roster(&mut replacement);
    replacement
        .session(Request::Open {
            user: user(),
            kind: Kind::Pty,
            argv: vec![],
            size: None,
            admission: Some(Admission {
                principal: [8; 16],
                run: None,
            }),
        })
        .unwrap();
    assert_eq!(replacement.entries().next().unwrap().id, parent);
    assert_eq!(replacement.entries().next().unwrap().principal, [8; 16]);
    assert_eq!(retained[0].principal, [7; 16]);
}

#[test]
fn cancelling_one_command_confirms_cleanup_without_killing_run_siblings() {
    let (mut s, state) = setup();
    roster(&mut s);
    let agent = User {
        login: "agent".into(),
        uid: 19999,
    };
    let first = open(&mut s, agent.clone(), Kind::Exec);
    let sibling = open(&mut s, agent, Kind::Exec);
    let member = open(&mut s, user(), Kind::Pty);
    // A populated cgroup is not a success, and its original actor is retained.
    state.lock().unwrap().fail_kill = Some(first);
    assert!(s.session(Request::KillSession(first)).is_err());
    let retained = s.entries().find(|entry| entry.id == first).unwrap();
    assert_eq!(retained.principal, [7; 16]);
    assert_eq!(retained.run.as_deref(), Some("run"));
    assert!(retained.closed);
    assert!(s
        .admission_of_cgroup(&format!("/smithers/sessions/s{first}"))
        .is_none());
    assert!(s
        .admission_of_cgroup(&format!("/smithers/sessions/s{sibling}"))
        .is_some());
    assert!(s
        .session(Request::Attach {
            session: first,
            received: 0
        })
        .is_err());
    assert!(s.frame(&frame(first, vec![1, 0, b'x'])).is_err());
    assert_eq!(state.lock().unwrap().running.len(), 3);
    // Cleanup retry uses the same owned group. Successful cleanup affects one
    // command, even though two commands share an admitted run and unix user.
    state.lock().unwrap().fail_kill = None;
    assert_eq!(
        s.session(Request::KillSession(first)).unwrap(),
        vec![0, 0, 0, 3, 1, 0, 1]
    );
    assert_eq!(state.lock().unwrap().kills, vec![first]);
    assert_eq!(
        state.lock().unwrap().running,
        BTreeSet::from([sibling, member])
    );
    assert_eq!(s.entries().count(), 2);
    assert_eq!(
        s.session(Request::KillSession(first)).unwrap(),
        vec![0, 0, 0, 3, 1, 0, 0]
    );
    assert_eq!(state.lock().unwrap().kills, vec![first]);
    send(&mut s, frame(sibling, vec![1, 0, b'y']));
    assert_eq!(poll(&mut s, 0).unwrap().payload, [6, 0, 0, 0, 1]);
    assert_eq!(state.lock().unwrap().inputs[&sibling], b"y");
    // Closed streams may still own detached descendants; they remain killable.
    s.session(Request::Close(sibling)).unwrap();
    assert!(state.lock().unwrap().running.contains(&sibling));
    s.session(Request::KillSession(sibling)).unwrap();
    assert_eq!(state.lock().unwrap().running, BTreeSet::from([member]));
    for id in [0, 0x8000_0000, u32::MAX] {
        assert!(s.session(Request::KillSession(id)).is_err());
    }
    assert_eq!(state.lock().unwrap().kills, vec![first, sibling]);
}

#[test]
fn process_binding_is_kernel_owned_and_invalid_identity_rolls_back_spawn() {
    use smithers_machined::broker::sessions::{Entry, ProcessIdentity};
    let identity = ProcessIdentity {
        pid: 123,
        start_ticks: 456,
        gid: 20001,
        groups: vec![20000],
        home: "/home/ben".into(),
    };
    let (mut supervisor, state) = setup();
    roster(&mut supervisor);
    state.lock().unwrap().identity = Some(identity.clone());
    let id = open(&mut supervisor, user(), Kind::Pty);
    let reply = control::handle(&packet(25, &[]), &mut supervisor).unwrap();
    let entries: Vec<Entry> = serde_json::from_slice(&reply[5..]).unwrap();
    assert_eq!(entries[0].id, id);
    assert_eq!(entries[0].process.as_ref(), Some(&identity));
    assert_eq!(entries[0].user.uid, 20001);
    let forged = control::handle(
        &packet(25, br#"{"pid":1,"gid":0,"home":"/root"}"#),
        &mut supervisor,
    )
    .unwrap();
    assert_eq!(forged[4], 255);
    assert_eq!(
        supervisor.entries().next().unwrap().process.as_ref(),
        Some(&identity)
    );

    for wrong in 0..6 {
        let (mut supervisor, state) = setup();
        roster(&mut supervisor);
        let mut binding = identity.clone();
        match wrong {
            0 => binding.pid = 0,
            1 => binding.start_ticks = 0,
            2 => binding.gid = 20002,
            3 => binding.groups = vec![0, 20000],
            4 => binding.home = "/home/maya".into(),
            5 => binding.groups = vec![],
            _ => unreachable!(),
        }
        state.lock().unwrap().identity = Some(binding);
        let reply =
            control::handle(&packet(6, &host_open_bytes("ben", 20001)), &mut supervisor).unwrap();
        assert_eq!(reply[4], 255);
        assert_eq!(state.lock().unwrap().kills, vec![1]);
        assert_eq!(supervisor.entries().count(), 0);
    }
}

// Production privileged dispatch with an observable kernel seam. Real account,
// descriptor and cgroup effects are deliberately not claimed by this receipt.
#[test]
#[allow(non_snake_case)]
fn TestSessionRootInputsValidated() {
    let (mut supervisor, state) = setup();
    roster(&mut supervisor);
    let id = open(&mut supervisor, user(), Kind::Pty);
    for (operation, body) in [
        (6, host_open_bytes("../ben", 20001)),
        (6, host_open_bytes("ben", 0)),
        (6, host_open_bytes("ben", 20002)),
        (6, host_open_bytes("root", 20001)),
        (6, open_bytes("ben", 20001)), // no host attribution
        (
            8,
            conn::structure_bytes(&[conn::field(1, 0u32.to_be_bytes())]),
        ),
        (
            8,
            conn::structure_bytes(&[conn::field(1, 999u32.to_be_bytes())]),
        ),
        (
            10,
            conn::structure_bytes(&[
                conn::field(1, [0, 3, b'r', b'u', b'n']),
                conn::field(2, id.to_be_bytes()),
            ]),
        ), // member cannot own a run
        (
            15,
            conn::structure_bytes(&[
                conn::field(1, 999u32.to_be_bytes()),
                conn::field(2, 0u64.to_be_bytes()),
            ]),
        ),
        (20, b"/sys/fs/cgroup/smithers/sessions/../../root".to_vec()),
        (25, br#"{"session":1,"pid":1,"uid":0}"#.to_vec()),
    ] {
        let reply = control::handle(&packet(operation, &body), &mut supervisor).unwrap();
        assert_eq!(reply[4], 255, "operation {operation}");
    }
    // Lifecycle values bypass the host encoder here, so its early refusals
    // cannot conceal a missing validation at the privileged broker boundary.
    for session in [0u32, 0x80000000, 0xffffffff] {
        for operation in [8, 9, 10, 15] {
            let body = match operation {
                9 => conn::structure_bytes(&[conn::field(
                    1,
                    conn::tagged(3, &[conn::field(1, session.to_be_bytes())]),
                )]),
                10 => conn::structure_bytes(&[
                    conn::field(1, [0, 3, b'r', b'u', b'n']),
                    conn::field(2, session.to_be_bytes()),
                ]),
                15 => conn::structure_bytes(&[
                    conn::field(1, session.to_be_bytes()),
                    conn::field(2, 0u64.to_be_bytes()),
                ]),
                _ => conn::structure_bytes(&[conn::field(1, session.to_be_bytes())]),
            };
            assert_eq!(
                control::handle(&packet(operation, &body), &mut supervisor).unwrap()[4],
                255,
                "operation {operation}, session {session}"
            );
        }
    }
    for bytes in [vec![0, 0], vec![0, 3, b'r', 0, b'n'], vec![0, 1, 255]] {
        for operation in [9, 10] {
            let body = if operation == 9 {
                conn::structure_bytes(&[conn::field(1, conn::tagged(2, &[conn::field(1, &bytes)]))])
            } else {
                conn::structure_bytes(&[conn::field(1, &bytes), conn::field(2, id.to_be_bytes())])
            };
            assert_eq!(
                control::handle(&packet(operation, &body), &mut supervisor).unwrap()[4],
                255,
                "operation {operation}, run bytes {bytes:?}"
            );
        }
    }
    // Construct hostile wire values directly: the client encoder must not
    // sanitize them before they reach the privileged production dispatcher.
    let user_bytes = conn::structure_bytes(&[
        conn::field(1, [0, 3, b'b', b'e', b'n']),
        conn::field(2, 20001u32.to_be_bytes()),
    ]);
    let bad_size = conn::structure_bytes(&[
        conn::field(1, 0u16.to_be_bytes()),
        conn::field(2, 24u16.to_be_bytes()),
    ]);
    for (kind, extra) in [
        (0, vec![]),
        (4, vec![]),
        (2, vec![]),                             // exec needs an executable
        (1, vec![conn::field(3, [0, 1, 0, 0])]), // empty executable
        (1, vec![conn::field(3, [0, 1, 0, 2, b'x', 0])]),
        (1, vec![conn::field(3, [0, 1, 0, 1, 255])]),
        (3, vec![conn::field(3, [0, 1, 0, 1, b'x'])]),
        (1, vec![conn::field(4, bad_size.clone())]),
        (3, vec![conn::field(4, bad_size)]),
        (1, vec![conn::field(7, b"/workspace/root-canary")]),
    ] {
        let mut fields = vec![conn::field(1, &user_bytes), conn::field(2, [kind])];
        fields.extend(extra);
        fields.push(conn::field(5, [7; 16]));
        let reply =
            control::handle(&packet(6, &conn::structure_bytes(&fields)), &mut supervisor).unwrap();
        assert_eq!(reply[4], 255, "kind {kind}");
    }
    for (port, principal) in [(0, [7; 16]), (8080, [0; 16])] {
        let args = conn::structure_bytes(&[
            conn::field(1, (port as u16).to_be_bytes()),
            conn::field(2, principal),
        ]);
        assert_eq!(
            control::handle(&packet(7, &args), &mut supervisor).unwrap()[4],
            255
        );
    }
    // A malformed roster must not revoke the already admitted member.
    let member = conn::structure_bytes(&[
        conn::field(1, [0, 3, b'b', b'e', b'n']),
        conn::field(2, 20001u32.to_be_bytes()),
    ]);
    let duplicate_roster = conn::structure_bytes(&[conn::field(
        1,
        [2u16.to_be_bytes().as_slice(), &member, &member].concat(),
    )]);
    assert_eq!(
        control::handle(&packet(16, &duplicate_roster), &mut supervisor).unwrap()[4],
        255
    );
    for payload in [
        vec![3, 0, 0, 0, 80],
        vec![3, 0, 24, 0, 0],
        vec![4, 0],
        vec![4, 255],
    ] {
        let bytes = [
            (payload.len() as u32).to_be_bytes().as_slice(),
            &[5],
            id.to_be_bytes().as_slice(),
            &payload,
        ]
        .concat();
        assert_eq!(
            control::handle(&packet(17, &bytes), &mut supervisor).unwrap()[4],
            255
        );
    }
    for bytes in [vec![0; 65537], vec![0; 4], packet(254, &[0; 4])] {
        let reply = control::handle(&bytes, &mut supervisor);
        assert!(reply.is_err() || reply.unwrap()[4] == 255);
    }
    let observed = state.lock().unwrap();
    assert_eq!(observed.spawns.len(), 1);
    assert_eq!(
        observed.ready_calls, 1,
        "malformed requests consumed admission"
    );
    assert!(observed.closes.is_empty());
    assert!(observed.kills.is_empty());
    assert!(observed.inputs.is_empty());
    assert!(observed.resizes.is_empty());
    assert!(observed.signals.is_empty());
    drop(observed);
    assert_eq!(supervisor.entries().count(), 1);
    // Valid controls reach only the held mapping for the admitted member.
    send(&mut supervisor, frame(id, vec![3, 0, 30, 0, 100]));
    send(&mut supervisor, frame(id, vec![4, 2]));
    assert_eq!(state.lock().unwrap().resizes, [(id, 100, 30)]);
    assert_eq!(state.lock().unwrap().signals, [(id, 2)]);
    let kill = conn::structure_bytes(&[conn::field(
        1,
        conn::tagged(3, &[conn::field(1, id.to_be_bytes())]),
    )]);
    assert_eq!(
        control::handle(&packet(9, &kill), &mut supervisor).unwrap()[4],
        9
    );
    assert!(supervisor.entries().next().is_none());
    for (operation, body) in [
        (
            8,
            conn::structure_bytes(&[conn::field(1, id.to_be_bytes())]),
        ),
        (
            15,
            conn::structure_bytes(&[
                conn::field(1, id.to_be_bytes()),
                conn::field(2, 0u64.to_be_bytes()),
            ]),
        ),
        (
            10,
            conn::structure_bytes(&[
                conn::field(1, [0, 3, b'r', b'u', b'n']),
                conn::field(2, id.to_be_bytes()),
            ]),
        ),
        (17, frame(id, vec![1, 0, b'x']).encode().unwrap()),
        (17, frame(id, vec![3, 0, 24, 0, 80]).encode().unwrap()),
        (17, frame(id, vec![4, 2]).encode().unwrap()),
    ] {
        assert_eq!(
            control::handle(&packet(operation, &body), &mut supervisor).unwrap()[4],
            255
        );
    }
    let observed = state.lock().unwrap();
    assert_eq!(observed.kills, [id]);
    assert!(observed.inputs.is_empty());
    assert!(observed.closes.is_empty());
    assert_eq!(observed.resizes, [(id, 100, 30)]);
    assert_eq!(observed.signals, [(id, 2)]);
}
