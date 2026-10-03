//! Typed ADR 0004 messages. Unknown tags are refused at every nesting level.
use crate::conn::{structure, Bytes, Cursor, Frame, Kind, ProtocolError, Wire};
pub type Oid = [u8; 20];
pub type Digest = [u8; 32];
pub type Id128 = [u8; 16];
pub const PROTOCOL: u16 = 1;

// One canonical struct implementation; the declarations below transcribe ADR tags.
macro_rules! encode_field {
    (required,$value:expr,$out:expr) => {
        $value.encode($out)?
    };
    (optional,$value:expr,$out:expr) => {
        if let Some(value) = $value {
            value.encode($out)?;
        }
    };
}

macro_rules! field_value {
    (required,$value:expr) => {
        $value.ok_or(ProtocolError::MissingField)?
    };
    (optional,$value:expr) => {
        $value
    };
}
macro_rules! emit_field {
    (required,$tag:expr,$value:expr,$body:expr) => {{
        ($tag as u8).encode($body)?;
        encode_field!(required, $value, $body);
    }};
    (optional,$tag:expr,$value:expr,$body:expr) => {
        if let Some(value) = $value {
            ($tag as u8).encode($body)?;
            value.encode($body)?;
        }
    };
}
macro_rules! wire_struct {
    ($name:ident {})=>{
        #[cfg_attr(feature="testing",derive(serde::Serialize,serde::Deserialize))]
        #[derive(Clone,Debug,PartialEq,Eq)]
        pub struct $name {}
        impl Wire for $name {
            fn encode(&self,out:&mut Vec<u8>)->Result<(),ProtocolError>{structure(Vec::new(),out)}
            fn decode(c:&mut Cursor<'_>)->Result<Self,ProtocolError>{let mut b=c.structure()?;if !b.done(){let tag=u8::decode(&mut b)?;return Err(if tag==0{ProtocolError::UnorderedField}else{ProtocolError::UnknownField});}Ok(Self{})}
        }
    };
    ($name:ident {$($tag:literal => $field:ident: $ty:ty = $mode:ident($wirety:ty),)+})=>{
        #[cfg_attr(feature="testing",derive(serde::Serialize,serde::Deserialize))]
        #[derive(Clone,Debug,PartialEq,Eq)]
        pub struct $name {$(pub $field:$ty,)+}
        impl Wire for $name {
            fn encode(&self,out:&mut Vec<u8>)->Result<(),ProtocolError>{
                let mut body=Vec::new();$(emit_field!($mode,$tag,&self.$field,&mut body);)+structure(body,out)
            }
            fn decode(c:&mut Cursor<'_>)->Result<Self,ProtocolError>{
                let mut b=c.structure()?;let mut last=0u8;$(let mut $field=None;)+
                while !b.done(){let tag=u8::decode(&mut b)?;if tag<=last{return Err(ProtocolError::UnorderedField);}last=tag;
                    match tag {$($tag=>$field=Some(<$wirety>::decode(&mut b)?),)+_=>return Err(ProtocolError::UnknownField)}
                }Ok(Self{$($field:field_value!($mode,$field),)+})
            }
        }
    };
}
macro_rules! wire_union {
    ($name:ident,$error:ident,{$($tag:literal => $variant:ident($ty:ty),)+})=>{
        #[cfg_attr(feature="testing",derive(serde::Serialize,serde::Deserialize))]
        #[derive(Clone,Debug,PartialEq,Eq)]
        pub enum $name {$($variant($ty),)+}
        impl Wire for $name {
            fn encode(&self,out:&mut Vec<u8>)->Result<(),ProtocolError>{match self{$(Self::$variant(value)=>{($tag as u8).encode(out)?;value.encode(out)},)+}}
            fn decode(c:&mut Cursor<'_>)->Result<Self,ProtocolError>{match u8::decode(c)?{$($tag=>Ok(Self::$variant(<$ty>::decode(c)?)),)+_=>Err(ProtocolError::$error)}}
        }
    };
}
wire_struct!(Empty {});

wire_struct!(Principal {
    1 => blob: Bytes = required(Bytes),
});

wire_struct!(SessionActor {
    1 => id: u32 = required(u32),
});

wire_struct!(RunActor {
    1 => run: String = required(String),
});

wire_union!(Actor, UnknownMessage, {
    1 => Principal(Principal),
    2 => Session(SessionActor),
    3 => Run(RunActor),
    4 => Outside(Empty),
});

wire_struct!(DigestBase {
    1 => digest: Digest = required(Digest),
});

wire_union!(Base, UnknownMessage, {
    1 => Digest(DigestBase),
    2 => Absent(Empty),
});

wire_struct!(User {
    1 => login: String = required(String),
    2 => uid: u32 = required(u32),
});

wire_struct!(Size {
    1 => cols: u16 = required(u16),
    2 => rows: u16 = required(u16),
});

wire_struct!(Challenge {
    1 => magic: u32 = required(u32),
    2 => protocol: u16 = required(u16),
    3 => boot_id: Id128 = required(Id128),
    4 => nonce: Digest = required(Digest),
});

wire_struct!(HostProof {
    1 => protocol: u16 = required(u16),
    2 => mac: Digest = required(Digest),
    3 => nonce: Digest = required(Digest),
});

wire_struct!(MachineHello {
    1 => credential: Bytes = required(Bytes),
    2 => instance: Id128 = required(Id128),
    3 => next_seq: u64 = required(u64),
    4 => sessions: Vec<u32> = required(Vec<u32>),
    5 => mac: Digest = required(Digest),
});

wire_struct!(Goodbye {
    1 => code: u8 = required(u8),
    2 => detail: Option<String> = optional(String),
});

wire_union!(Hello, UnknownMessage, {
    1 => Challenge(Challenge),
    2 => HostProof(HostProof),
    3 => Machine(MachineHello),
    4 => Welcome(Empty),
    5 => Goodbye(Goodbye),
});

wire_struct!(ReadFile {
    1 => path: String = required(String),
    2 => at: Option<Oid> = optional(Oid),
});

wire_struct!(WriteFile {
    1 => path: String = required(String),
    2 => base: Base = required(Base),
    3 => content: Bytes = required(Bytes),
    4 => actor: Actor = required(Actor),
});

wire_struct!(LocalWriteFile {
    1 => path: String = required(String),
    2 => base: Base = required(Base),
    3 => content: Bytes = required(Bytes),
});

wire_struct!(Head {
    1 => head: Oid = required(Oid),
});

wire_struct!(OpenSession {
    1 => user: User = required(User),
    2 => kind: u8 = required(u8),
    3 => argv: Option<Vec<String>> = optional(Vec<String>),
    4 => size: Option<Size> = optional(Size),
});

wire_struct!(TcpConnect {
    1 => port: u16 = required(u16),
});

wire_struct!(SessionId {
    1 => session: u32 = required(u32),
});

wire_struct!(UserTarget {
    1 => user: User = required(User),
});

wire_union!(KillTarget, UnknownMessage, {
    1 => User(UserTarget),
    2 => Run(RunActor),
});

wire_struct!(KillSessions {
    1 => target: KillTarget = required(KillTarget),
});

wire_struct!(RegisterRun {
    1 => run: String = required(String),
    2 => session: u32 = required(u32),
});

wire_struct!(Rebase {
    1 => onto: Oid = required(Oid),
    2 => actor: Actor = required(Actor),
});

wire_struct!(ReturnToItem {
    1 => actor: Actor = required(Actor),
});

wire_struct!(OpenDoc {
    1 => path: String = required(String),
});

wire_struct!(StreamId {
    1 => stream: u32 = required(u32),
});

wire_struct!(AttachSession {
    1 => session: u32 = required(u32),
    2 => received: u64 = required(u64),
});

wire_union!(Call, UnknownMethod, {
    1 => Status(Empty),
    2 => ReadFile(ReadFile),
    3 => WriteFile(WriteFile),
    4 => Capture(Empty),
    5 => WakeReconcile(Head),
    6 => OpenSession(OpenSession),
    7 => TcpConnect(TcpConnect),
    8 => CloseSession(SessionId),
    9 => KillSessions(KillSessions),
    10 => RegisterRun(RegisterRun),
    11 => Rebase(Rebase),
    12 => ReturnToItem(ReturnToItem),
    13 => OpenDoc(OpenDoc),
    14 => CloseDoc(StreamId),
    15 => AttachSession(AttachSession),
});

wire_struct!(Status {
    1 => state: u8 = required(u8),
    2 => protocol: u16 = required(u16),
    3 => version: String = required(String),
    4 => outbox_depth: u32 = required(u32),
    5 => acked_head: Option<Oid> = optional(Oid),
    6 => lock_queue: u16 = required(u16),
});

wire_struct!(FileContent {
    1 => content: Bytes = required(Bytes),
    2 => digest: Digest = required(Digest),
    3 => mode: u32 = required(u32),
});

wire_struct!(Written {
    1 => post_digest: Digest = required(Digest),
});

wire_struct!(Captured {
    1 => head: Oid = required(Oid),
    2 => tree: Oid = required(Oid),
    3 => flushed_documents: u16 = required(u16),
});

wire_struct!(Conflict {
    1 => paths: Vec<String> = required(Vec<String>),
});

wire_union!(ReconcileOutcome, UnknownMessage, {
    1 => Unchanged(Empty),
    2 => Moved(Head),
    3 => Conflict(Conflict),
});

wire_struct!(Reconciled {
    1 => outcome: ReconcileOutcome = required(ReconcileOutcome),
});

wire_struct!(Killed {
    1 => killed: u16 = required(u16),
});

wire_struct!(Received {
    1 => received: u64 = required(u64),
});

wire_struct!(Error {
    1 => code: u8 = required(u8),
    2 => detail: Option<String> = optional(String),
    3 => current_digest: Option<Digest> = optional(Digest),
    4 => session: Option<u32> = optional(u32),
    5 => limit: Option<u32> = optional(u32),
    6 => protocol: Option<u8> = optional(u8),
    7 => oids: Option<Vec<Oid>> = optional(Vec<Oid>),
});

wire_union!(CallResult, UnknownMethod, {
    1 => Status(Status),
    2 => ReadFile(FileContent),
    3 => WriteFile(Written),
    4 => Capture(Captured),
    5 => WakeReconcile(Reconciled),
    6 => OpenSession(SessionId),
    7 => TcpConnect(SessionId),
    8 => CloseSession(Empty),
    9 => KillSessions(Killed),
    10 => RegisterRun(Empty),
    11 => Rebase(Head),
    12 => ReturnToItem(Head),
    13 => OpenDoc(StreamId),
    14 => CloseDoc(Empty),
    15 => AttachSession(Received),
    255 => Error(Error),
});

wire_struct!(Request {
    1 => req_id: u32 = required(u32),
    2 => call: Call = required(Call),
});

wire_struct!(Response {
    1 => req_id: u32 = required(u32),
    2 => result: CallResult = required(CallResult),
});

wire_union!(Control, UnknownMessage, {
    1 => Request(Request),
    2 => Response(Response),
});

wire_struct!(BurstFile {
    1 => path: String = required(String),
    2 => change: u8 = required(u8),
    3 => renamed_to: Option<String> = optional(String),
    4 => before_blob: Option<Oid> = optional(Oid),
    5 => after_blob: Option<Oid> = optional(Oid),
    6 => post_digest: Option<Digest> = optional(Digest),
});

wire_struct!(Burst {
    1 => burst_id: Id128 = required(Id128),
    2 => actor: Actor = required(Actor),
    3 => files: Vec<BurstFile> = required(Vec<BurstFile>),
    4 => versions_commit: Oid = required(Oid),
    5 => part: Option<u16> = optional(u16),
    6 => parts: Option<u16> = optional(u16),
});

wire_struct!(CapturedEvent {
    1 => head: Oid = required(Oid),
    2 => tree: Oid = required(Oid),
    3 => base: Oid = required(Oid),
});

wire_struct!(ReconciledEvent {
    1 => from: Oid = required(Oid),
    2 => onto: Oid = required(Oid),
    3 => outcome: u8 = required(u8),
    4 => paths: Option<Vec<String>> = optional(Vec<String>),
});

wire_union!(Event, UnknownMessage, {
    1 => Burst(Burst),
    2 => Captured(CapturedEvent),
    3 => Reconciled(ReconciledEvent),
    4 => MovedOff(Empty),
    5 => Transcript(Empty),
    6 => DocEdit(Empty),
});

wire_struct!(FileWritten {
    1 => path: String = required(String),
    2 => actor: Actor = required(Actor),
    3 => post_digest: Option<Digest> = optional(Digest),
});

wire_union!(Hint, UnknownMessage, {
    1 => FileWritten(FileWritten),
});

wire_struct!(Durable {
    1 => seq: u64 = required(u64),
    2 => event_id: Id128 = required(Id128),
    3 => event: Event = required(Event),
});

wire_struct!(HintMessage {
    1 => hint: Hint = required(Hint),
});

wire_struct!(Ack {
    1 => seq: u64 = required(u64),
    2 => outcome: u8 = required(u8),
    3 => oids: Option<Vec<Oid>> = optional(Vec<Oid>),
    4 => error: Option<Error> = optional(Error),
    5 => haves: Option<Vec<Oid>> = optional(Vec<Oid>),
});

wire_union!(Events, UnknownMessage, {
    1 => Durable(Durable),
    2 => Hint(HintMessage),
    3 => Ack(Ack),
});

wire_struct!(SessionWhere {
    1 => session: u32 = required(u32),
    2 => path: Option<String> = optional(String),
});

wire_struct!(Snapshot {
    1 => sessions: Vec<SessionWhere> = required(Vec<SessionWhere>),
});

wire_union!(Presence, UnknownMessage, {
    1 => Snapshot(Snapshot),
});
impl Call {
    pub fn method(&self) -> u8 {
        match self {
            Self::Status(_) => 1,
            Self::ReadFile(_) => 2,
            Self::WriteFile(_) => 3,
            Self::Capture(_) => 4,
            Self::WakeReconcile(_) => 5,
            Self::OpenSession(_) => 6,
            Self::TcpConnect(_) => 7,
            Self::CloseSession(_) => 8,
            Self::KillSessions(_) => 9,
            Self::RegisterRun(_) => 10,
            Self::Rebase(_) => 11,
            Self::ReturnToItem(_) => 12,
            Self::OpenDoc(_) => 13,
            Self::CloseDoc(_) => 14,
            Self::AttachSession(_) => 15,
        }
    }
}
impl Error {
    pub fn new(code: u8) -> Self {
        Self {
            code,
            detail: None,
            current_digest: None,
            session: None,
            limit: None,
            protocol: None,
            oids: None,
        }
    }
    pub fn unsupported() -> Self {
        Self::new(2)
    }
    pub fn malformed(protocol: ProtocolError) -> Self {
        Self {
            protocol: Some(protocol as u8),
            ..Self::new(1)
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "machined error {}", self.code)
    }
}
impl std::error::Error for Error {}
#[cfg_attr(feature = "testing", derive(serde::Serialize, serde::Deserialize))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StreamFrame {
    Data { fd: u8, bytes: Vec<u8> },
    Eof { fd: u8 },
    Resize(Size),
    Signal(u8),
    ExitCode(i32),
    ExitSignal { sig: u8, core: bool },
    Window(u32),
    Close,
    Refused(Error),
}
impl StreamFrame {
    pub fn encode(&self, objects: bool) -> Result<Vec<u8>, ProtocolError> {
        self.validate(objects)?;
        let mut out = Vec::new();
        match self {
            Self::Data { fd, bytes } => {
                out.push(1);
                out.push(*fd);
                out.extend_from_slice(bytes);
            }
            Self::Eof { fd } => {
                out.extend_from_slice(&[2, *fd]);
            }
            Self::Resize(s) => {
                out.push(3);
                s.cols.encode(&mut out)?;
                s.rows.encode(&mut out)?;
            }
            Self::Signal(sig) => out.extend_from_slice(&[4, *sig]),
            Self::ExitCode(code) => {
                out.extend_from_slice(&[5, 0]);
                code.encode(&mut out)?;
            }
            Self::ExitSignal { sig, core } => out.extend_from_slice(&[5, 1, *sig, u8::from(*core)]),
            Self::Window(n) => {
                out.push(6);
                n.encode(&mut out)?;
            }
            Self::Close => out.push(7),
            Self::Refused(e) => {
                out.push(255);
                e.encode(&mut out)?;
            }
        }
        Ok(out)
    }
    pub fn decode(bytes: &[u8], objects: bool) -> Result<Self, ProtocolError> {
        let mut c = Cursor::new(bytes);
        let msg = u8::decode(&mut c)?;
        // ADR 0004: forbidden object variants fail bad_value before decoding bodies.
        if objects && matches!(msg, 3..=5) {
            return Err(ProtocolError::BadValue);
        }
        let value = match msg {
            1 => {
                let fd = u8::decode(&mut c)?;
                let bytes = c.take(bytes.len() - 2)?.to_vec();
                Self::Data { fd, bytes }
            }
            2 => Self::Eof {
                fd: u8::decode(&mut c)?,
            },
            3 => Self::Resize(Size {
                cols: u16::decode(&mut c)?,
                rows: u16::decode(&mut c)?,
            }),
            4 => Self::Signal(u8::decode(&mut c)?),
            5 => match u8::decode(&mut c)? {
                0 => Self::ExitCode(i32::decode(&mut c)?),
                1 => {
                    let sig = u8::decode(&mut c)?;
                    let core = u8::decode(&mut c)?;
                    if core > 1 {
                        return Err(ProtocolError::BadValue);
                    }
                    Self::ExitSignal {
                        sig,
                        core: core == 1,
                    }
                }
                _ => return Err(ProtocolError::BadValue),
            },
            6 => Self::Window(u32::decode(&mut c)?),
            7 => Self::Close,
            255 => Self::Refused(Error::decode(&mut c)?),
            _ => return Err(ProtocolError::UnknownMessage),
        };
        c.finish()?;
        value.validate(objects)?;
        Ok(value)
    }
    fn validate(&self, objects: bool) -> Result<(), ProtocolError> {
        let valid = match self {
            Self::Data { fd, bytes } => *fd <= 2 && (!objects || *fd == 0) && bytes.len() <= 65536,
            Self::Eof { fd } => *fd <= 2 && (!objects || *fd == 0),
            Self::Resize(_) | Self::ExitCode(_) => !objects,
            Self::Signal(sig) | Self::ExitSignal { sig, .. } => !objects && (1..=7).contains(sig),
            Self::Refused(e) => e.validate().is_ok(),
            _ => true,
        };
        if valid {
            Ok(())
        } else {
            Err(ProtocolError::BadValue)
        }
    }
}
#[cfg_attr(feature = "testing", derive(serde::Serialize, serde::Deserialize))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DocumentFrame {
    Reserved { msg: u8, body: Vec<u8> },
    Refused(Error),
}
impl DocumentFrame {
    fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        match self {
            Self::Reserved { msg, body } => {
                if !(1..=254).contains(msg) {
                    return Err(ProtocolError::BadValue);
                }
                let mut out = vec![*msg];
                out.extend_from_slice(body);
                Ok(out)
            }
            Self::Refused(e) => {
                e.validate()?;
                let mut out = vec![255];
                e.encode(&mut out)?;
                Ok(out)
            }
        }
    }
    fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        match bytes.first().copied().ok_or(ProtocolError::Truncated)? {
            0 => Err(ProtocolError::BadValue),
            255 => {
                let e = Error::from_bytes(&bytes[1..])?;
                e.validate()?;
                Ok(Self::Refused(e))
            }
            msg => Ok(Self::Reserved {
                msg,
                body: bytes[1..].to_vec(),
            }),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    HostToDaemon,
    DaemonToHost,
    Local,
}
#[cfg_attr(feature = "testing", derive(serde::Serialize, serde::Deserialize))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Message {
    Hello(Hello),
    Control(Control),
    Events(Events),
    Presence(Presence),
    Document(DocumentFrame),
    Session(StreamFrame),
    Object(StreamFrame),
}
impl Message {
    pub fn frame(&self, stream: u32, direction: Direction) -> Result<Frame, ProtocolError> {
        self.validate(direction)?;
        let (kind, payload) = match self {
            Self::Hello(v) => (Kind::Hello, v.bytes()?),
            Self::Control(v) => (Kind::Control, v.bytes()?),
            Self::Events(v) => (Kind::Events, v.bytes()?),
            Self::Presence(v) => (Kind::Presence, v.bytes()?),
            Self::Document(v) => (Kind::Documents, v.encode()?),
            Self::Session(v) => (Kind::Sessions, v.encode(false)?),
            Self::Object(v) => (Kind::Objects, v.encode(true)?),
        };
        let f = Frame {
            kind,
            stream,
            payload,
        };
        f.encode()?;
        Ok(f)
    }
    pub fn decode(frame: &Frame, direction: Direction) -> Result<Self, ProtocolError> {
        frame.encode()?;
        let b = &frame.payload;
        let value = match frame.kind {
            Kind::Hello => Self::Hello(Hello::from_bytes(b)?),
            Kind::Control => Self::Control(Control::from_bytes(b)?),
            Kind::Events => Self::Events(Events::from_bytes(b)?),
            Kind::Presence => Self::Presence(Presence::from_bytes(b)?),
            Kind::Documents => Self::Document(DocumentFrame::decode(b)?),
            Kind::Sessions => Self::Session(StreamFrame::decode(b, false)?),
            Kind::Objects => Self::Object(StreamFrame::decode(b, true)?),
        };
        value.validate(direction)?;
        Ok(value)
    }
    fn validate(&self, d: Direction) -> Result<(), ProtocolError> {
        use Direction::*;
        match self {
            Self::Hello(v) => match v {
                Hello::Challenge(c) => {
                    ensure(d == DaemonToHost)?;
                    ensure(c.magic == 0x534d4d44)?;
                    ensure_version(c.protocol)
                }
                Hello::HostProof(p) => {
                    ensure(d == HostToDaemon)?;
                    ensure_version(p.protocol)
                }
                Hello::Machine(m) => {
                    ensure(d == DaemonToHost)?;
                    ensure(
                        m.credential.0.len() <= 1024
                            && m.sessions.len() <= 512
                            && m.sessions.iter().all(|id| *id > 0 && *id <= 0x7fffffff),
                    )
                }
                Hello::Welcome(_) => ensure(d == HostToDaemon),
                Hello::Goodbye(g) => {
                    ProtocolError::from_code(g.code)?;
                    ensure(g.detail.as_ref().is_none_or(|s| s.len() <= 1024))
                }
            },
            Self::Control(Control::Request(r)) => {
                ensure(d == HostToDaemon)?;
                r.call.validate()
            }
            Self::Control(Control::Response(r)) => {
                ensure(d == DaemonToHost)?;
                r.result.validate()
            }
            Self::Events(Events::Ack(a)) => {
                ensure(d == HostToDaemon)?;
                ensure((1..=5).contains(&a.outcome))?;
                if let Some(e) = &a.error {
                    e.validate()?;
                }
                Ok(())
            }
            Self::Events(Events::Durable(e)) => {
                ensure(d == DaemonToHost)?;
                match &e.event {
                    Event::Burst(b) => {
                        b.actor.validate(false)?;
                        for f in &b.files {
                            ensure((1..=4).contains(&f.change))?;
                        }
                        ensure(b.part.is_some() == b.parts.is_some())?;
                        if let (Some(p), Some(n)) = (b.part, b.parts) {
                            ensure(p > 0 && p <= n)?;
                        }
                        Ok(())
                    }
                    Event::Reconciled(r) => ensure((1..=2).contains(&r.outcome)),
                    _ => Ok(()),
                }
            }
            Self::Events(Events::Hint(h)) => {
                ensure(d == DaemonToHost)?;
                match &h.hint {
                    Hint::FileWritten(f) => f.actor.validate(false),
                }
            }
            Self::Presence(_) => ensure(d == DaemonToHost),
            Self::Session(v) => v.validate(false),
            Self::Object(v) => v.validate(true),
            Self::Document(_) => Ok(()),
        }
    }
}
fn ensure(v: bool) -> Result<(), ProtocolError> {
    if v {
        Ok(())
    } else {
        Err(ProtocolError::BadValue)
    }
}
fn ensure_version(v: u16) -> Result<(), ProtocolError> {
    if v == PROTOCOL {
        Ok(())
    } else {
        Err(ProtocolError::VersionMismatch)
    }
}
impl Actor {
    pub fn validate(&self, host: bool) -> Result<(), ProtocolError> {
        if host && !matches!(self, Self::Principal(_)) {
            return Err(ProtocolError::BadValue);
        }
        match self {
            Self::Principal(p) => ensure(p.blob.0.len() <= 1024),
            Self::Session(s) => ensure(s.id > 0 && s.id <= 0x7fffffff),
            _ => Ok(()),
        }
    }
}
impl Call {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            Self::WriteFile(w) => {
                ensure(w.content.0.len() <= crate::conn::MAX_FILE_BYTES)?;
                w.actor.validate(true)
            }
            Self::Rebase(r) => r.actor.validate(true),
            Self::ReturnToItem(r) => r.actor.validate(true),
            Self::OpenSession(s) => ensure((1..=3).contains(&s.kind)),
            _ => Ok(()),
        }
    }
}
impl Error {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        ensure((1..=12).contains(&self.code))?;
        if let Some(p) = self.protocol {
            ProtocolError::from_code(p)?;
        }
        Ok(())
    }
}
impl CallResult {
    fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            Self::Error(e) => e.validate(),
            Self::Status(s) => {
                ensure((1..=3).contains(&s.state))?;
                ensure_version(s.protocol)
            }
            Self::ReadFile(f) => ensure(f.content.0.len() <= crate::conn::MAX_FILE_BYTES),
            _ => Ok(()),
        }
    }
}
/// Local schema deliberately has no actor tag; attribution comes from peer context.
pub fn local_request(frame: &Frame, run: &str) -> Result<Request, ProtocolError> {
    if frame.kind != Kind::Control || frame.stream != 0 {
        return Err(ProtocolError::BadValue);
    }
    let mut c = Cursor::new(&frame.payload);
    if u8::decode(&mut c)? != 1 {
        return Err(ProtocolError::BadValue);
    }
    let mut body = c.structure()?;
    if u8::decode(&mut body)? != 1 {
        return Err(ProtocolError::MissingField);
    }
    let req_id = u32::decode(&mut body)?;
    if u8::decode(&mut body)? != 2 {
        return Err(ProtocolError::MissingField);
    }
    let call = match u8::decode(&mut body)? {
        2 => Call::ReadFile(ReadFile::decode(&mut body)?),
        3 => {
            let w = LocalWriteFile::decode(&mut body)?;
            ensure(w.content.0.len() <= crate::conn::MAX_FILE_BYTES)?;
            Call::WriteFile(WriteFile {
                path: w.path,
                base: w.base,
                content: w.content,
                actor: Actor::Run(RunActor {
                    run: run.to_owned(),
                }),
            })
        }
        _ => return Err(ProtocolError::UnknownMethod),
    };
    body.finish()?;
    c.finish()?;
    Ok(Request { req_id, call })
}
