//! Design §2.2 socketpair packet types; privileged implementation belongs to A1.
use crate::{
    hooks::{Broker, Frozen},
    msg::*,
};
use std::time::Duration;
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BrokerCall {
    Freeze {
        timeout_ms: u32,
    },
    Thaw,
    KillSessions {
        sessions: Option<Vec<u32>>,
    },
    Spawn {
        session: u32,
        user: User,
        kind: u8,
        argv: Option<Vec<String>>,
        size: Option<Size>,
    },
    Signal {
        session: u32,
        sig: u8,
    },
    WriteEnv {
        content: crate::conn::Bytes,
    },
    HomeRead {
        uid: u32,
        path: String,
    },
    HomeWrite {
        uid: u32,
        path: String,
        content: crate::conn::Bytes,
    },
}
pub struct SocketpairBroker;
impl Broker for SocketpairBroker {
    fn freeze(&self, _: Duration) -> Result<Frozen, Error> {
        Err(Error::unsupported())
    }
    fn thaw(&self) -> Result<(), Error> {
        Err(Error::unsupported())
    }
    fn kill_sessions(&self, _: Option<&[u32]>) -> Result<u16, Error> {
        Err(Error::unsupported())
    }
}
