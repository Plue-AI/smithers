//! A transcript record through the daemon's durable outbox and event service
//! (spec §9.6.6, ADR 0004 variant 5). A record is text: it has no git object,
//! so no pin and no bundle. Its frame goes out as it is, in queue order with
//! the change events around it, and the host's receipt settles it.
use smithers_machined::{
    conn::{self, Frame},
    event_service::Events,
    hooks::{EventSink, Oid},
    objects::Bundles,
    outbox::{self, Outbox, Refs},
    outbox_store::Store,
    transcript::{wire::Source, Record},
};
use std::{
    collections::BTreeMap,
    io::{self, Cursor},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
};

#[derive(Clone, Default)]
struct Repo(Arc<Mutex<BTreeMap<[u8; 16], Oid>>>);
impl Refs for Repo {
    fn pin_and_sync(&mut self, id: [u8; 16], oid: Oid) -> io::Result<()> {
        self.0.lock().unwrap().insert(id, oid);
        Ok(())
    }
    fn acknowledge_and_sync(&mut self, _: Oid) -> io::Result<()> {
        Ok(())
    }
    fn unpin(&mut self, id: [u8; 16]) -> io::Result<()> {
        self.0.lock().unwrap().remove(&id);
        Ok(())
    }
    fn pending(&mut self) -> io::Result<Vec<[u8; 16]>> {
        Ok(self.0.lock().unwrap().keys().copied().collect())
    }
}

/// The repository's exporter: it can bundle only an event that has a pin, as
/// `git bundle create refs/smithers/pending/<id>` can.
#[derive(Clone)]
struct Exports(Repo, Arc<Mutex<Vec<[u8; 16]>>>);
impl Bundles for Exports {
    type Source = Cursor<Vec<u8>>;
    fn export(&mut self, event: &conn::Durable, _: &[Oid]) -> io::Result<Self::Source> {
        if !self.0 .0.lock().unwrap().contains_key(&event.id) {
            return Err(io::Error::other("unknown revision refs/smithers/pending"));
        }
        self.1.lock().unwrap().push(event.id);
        Ok(Cursor::new(vec![7; 10]))
    }
}

