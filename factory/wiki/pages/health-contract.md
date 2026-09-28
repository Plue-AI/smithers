# Agent and flow health policy

This page summarizes the intended health contract in `docs/design/agent-flow-health.md`. It does not certify implementation or current deployment behavior.

## Authority

Control and PTY lifecycle remain authoritative. Observational callbacks must not approve, resume or establish terminal success. Unknown exit outcome is not success, and a nonzero exit is failing.

## Activity and freshness contract

The design in `docs/design/agent-flow-health.md` requires unknown activity and health for unobserved or stale nonterminal work. Known authoritative waits and terminal states retain their meanings. Quiet or chatty output alone must not establish semantic activity; only a configured semantic checker may report working, idle or needs-input.

## Monitor classification

`Monitor.classify` consumes a run summary, journal events, a no-progress count and optional semantic progress. Without a summary it returns `unknown`. After checking terminal states, waits, the round bound and failed attempts, a no-progress count at the stall threshold produces `wedged-node` when an attempt is open, or `stalled` otherwise, unless semantic progress is reported. This classifier's input has no freshness field.

## Delivery

Health publication must use committed evidence and incarnation scoping. Alert delivery requires a real configured sink; a noop sink must not claim delivery. Read receipts are separate from health.
