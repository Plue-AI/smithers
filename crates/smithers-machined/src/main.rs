//! Dark binary entry point. Planting belongs to T-COL-03.
fn main() {
    let result = match std::env::args().nth(1).as_deref() {
        Some("broker") => smithers_machined::broker::run(),
        Some("daemon") => smithers_machined::daemon::run(),
        Some("client") => smithers_machined::client::run(),
        _ => Err(smithers_machined::msg::Error::unsupported()),
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(78);
    }
}
