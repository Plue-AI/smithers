//! Exact I1 method-16 contract against the real dispatcher and broker registry.
//! Only process/cgroup controls are faked; production W1/W7 owns those hooks.
use smithers_machined::{
    broker::sessions::{Controls, Kind, Sessions, User},
    conn::{field, structure_bytes, tagged, Frame},
    hooks::{Broker, Error, Hooks},
    lock::LockCx,
    rpc,
};
use std::{
    io,
    sync::{Arc, Mutex},
    time::Instant,
};
#[derive(Default)]
struct ProcessControls(Vec<u32>);
impl Controls for ProcessControls {
    fn close(&mut self, _: u32, _: Kind) -> io::Result<()> {
        Ok(())
    }
    fn kill(&mut self, id: u32, _: Instant) -> io::Result<()> {
        self.0.push(id);
        Ok(())
    }
}
struct RosterBroker(Mutex<Sessions<ProcessControls>>);
impl Broker for RosterBroker {
    fn set_roster(&self, members: &[User]) -> smithers_machined::hooks::Result<()> {
        self.0
            .lock()
            .unwrap()
            .set_roster(members, Instant::now())
            .map_err(|_| Error::unsupported())
    }
}
fn request(members: &[(&str, u32)]) -> Frame {
    let mut list = (members.len() as u16).to_be_bytes().to_vec();
    for (login, uid) in members {
        let mut text = (login.len() as u16).to_be_bytes().to_vec();
        text.extend(login.as_bytes());
        list.extend(structure_bytes(&[
            field(1, text),
            field(2, uid.to_be_bytes()),
        ]));
    }
    Frame {
        kind: 1,
        stream: 0,
        payload: tagged(
            1,
            &[
                field(1, 42u32.to_be_bytes()),
                field(2, tagged(16, &[field(1, list)])),
            ],
        ),
    }
}
fn call(cx: &mut LockCx, request: &Frame) -> Frame {
    let mut output = vec![];
    rpc::serve_one(
        &mut io::Cursor::new(request.encode().unwrap()),
        &mut output,
        cx,
    )
    .unwrap();
    Frame::decode(&output).unwrap()
}
#[test]
fn host_roster_wire_controls_admission_and_reconnect_revocation() {
    let broker = Arc::new(RosterBroker(Mutex::new(Sessions::new(
        ProcessControls::default(),
    ))));
    let mut cx = LockCx::new(Hooks {
        broker: broker.clone(),
        ..Hooks::default()
    });
    let ben = User {
        login: "ben".into(),
        uid: 20001,
    };
    assert!(broker.0.lock().unwrap().authorize(&ben).is_err());
    let expected = Frame {
        kind: 1,
        stream: 0,
        payload: tagged(
            2,
            &[field(1, 42u32.to_be_bytes()), field(2, tagged(16, &[]))],
        ),
    };
    assert_eq!(
        call(&mut cx, &request(&[("ben", 20001), ("alice", 20002)])),
        expected
    );
    {
        let mut sessions = broker.0.lock().unwrap();
        sessions
            .insert(
                1,
                ben.clone(),
                Kind::Pty,
                smithers_machined::broker::sessions::Admission {
                    principal: [7; 16],
                    run: None,
                },
            )
            .unwrap();
        sessions
            .insert(
                2,
                User {
                    login: "alice".into(),
                    uid: 20002,
                },
                Kind::Sftp,
                smithers_machined::broker::sessions::Admission {
                    principal: [7; 16],
                    run: None,
                },
            )
            .unwrap();
        sessions.disconnected(Instant::now());
    }
    assert_eq!(call(&mut cx, &request(&[("alice", 20002)])), expected);
    let mut sessions = broker.0.lock().unwrap();
    assert!(sessions.attach(1, Instant::now()).is_err());
    assert!(sessions.authorize(&ben).is_err());
    sessions.attach(2, Instant::now()).unwrap();
    assert_eq!(sessions.entries().map(|e| e.id).collect::<Vec<_>>(), [2]);
}
#[test]
fn default_broker_refuses_and_malformed_roster_never_mutates() {
    let mut cx = LockCx::new(Hooks::default());
    let refused = Frame {
        kind: 1,
        stream: 0,
        payload: tagged(
            2,
            &[
                field(1, 42u32.to_be_bytes()),
                field(2, tagged(255, &[field(1, [2])])),
            ],
        ),
    };
    assert_eq!(call(&mut cx, &request(&[])), refused);
    let broker = Arc::new(RosterBroker(Mutex::new(Sessions::new(
        ProcessControls::default(),
    ))));
    let mut cx = LockCx::new(Hooks {
        broker: broker.clone(),
        ..Hooks::default()
    });
    for members in [
        vec![("root", 20001)],
        vec![("machined", 20001)],
        vec![("ben", 20001), ("ben", 20002)],
    ] {
        assert_eq!(call(&mut cx, &request(&members)), refused);
        assert!(broker
            .0
            .lock()
            .unwrap()
            .authorize(&User {
                login: "agent".into(),
                uid: 19999
            })
            .is_err());
    }
    let frame = request(&[("ben", 20001)]);
    for length in 0..frame.payload.len() {
        let mut truncated = frame.clone();
        truncated.payload.truncate(length);
        assert!(truncated.encode().is_err());
    }
}
