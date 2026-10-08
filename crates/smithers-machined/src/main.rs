fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        // A fixed unprivileged build marker lets reference SSH checks refuse a
        // normal image that cannot execute the private-channel test cases.
        #[cfg(all(target_os = "linux", feature = "testing", debug_assertions))]
        Some("ssh-acceptance-image") if args.len() == 1 => {
            println!("ssh-input-validation-v1");
            Ok(true)
        }
        #[cfg(target_os = "linux")]
        Some("session-exec") => {
            smithers_machined::session_environment::run(&args[1..]).map(|()| true)
        }
        #[cfg(target_os = "linux")]
        Some("daemon") => smithers_machined::installed::run().map(|()| true),
        #[cfg(target_os = "linux")]
        Some("transcript-reader") if args.len() == 1 => {
            smithers_machined::transcript::reader::run().map(|()| true)
        }
        #[cfg(target_os = "linux")]
        Some("transcript-resolve") if args.len() == 1 => {
            smithers_machined::transcript::resolve::run().map(|()| true)
        }
        #[cfg(target_os = "linux")]
        Some("broker") => smithers_machined::broker::process::run().map(|()| true),
        #[cfg(target_os = "linux")]
        Some("session-tcp") if args.len() == 2 => args[1]
            .parse::<u16>()
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))
            .and_then(smithers_machined::broker::spawn::tcp)
            .map(|()| true),
        Some("client") => smithers_machined::client::run(&args[1..]),
        _ => {
            let error = smithers_machined::wiring::compose(Default::default())
                .err()
                .expect("unsupported providers");
            eprintln!("smithers-machined: {error}");
            std::process::exit(78);
        }
    };
    match result {
        Ok(true) => (),
        Ok(false) => std::process::exit(1),
        Err(_) => {
            eprintln!("{{\"error\":{{\"code\":\"unavailable\"}}}}");
            std::process::exit(1);
        }
    }
}
