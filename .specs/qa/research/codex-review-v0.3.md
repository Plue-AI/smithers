Re-review of v0.3 against the supplied contracts. References below are v0.3 lines unless prefixed otherwise; RESOLVED means the plan addresses the finding, not that checks have passed.

1. RESOLVED — L168 rejects every nonpassing/missing mandatory criterion on the pinned candidate regardless of severity; L181 requires PR checks before factory landing.
2. RESOLVED — L56–81 define a closed, fail-closed manifest; L114–128 retain all G01–G77 and W1–W38 with stages; L103–106 include M-34–M-37. Missing inventories explicitly block qualification.
3. PARTIAL — L189, L196–198 fix the recording denominator and required inclusions. L194/L199 honestly retain the actual day-seven upgrade as BLOCKED, but the launch dependency remains circular: mvp.md:588–600 requires that receipt before shipping, while :610–612 schedules its release after launch. Missing: an approved normative decision defining the prelaunch gate and separate postlaunch upgrade gate; merely asking Product at L360 cannot make the current gate pass.
5. RESOLVED — L138 explicitly refuses Member admission of outsider text before drafting, with zero effects, and covers both admission doors, delegation, races, replay and source changes.
16. RESOLVED — L146 requires real legacy fixtures, explicit semantic transformations, migration races/restarts and supported/unsupported PostgreSQL upgrade behavior; L194 attaches these to release qualification.
17. RESOLVED — L147 requires a coherent fence, separate-volume portable backup, independent offline restore, Mac-B comparison and negative restores before destination replacement.
19. RESOLVED — L149 requires deterministic hostile tool attempts through the real coding host plus a live canary, runtime-enforced refusals, audit/effect receipts and genuine revision-bound approval; L102 preserves the no-host-fallback boundary.
23. RESOLVED — L153 specifies ENOSPC persistence points, no false Saved/completed acknowledgement, durable-byte/backup preservation and restart/retry without duplicate effects.
25. RESOLVED — L288–292 require immediate J1/J2 cutover, side-door removal, provenance, self-change/restart recovery, early person-minutes and genuine 14-day dogfood with laptop reconciliation; exceptions match current M-37.

NEW blocker — L50/L265 assign adversarial test-case authoring to Sonnet, and L325 claims a newer ruling without a supplied authorization receipt. AGENTS.md:202 requires “Delegate test work to GPT-6.1 Sol agents.” Sol owning later automation/fixes does not satisfy that assignment rule. Assign test-case work to Sol, or provide Will's explicit superseding instruction and reconcile the contract before dispatch.

Blocker count: 2 (one remaining PARTIAL, one NEW). Unbuilt harnesses and pending execution are not additional plan blockers because v0.3 rejects their qualification explicitly.
VERDICT: not ready — 2 blockers
