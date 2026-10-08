//! Diagnostic JSONL from guest monotonic time. Missing or failed observations
//! cannot qualify a benchmark; logging never alters rewrite or ACK semantics.
use crate::hooks::Oid;
use serde_json::{json, Value};
use std::{fs::File, io::Write};

pub(crate) struct Observer {
    boot: String,
    bytes: u64,
    log: File,
    active: Option<Value>,
    draining: Vec<Value>,
    failed: bool,
}
// Kernel monotonic time survives a daemon restart within the same guest boot.
fn monotonic_ms() -> f64 {
    let now = rustix::time::clock_gettime(rustix::time::ClockId::Monotonic);
    now.tv_sec as f64 * 1000.0 + now.tv_nsec as f64 / 1_000_000.0
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
impl Observer {
    pub fn new(boot: [u8; 16], log: File) -> Self {
        Self {
            boot: hex(&boot),
            bytes: log.metadata().map(|m| m.len()).unwrap_or(u64::MAX),
            log,
            active: None,
            draining: vec![],
            failed: false,
        }
    }
    fn emit(&mut self, row: &Value) {
        if self.failed {
            return;
        }
        let result = (|| -> std::io::Result<()> {
            let mut bytes = serde_json::to_vec(row)?;
            bytes.push(b'\n');
            if self.bytes.saturating_add(bytes.len() as u64) > 100 * 1024 * 1024 {
                return Err(std::io::Error::other("rebase observation log full"));
            }
            self.log.write_all(&bytes)?;
            self.bytes += bytes.len() as u64;
            self.log.flush()
        })();
        if result.is_err() {
            self.failed = true;
        }
    }
    pub fn started(&mut self, onto: Oid, request: u32) {
        if self.active.is_some() {
            self.failed = true;
            return;
        }
        let row = json!({"phase":"held", "id":format!("{}:{}:{request:08x}", self.boot, hex(&onto)), "boot":self.boot,
            "onto":hex(&onto), "clock":format!("guest monotonic:{}", self.boot),
            "start":monotonic_ms()});
        self.emit(&row);
        self.active = Some(row);
    }
    pub fn captured(&mut self, sequence: u64, event: [u8; 16]) {
        if let Some(row) = &mut self.active {
            row["capture"] = json!({"boot":self.boot, "event":hex(&event), "sequence":sequence});
        }
    }
    pub fn capture_sequence(&self) -> Option<u64> {
        self.active
            .as_ref()?
            .get("capture")?
            .get("sequence")?
            .as_u64()
    }
    pub fn finished(&mut self, failed: bool, pending: Option<bool>, depth: u32) {
        let Some(mut row) = self.active.take() else {
            return;
        };
        row["phase"] = json!(if failed { "failed" } else { "thawed" });
        row["end"] = json!(monotonic_ms());
        row["failed"] = json!(failed);
        row["localSnapshotQueued"] = json!(row.get("capture").is_some());
        row["acknowledgedBeforeThaw"] = pending.map(|p| json!(!p)).unwrap_or(Value::Null);
        self.emit(&row);
        if !failed && pending == Some(true) {
            // Bounded diagnostics: an undrained host cannot grow this forever.
            if self.draining.len() == 1024 {
                self.failed = true;
                return;
            }
            self.draining.push(row);
        } else if !failed && pending == Some(false) && depth == 0 {
            row["phase"] = json!("drained");
            row["outboxDepth"] = json!(0);
            self.emit(&row);
        }
    }
    pub fn drained(&mut self) {
        for mut row in std::mem::take(&mut self.draining) {
            row["phase"] = json!("drained");
            row["outboxDepth"] = json!(0);
            self.emit(&row);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rows(path: &std::path::Path) -> Vec<Value> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    #[test]
    fn refusal_and_missing_capture_never_claim_a_drain() {
        for failed in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("observations");
            let mut observer = Observer::new([1; 16], File::create(&path).unwrap());
            observer.started([2; 20], 7);
            observer.finished(failed, None, 0);
            observer.drained();
            let entries = rows(&path);
            assert_eq!(entries.len(), 2);
            assert_eq!(
                entries[1]["phase"],
                if failed { "failed" } else { "thawed" }
            );
            assert_eq!(entries[1]["localSnapshotQueued"], false);
            assert_eq!(entries[1]["acknowledgedBeforeThaw"], Value::Null);
        }
    }
    #[test]
    fn already_acknowledged_capture_and_delayed_drain_keep_exact_identity() {
        for pending in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("observations");
            let mut observer = Observer::new([1; 16], File::create(&path).unwrap());
            observer.started([2; 20], 9);
            observer.captured(31, [3; 16]);
            observer.finished(false, Some(pending), if pending { 1 } else { 0 });
            assert_eq!(rows(&path).len(), if pending { 2 } else { 3 });
            observer.drained();
            observer.drained();
            let entries = rows(&path);
            assert_eq!(entries.len(), 3, "drain is emitted only once");
            assert_eq!(entries[2]["phase"], "drained");
            assert_eq!(entries[2]["id"], entries[0]["id"]);
            assert_eq!(entries[2]["capture"], entries[1]["capture"]);
            assert_eq!(entries[2]["capture"]["sequence"], 31);
            assert_eq!(entries[1]["acknowledgedBeforeThaw"], !pending);
        }
    }
    #[test]
    fn io_failure_and_size_bound_stop_observations() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("observations");
        File::create(&path).unwrap();
        let mut observer = Observer::new([1; 16], File::open(&path).unwrap());
        observer.started([2; 20], 1);
        observer.finished(false, None, 0);
        assert!(std::fs::read(&path).unwrap().is_empty());
        let log = File::create(&path).unwrap();
        log.set_len(100 * 1024 * 1024).unwrap();
        let mut observer = Observer::new([1; 16], log);
        observer.started([2; 20], 1);
        assert!(observer.failed);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 100 * 1024 * 1024);
    }
}
