//! Opt-in crash hooks for C-DUR-04; absent from normal execution.
#[macro_export]
macro_rules! killpoint {
    ($name:expr) => {{
        #[cfg(feature = "killpoints")]
        if std::env::var("SMITHERS_MACHINED_KILL_AT").as_deref() == Ok($name) {
            std::process::abort();
        }
    }};
}
