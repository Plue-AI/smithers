---
title: "Revocation startup"
description: "The backend establishes its revocation history boundary before serving requests."
---

## Startup and shutdown

The backend waits for the first successful revocation log read before exposing
its HTTP handler or opening its HTTP listener. Failed reads retry until the
startup context is canceled. Cancellation returns an error and stops the bus.

`revocation.Bus.Start` must succeed before callers admit live consumers. Concurrent
calls wait for the same initial read. Durable catch-up skips events already present
at that boundary; authentication reads current database state for each new request.
Subsequent events reach live consumers through LISTEN notifications and durable
catch-up polling, including events committed between positioning and LISTEN.

Local `Deliver` calls remain usable before startup. A bus without a durable lister
starts without a history read and keeps `Positioned()` false. After successful
startup, cancel the original startup context and await `Done()` before closing the
database pool. A bus is single-use; construct a new bus after shutdown.
