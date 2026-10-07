//! File RPC adapter. Disk authority is shared with live documents; there is no
//! fallback writer when the document/write-through hook is unavailable.
use crate::{
    conn::{self, WriteArgs},
    hooks::{self, Core, Error},
    lock::LockCx,
};
use rustix::fs::{Mode, OFlags};
use std::{fs::File, os::unix::fs::MetadataExt, sync::Arc};

pub struct Files {
    workspace: File,
    next: Arc<dyn Core>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    #[test]
    fn queued_coding_writes_admitted_before_and_during_return_refuse_after_thaw() {
        struct Allowed;
        impl Core for Allowed {
            fn validate_coding_write(&self) -> hooks::Result<()> {
                Ok(())
            }
        }
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("file"), b"preserved bytes\n").unwrap();
        let files = Arc::new(Files {
            workspace: File::open(root.path()).unwrap(),
            next: Arc::new(Allowed),
        });
        let executor = crate::lock::Executor::start(Default::default()).unwrap();
        let lock = executor.lock.clone();
        let before = lock.epoch();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let rewrite = lock
            .enqueue("return", move |cx| {
                cx.begin_rewrite_for(true).unwrap();
                started_tx.send(()).unwrap();
                finish_rx.recv().unwrap();
                cx.settle_rewrite().unwrap();
            })
            .unwrap();
        started_rx.recv().unwrap();
        let during = lock.epoch();
        assert_ne!(before, during);
        // A later non-Return rewrite must not erase why these queued writes
        // lost their original branch. The admission epoch identifies the move.
        lock.enqueue("later_rebase", |cx| {
            cx.begin_rewrite_for(false).unwrap();
            cx.settle_rewrite().unwrap();
        })
        .unwrap();
        let mut writes = vec![];
        for admitted in [before, during] {
            let files = files.clone();
            writes.push(
                lock.enqueue("coding_write", move |cx| {
                    let args = conn::local_write_args(
                        &conn::structure_bytes(&[
                            conn::field(1, [0, 4, b'f', b'i', b'l', b'e']),
                            conn::field(2, conn::tagged(2, &[])),
                            conn::field(3, [0, 0, 0, 3, b'n', b'e', b'w']),
                        ]),
                        [7; 16],
                    )
                    .unwrap();
                    crate::local::write_response(cx, &files, 73, args, admitted)
                })
                .unwrap(),
            );
        }
        finish_tx.send(()).unwrap();
        rewrite.wait().unwrap();
        for write in writes {
            let frame = write.wait().unwrap();
            let value = conn::fields("response", &frame.payload[1..]).unwrap()[1].1;
            assert_eq!(value[0], 255);
            assert_eq!(conn::fields("error", &value[1..]).unwrap()[0].1, [10]);
        }
        assert_eq!(
            std::fs::read(root.path().join("file")).unwrap(),
            b"preserved bytes\n"
        );
        drop(lock);
        executor.shutdown().unwrap();
    }
    #[test]
    fn coding_refusal_precedes_documents_and_disk_at_local_wire_dispatch() {
        struct Guard(u8);
        impl Core for Guard {
            fn validate_coding_write(&self) -> hooks::Result<()> {
                Err(error(self.0))
            }
        }
        struct NoWrite;
        impl hooks::Documents for NoWrite {
            fn write_through(
                &self,
                _: &mut LockCx,
                _: &str,
                _: &hooks::Base,
                _: &[u8],
                _: &hooks::Actor,
            ) -> Option<hooks::Result<hooks::DocumentWrite>> {
                panic!("a refused coding write reached the document provider")
            }
        }
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("file"), b"preserved bytes\n").unwrap();
        for code in [2, 10] {
            let files = Files {
                workspace: File::open(root.path()).unwrap(),
                next: Arc::new(Guard(code)),
            };
            let mut cx = LockCx::new(hooks::Hooks {
                documents: Arc::new(NoWrite),
                ..Default::default()
            });
            let frame = conn::Frame {
                kind: 1,
                stream: 0,
                payload: conn::tagged(
                    1,
                    &[
                        conn::field(1, 73u32.to_be_bytes()),
                        conn::field(
                            2,
                            conn::tagged(
                                3,
                                &[
                                    conn::field(1, [0, 4, b'f', b'i', b'l', b'e']),
                                    conn::field(2, conn::tagged(2, &[])),
                                    conn::field(3, [0, 0, 0, 3, b'n', b'e', b'w']),
                                ],
                            ),
                        ),
                    ],
                ),
            };
            frame.validate(true).unwrap();
            let (id, _, args) = frame.request().unwrap();
            let args = conn::local_write_args(args, [7; 16]).unwrap();
            let response = crate::local::write_response(&mut cx, &files, id, args, 0);
            let response = conn::fields("response", &response.payload[1..]).unwrap()[1].1;
            assert_eq!(response[0], 255);
            assert_eq!(conn::fields("error", &response[1..]).unwrap()[0].1, &[code]);
            assert_eq!(
                std::fs::read(root.path().join("file")).unwrap(),
                b"preserved bytes\n"
            );
        }
    }
    struct Restorer(AtomicBool);
    impl Core for Restorer {
        fn restore_rewrite(&self, _: &mut LockCx) -> hooks::Result<()> {
            self.0.store(true, Ordering::Release);
            Ok(())
        }
    }
    #[test]
    fn wrapper_delegates_rewrite_restore_to_native_core() {
        let next = Arc::new(Restorer(AtomicBool::new(false)));
        // No file operation occurs; the test exercises the wrapper's Core
        // forwarding contract independently of privileged startup admission.
        let files = Files {
            workspace: File::open("/").unwrap(),
            next: next.clone(),
        };
        files
            .restore_rewrite(&mut LockCx::new(Default::default()))
            .unwrap();
        assert!(next.0.load(Ordering::Acquire));
    }
}
fn error(code: u8) -> Error {
    Error {
        code,
        ..Error::unsupported()
    }
}
fn io_error(e: std::io::Error) -> Error {
    match e.raw_os_error() {
        Some(2) => error(5),
        Some(18 | 40) => error(6),
        _ if e.kind() == std::io::ErrorKind::InvalidInput => error(6),
        _ => error(12),
    }
}
impl Files {
    #[cfg(test)]
    pub(crate) fn fixture(workspace: File, next: Arc<dyn Core>) -> Self {
        Self { workspace, next }
    }
    pub fn new(workspace: File, next: Arc<dyn Core>) -> std::io::Result<Self> {
        if rustix::process::geteuid().as_raw() != 19998 || !workspace.metadata()?.is_dir() {
            return Err(std::io::ErrorKind::PermissionDenied.into());
        }
        crate::confine::probe(&workspace)?;
        Ok(Self { workspace, next })
    }
    pub fn read(&self, path: &str) -> hooks::Result<(Vec<u8>, u32)> {
        let (parent, name) = crate::confine::parent(&self.workspace, path).map_err(io_error)?;
        let mut file = crate::confine::open(&parent, &name, OFlags::RDONLY, Mode::empty())
            .map_err(io_error)?;
        let metadata = file.metadata().map_err(io_error)?;
        if !metadata.is_file() {
            return Err(error(7));
        }
        let bytes = crate::confine::read(&mut file, conn::MAX_FILE_BYTES).map_err(io_error)?;
        if bytes.len() > conn::MAX_FILE_BYTES {
            return Err(Error {
                limit: Some(conn::MAX_FILE_BYTES as u32),
                ..error(8)
            });
        }
        Ok((bytes, metadata.mode() & 0o7777))
    }
    pub fn write(&self, cx: &mut LockCx, args: WriteArgs) -> hooks::Result<Vec<u8>> {
        if matches!(
            args.actor,
            hooks::Actor::Run(_) | hooks::Actor::Principal(_)
        ) {
            self.next.validate_coding_write()?;
        }
        if !crate::doc::disk::valid_path(&args.path) {
            return Err(error(6));
        }
        let documents = cx.hooks.documents.clone();
        // This hook compares against document text for an open path, and uses
        // the same confined never-rollback swap for a closed path (W15).
        let write = documents
            .write_through(cx, &args.path, &args.base, &args.content, &args.actor)
            .ok_or_else(Error::unsupported)??;
        let mut fields = vec![conn::field(1, write.digest.ok_or_else(Error::unsupported)?)];
        if let Some(displaced) = write.raced {
            let mut path = (args.path.len() as u16).to_be_bytes().to_vec();
            path.extend(args.path.as_bytes());
            fields.push(conn::field(
                2,
                conn::structure_bytes(&[conn::field(1, path), conn::field(2, displaced)]),
            ));
        }
        Ok(conn::structure_bytes(&fields))
    }
    pub fn write_batch(
        &self,
        cx: &mut LockCx,
        changes: Vec<hooks::FileWrite>,
        actor: hooks::Actor,
    ) -> hooks::Result<Vec<u8>> {
        if matches!(actor, hooks::Actor::Run(_) | hooks::Actor::Principal(_)) {
            self.next.validate_coding_write()?;
        }
        let documents = cx.hooks.documents.clone();
        let result = documents.write_batch(cx, &changes, &actor)?;
        let mut writes = (result.writes.len() as u16).to_be_bytes().to_vec();
        for (change, write) in changes.iter().zip(&result.writes) {
            let post = match write.digest {
                Some(digest) => conn::tagged(1, &[conn::field(1, digest)]),
                None => conn::tagged(2, &[]),
            };
            let mut fields = vec![conn::field(1, post)];
            if let Some(displaced) = write.raced {
                let mut path = (change.path.len() as u16).to_be_bytes().to_vec();
                path.extend(change.path.as_bytes());
                fields.push(conn::field(
                    2,
                    conn::structure_bytes(&[conn::field(1, path), conn::field(2, displaced)]),
                ));
            }
            writes.extend(conn::structure_bytes(&fields));
        }
        let mut fields = vec![conn::field(1, writes)];
        if let Some(failure) = result.failure {
            fields.push(conn::field(
                2,
                conn::structure_bytes(&[
                    conn::field(1, (failure.index as u16).to_be_bytes()),
                    conn::field(2, [u8::from(failure.preflight)]),
                    conn::field(3, conn::structure_bytes(&failure.error.fields())),
                ]),
            ));
        }
        Ok(conn::structure_bytes(&fields))
    }
}
impl Core for Files {
    fn validate_coding_write(&self) -> hooks::Result<()> {
        self.next.validate_coding_write()
    }
    fn ready(&self) -> hooks::Result<()> {
        self.next.ready()
    }
    fn call(&self, cx: &mut LockCx, method: u8, arguments: &[u8]) -> hooks::Result<Vec<u8>> {
        match method {
            2 => {
                let fields = conn::fields("args2", arguments).map_err(|_| error(1))?;
                if fields.len() > 1 {
                    return self.next.call(cx, method, arguments);
                }
                let path = std::str::from_utf8(&fields[0].1[2..]).map_err(|_| error(1))?;
                let (bytes, mode) = self.read(path)?;
                let digest = crate::doc::state::digest(&bytes);
                let mut content = (bytes.len() as u32).to_be_bytes().to_vec();
                content.extend(bytes);
                Ok(conn::structure_bytes(&[
                    conn::field(1, content),
                    conn::field(2, digest),
                    conn::field(3, mode.to_be_bytes()),
                ]))
            }
            3 => self.write(cx, conn::write_args(arguments).map_err(|_| error(1))?),
            17 => {
                let (changes, actor) = conn::batch_write_args(arguments).map_err(|_| error(1))?;
                self.write_batch(cx, changes, actor)
            }
            _ => self.next.call(cx, method, arguments),
        }
    }
    fn validate_rebase(&self, onto: hooks::Oid) -> hooks::Result<()> {
        self.next.validate_rebase(onto)
    }
    fn validate_return_to_item(&self) -> hooks::Result<()> {
        self.next.validate_return_to_item()
    }
    fn returned_by(&self, actor: &hooks::Actor) -> hooks::Result<()> {
        self.next.returned_by(actor)
    }
    fn return_to_item(&self, cx: &mut LockCx) -> hooks::Result<hooks::Oid> {
        self.next.return_to_item(cx)
    }
    fn capture_local(&self, cx: &mut LockCx) -> hooks::Result<()> {
        self.next.capture_local(cx)
    }
    fn rebase(&self, cx: &mut LockCx, onto: hooks::Oid) -> hooks::Result<hooks::Oid> {
        self.next.rebase(cx, onto)
    }
    fn restore_rewrite(&self, cx: &mut LockCx) -> hooks::Result<()> {
        self.next.restore_rewrite(cx)
    }
}
