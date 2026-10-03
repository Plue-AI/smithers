# T-FLW-05 /flow.edit is a templated TODO request

Stage S1 · Size M · Depends on T-FLW-03, T-STK-02, T-CAT-01, T-FLW-11, T-FLW-04, T-APP-04 (confirmations), T-APP-16, T-APP-05 · Unblocks T-FLW-06, T-REL-02 · Issue: [#3513](https://github.com/smithersai/smithers/issues/3513)
Spec: spec.md §11.5 · Product: mvp.md J5.1–J5.3

## Goal
Show the proposed diff, then create an ordinary TODO with the request and diff as revision-1 context.

## Scope
In: /flow.edit, Make TODO and /flow.source through existing catalog and TODO paths.
Out: patch storage, patch application, confinement validator, second proposal service.

## Changes
- Template /todo.new: Change flows/<name>/flow.ts: <request>; start from the built-in composition when no override exists.
- Quote the agent’s proposed diff in the prompt context. Keep ordinary placement and confirmation rules.
- /flow.source opens the proposing TODO’s file; when absent, use the same request path.
- The coding agent derives and checks the change in its machine on the attempt’s pinned flow.

## Tests
- Through the catalog and production TODO route, show a diff then Make TODO: revision 1 retains request/diff context and default placement appends once.
- Repeated idempotency key returns the same TODO; changed payload refuses; another person cannot approve.
- Change the source before execution: the agent derives from the request and records the resulting change; no stored patch is applied.
- With no override, the machine creates flows/<name>/flow.ts from the built-in composition. No repository code executes on the host.

## Acceptance
- [C-J5-01](../checks/C-J5-01.md): proposed diff → ordinary TODO → merge → Active.
- [C-ACC-02](../checks/C-ACC-02.md): confirmation and idempotency.
- [C-SEC-02](../checks/C-SEC-02.md): machine-only execution.
- [C-J11-02](../checks/C-J11-02.md): scratch flow path at its phase.

## Risks and notes
Proposed diffs are context, not executable input.
