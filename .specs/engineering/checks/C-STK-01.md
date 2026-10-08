# C-STK-01 Every TODO transition is allowed or refused exactly as spec §4.1 says

Folded into T-STK-01's tests (minimal-code synthesis, 2026-10-03).

## Guest qualification

The real HumanTask approval producer, first accepted answer, consumed boolean, late-answer refusal and Drop run through the installed guest coding host. The reference entry uses the existing approved-bundle microVM composition without a process fallback.

From `packages/backend`, run:

```sh
SMITHERS_TODO_APPROVAL_MICROVM=1 SMITHERS_CHECK_BUNDLE=<approved-installed-bundle> \
  go test -p 4 ./internal/compose -run '^TestTodoApprovalManagedHostMicroVM$' -count=1 -v -timeout=20m
```

Requires the reference Mac, installed smithers-machined, native repository helper and PostgreSQL with a private test namespace. Linux process receipts do not qualify guest isolation or reference timing. Human/GitHub acceptance and the attachment latency receipt remain separate requirements.
