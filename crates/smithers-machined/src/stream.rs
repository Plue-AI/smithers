//! Link writer handle. Credit scheduling is supplied by T-COL-03a A4.
use crate::{
    conn::{Frame, Kind},
    msg::*,
};
#[derive(Clone)]
pub struct FrameTx {
    tx: std::sync::mpsc::Sender<Frame>,
}
impl FrameTx {
    pub fn channel() -> (Self, std::sync::mpsc::Receiver<Frame>) {
        let (tx, rx) = std::sync::mpsc::channel();
        (Self { tx }, rx)
    }
    pub fn send(&self, frame: Frame) -> Result<(), Error> {
        frame.encode().map_err(Error::malformed)?;
        self.tx.send(frame).map_err(|_| Error::new(12))
    }
    pub fn refuse(&self, kind: Kind, stream: u32) {
        let msg = if kind == Kind::Documents {
            Message::Document(DocumentFrame::Refused(Error::unsupported()))
        } else {
            Message::Session(StreamFrame::Refused(Error::unsupported()))
        };
        if let Ok(frame) = msg.frame(stream, Direction::DaemonToHost) {
            let _ = self.send(frame);
        }
    }
}
