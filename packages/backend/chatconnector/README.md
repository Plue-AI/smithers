# Chat connectors

The combined self-host backend supervises this host as a critical worker.
It runs the existing Slack Socket Mode and Telegram polling adapters over
`NodeRuntime` and `$SMITHERS_DATA_ROOT/chat-connectors/engine.sqlite`.
Keep that directory with backend backups: it holds action receipts and the
Telegram intake cursor. Never replace it with an empty store during recovery.

Set these backend environment variables:

| Variable | Value |
| --- | --- |
| `SMITHERS_CHAT_CONNECTOR_CONFIG` | Absolute path to the JSON configuration below |
| `SMITHERS_CHAT_CONNECTOR_TOKEN_FILE` | Absolute path to a mode-600 file containing the owner bootstrap credential with repository write access; only the backend reads it |
| `SMITHERS_CHAT_CONNECTOR_BUNDLE` | Packaged executable; the container sets this automatically |
| `SMITHERS_NODE_BINARY` | Packaged Node 26 executable; the container sets this automatically |
| `SMITHERS_SLACK_BOT_TOKEN`, `SMITHERS_SLACK_APP_TOKEN` | Slack credentials, when Slack is configured |
| `SMITHERS_TELEGRAM_BOT_TOKEN` | Telegram credential, when Telegram is configured |

```json
{
  "owner": "owner",
  "repo": "repository",
  "slack": {
    "teamIds": ["T001"],
    "channelIds": ["C001", "D001"],
    "userIds": ["U001"]
  },
  "telegram": {
    "botId": "123",
    "chatIds": ["-100"],
    "userIds": ["42"]
  }
}
```

Omit providers that are not configured. Slack `channelIds` includes the concrete
DM conversation IDs used for outbound replies. Configure the same admissions
through `PUT /api/repos/{owner}/{repo}/issues/sync/channels`, using the existing
issue sync API (`connection_id` is `slack` or `telegram`). The host does not
expand or overwrite admission settings on restart. Inbound events commit to
the issue store before the source acknowledges them; the factory consumes the
same issues. No model credential or separate agent loop enters this host.

The backend supplies its loopback URL and persistent state path. It exchanges
bootstrap authorization for a repository-bound, system-issued sync credential,
rotates it every 30 minutes with a one-hour expiry, and revokes it on shutdown.
The child reads that credential from an atomically replaced private file; the
bootstrap credential never enters the child. Sync traffic has its own bounded
rate-limit principal, shared across rotations, using the normal API limits.

Outbound delivery wakes from the existing issue event stream. Pending delivery
notifications also cover reactions and explicit retries. The durable delivery
list remains authoritative. A repair poll backs off from 30 seconds to five
minutes when idle or unavailable, and HTTP Retry-After delays take precedence.
Stream reconnects resume the cursor and check persisted deliveries again.
 A source failure
fails the critical worker and stops the backend for its supervisor to restart.
Delivery receipt failures leave their claim for replay. An uncertain provider
write stays visible as an unknown outcome and requires reconciliation or the
existing owner resolution action. Restart never authorizes a blind resend.
The child also exits on stdin EOF when the backend is killed.

Build and test from the repository root:

```sh
node packages/backend/chatconnector/build.mjs
node --test packages/backend/chatconnector/*.test.ts
go test ./packages/backend/chatconnector
```

The build writes the executable and its SHA-256 companion. The distribution
verifies that checksum at startup. Launchd/systemd installations should stage
and verify both alongside the backend, preserving the data directory through
upgrades and rollback.
