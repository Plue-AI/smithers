fn main() {
    #[cfg(target_os = "linux")]
    {
        let args: Vec<_> = std::env::args().collect();
        if args.len() == 2 && (args[1] == "--init" || args[1] == "--serve") {
            let result = if args[1] == "--init" {
                trm06_supervisor::installed::init()
            } else {
                trm06_supervisor::installed::serve()
            };
            if let Err(error) = result {
                eprintln!("{error}");
                std::process::exit(78);
            }
            return;
        }
        if args.len() == 3 && args[1] == "--tcp-worker" {
            let result = args[2]
                .parse::<u16>()
                .map_err(std::io::Error::other)
                .and_then(trm06_supervisor::worker::tcp);
            if let Err(error) = result {
                eprintln!("{error}");
                std::process::exit(78);
            }
            return;
        }
    }
    // No default/branch startup; installed modes verify fixed root authority.
    eprintln!("prototype_authority_unavailable: main-pinned installed provider required");
    std::process::exit(78);
}
