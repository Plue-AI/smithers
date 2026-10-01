> Historical lane evidence. D-11/CUT-01 retires first-party Linear routes,
> commands, and cards. The old ADR filename is retained for provenance;
> its current scope is GitHub synchronization. The reusable `@smthrs/integrations`
> Linear SDK remains available to authored flows. These reports do not establish
> current Cloud deployment or wiki freshness.

Brief: `../decisions/0005-linear-github-sync.md`. Depends on lane `piper`
(cloud proxy, sign-in, repositories tree). Laws as every lane; a failed op
is never hidden and reads the server error verbatim with Retry.
