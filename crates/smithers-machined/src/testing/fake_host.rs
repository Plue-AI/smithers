//! Real byte-stream/codec host and objects-only quarantine importer.
//! Git is a real dependency; fixture privileges are not needed on the Mac host.
use crate::{
    conn::{Frame, ProtocolError},
    link::{nonce, proof, verify, ProofRole},
    msg::*,
    rpc::Rpc,
};
use std::{
    collections::HashSet,
    io::{self, Write},
    net::SocketAddr,
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
#[derive(Clone, Debug)]
pub enum Fault {
    DropAck { seq: u64 },
    AckDuplicate { seq: u64 },
    MissingObjects { seq: u64, times: u8 },
    Reject { seq: u64 },
    DisconnectAfterFrames(usize),
    BadProof,
    NewerBoot,
    Silence(Duration),
}
#[derive(Default)]
pub struct Script {
    pub faults: Vec<Fault>,
}
pub struct FakeHost {
    pub relay_secret: [u8; 32],
    pub boot_id: Id128,
    pub credential: Vec<u8>,
    pub store: TempDir,
    pub receipts: HashSet<Id128>,
    pub heads: Option<Oid>,
    pub script: Script,
    pub sent_prerequisites: HashSet<Oid>,
    pub bundle_cap: usize,
    pub quota: usize,
    used: usize,
    next_stream: u32,
    received_frames: usize,
    stream: Option<TcpStream>,
    next_req: u32,
    last_seq: Option<u64>,
}
impl FakeHost {
    pub fn new() -> io::Result<Self> {
        let store = tempfile::tempdir()?;
        git(store.path(), &["init", "--bare", "--quiet"], None)?;
        Ok(Self {
            relay_secret: [7; 32],
            boot_id: [1; 16],
            credential: b"machine-boot-1".to_vec(),
            store,
            receipts: HashSet::new(),
            heads: None,
            script: Script::default(),
            sent_prerequisites: HashSet::new(),
            bundle_cap: 64 << 20,
            quota: 256 << 20,
            used: 0,
            next_stream: 0x8000_0000,
            received_frames: 0,
            stream: None,
            next_req: 1,
            last_seq: None,
        })
    }
    pub async fn relay(addr: SocketAddr) -> io::Result<Self> {
        let mut h = Self::new()?;
        h.stream = Some(TcpStream::connect(addr).await?);
        Ok(h)
    }
    pub async fn bridge(listener: TcpListener) -> io::Result<Self> {
        let mut h = Self::new()?;
        h.stream = Some(listener.accept().await?.0);
        Ok(h)
    }
    pub async fn send(&mut self, msg: Message, stream: u32) -> Result<(), ProtocolError> {
        let bytes = msg.frame(stream, Direction::HostToDaemon)?.encode()?;
        self.stream
            .as_mut()
            .ok_or(ProtocolError::HandshakeOrder)?
            .write_all(&bytes)
            .await
            .map_err(|_| ProtocolError::Truncated)
    }
    pub async fn receive_frame(&mut self) -> Result<Frame, ProtocolError> {
        let stream = self.stream.as_mut().ok_or(ProtocolError::HandshakeOrder)?;
        let mut header = [0; 9];
        stream
            .read_exact(&mut header)
            .await
            .map_err(|_| ProtocolError::Truncated)?;
        let (kind, _, len) = crate::conn::decode_header(&header)?;
        let mut bytes = header.to_vec();
        bytes.resize(9 + len, 0);
        stream
            .read_exact(&mut bytes[9..])
            .await
            .map_err(|_| ProtocolError::Truncated)?;
        let frame = Frame::decode(&bytes)?;
        debug_assert_eq!(frame.kind, kind);
        Message::decode(&frame, Direction::DaemonToHost)?;
        self.received_frames += 1;
        Ok(frame)
    }
    pub async fn receive(&mut self) -> Result<Message, ProtocolError> {
        let frame = self.receive_frame().await?;
        Message::decode(&frame, Direction::DaemonToHost)
    }
    pub async fn handshake(&mut self) -> Result<MachineHello, ProtocolError> {
        let challenge = match self.receive().await? {
            Message::Hello(Hello::Challenge(c)) => c,
            _ => return Err(ProtocolError::HandshakeOrder),
        };
        if self
            .script
            .faults
            .iter()
            .any(|f| matches!(f, Fault::NewerBoot))
        {
            self.send(
                Message::Hello(Hello::Goodbye(Goodbye {
                    code: ProtocolError::AuthFailed as u8,
                    detail: None,
                })),
                0,
            )
            .await?;
            return Err(ProtocolError::AuthFailed);
        }
        if challenge.boot_id != self.boot_id {
            return Err(ProtocolError::AuthFailed);
        }
        let host_nonce = nonce()?;
        let secret = if self
            .script
            .faults
            .iter()
            .any(|f| matches!(f, Fault::BadProof))
        {
            [0; 32]
        } else {
            self.relay_secret
        };
        let p = HostProof {
            protocol: PROTOCOL,
            nonce: host_nonce,
            mac: proof(
                &secret,
                ProofRole::Host,
                &self.boot_id,
                &challenge.nonce,
                &host_nonce,
            ),
        };
        self.send(Message::Hello(Hello::HostProof(p)), 0).await?;
        let hello = match self.receive().await? {
            Message::Hello(Hello::Machine(m)) => m,
            _ => return Err(ProtocolError::HandshakeOrder),
        };
        verify(
            &self.relay_secret,
            ProofRole::Daemon,
            &self.boot_id,
            &challenge.nonce,
            &host_nonce,
            &hello.mac,
        )?;
        // Constant-time credential comparison via HMAC's verify_slice.
        use hmac::{Hmac, Mac};
        use sha2::Sha256;
        let mut expected = Hmac::<Sha256>::new_from_slice(&self.relay_secret).unwrap();
        expected.update(&self.credential);
        let mut actual = Hmac::<Sha256>::new_from_slice(&self.relay_secret).unwrap();
        actual.update(&hello.credential.0);
        expected
            .verify_slice(&actual.finalize().into_bytes())
            .map_err(|_| ProtocolError::AuthFailed)?;
        self.send(Message::Hello(Hello::Welcome(Empty {})), 0)
            .await?;
        Ok(hello)
    }
    pub async fn call(&mut self, call: Call) -> Result<CallResult, Error> {
        let req_id = self.next_req;
        self.next_req = self.next_req.checked_add(1).ok_or_else(|| Error::new(12))?;
        self.send(
            Message::Control(Control::Request(Request { req_id, call })),
            0,
        )
        .await
        .map_err(Error::malformed)?;
        loop {
            match self.receive().await.map_err(Error::malformed)? {
                Message::Control(Control::Response(r)) if r.req_id == req_id => {
                    return match r.result {
                        CallResult::Error(e) => Err(e),
                        v => Ok(v),
                    }
                }
                Message::Events(Events::Durable(d)) => {
                    let ack = self.apply(d)?;
                    self.send(Message::Events(Events::Ack(ack)), 0)
                        .await
                        .map_err(Error::malformed)?;
                }
                _ => return Err(Error::malformed(ProtocolError::BadValue)),
            }
        }
    }
    /// Send a host-owned head's objects before requesting reconciliation.
    pub async fn send_head(&mut self, head: Oid) -> io::Result<()> {
        let stream = self.next_stream;
        self.next_stream = self
            .next_stream
            .checked_add(1)
            .ok_or_else(|| io::Error::other("stream ids exhausted"))?;
        let transfer = format!("refs/smithers/xfer/{stream}");
        git(
            self.store.path(),
            &["update-ref", &transfer, &hex(&head)],
            None,
        )?;
        let bundle = self.store.path().join(format!("head-{stream}.bundle"));
        let created = git(
            self.store.path(),
            &[
                "bundle",
                "create",
                bundle.to_str().ok_or_else(|| io::Error::other("path"))?,
                &transfer,
            ],
            None,
        );
        let _ = git(self.store.path(), &["update-ref", "-d", &transfer], None);
        created?;
        let bytes = std::fs::read(&bundle)?;
        std::fs::remove_file(bundle)?;
        if bytes.len() > self.bundle_cap {
            return Err(io::Error::other("bundle cap"));
        }
        let mut credit = crate::conn::INITIAL_CREDIT as usize;
        let mut offset = 0;
        while offset < bytes.len() {
            if credit == 0 {
                let frame = self.receive_frame().await.map_err(io::Error::other)?;
                match Message::decode(&frame, Direction::DaemonToHost).map_err(io::Error::other)? {
                    Message::Object(StreamFrame::Window(n))
                        if frame.stream == stream && n > 0 && n <= crate::conn::INITIAL_CREDIT =>
                    {
                        credit = n as usize
                    }
                    _ => return Err(io::Error::other("head stream credit")),
                }
            }
            let n = credit.min(65536).min(bytes.len() - offset);
            self.send(
                Message::Object(StreamFrame::Data {
                    fd: 0,
                    bytes: bytes[offset..offset + n].to_vec(),
                }),
                stream,
            )
            .await
            .map_err(io::Error::other)?;
            credit -= n;
            offset += n;
        }
        self.send(Message::Object(StreamFrame::Eof { fd: 0 }), stream)
            .await
            .map_err(io::Error::other)?;
        loop {
            let frame = self.receive_frame().await.map_err(io::Error::other)?;
            match Message::decode(&frame, Direction::DaemonToHost).map_err(io::Error::other)? {
                Message::Object(StreamFrame::Close) if frame.stream == stream => break,
                Message::Object(StreamFrame::Window(_)) if frame.stream == stream => {}
                Message::Object(StreamFrame::Refused(e)) if frame.stream == stream => {
                    return Err(io::Error::other(e))
                }
                _ => return Err(io::Error::other("head object stream order")),
            }
        }
        self.sent_prerequisites.insert(head);
        self.heads = Some(head);
        self.call(Call::WakeReconcile(Head { head }))
            .await
            .map_err(io::Error::other)?;
        Ok(())
    }
    /// Drive object streams and durable receipts with deterministic fault injection.
    pub async fn pump(&mut self, until: Until) -> Result<Vec<Event>, Error> {
        for fault in &mut self.script.faults {
            if let Fault::Silence(duration) = fault {
                let delay = *duration;
                *duration = Duration::ZERO;
                tokio::time::sleep(delay).await;
            }
        }
        let mut events = Vec::new();
        let mut objects = std::collections::HashMap::<u32, Vec<u8>>::new();
        loop {
            if until.reached(events.len(), self.last_seq, self.received_frames) {
                return Ok(events);
            }
            if self
                .script
                .faults
                .iter()
                .any(|f| matches!(f,Fault::DisconnectAfterFrames(n)if self.received_frames>=*n))
            {
                self.stream = None;
                return Ok(events);
            }
            let frame = self.receive_frame().await.map_err(Error::malformed)?;
            let message =
                Message::decode(&frame, Direction::DaemonToHost).map_err(Error::malformed)?;
            match message {
                Message::Object(StreamFrame::Data { bytes, .. }) => {
                    let held_total: usize = objects.values().map(Vec::len).sum();
                    let spool = objects.entry(frame.stream).or_default();
                    let held: usize = spool.len();
                    if bytes.len() > self.bundle_cap.saturating_sub(held)
                        || bytes.len()
                            > self
                                .quota
                                .saturating_sub(self.used.saturating_add(held_total))
                    {
                        return Err(Error::new(8));
                    }
                    let len = bytes.len() as u32;
                    spool.extend(bytes);
                    self.send(Message::Object(StreamFrame::Window(len)), frame.stream)
                        .await
                        .map_err(Error::malformed)?;
                }
                Message::Object(StreamFrame::Eof { .. }) => {
                    let bundle = objects
                        .remove(&frame.stream)
                        .ok_or_else(|| Error::new(12))?;
                    self.import_bundle(&bundle).map_err(|_| Error::new(12))?;
                    self.send(Message::Object(StreamFrame::Close), frame.stream)
                        .await
                        .map_err(Error::malformed)?;
                }
                Message::Events(Events::Durable(d)) => {
                    let mut dropped = false;
                    let mut forced_missing = false;
                    let mut rejected = false;
                    let mut duplicate = false;
                    for fault in &mut self.script.faults {
                        match fault {
                            Fault::DropAck { seq } if *seq == d.seq => {
                                dropped = true;
                                *seq = u64::MAX;
                            }
                            Fault::AckDuplicate { seq } if *seq == d.seq => duplicate = true,
                            Fault::MissingObjects { seq, times } if *seq == d.seq && *times > 0 => {
                                forced_missing = true;
                                *times -= 1;
                            }
                            Fault::Reject { seq } if *seq == d.seq => rejected = true,
                            _ => {}
                        }
                    }
                    let ack = if forced_missing {
                        Ack {
                            seq: d.seq,
                            outcome: 3,
                            oids: Some(vec![]),
                            haves: Some(self.sent_prerequisites.iter().copied().collect()),
                            error: None,
                        }
                    } else if rejected {
                        self.last_seq = Some(d.seq);
                        Ack {
                            seq: d.seq,
                            outcome: 4,
                            oids: None,
                            haves: None,
                            error: Some(Error::new(11)),
                        }
                    } else {
                        self.apply(d.clone())?
                    };
                    if duplicate && ack.outcome != 2 {
                        return Err(Error::new(12));
                    }
                    if ack.outcome == 1 {
                        events.push(d.event);
                    }
                    if !dropped {
                        self.send(Message::Events(Events::Ack(ack)), 0)
                            .await
                            .map_err(Error::malformed)?;
                    }
                }
                Message::Events(Events::Hint(_)) | Message::Presence(_) => {}
                _ => return Err(Error::malformed(ProtocolError::BadValue)),
            }
        }
    }
    /// Byte-for-byte component replay, never deriving an expected byte from an encoder.
    pub fn replay(&self, rpc: &Rpc, request: &[u8], expected: &[u8]) -> Result<(), ProtocolError> {
        let got = rpc.frame(&Frame::decode(request)?)?.encode()?;
        if got == expected {
            Ok(())
        } else {
            Err(ProtocolError::BadValue)
        }
    }
    pub fn has_object(&self, oid: &Oid) -> bool {
        git(self.store.path(), &["cat-file", "-e", &hex(oid)], None).is_ok()
    }
    pub fn apply(&mut self, d: Durable) -> Result<Ack, Error> {
        // ADR 0004 ack table: applied=1, duplicate=2, missing_objects=3, rejected=4, stale_base=5.
        let mut ack = Ack {
            seq: d.seq,
            outcome: 1,
            oids: None,
            error: None,
            haves: None,
        };
        if self.receipts.contains(&d.event_id) {
            ack.outcome = 2;
            return Ok(ack);
        }
        if self.last_seq.is_some_and(|s| d.seq != s + 1) {
            return Err(Error::new(12));
        }
        let required = match &d.event {
            Event::Captured(c) => vec![c.head, c.tree, c.base],
            Event::Burst(b) => vec![b.versions_commit],
            Event::Reconciled(r) => vec![r.from, r.onto],
            _ => vec![],
        };
        let missing: Vec<_> = required
            .into_iter()
            .filter(|oid| !self.has_object(oid))
            .collect();
        if !missing.is_empty() {
            ack.outcome = 3;
            ack.oids = Some(missing);
            ack.haves = Some(self.sent_prerequisites.iter().copied().collect());
            return Ok(ack);
        }
        if let Event::Captured(c) = &d.event {
            if self.heads.is_some_and(|head| head != c.base) {
                ack.outcome = 5;
            } else {
                git(
                    self.store.path(),
                    &[
                        "update-ref",
                        "refs/smithers/branches/fixture/head",
                        &hex(&c.head),
                    ],
                    None,
                )
                .map_err(|_| Error::new(12))?;
                self.heads = Some(c.head);
            }
        }
        self.receipts.insert(d.event_id);
        self.last_seq = Some(d.seq);
        Ok(ack)
    }
    /// Binding condition 5: bundle refs are ignored. Verify + strict fsck in quarantine
    /// precede objects-only import. Prerequisites must have been sent by this host.
    pub fn import_bundle(&mut self, bytes: &[u8]) -> io::Result<()> {
        if bytes.len() > self.bundle_cap || bytes.len() > self.quota.saturating_sub(self.used) {
            return Err(io::Error::other("bundle quota"));
        }
        let pack = bundle_pack(bytes, &self.sent_prerequisites)?;
        let quarantine = tempfile::tempdir()?;
        git(quarantine.path(), &["init", "--bare", "--quiet"], None)?;
        let bundle = quarantine.path().join("incoming.bundle");
        std::fs::write(&bundle, bytes)?;
        git(
            self.store.path(),
            &[
                "bundle",
                "verify",
                bundle.to_str().ok_or_else(|| io::Error::other("path"))?,
            ],
            None,
        )?;
        let alternates = self.store.path().join("objects");
        let mut unpack = Command::new("git");
        unpack
            .current_dir(quarantine.path())
            .args(["unpack-objects", "--strict"])
            .env("GIT_ALTERNATE_OBJECT_DIRECTORIES", &alternates);
        command(unpack, Some(pack))?;
        let mut fsck = Command::new("git");
        fsck.current_dir(quarantine.path())
            .args([
                "fsck",
                "--strict",
                "--full",
                "--no-reflogs",
                "--no-dangling",
            ])
            .env("GIT_ALTERNATE_OBJECT_DIRECTORIES", &alternates);
        command(fsck, None)?;
        // No fetch, update-ref, or bundle refspec is ever executed here.
        git(
            self.store.path(),
            &["unpack-objects", "--strict"],
            Some(pack),
        )?;
        self.used += bytes.len();
        Ok(())
    }
}
fn bundle_pack<'a>(bytes: &'a [u8], sent: &HashSet<Oid>) -> io::Result<&'a [u8]> {
    let end = bytes
        .windows(2)
        .position(|b| b == b"\n\n")
        .ok_or_else(|| io::Error::other("bundle header"))?;
    let text = std::str::from_utf8(&bytes[..end]).map_err(io::Error::other)?;
    let mut lines = text.lines();
    if lines.next() != Some("# v2 git bundle") {
        return Err(io::Error::other("bundle version"));
    }
    for line in lines {
        if let Some(prereq) = line.strip_prefix('-') {
            let id = unhex(prereq.split(' ').next().unwrap_or(""))?;
            if !sent.contains(&id) {
                return Err(io::Error::other("foreign prerequisite"));
            }
        }
    }
    let pack = &bytes[end + 2..];
    if !pack.starts_with(b"PACK") {
        return Err(io::Error::other("bundle pack"));
    }
    Ok(pack)
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn unhex(s: &str) -> io::Result<Oid> {
    if s.len() != 40 || !s.is_ascii() {
        return Err(io::Error::other("oid"));
    }
    let mut id = [0; 20];
    for (i, b) in id.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).map_err(io::Error::other)?;
    }
    Ok(id)
}
pub fn git(root: &Path, args: &[&str], input: Option<&[u8]>) -> io::Result<Vec<u8>> {
    let mut c = Command::new("git");
    c.current_dir(root).args(args);
    command(c, input)
}
fn command(mut c: Command, input: Option<&[u8]>) -> io::Result<Vec<u8>> {
    c.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let mut child = c.spawn()?;
    // Drain output concurrently while writing packs to avoid pipe deadlock.
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let read = |mut pipe: Box<dyn std::io::Read + Send>| {
        let mut b = Vec::new();
        pipe.read_to_end(&mut b).map(|_| b)
    };
    let out = std::thread::spawn(move || read(Box::new(stdout)));
    let err = std::thread::spawn(move || read(Box::new(stderr)));
    let written = if let Some(b) = input {
        child.stdin.take().unwrap().write_all(b)
    } else {
        Ok(())
    };
    let status = child.wait()?;
    let output = out.join().map_err(|_| io::Error::other("reader"))??;
    let error = err.join().map_err(|_| io::Error::other("reader"))??;
    if !status.success() {
        return Err(io::Error::other(
            String::from_utf8_lossy(&error).into_owned(),
        ));
    }
    written?;
    Ok(output)
}

#[derive(Clone, Copy)]
pub enum Until {
    Events(usize),
    Acked(u64),
    Frames(usize),
}
impl Until {
    fn reached(self, events: usize, seq: Option<u64>, frames: usize) -> bool {
        match self {
            Self::Events(n) => events >= n,
            Self::Acked(n) => seq.is_some_and(|s| s >= n),
            Self::Frames(n) => frames >= n,
        }
    }
}
