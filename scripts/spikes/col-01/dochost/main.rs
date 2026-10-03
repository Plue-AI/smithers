#[cfg(test)]
mod tests;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::{MetadataExt, chown};
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};
use yrs::{
    Doc, GetString, ReadTxn, StateVector, Text, TextRef, Transact, Update, updates::decoder::Decode,
};

fn seed() -> String {
    (1..=400)
        .map(|n| format!("line {n:03}: initial content"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn seeded_doc() -> (Doc, TextRef) {
    let doc = Doc::with_client_id(1);
    let text = doc.get_or_insert_text("content");
    text.insert(&mut doc.transact_mut(), 0, &seed());
    (doc, text)
}

fn snapshot(doc: &Doc) -> String {
    doc.get_or_insert_text("content")
        .get_string(&doc.transact())
}

fn state_update(doc: &Doc) -> String {
    STANDARD.encode(
        doc.transact()
            .encode_state_as_update_v1(&StateVector::default()),
    )
}

fn apply(doc: &Doc, encoded: &str) -> io::Result<()> {
    let bytes = STANDARD.decode(encoded).map_err(io::Error::other)?;
    let update = Update::decode_v1(&bytes).map_err(io::Error::other)?;
    doc.transact_mut()
        .apply_update(update)
        .map_err(io::Error::other)
}

fn persist(path: &Path, doc: &Doc, text: &TextRef) -> io::Result<()> {
    let temp = path.with_extension(format!("col01-{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(text.get_string(&doc.transact()).as_bytes())?;
        if let Ok(metadata) = fs::metadata(path) {
            file.set_permissions(metadata.permissions())?;
            chown(&temp, Some(metadata.uid()), Some(metadata.gid()))?;
        }
        file.sync_all()?;
        fs::rename(&temp, path)?;
        File::open(
            path.parent()
                .ok_or_else(|| io::Error::other("missing parent"))?,
        )?
        .sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

struct Debounce {
    first: Option<Instant>,
    last: Option<Instant>,
}
impl Debounce {
    fn new() -> Self {
        Self {
            first: None,
            last: None,
        }
    }
    fn update(&mut self, now: Instant) {
        self.first.get_or_insert(now);
        self.last = Some(now);
    }
    fn deadline(&self) -> Option<Instant> {
        Some((self.first? + Duration::from_secs(1)).min(self.last? + Duration::from_millis(200)))
    }
    fn saved(&mut self) {
        self.first = None;
        self.last = None;
    }
}

#[derive(Deserialize, Serialize)]
struct Message {
    kind: String,
    #[serde(default)]
    seq: u64,
    #[serde(default)]
    update: String,
    #[serde(default)]
    saves: u64,
    #[serde(default)]
    save_ns: u64,
}

fn read_frame(stream: &mut TcpStream) -> io::Result<Vec<u8>> {
    let mut header = [0; 4];
    stream.read_exact(&mut header)?;
    let n = u32::from_be_bytes(header) as usize;
    if n == 0 || n > 1024 * 1024 {
        return Err(io::Error::other("invalid frame size"));
    }
    let mut payload = vec![0; n];
    stream.read_exact(&mut payload)?;
    Ok(payload)
}

fn serve(mut stream: TcpStream, path: &Path) -> io::Result<()> {
    stream.set_nodelay(true)?;
    let mut reader = stream.try_clone()?;
    let (tx, rx) = mpsc::sync_channel(128);
    // The reader owns framing across save deadlines; a timed-out read_exact
    // would otherwise lose the already consumed portion of a frame.
    thread::spawn(move || {
        loop {
            let frame = read_frame(&mut reader);
            let failed = frame.is_err();
            if tx.send(frame).is_err() || failed {
                break;
            }
        }
    });
    let (mut doc, mut text) = seeded_doc();
    persist(path, &doc, &text)?;
    let mut debounce = Debounce::new();
    let mut saves = 0;
    let mut save_ns = 0;
    loop {
        if debounce
            .deadline()
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            let start = Instant::now();
            persist(path, &doc, &text)?;
            save_ns += start.elapsed().as_nanos() as u64;
            saves += 1;
            debounce.saved();
        }
        let timeout = debounce
            .deadline()
            .map(|d| d.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::from_secs(60));
        let bytes = match rx.recv_timeout(timeout) {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(e)) if e.kind() == io::ErrorKind::UnexpectedEof => break,
            Ok(Err(e)) => return Err(e),
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let mut message: Message = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
        match message.kind.as_str() {
            "update" => {
                apply(&doc, &message.update)?;
                debounce.update(Instant::now());
            }
            "reset" => {
                (doc, text) = seeded_doc();
                persist(path, &doc, &text)?;
                debounce.saved();
                saves = 0;
                save_ns = 0;
                message.update = state_update(&doc);
            }
            "snapshot" => {
                message.kind = "init".into();
                message.update = state_update(&doc);
            }
            "stats" => {
                message.update = snapshot(&doc);
            }
            _ => return Err(io::Error::other("unknown message")),
        }
        message.saves = saves;
        message.save_ns = save_ns;
        let bytes = serde_json::to_vec(&message).map_err(io::Error::other)?;
        let mut frame = (bytes.len() as u32).to_be_bytes().to_vec();
        frame.extend(bytes);
        stream.write_all(&frame)?;
    }
    if debounce.deadline().is_some() {
        persist(path, &doc, &text)?;
    }
    Ok(())
}

fn main() -> io::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let address = &args[2];
    let path = Path::new(&args[3]);
    if args[1] == "listen" {
        let listener = TcpListener::bind(address)?;
        // The fan-out uses one connection. Readiness probes close immediately.
        for stream in listener.incoming() {
            if let Err(e) = serve(stream?, path) {
                eprintln!("dochost: {e}");
            }
        }
        Ok(())
    } else if args[1] == "dial" {
        let mut stream = TcpStream::connect(address)?;
        stream.set_nodelay(true)?;
        let marker = b"col01-dochost";
        let mut frame = (marker.len() as u32).to_be_bytes().to_vec();
        frame.extend(marker);
        stream.write_all(&frame)?;
        serve(stream, path)
    } else {
        Err(io::Error::other("expected listen|dial ADDRESS DISK_PATH"))
    }
}
