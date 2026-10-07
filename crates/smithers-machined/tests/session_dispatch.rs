//! Production dispatcher with a test-only kernel. These are deterministic
//! admission/stream checks, not real-user or reference-host acceptance receipts.
use smithers_machined::{
    broker::{
        control::{self, Controls},
        request::{self, Request},
        sessions::{Kind, User},
        supervisor::{Kernel, Supervisor},
    },
    conn::{self, Frame},
    session_stream::Exit,
};
use std::{
    collections::BTreeMap,
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
    missing: Option<&'static str>,
    blocked: bool,
    fail_kill: Option<u32>,
}
struct OS(Arc<Mutex<State>>);
impl Kernel for OS {
    fn available(&mut self) -> io::Result<()> {
        Ok(())
    }
    fn recover(&mut self, _: Instant) -> io::Result<()> {
        Ok(())
    }
    fn ready(&mut self, u: &User) -> io::Result<()> {
        let state = self.0.lock().unwrap();
        if state.missing.is_some() {
            return Err(io::ErrorKind::Unsupported.into());
        }
        if u.login != "agent" && !(u.login == "ben" && u.uid == 20001) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
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
        self.0.lock().unwrap().spawns.push((id, u.clone(), k));
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
    fn resize(&mut self, _: u32, _: u16, _: u16) -> io::Result<()> {
        Ok(())
    }
    fn signal(&mut self, _: u32, _: u8) -> io::Result<()> {
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
        if s.fail_kill == Some(id) {
            return Err(io::ErrorKind::TimedOut.into());
        }
        s.kills.push(id);
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
    let bytes = s
        .session(Request::Open {
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
fn admission_fails_closed_through_root_dispatch_before_effects() {
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
        let reply = control::handle(&packet(6, &open_bytes("ben", 20001)), &mut s).unwrap();
        assert_eq!(reply[4], 255, "{missing}");
        assert!(s.entries().next().is_none());
        assert!(state.lock().unwrap().spawns.is_empty());
    }
    let (mut s, state) = setup();
    assert_eq!(
        control::handle(&packet(6, &open_bytes("ben", 20001)), &mut s).unwrap()[4],
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
            control::handle(&packet(6, &open_bytes(login, uid)), &mut s).unwrap()[4],
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
        control::handle(&packet(6, &open_bytes("ben", 20001)), &mut s).unwrap()[4],
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
    let (mut s, _) = setup();
    roster(&mut s);
    let agent = User {
        login: "agent".into(),
        uid: 19999,
    };
    let parent = open(&mut s, agent, Kind::Exec);
    let args = open_bytes("agent", 19999);
    assert!(s.open_local(parent, &args).is_err());
    s.session(Request::Register {
        session: parent,
        run: "run-one".into(),
    })
    .unwrap();
    let child = s.open_local(parent, &args).unwrap();
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
        s.run_of_cgroup(&format!("/smithers/sessions/s{child}")),
        Some("run-one".into())
    );
    assert!(s.run_of_cgroup("/smithers/sessions/../s1").is_none());
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
    let reply = Sessions::call(&broker, 6, &open_bytes("ben", 20001)).unwrap();
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
            size: Some((24, 80))
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
