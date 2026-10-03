# Engineering spec: Smithers MVP

Owner: the engineering agent (smithers-8a, tech lead). Product: [../product/mvp.md](../product/mvp.md) (smithers-98). Design: [../design/mock](../design/mock) (smithers-06). Will approves; then a separate engineer session implements from these files.

| File | What it is | Read when |
| --- | --- | --- |
| [overview.md](overview.md) | One page: architecture, decisions E-01..E-21, stages, risks, open questions | First |
| [spec.md](spec.md) | The target system, independent of today's code: topology, data model, state machines, protocols, budgets | Before designing anything |
| [delta.md](delta.md) | Today's `main` → spec, per subsystem, with paths: keep, modify, add, delete, restore | Before touching code |
| [ui-components.md](ui-components.md) | The props contract between design's Views and engineering's Containers, in order of need | Before building or wiring any card |
| [tickets/](tickets/README.md) | 172 tickets (T-UI-* are design's) in stage order with dependencies, sizes and checks | To pick work |
| [checks/](checks/README.md) | 150 acceptance checks: layer, steps, pass/fail, evidence. QA gates them per [../qa/validation-plan.md](../qa/validation-plan.md) | To prove work |
| [research/](research/) | Cited findings about `main` on 2026-10-02 (10 reports) | To verify a claim in delta.md |
| [reviews/](reviews/) | Fable and Codex Astra reviews of the core docs, tickets and checks, and how each finding was resolved | To see why the spec says what it says |

Ready before start (product, 2026-10-02). No lane starts a ticket until the tech lead stamps it with a line `Ready: <date> <who> sha256:<first 12 hex digits>` under its header. Ready means:
1. **Depends on** lists every runtime precondition the change needs to land safely, not just the code it builds on.
2. **Out of scope** names the tempting exclusions explicitly.
3. **Acceptance tests** are named at the real boundary (the production dispatcher, route or command, not a bypass), and no test derives expectations from the spec file or the code at runtime.
4. **Who decides** is named for every judgement in the ticket (who accepts an ADR, who approves a seam).
5. **Owner pre-review** is done for a seam or cross-owner ticket: smithers-06 (UI views), smithers-b8 (apps/, CLI, skills, user-facing API), smithers-3f (Go, infra), smithers-38 (packages/). Each turns it around in 30 minutes or less.
6. **Security preconditions** have a named executable test at the real lifecycle boundary for anything that executes repository code (M-29), with owner review before start. A sentence is not evidence. For example, lifecycle scripts run without root; C-SEC-02 must assert the effective uid for that path.

The stamp carries the ticket file's SHA-256, truncated to its first 12 hexadecimal digits; compute it over the reviewed UTF-8 file bytes with the entire `Ready:` line omitted and the generated ` · Unblocks …` and ` · Issue: …` header fields removed (product, 2026-10-02), so recomputing dependencies never changes a digest. Lanes cite that digest before starting. Any later ruling becomes a follow-up ticket instead of changing the stamped scope.

In-flight tickets are frozen (product, 2026-10-02). A ruling that changes a ticket a lane is already implementing goes into a follow-up ticket, except for security, data loss, or a contradiction of Will's binding rules. A ruling that blocks a lane takes 30 minutes at most.

Rules that override convenience:
- Spec sections tagged [D] are deferred by mvp.md §16; never build them.
- A ticket deletes the path it replaces in the same change (AGENTS.md zero tech debt).
- A check passes only with evidence from its named layer, stored under `.artifacts/checks/<id>/<ts>/`.
- A disagreement between spec.md and mvp.md is a spec bug: raise it with the tech lead, don't pick a side in code.
