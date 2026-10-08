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
    bursts: u64,
    hints: VecDeque<Frame>,
    /// Transcript sources whose record the host refused, until the transcript
    /// pump takes them and stops reading those sources.
    refused: Vec<[u8; 16]>,
    observer: Option<crate::rebase_observer::Observer>,
}

pub struct Events<R: Refs, B: Bundles> {
    state: Mutex<State<R, B>>,
    incoming: Option<crate::incoming::Incoming>,
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
                bursts: 0,
                hints: VecDeque::new(),
                refused: Vec::new(),
                observer: None,
            }),
            allocate: Box::new(allocate),
            incoming: None,
        })
    }

    /// The installed daemon opens this private log, never a member-selected path.
    pub fn observe_rebases(&self, boot: [u8; 16], log: std::fs::File) -> io::Result<()> {
        let mut state = self.state.lock().map_err(|_| io::Error::other("event state poisoned"))?;
        if state.observer.is_some() { return Err(io::ErrorKind::AlreadyExists.into()); }
        state.observer = Some(crate::rebase_observer::Observer::new(boot, log));
        Ok(())
    }

    pub fn with_incoming(mut self, store: std::sync::Arc<dyn crate::incoming::Store>) -> Self {
        self.incoming = Some(crate::incoming::Incoming::new(store));
        self
    }

    pub(crate) fn append_keyed(&self, id: [u8; 16], event: &[u8], pin: Oid) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| io::Error::other("event state poisoned"))?;
        let before = state.outbox.depth();
        state.outbox.append_keyed(id, event, Some(pin))?;
        if event.first() == Some(&1) && state.outbox.depth() != before {
            state.bursts = state.bursts.wrapping_add(1);
        }
        Ok(())
    }
    pub fn next_sequence(&self) -> io::Result<u64> {
        self.state
            .lock()
            .map_err(|_| io::Error::other("event state poisoned"))?
            .outbox
            .next_sequence()
    }
    pub fn queued(&self, head: Oid) -> io::Result<bool> {
        self.state
            .lock()
            .map_err(|_| io::Error::other("event state poisoned"))?
            .outbox
            .contains_capture(head)
    }
    pub fn depth(&self) -> io::Result<u32> {
        Ok(self
            .state
            .lock()
            .map_err(|_| io::Error::other("event state poisoned"))?
            .outbox
            .depth())
    }
    /// The transcript sources the host has refused since this was last asked.
    pub fn refused_transcripts(&self) -> io::Result<Vec<[u8; 16]>> {
        Ok(std::mem::take(
            &mut self
                .state
                .lock()
                .map_err(|_| io::Error::other("event state poisoned"))?
                .refused,
        ))
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
    #[cfg(all(feature = "killpoints", debug_assertions))]
    fn sent(&self, frame: &Frame) {
        // Observe the actual socket write, not creation/queueing of a receipt.
        // K7b is only meaningful once the client can receive `saved`.
        if crate::events::DOCUMENT_EDITED.load(std::sync::atomic::Ordering::Acquire)
            && frame.kind == 4
            && crate::document_payload::Document::decode_v2(&frame.payload)
                .is_ok_and(|document| document.msg == 6 && document.through_seq != 0)
        {
            crate::events::killpoint("K7b");
        }
        if let Ok(mut state) = self.state.lock() {
            state.delivery.sent(frame);
        }
    }

    fn rebase_started(&self, onto: Oid, request: u32) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(observer) = &mut state.observer { observer.started(onto, request); }
        }
    }
    fn rebase_finished(&self, failed: bool) {
        if let Ok(mut state) = self.state.lock() {
            let depth = state.outbox.depth();
            let pending = state.observer.as_ref().and_then(|o| o.capture_sequence())
                .map(|sequence| state.outbox.contains_sequence(sequence));
            if let Some(observer) = &mut state.observer { observer.finished(failed, pending, depth); }
        }
    }

    fn presence(&self, payload: &[u8]) -> hooks::Result<()> {
        let frame = Frame {
            kind: 3,
            stream: 0,
            payload: payload.into(),
        };
        frame.encode().map_err(|_| hooks::Error::unsupported())?;
        let mut state = self.state()?;
        // Only the newest complete snapshot is useful after a slow reader.
        state.hints.retain(|f| f.kind != 3);
        if state.hints.len() == 64 {
            state.hints.pop_front();
        }
        state.hints.push_back(frame);
        Ok(())
    }
    fn ready(&self) -> hooks::Result<()> {
        self.state()?.outbox.front().map(|_| ()).map_err(error)
    }
    fn drained(&self) -> hooks::Result<bool> {
        self.state()?
            .outbox
            .front()
            .map(|front| front.is_none())
            .map_err(error)
    }

    fn burst_generation(&self) -> u64 {
        self.state.lock().map(|s| s.bursts).unwrap_or(0)
    }

    fn append(&self, event: &[u8], pin: Option<Oid>) -> hooks::Result<(u64, [u8; 16])> {
        let mut state = self.state()?;
        let receipt = state.outbox.append(event, pin).map_err(error)?;
        if event.first() == Some(&2) {
            if let Some(observer) = &mut state.observer { observer.captured(receipt.0, receipt.1); }
        }
        if event.first() == Some(&1) {
            state.bursts = state.bursts.wrapping_add(1);
        }
        Ok(receipt)
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

    fn disconnected(&self) -> hooks::Result<()> {
        if let Some(incoming) = &self.incoming {
            incoming.disconnect().map_err(error)?;
        }
        Ok(())
    }

    fn reconnect(&self) -> hooks::Result<()> {
        self.disconnected()?;
        let mut state = self.state()?;
        let State {
            outbox,
            delivery,
            active,
            hints,
            ..
        } = &mut *state;
        delivery.reconnect(outbox);
        *active = false;
        hints.clear();
        Ok(())
    }

    fn poll(&self) -> hooks::Result<Vec<Frame>> {
        let mut state = self.state()?;
        let mut objectless = None;
        if !state.active {
            if let Some(front) = state.outbox.front().map_err(error)? {
                let State {
                    outbox,
                    delivery,
                    active,
                    ..
                } = &mut *state;
                if crate::transcript::wire::objectless(&front) {
                    objectless = delivery.begin_objectless(outbox).map_err(error)?;
                    *active = objectless.is_some();
                } else {
                    let stream = (self.allocate)()?;
                    *active = delivery.begin(outbox, stream).map_err(error)?;
                }
            }
        }
        let mut frames = Vec::with_capacity(3);
        if let Some(incoming) = &self.incoming {
            if let Some(frame) = incoming.poll().map_err(error)? {
                frames.push(frame);
            }
        }
        if let Some(frame) = objectless {
            frames.push(frame);
        } else if let Some(frame) = state.delivery.next_frame().map_err(error)? {
            frames.push(frame);
        }
        if let Some(hint) = state.hints.pop_front() {
            frames.push(hint);
        }
        Ok(frames)
    }

    fn frame(&self, frame: &Frame) -> hooks::Result<Option<Frame>> {
        if frame.kind == 6 && frame.stream >= 0x8000_0000 {
            return self
                .incoming
                .as_ref()
                .ok_or_else(hooks::Error::unsupported)?
                .frame(frame)
                .map_err(error);
        }
        if !(frame.kind == 6 || (frame.kind == 2 && frame.payload.first() == Some(&3))) {
            return Err(hooks::Error::unsupported());
        }
        let mut state = self.state()?;
        let State {
            outbox,
            delivery,
            active,
            refused,
            ..
        } = &mut *state;
        // The source of a transcript record the host is refusing for good,
        // read before the receipt removes the record.
        let refusal = conn::Acknowledgement::decode(frame)
            .ok()
            .filter(|ack| ack.outcome == 4)
            .and_then(|_| outbox.front().ok().flatten())
            .and_then(|event| crate::transcript::wire::Source::decode(&event.event).ok())
            .map(|(source, _)| source.lifetime);
        let result = delivery.receive(outbox, frame).map_err(error)?;
        if frame.kind == 2 {
            *active = false;
        }
        if let Some(lifetime) = refusal {
            // One entry per source; the pump takes them several times a second.
            if !refused.contains(&lifetime) && refused.len() < 4096 {
                refused.push(lifetime);
            }
        }
        if state.outbox.depth() == 0 {
            if let Some(observer) = &mut state.observer { observer.drained(); }
        }
        Ok(result)
    }
}
