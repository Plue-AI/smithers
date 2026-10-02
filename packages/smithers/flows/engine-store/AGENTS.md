# Durable engine storage

Read the [Smithers maintenance skill](../../../../.agents/skills/smithers-maintenance/SKILL.md), [engine README](../engine/README.md), and [store README](README.md) before changing persistence. Preserve the single engine decision model and the store's transactional journal/state boundary; migrations precede SQL-backed service startup. Verify replay and recovery against the actual durable store.

Released recovery policy (Will, 2026-10-02, [#3409](https://github.com/smithersai/smithers/issues/3409)): automatically retry a released execution only when every unfinished action has a genuine persisted `keyed: true` marker. Missing legacy metadata remains unkeyed. Unfinished unkeyed effects require an explicit resume grant bound to the release and journal generation, even after owner death. Recheck that policy in the activation transaction; retain normal ownership and cancellation fencing.
