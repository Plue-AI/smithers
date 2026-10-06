//! Production composition boundary shared by independently landing providers.
//!
//! Supply initialized providers in `Hooks`; omitted providers use its unsupported
//! defaults. No concrete lane module is imported here, so a lane can remain a
//! stub without disabling compilation of its neighbors. Startup checks actual
//! provider readiness, never a configuration flag or the presence of an adapter.
use crate::{hooks::Hooks, lock::Executor};

#[derive(Debug)]
pub enum StartError {
    NotReady {
        provider: &'static str,
        source: crate::hooks::Error,
    },
    Executor(std::io::Error),
}
impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotReady { provider, .. } => write!(f, "{provider} not ready"),
            Self::Executor(error) => write!(f, "mutation executor: {error}"),
        }
    }
}
impl std::error::Error for StartError {}

/// Check immediately before admitting a connection or publishing `ready`.
/// A previously successful check is not a durable authorization to serve.
pub fn ready(hooks: &Hooks) -> Result<(), StartError> {
    macro_rules! check {
        ($provider:ident) => {
            hooks
                .$provider
                .ready()
                .map_err(|source| StartError::NotReady {
                    provider: stringify!($provider),
                    source,
                })?;
        };
    }
    check!(watcher);
    check!(documents);
    check!(sessions);
    check!(broker);
    check!(events);
    check!(core);
    Ok(())
}

/// Compose independently initialized providers into the production hook set.
/// Unfilled fields retain `Hooks::default()` and fail closed at this boundary.
pub fn compose(hooks: Hooks) -> Result<Hooks, StartError> {
    ready(&hooks)?;
    Ok(hooks)
}

/// Start the one mutation executor only when every required provider is ready.
/// Broker confinement and authenticated link admission remain the caller's job.
pub fn start(hooks: Hooks) -> Result<Executor, StartError> {
    Executor::start(compose(hooks)?).map_err(StartError::Executor)
}
