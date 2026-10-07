fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
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
