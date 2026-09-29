---
title: "Telemetry ingestion"
description: "Client error field limits and server-controlled trace sampling."
---

## Client error reports

`POST /api/telemetry/errors` accepts web and CLI reports without authentication
and returns HTTP 204. Invalid reports are discarded. Before logging, each text
field is truncated to the longest complete UTF-8 prefix within its byte limit;
no suffix is added. Empty and shorter values are unchanged.

| Field | Maximum UTF-8 bytes |
| --- | ---: |
| `version` | 128 |
| `error.message` | 512 |
| `error.stack` | 4096 |
| `error.type` | 128 |
| `context.url` | 2048 |
| `context.user_agent` | 512 |
| `context.username` | 128 |
| `context.command` | 512 |
| `context.os` | 64 |
| `context.arch` | 64 |

`client` must be exactly `web` or `cli`. `context.user_id` is an integer.
Error metrics use a fixed error-type allowlist, with unknown types counted as
`other`; reports cannot create arbitrary metric labels.

## Trace sampling

`SMITHERS_TRACE_SAMPLE_RATE` controls server sampling: zero disables export and
one samples every request. At intermediate rates, each remote parent receives
an independent server-generated random sampling decision. Neither the incoming
`traceparent` sampled flag nor a chosen trace ID can force or suppress sampling.
The original trace ID and parent remain intact for correlation. In-process child
spans inherit the server decision; requests crossing a service boundary are
sampled independently, so distributed traces can be partial.

Operator tools use the same policy. Supplying a sampled `traceparent` does not
guarantee an exported trace.
