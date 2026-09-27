# Gateway retries

`callGateway` defaults to replayable calls. A transport rejection, headers
timeout, relay HTTP 401, or tunnel HTTP 502/503/504 can refresh the gateway
record and retry once. Fresh records suppress repeated tunnel reprovisioning.

`replayable: false` forbids retrying after a transport rejection or headers
timeout. The command may have been accepted. The seam attempts to refresh the
record for subsequent callers, then returns `status: "unknown_outcome"` with
a detail explaining that the command was not replayed. A failed refresh does
not replace this result with a provisioning error. The workflow RPC route
surfaces it as HTTP 502 with `status: "error"` and the detail as `message`.

Non-replayable calls also retain the tunnel-failure no-retry guard. HTTP 401
can retry once because the relay rejected the credentials. Run calls use
`replayable: false`; a lost response does not establish that a run failed.

## Relay address

A gateway record's `baseUrl` is exactly
`<SMITHERS_CLOUD_API_BASE_URL origin>/api/gateways/<gateway_id>`. A provision
answer naming any other scheme, host, port, path, query, fragment or
credentials is refused as `unavailable` before the bearer is sent, and logs
one `worker_seam_failure` line with seam `gateway provision`. A stored row
outside that address is treated as cold and re-provisioned.
