//! Durable events on the existing object credit pipe. Only the authenticated
//! link supplies receipts; local append pins and persists before returning.
use crate::{
    conn::{self, Frame},
    hooks::{self, EventSink, Oid},
    objects::{Bundles, Delivery},
    outbox::{Outbox, Refs},
};
use std::{collections::VecDeque, io, sync::Mutex};

struct State<R: Refs, B: Bundles> {
    outbox: Outbox<R>,
    delivery: Delivery<B>,
    active: bool,
    hints: VecDeque<Frame>,
}

pub struct Events<R: Refs, B: Bundles> {
    state: Mutex<State<R, B>>,
    allocate: Box<dyn Fn() -> hooks::Result<u32> + Send + Sync>,
}

fn error(e: io::Error) -> hooks::Error {
    hooks::Error {
        code: 12,
        detail: Some(e.to_string()),
        ..hooks::Error::unsupported()
    }
}

impl<R: Refs, B: Bundles> Events<R, B> {
    pub fn new(
        outbox: Outbox<R>,
        bundles: B,
        allocate: impl Fn() -> hooks::Result<u32> + Send + Sync + 'static,
    ) -> io::Result<Self> {
        // Read the recovered head before exposing the provider. Corrupt disk
        // never becomes an apparently empty queue or a ready provider.
        outbox.front()?;
        Ok(Self {
            state: Mutex::new(State {
                outbox,
                delivery: Delivery::new(bundles),
                active: false,
                hints: VecDeque::new(),
            }),
            allocate: Box::new(allocate),
        })
    }

    fn state(&self) -> hooks::Result<std::sync::MutexGuard<'_, State<R, B>>> {
        self.state
            .lock()
            .map_err(|_| error(io::Error::other("event state poisoned")))
    }
}

impl<R: Refs + Send, B: Bundles + Send> EventSink for Events<R, B>
where
    B::Source: Send,
{
    fn ready(&self) -> hooks::Result<()> {
        self.state()?.outbox.front().map(|_| ()).map_err(error)
    }

    fn append(&self, event: &[u8], pin: Option<Oid>) -> hooks::Result<(u64, [u8; 16])> {
        self.state()?.outbox.append(event, pin).map_err(error)
    }

    fn hint(&self, hint: &[u8]) -> hooks::Result<()> {
        let frame = Frame {
            kind: 2,
            stream: 0,
            payload: conn::tagged(2, &[conn::field(1, hint)]),
        };
        frame.encode().map_err(|_| hooks::Error::unsupported())?;
        let mut state = self.state()?;
        // Hints are ephemeral. Never let a disconnected reader grow memory or
        // displace durable entries; the newest presence supersedes old hints.
        if state.hints.len() == 64 {
            state.hints.pop_front();
        }
        state.hints.push_back(frame);
        Ok(())
    }

    fn reconnect(&self) -> hooks::Result<()> {
        let mut state = self.state()?;
        let State {
            outbox,
            delivery,
            active,
            hints,
        } = &mut *state;
        delivery.reconnect(outbox);
        *active = false;
        hints.clear();
        Ok(())
    }

    fn poll(&self) -> hooks::Result<Vec<Frame>> {
        let mut state = self.state()?;
        if !state.active && state.outbox.front().map_err(error)?.is_some() {
            let stream = (self.allocate)()?;
            let State {
                outbox,
                delivery,
                active,
                ..
            } = &mut *state;
            *active = delivery.begin(outbox, stream).map_err(error)?;
        }
        let mut frames = Vec::with_capacity(2);
        if let Some(frame) = state.delivery.next_frame().map_err(error)? {
            frames.push(frame);
        }
        if let Some(hint) = state.hints.pop_front() {
            frames.push(hint);
        }
        Ok(frames)
    }

    fn frame(&self, frame: &Frame) -> hooks::Result<Option<Frame>> {
        if !(frame.kind == 6 || (frame.kind == 2 && frame.payload.first() == Some(&3))) {
            return Err(hooks::Error::unsupported());
        }
        let mut state = self.state()?;
        let State {
            outbox,
            delivery,
            active,
            ..
        } = &mut *state;
        let result = delivery.receive(outbox, frame).map_err(error)?;
        if frame.kind == 2 {
            *active = false;
        }
        Ok(result)
    }
}
