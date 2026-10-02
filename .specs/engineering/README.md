# Engineering spec: Smithers MVP

Owner: the engineering agent (smithers-8a, tech lead). Product: [../product/mvp.md](../product/mvp.md) (smithers-98). Design: [../design/mock](../design/mock) (smithers-06). Will approves; then a separate engineer session implements from these files.

| File | What it is | Read when |
| --- | --- | --- |
| [overview.md](overview.md) | One page: architecture, decisions E-01..E-15, stages, risks, open questions | First |
| [spec.md](spec.md) | The target system, independent of today's code: topology, data model, state machines, protocols, budgets | Before designing anything |
| [delta.md](delta.md) | Today's `main` → spec, per subsystem, with paths: keep, modify, add, delete, restore | Before touching code |
| [tickets/](tickets/README.md) | 102 tickets in stage order with dependencies, sizes and checks | To pick work |
| [checks/](checks/README.md) | 107 acceptance checks: layer, steps, pass/fail, evidence | To prove work |
| [research/](research/) | Cited findings about `main` on 2026-10-02 (10 reports) | To verify a claim in delta.md |
| [reviews/](reviews/) | Fable and Codex Astra reviews of the core docs, and how each finding was resolved | To see why the spec says what it says |

Rules that override convenience:
- Spec sections tagged [D] are deferred by mvp.md §16; never build them.
- A ticket deletes the path it replaces in the same change (AGENTS.md zero tech debt).
- A check passes only with evidence from its named layer, stored under `.artifacts/checks/<id>/<ts>/`.
- A disagreement between spec.md and mvp.md is a spec bug: raise it with the tech lead, don't pick a side in code.
