# Retired chat integrations

MVP retirement: [smithers#3389](https://github.com/smithersai/smithers/issues/3389).

The last source snapshot before this app/backend retirement is
`e749f65b9194271a41366dab438ecec4ede7e5e7`. Recover individual paths with
`git show e749f65b9194271a41366dab438ecec4ede7e5e7:<path>`.

Removed source roots:

- `packages/backend/chatconnector/`: provider delivery worker and credential host.
- `packages/backend/internal/services/issue_sync.go`: Slack/Telegram admission,
  ingress, dispatch, reconciliation and retry.
- `packages/backend/internal/services/chat_connector_credential.go`: worker auth.
- `packages/backend/internal/routes/issue_sync.go`: provider sync endpoints.
- `apps/app/src/mainview/flows/entries/integrations.ts` and
  `apps/app/src/mainview/state/seams/IntegrationsSeam.ts`: provider controls.

`IssuesSeam.ts`, `IssueThread.tsx`, `ConversationCards.tsx`, RPC `Cards.ts` and
`Threads.ts`, and `docs/api/openapi/repositories.yaml` in that snapshot retain
all former UI and wire contracts for reference.

Native issue/conversation comments, idempotent pending requests, reactions,
personas, fact polling, issue events and historical origin decoding remain.
Historical migrations, mapping tables and delivery receipts remain readable;
0103 changes only new native-comment provider dispatch. The generic durable
outbox/claim/settlement schemas and wiki folder storage with Git provenance
remain. GitHub imports and the common flow/run/auth machinery remain.

Reintroduce providers through the common flow machinery and generic durable
receipts; restore a provider only with explicit scope and execution evidence on
#3389. Do not restore a separate chat worker or service by copying these paths.
