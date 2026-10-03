//! The compiled skeleton cannot start a transport, mutate a repository or run hooks.
#[test]
fn machined_skeleton_disabled() {
    let dir = tempfile::tempdir().unwrap();
    let sentinel = dir.path().join("unchanged");
    std::fs::write(&sentinel, b"fixture").unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    for command in ["broker", "daemon", "client", "unknown"] {
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_smithers-machined"))
            .arg(command)
            .current_dir(dir.path())
            .env(
                "SMITHERS_MACHINED_TEST_HOST",
                listener.local_addr().unwrap().to_string(),
            )
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(78));
        assert_eq!(output.stderr, b"machined error 2\n");
        assert!(output.stdout.is_empty());
        assert!(matches!(listener.accept(),Err(e)if e.kind()==std::io::ErrorKind::WouldBlock));
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"fixture");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
