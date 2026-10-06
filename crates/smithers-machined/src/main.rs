fn main() {
    // Providers are supplied by the process composition as their lanes land.
    // Unsupported defaults must never publish ready or start a mutation worker.
    match smithers_machined::wiring::start(Default::default()) {
        Err(error) => {
            eprintln!("smithers-machined: {error}");
            std::process::exit(78);
        }
        Ok(executor) => {
            executor.shutdown().expect("mutation executor shutdown");
        }
    }
}
