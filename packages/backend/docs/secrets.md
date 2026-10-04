# Secrets

Secret responses show names, scope and host bindings, never stored values.

All-branches secrets without declared hosts are readable by any session on any branch machine, including the coding agent. Declare hosts to keep a value on the relay: it substitutes that value only toward those hosts. Open egress means an agent can send an unbound value elsewhere.

Main-only secrets are absent from branch sessions. They are restricted to a maintainer's manual trusted run on `main` in an ephemeral background machine. Provider model keys and the GitHub App PEM stay on the host.

Machine environment delivery remains disabled until the authenticated per-boot connection, assigned `team` identities, atomic tmpfs writer, unprivileged session loader and installed machine-only dispatcher are available. Missing authority refuses delivery. The legacy scheduler does not establish trusted-main authority.
