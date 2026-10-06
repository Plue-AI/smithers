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
        if !crate::doc::disk::valid_path(&args.path) {
            return Err(error(6));
        }
        let documents = cx.hooks.documents.clone();
        // This hook compares against document text for an open path, and uses
        // the same confined never-rollback swap for a closed path (W15).
        let write = documents
            .write_through(cx, &args.path, &args.base, &args.content, &args.actor)
            .ok_or_else(Error::unsupported)??;
        let mut fields = vec![conn::field(1, write.digest)];
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
}
impl Core for Files {
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
            _ => self.next.call(cx, method, arguments),
        }
    }
    fn validate_rebase(&self, onto: hooks::Oid) -> hooks::Result<()> {
        self.next.validate_rebase(onto)
    }
    fn capture_local(&self, cx: &mut LockCx) -> hooks::Result<()> {
        self.next.capture_local(cx)
    }
    fn restore_rewrite(&self, cx: &mut LockCx) -> hooks::Result<()> {
        self.next.restore_rewrite(cx)
    }
    fn rebase(&self, cx: &mut LockCx, onto: hooks::Oid) -> hooks::Result<hooks::Oid> {
        self.next.rebase(cx, onto)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Recovery(bool);
    impl Core for Recovery {
        fn restore_rewrite(&self, cx: &mut LockCx) -> hooks::Result<()> {
            assert!(cx.rewrite_pending);
            assert_eq!(cx.completed, 17);
            cx.completed += 1;
            if self.0 {
                Ok(())
            } else {
                Err(Error {
                    detail: Some("restore failed".into()),
                    ..error(12)
                })
            }
        }
    }
    impl hooks::Documents for Recovery {
        fn reconcile_all(&self, cx: &mut LockCx, _: &hooks::Actor) -> hooks::Result<()> {
            assert_eq!(cx.completed, 18);
            cx.completed += 1;
            Ok(())
        }
    }
    impl hooks::Broker for Recovery {
        fn thaw(&self) -> hooks::Result<()> {
            assert!(self.0, "failed restoration must not thaw");
            Ok(())
        }
    }

    #[test]
    fn file_adapter_preserves_rewrite_recovery_and_refusals() {
        for succeeds in [true, false] {
            // No workspace operation occurs: this fixture tests the decorator's
            // forwarding on the existing mutation context, not confinement.
            let files = Files {
                workspace: File::open(".").unwrap(),
                next: Arc::new(Recovery(succeeds)),
            };
            let mut cx = LockCx::new(Default::default());
            cx.completed = 17;
            cx.rewrite_pending = true;
            let result = files.restore_rewrite(&mut cx);
            assert_eq!(cx.completed, 18);
            assert!(cx.rewrite_pending);
            if succeeds {
                assert_eq!(result, Ok(()));
            } else {
                assert_eq!(
                    result.unwrap_err().detail.as_deref(),
                    Some("restore failed")
                );
            }
        }
    }

    #[test]
    fn interrupted_rewrite_restores_through_file_adapter_before_reconciling() {
        for succeeds in [true, false] {
            let recovery = Arc::new(Recovery(succeeds));
            let mut cx = LockCx::new(hooks::Hooks {
                core: Arc::new(Files {
                    workspace: File::open(".").unwrap(),
                    next: recovery.clone(),
                }),
                documents: recovery.clone(),
                broker: recovery,
                ..Default::default()
            });
            cx.completed = 17;
            cx.rewrite_pending = true;
            let result = crate::freeze::restore(&mut cx, &hooks::Actor::Outside);
            assert_eq!(result.is_ok(), succeeds);
            assert_eq!(cx.rewrite_pending, !succeeds);
            assert_eq!(cx.completed, if succeeds { 19 } else { 18 });
        }
    }
}
