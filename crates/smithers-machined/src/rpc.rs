//! Readiness admission and typed dark dispatch; core handlers belong to 03a.
use crate::{
    conn::{Frame, Kind, ProtocolError, Wire},
    hooks::Hooks,
    msg::*,
};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Booting = 1,
    Reconciling = 2,
    Ready = 3,
}
pub struct Rpc {
    pub state: State,
    pub hooks: Hooks,
}
impl Rpc {
    pub fn dispatch(&self, request: Request) -> Response {
        let result = if !matches!(request.call, Call::Status(_) | Call::WakeReconcile(_))
            && self.state != State::Ready
        {
            CallResult::Error(Error::new(3))
        } else {
            match request.call {
                Call::Status(_) => CallResult::Status(Status {
                    state: self.state as u8,
                    protocol: PROTOCOL,
                    version: env!("CARGO_PKG_VERSION").into(),
                    outbox_depth: 0,
                    acked_head: None,
                    lock_queue: 0,
                }),
                _ => CallResult::Error(Error::unsupported()),
            }
        };
        Response {
            req_id: request.req_id,
            result,
        }
    }
    pub fn frame(&self, frame: &Frame) -> Result<Frame, ProtocolError> {
        match Message::decode(frame, Direction::HostToDaemon) {
            Ok(Message::Control(Control::Request(req))) => {
                Message::Control(Control::Response(self.dispatch(req)))
                    .frame(0, Direction::DaemonToHost)
            }
            Ok(Message::Document(_)) => {
                Message::Document(DocumentFrame::Refused(Error::unsupported()))
                    .frame(frame.stream, Direction::DaemonToHost)
            }
            Ok(Message::Session(_)) => Message::Session(StreamFrame::Refused(Error::unsupported()))
                .frame(frame.stream, Direction::DaemonToHost),
            Ok(Message::Object(_)) => Message::Object(StreamFrame::Refused(Error::unsupported()))
                .frame(frame.stream, Direction::DaemonToHost),
            Err(e) if frame.kind == Kind::Control && (5..=12).contains(&(e as u8)) => {
                let mut c = crate::conn::Cursor::new(&frame.payload);
                if u8::decode(&mut c)? != 1 {
                    return Err(e);
                }
                let mut b = c.structure()?;
                if u8::decode(&mut b)? != 1 {
                    return Err(e);
                }
                let req_id = u32::decode(&mut b)?;
                Message::Control(Control::Response(Response {
                    req_id,
                    result: CallResult::Error(Error::malformed(e)),
                }))
                .frame(0, Direction::DaemonToHost)
            }
            Err(e) => Err(e),
            _ => Err(ProtocolError::BadValue),
        }
    }
}