struct Fixture {
    path: PathBuf,
    repo: Repo,
    exported: Arc<Mutex<Vec<[u8; 16]>>>,
    streams: Arc<AtomicU32>,
}
impl Fixture {
    fn new() -> Self {
        let mut id = [0; 8];
        getrandom::fill(&mut id).unwrap();
        let path = std::env::temp_dir().join(format!("smithers-transcript-delivery-{id:x?}"));
        for directory in [path.clone(), path.join("outbox")] {
            std::fs::create_dir(&directory).unwrap();
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self {
            path,
            repo: Repo::default(),
            exported: Default::default(),
            streams: Arc::new(AtomicU32::new(0)),
        }
    }
    fn events(&self) -> Events<Repo, Exports> {
        let owner = std::fs::metadata(&self.path).unwrap().uid();
        let outbox = Outbox::open(
            Store::open(&self.path.join("outbox"), owner).unwrap(),
            owner,
            self.repo.clone(),
        )
        .unwrap();
        let streams = self.streams.clone();
        Events::new(
            outbox,
            Exports(self.repo.clone(), self.exported.clone()),
            move || Ok(streams.fetch_add(1, Ordering::SeqCst) + 1),
        )
        .unwrap()
    }
    fn dead(&self) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(self.path.join("outbox/dead"))
            .map(|entries| {
                entries
                    .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn source(lifetime: u8) -> Source {
    Source {
        session: 7,
        participant: [9; 16],
        lifetime: [lifetime; 16],
        profile: "codex-rollout/0.160".into(),
    }
}
/// The record at `start` of a source, with the byte range its text implies.
fn record(source: &Source, start: u64, text: &str) -> Vec<u8> {
    source
        .event(&Record {
            generation: 1,
            start,
            end: start + text.len() as u64 + 1,
            text: text.into(),
            skipped: None,
        })
        .unwrap()
}
fn ack(seq: u64, outcome: u8) -> Frame {
    Frame {
        kind: 2,
        stream: 0,
        payload: conn::tagged(
            3,
            &[conn::field(1, seq.to_be_bytes()), conn::field(2, [outcome])],
        ),
    }
}
/// What the daemon would write to the host next, through the production codec.
fn sent(events: &Events<Repo, Exports>) -> Vec<Frame> {
    events
        .poll()
        .unwrap()
        .into_iter()
        .map(|frame| Frame::decode(&frame.encode().unwrap()).unwrap())
        .collect()
}
fn durable(frame: &Frame) -> conn::Durable {
    assert_eq!((frame.kind, frame.stream), (2, 0));
    conn::Durable::decode(&frame.payload).unwrap()
}

#[test]
fn a_transcript_record_is_sent_with_no_bundle_and_settled_by_its_receipt() {
    let fixture = Fixture::new();
    let events = fixture.events();
    let codex = source(1);
    let first = record(&codex, 0, r#"{"type":"session_meta"}"#);
    let (seq, id) = events.append(&first, None).unwrap();
    assert_eq!(events.depth().unwrap(), 1);
    assert!(
        fixture.repo.0.lock().unwrap().is_empty(),
        "a record has no pin"
    );

    // One frame: the durable event itself. No object stream, no stream id used.
    let frames = sent(&events);
    assert_eq!(frames.len(), 1);
    let event = durable(&frames[0]);
    assert_eq!((event.seq, event.id, &event.event), (seq, id, &first));
    let (from, read) = Source::decode(&event.event).unwrap();
    assert_eq!(
        (from, read.text.as_str()),
        (codex.clone(), r#"{"type":"session_meta"}"#)
    );
    assert_eq!(fixture.streams.load(Ordering::SeqCst), 0);
    assert!(fixture.exported.lock().unwrap().is_empty());
    // Until its receipt arrives nothing else is sent, and it stays queued.
    assert_eq!(sent(&events), vec![]);
    assert_eq!(events.depth().unwrap(), 1);
    // A receipt for another sequence settles nothing.
    assert!(events.frame(&ack(seq + 1, 1)).is_err());
    drop(events);

    // The daemon restarted before the receipt: the same event, same identity.
    let events = fixture.events();
    let again = durable(&sent(&events)[0]);
    assert_eq!((again.seq, again.id, again.event), (seq, id, first));
    assert_eq!(events.frame(&ack(seq, 1)).unwrap(), None);
    assert_eq!(events.depth().unwrap(), 0);
    assert!(events.drained().unwrap());
    assert_eq!(sent(&events), vec![]);
    assert_eq!(
        events.refused_transcripts().unwrap(),
        Vec::<[u8; 16]>::new()
    );
    assert_eq!(fixture.dead(), Vec::<String>::new());
}

#[test]
fn a_reconnect_replays_the_unacknowledged_record_once_in_order() {
    let fixture = Fixture::new();
    let events = fixture.events();
    let codex = source(1);
    let texts = ["{\"n\":1}", "{\"n\":2}", "{\"n\":3}"];
    let mut start = 0;
    let mut appended = Vec::new();
    for text in texts {
        appended.push(events.append(&record(&codex, start, text), None).unwrap());
        start += text.len() as u64 + 1;
    }
    let first = durable(&sent(&events)[0]);
    events.frame(&ack(first.seq, 1)).unwrap();
    let second = durable(&sent(&events)[0]);
    assert_eq!((second.seq, second.id), appended[1]);
    // The link drops with the second record written but not acknowledged.
    events.reconnect().unwrap();
    let mut delivered = vec![first];
    for _ in 0..2 {
        let event = durable(&sent(&events)[0]);
        // A duplicate receipt is a settled record too.
        events.frame(&ack(event.seq, 2)).unwrap();
        delivered.push(event);
    }
    assert_eq!(
        delivered
            .iter()
            .map(|event| (event.seq, event.id))
            .collect::<Vec<_>>(),
        appended
    );
    assert_eq!(
        delivered
            .iter()
            .map(|event| Source::decode(&event.event).unwrap().1.text)
            .collect::<Vec<_>>(),
        texts
    );
    assert_eq!(events.depth().unwrap(), 0);
}

#[test]
fn records_keep_their_place_in_the_queue_among_change_events() {
    let fixture = Fixture::new();
    let events = fixture.events();
    let codex = source(1);
    let before = events
        .append(&outbox::captured([1; 20], [2; 20], [3; 20]), Some([1; 20]))
        .unwrap();
    let text = events
        .append(&record(&codex, 0, "{\"n\":1}"), None)
        .unwrap();
    let after = events
        .append(&outbox::captured([4; 20], [5; 20], [1; 20]), Some([4; 20]))
        .unwrap();

    // A change event still travels behind its bundle, on an object stream.
    let mut order = Vec::new();
    for expected in [before, after] {
        if expected == after {
            // Between the two captures: the record, alone.
            let frames = sent(&events);
            assert_eq!(frames.len(), 1);
            let event = durable(&frames[0]);
            assert_eq!((event.seq, event.id), text);
            events.frame(&ack(event.seq, 1)).unwrap();
            order.push(event.seq);
        }
        let stream = loop {
            let frames = sent(&events);
            let frame = frames.first().expect("a bundle frame");
            assert_eq!(frame.kind, 6, "objects come before a change event");
            if frame.payload[0] == 2 {
                break frame.stream;
            }
            let mut credit = vec![6];
            credit.extend(((frame.payload.len() - 2) as u32).to_be_bytes());
            events
                .frame(&Frame {
                    kind: 6,
                    stream: frame.stream,
                    payload: credit,
                })
                .unwrap();
        };
        let event = events
            .frame(&Frame {
                kind: 6,
                stream,
                payload: vec![7],
            })
            .unwrap()
            .unwrap();
        let event = durable(&Frame::decode(&event.encode().unwrap()).unwrap());
        assert_eq!((event.seq, event.id), expected);
        events.frame(&ack(event.seq, 1)).unwrap();
        order.push(event.seq);
    }
    assert_eq!(order, [before.0, text.0, after.0]);
    assert_eq!(*fixture.exported.lock().unwrap(), [before.1, after.1]);
    assert_eq!(fixture.streams.load(Ordering::SeqCst), 2);
    assert!(events.drained().unwrap());
}

#[test]
fn a_refused_record_names_its_source_once_and_is_not_kept() {
    let fixture = Fixture::new();
    let events = fixture.events();
    let (codex, claude) = (source(1), source(2));
    events
        .append(&record(&codex, 0, "{\"n\":1}"), None)
        .unwrap();
    events
        .append(&record(&codex, 8, "{\"n\":2}"), None)
        .unwrap();
    events
        .append(&record(&claude, 0, "{\"n\":3}"), None)
        .unwrap();
    let capture = events
        .append(&outbox::captured([1; 20], [2; 20], [3; 20]), Some([1; 20]))
        .unwrap();

    // The host refuses both of the first source's records for good.
    for _ in 0..2 {
        let event = durable(&sent(&events)[0]);
        events.frame(&ack(event.seq, 4)).unwrap();
    }
    // The source is reported once, however many of its records were refused.
    assert_eq!(events.refused_transcripts().unwrap(), vec![[1; 16]]);
    assert_eq!(
        events.refused_transcripts().unwrap(),
        Vec::<[u8; 16]>::new()
    );
    // A member's refused text is not kept in the daemon's state.
    assert_eq!(fixture.dead(), Vec::<String>::new());
    // The other source's record is applied and names no one.
    let event = durable(&sent(&events)[0]);
    assert_eq!(Source::decode(&event.event).unwrap().0, claude);
    events.frame(&ack(event.seq, 1)).unwrap();
    assert_eq!(
        events.refused_transcripts().unwrap(),
        Vec::<[u8; 16]>::new()
    );

    // A refused change event is still kept for inspection, and is not a
    // transcript source.
    let stream = loop {
        let frames = sent(&events);
        let frame = &frames[0];
        if frame.payload[0] == 2 {
            break frame.stream;
        }
        let mut credit = vec![6];
        credit.extend(((frame.payload.len() - 2) as u32).to_be_bytes());
        events
            .frame(&Frame {
                kind: 6,
                stream: frame.stream,
                payload: credit,
            })
            .unwrap();
    };
    events
        .frame(&Frame {
            kind: 6,
            stream,
            payload: vec![7],
        })
        .unwrap()
        .unwrap();
    events.frame(&ack(capture.0, 4)).unwrap();
    assert_eq!(fixture.dead().len(), 1);
    assert_eq!(
        events.refused_transcripts().unwrap(),
        Vec::<[u8; 16]>::new()
    );
    assert!(events.drained().unwrap());
}
