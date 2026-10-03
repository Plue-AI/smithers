//! Injectable daemon shell; lifecycle, timers and startup belong to A4.
use crate::{
    conn::{Frame, ProtocolError},
    hooks::Hooks,
    msg::Error,
    rpc::{Rpc, State},
};
pub struct Daemon {
    pub rpc: Rpc,
}
impl Daemon {
    pub fn new(hooks: Hooks) -> Self {
        Self {
            rpc: Rpc {
                state: State::Booting,
                hooks,
            },
        }
    }
    pub fn frame(&self, frame: &Frame) -> Result<Frame, ProtocolError> {
        self.rpc.frame(frame)
    }
}
pub fn run() -> Result<(), Error> {
    Err(Error::unsupported())
}
