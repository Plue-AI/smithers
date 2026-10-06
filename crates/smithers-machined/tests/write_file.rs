#![cfg(target_os = "linux")]
use smithers_machined::{
    conn::{self, Frame},
    files::Files,
    hooks::{self, Hooks},
    lock::LockCx,
    rpc,
};
use std::{
    fs::{self, File},
    io::Write,
    os::unix::net::UnixStream,
    sync::Arc,
};
struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        assert_eq!(rustix::process::geteuid().as_raw(), 19998);
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).unwrap();
        let path = std::env::temp_dir().join(format!("w1-files-{:x}", u128::from_be_bytes(nonce)));
        fs::create_dir(&path).unwrap();
        fs::write(path.join("a"), b"unchanged bytes").unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn request(method: u8, fields: &[Vec<u8>]) -> Frame {
    Frame {
        kind: 1,
        stream: 0,
        payload: conn::tagged(
            1,
            &[
                conn::field(1, 9u32.to_be_bytes()),
                conn::field(2, conn::tagged(method, fields)),
            ],
        ),
    }
}
fn exchange(fixture: &Fixture, request: Frame, documents: Arc<dyn hooks::Documents>) -> Frame {
    let files = Files::new(File::open(&fixture.0).unwrap(), Arc::new(hooks::Disabled)).unwrap();
    let mut cx = LockCx::new(Hooks {
        core: Arc::new(files),
        documents,
        ..Default::default()
    });
    let (mut caller, mut server) = UnixStream::pair().unwrap();
    let worker = std::thread::spawn(move || {
        rpc::serve_one(&mut server.try_clone().unwrap(), &mut server, &mut cx).unwrap()
    });
    caller.write_all(&request.encode().unwrap()).unwrap();
    let reply = Frame::read(&mut caller).unwrap();
    worker.join().unwrap();
    reply
}
#[test]
fn file_reads_and_unavailable_writes_through_production_rpc_socket() {
    let fixture = Fixture::new();
    let path = conn::field(1, [0, 1, b'a']);
    let reply = exchange(
        &fixture,
        request(2, std::slice::from_ref(&path)),
        Arc::new(hooks::Disabled),
    );
    let result = conn::fields("response", &reply.payload[1..]).unwrap()[1].1;
    assert_eq!(
        &conn::fields("result2", &result[1..]).unwrap()[0].1[4..],
        b"unchanged bytes"
    );
    let reply = exchange(
        &fixture,
        request(
            3,
            &[
                path,
                conn::field(2, conn::tagged(2, &[])),
                conn::field(3, [0, 0, 0, 3, b'n', b'e', b'w']),
                conn::field(
                    4,
                    conn::actor_bytes(&hooks::Actor::Principal(b"author".to_vec())),
                ),
            ],
        ),
        Arc::new(hooks::Disabled),
    );
    let result = conn::fields("response", &reply.payload[1..]).unwrap()[1].1;
    assert_eq!(result[0], 255);
    assert_eq!(conn::fields("error", &result[1..]).unwrap()[0].1, &[2]);
    assert_eq!(fs::read(fixture.0.join("a")).unwrap(), b"unchanged bytes");
    assert_eq!(
        fs::read_dir(&fixture.0).unwrap().count(),
        1,
        "kernel probes clean up their files"
    );
}
#[test]
fn stale_document_base_is_preserved_by_the_file_rpc() {
    struct Document;
    impl hooks::Documents for Document {
        fn write_through(
            &self,
            _: &mut LockCx,
            path: &str,
            base: &hooks::Base,
            content: &[u8],
            actor: &hooks::Actor,
        ) -> Option<hooks::Result<hooks::DocumentWrite>> {
            assert_eq!(path, "a");
            assert_eq!(base, &hooks::Base::Absent);
            assert_eq!(content, b"new");
            assert_eq!(actor, &hooks::Actor::Principal(b"author".to_vec()));
            Some(Err(hooks::Error {
                code: 4,
                current_digest: Some([7; 32]),
                ..hooks::Error::unsupported()
            }))
        }
    }
    let fixture = Fixture::new();
    let reply = exchange(
        &fixture,
        request(
            3,
            &[
                conn::field(1, [0, 1, b'a']),
                conn::field(2, conn::tagged(2, &[])),
                conn::field(3, [0, 0, 0, 3, b'n', b'e', b'w']),
                conn::field(
                    4,
                    conn::actor_bytes(&hooks::Actor::Principal(b"author".to_vec())),
                ),
            ],
        ),
        Arc::new(Document),
    );
    let result = conn::fields("response", &reply.payload[1..]).unwrap()[1].1;
    assert_eq!(result[0], 255);
    let error = conn::fields("error", &result[1..]).unwrap();
    assert_eq!(error[0].1, &[4]);
    assert_eq!(error[1].1, &[7; 32]);
    assert_eq!(fs::read(fixture.0.join("a")).unwrap(), b"unchanged bytes");
}
