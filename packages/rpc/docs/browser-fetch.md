# Browser fetch deadline

`browserFetch` uses one `timeoutMs` deadline for DNS resolution, response headers,
redirect hops and body reads. The default is 10,000 ms. A deadline returns
`{ ok: false, code: "timeout" }` with a message that reading the current host
took too long.

The deadline bounds caller settlement. Transport cleanup is best-effort and
fire-and-forget: redirect bodies, capped readers and interrupted readers are
cancelled without waiting for cancellation to settle. Cancellation rejections are
ignored. A stalled cancellation cannot delay a redirect, a capped result or a
deadline failure. An errored redirect body does not prevent processing its status
and location.

## Resolution and framing answers

Only public addresses are read. IPv6 is default-deny: only global unicast
(`2000::/3`) passes. A 6to4 address (`2002::/16`) is judged by the IPv4 address
it embeds, and Teredo (`2001::/32`) is refused.

A hostname whose resolver returns no addresses, or an NXDOMAIN answer, fails with
`The host <name> could not be resolved.` A resolver that errors fails with
`The name resolver did not answer (<cause>); try again.` so an outage is never
mistaken for an unknown name. The DNS-over-HTTPS resolver treats a non-2xx
answer, a body that is not JSON, and any DNS status other than NOERROR (0) or
NXDOMAIN (3) as an outage.

Every delivered `Content-Security-Policy` is enforced on its own. If any policy
carries a `frame-ancestors` directive that does not admit every origin, the page
is reported as unframeable and `blockReason` names that directive.

## Failure codes

Every failure carries a closed `code`. Both hosts refuse with the Worker failure
code that `browserFetchWorkerCode` maps it to, so the app reads the fault from
the registry instead of from the HTTP status.

| `code`                                                                              | Worker code                 | Fault      |
| ----------------------------------------------------------------------------------- | --------------------------- | ---------- |
| `invalid_url`, `scheme_refused`, `credentials_in_url`, `private_host`, `unresolved` | `request_invalid`           | user       |
| `resolver_unavailable`, `read_failed`                                               | `upstream_unreachable`      | dependency |
| `timeout`                                                                           | `upstream_timeout`          | dependency |
| `too_many_redirects`, `redirect_invalid`                                            | `upstream_malformed`        | dependency |
| `egress_unavailable`                                                                | `deployment_not_configured` | infra      |
