# T-FLW-01 Overridable flows run only in machines; system flow catalog

Stage S1 · Size M · Depends on — · Unblocks T-AGT-04, T-APP-01, T-APP-05, T-COL-02, T-COL-10, T-FLW-02, T-FLW-03, T-FLW-11, T-FLW-13, T-INS-06, T-INS-07, T-MCH-14, T-MNT-01, T-MNT-02, T-MNT-03, T-MNT-04, T-REL-02, T-STK-02, T-STK-12 · Issue: [#3438](https://github.com/smithersai/smithers/issues/3438)
Spec: spec.md §1.3, §10.4.1, §10.4.1a, §11.1, §17.3 · Delta: delta.md §8 (row 1), §11 (ADR 0001 row) · Product: mvp.md §6.12 "Change the factory", §9 Isolation, M-29, M-30

## Goal
Every run of `todo`, `learning`, `review` or a repository flow executes inside a microVM, a repository file that names a system flow is refused, and no host process ever imports repository flow code.

## Scope
In:
- One catalog with two disjoint sets (§11.1). System flows: stack operations (including `stack.propose`), merge, members, settings, secrets, sync, admission, setup, `flow-load` and the summarizer. Overridable flows: `todo`, `learning`, `review`, and any `flows/<name>/flow.ts` whose name isn't a system name.
- A repository flow named after a system flow is never registered and is reported as refused with code `reserved_name`.
- Overridable-flow runs resolve only to a coding host on the workspace (microVM) runtime: the TODO's branch machine, or an ephemeral background machine. A `trusted_process` runtime refuses them with a typed error.
- The built-in default for each overridable name is named in the catalog. The built-in `todo` is T-FLW-11's composition file (§10.4.1a).

Out:
- Launcher env pass-through and refusing to start without `msb` (T-INS-02).
- The `todo` composition and `stack.propose` (T-FLW-11); `flow-load`, versions and activation (T-FLW-03); loading the pinned closure (T-FLW-04).
- Secrets and provider keys in machines (T-MCH-12).
- Triggers ([D] spec §0, §11.7).

## Changes
- `packages/backend/internal/services/flow_catalog.go` (new) → `SystemFlows` and `Overridable(name)`. It is the single source: `/api/flows` (T-FLW-03), `flow-load` and the dispatcher read it, and the coding host receives the system names through its launch spec.
- `packages/backend/flowhost/process_spec.go` → pass the system names to the coding host as its `hostOwned` list.
- `flows/repository/registry.ts:333-342` (`bindRepositoryRegistry`) → replace the hard-coded `repository/setup|repository/trigger|repository-jobs/*` predicate with the host-supplied system names. A repository entry with a system name goes to `catalog.refused` with `reserved_name` instead of being shadowed silently. Delete the hard-coded predicate in the same change.
- `packages/backend/flowhost/resolver.go:199` (`resolve`) and `workspace_launcher.go:24-35` → an overridable run binds only through `NewWorkspaceLauncher` on a runtime whose `Isolation()` is `IsolationSandboxed`. A `trusted_process` runtime returns `isolation_required` (class `infra`). Tests opt in to the process runtime through an explicit `flowhost` config field, never an environment variable on the install.
- `apps/backend/main.go:113-121` → the `control` runtime (`isolation.go:136-141`) stays for packaged hosts only (the model host). Assert in a test that no flow-host binding resolves to it.
- Self-host coding host (handed over by T-INS-02) → `packages/backend/internal/compose/flow_composition.go:155-170` binds the Mac install's coding host as a guest host (helper at `services.WorkspaceJJExportGuestPath`) that publishes source through the backend. Delete `SMITHERS_CODING_LOCAL_OWNER=1` from `apps/app/src/bun/NativeBackendProcess.ts:383` and its expectation at `NativeBackendProcess.test.ts:165`. Tests that set it explicitly (`packages/backend/flowdispatch/real_host_test.go:144`, `flowhost/fresh_box_real_host_test.go:110`) keep it.
- One `Flow.make` shape (minimal-code synthesis, 2026-10-03, v1 §6; smithers-38): the deprecated object-form `Flow.make` in `packages/smithers/flows/core/src/Flow.ts` (`@smthrs/core/Flow`, about 40 body-less callers, for example `flows/repository/registry.ts:3`) → move each caller to `@smthrs/flow` or a plain FlowBinding record and delete core's `make` in the same change (AGENTS.md "Flow layering").
- `docs/api/openapi/` → no route change. `flows/README.md` → add the overridable and system sets; run `pnpm docs:sync` and `pnpm docs:check`.

## Tests
- Unit, `packages/backend/internal/services/flow_catalog_test.go` (new): each system name, `stack.propose`, `flow-load` and the summarizer included, isn't overridable; `todo`, `learning`, `review` and `release-notes` are; matching is exact (`Merge` and `merge/x` aren't system names unless listed).
- Unit, `flows/test/coding-builtin-routes.test.ts` (extend): a repository `flows/merge/flow.ts` is refused with `reserved_name` and the built-in stays; a repository `flows/review/flow.ts` wins over the built-in `review`.
- Unit, `packages/backend/flowhost/resolver_test.go` (extend): an overridable target on a `trusted_process` runtime returns `isolation_required` and starts no process; the same target on a sandboxed fake runtime binds.
- Integration, [C-SEC-02](../checks/C-SEC-02.md) on the reference host: canary flows prove host non-execution.

## Acceptance
- [C-SEC-02](../checks/C-SEC-02.md): the host never loads or executes repository flow code during a TODO run and a `/flow.run`, and a system-named repository flow is refused.
- [C-J10-09](../checks/C-J10-09.md): `/review` on a teammate's PR runs the Active review flow in an ephemeral background machine at the PR head and writes nothing to GitHub; an outsider's PR is refused
- [C-SEC-01](../checks/C-SEC-01.md): Provider keys, the App PEM and main-only secrets never appear in any branch machine
- [C-J1-04](../checks/C-J1-04.md): First TODO to merged PR, unassisted, within 60 minutes of starting the install

## Risks and notes
- C-SEC-01 (T-MCH-12) also exercises this ticket: the coding host in the machine runs without provider keys.
- Risk: the local model host requires a `trusted_process` runtime (`packages/backend/modelhost/local.go:53`). If a refactor routes it through the workspace runtime, the app agent stops. Confirmed by `apps/backend/main_test.go` failing to start the model host.
- Risk: `SMITHERS_CODING_LOCAL_OWNER` also selects `local-only` source publication (`flows/coding/serve.ts:114`) and the FFI's local source owner (`crates/smithers-ffi/src/workspace_local.rs:604-613`). Without a provisioned binding, source creation fails with `source_creation_unavailable`. Confirmed by the first TODO run on a fresh install; the guest binding must be provisioned before the variable goes.
