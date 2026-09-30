# Cloud execution

Tracked in [smithers#2924](https://github.com/smithersai/smithers/issues/2924).
Use `@smthrs/cli/CloudSandbox` with `Sandbox.layerHost`:

```ts
import * as CloudSandbox from "@smthrs/cli/CloudSandbox"
import { Sandbox } from "@smthrs/sandbox"

const provider = CloudSandbox.make({
  spawner, // the local host's ChildProcessSpawner
  repository: "smithersai/smithers",
  sourceBookmark: "main",
  environment: process.env
})
const host = Sandbox.layerHost(provider, { session: "smithersai/smithers#42@attempt-1" })
```

A session gets a stable hashed workspace name. Commands, file reads and writes
reach `/home/developer/workspace` through the public workspace SSH API. Closing
the scope deletes the workspace. Different issue attempts need different session
keys. The local flow host retains the journal and resolves credentials locally.

## Account setup

Commands below omit secret values. Administrator and organization-owner tokens
are temporary bootstrap credentials; revoke them after setup. The development
account remains a non-admin user. Run these commands with shell tracing disabled.

```sh
export SMITHERS_API_ORIGIN=https://api.jjhub.tech
export cloud_project=plue-prod-1771780303

curl -fsS "$SMITHERS_API_ORIGIN/api/admin/users" \
  -H "Authorization: Bearer $cloud_admin_token" -H 'Content-Type: application/json' \
  -d '{"username":"smithers-dev","display_name":"Smithers Development"}'

# Pipe the returned PAT directly to Secret Manager; never print it.
gcloud secrets create smithers-dev-cloud-token \
  --project "$cloud_project" --replication-policy automatic
curl -fsS "$SMITHERS_API_ORIGIN/api/admin/users/smithers-dev/tokens" \
  -H "Authorization: Bearer $cloud_admin_token" -H 'Content-Type: application/json' \
  -d '{"name":"burndown-cloud","scopes":["read:user","write:user","write:repository","write:workspace","write:agent"]}' \
  | jq -er .token | gcloud secrets versions add smithers-dev-cloud-token \
      --project "$cloud_project" --data-file=-

export SMITHERS_TOKEN="$(gcloud secrets versions access latest \
  --secret smithers-dev-cloud-token --project "$cloud_project")"
curl -fsS "$SMITHERS_API_ORIGIN/api/user" -H "Authorization: Bearer $SMITHERS_TOKEN"
```

Production bootstrap used a one-hour infrastructure-issued admin PAT for the
existing operator principal. Only its SHA-256 hash went into `access_tokens`;
user and PAT creation then used the public admin endpoints above. That bootstrap
row was deleted in `finally`. The read-only observation token cannot create users.
The infrastructure operator commands and audit receipts belong in private Plue.

SSH keys belong to one Cloud principal. Register a dedicated key instead of
reusing a key already registered to another account:

```sh
ssh-keygen -t ed25519 -f "$HOME/.ssh/smithers-dev-cloud" -N '' -C smithers-dev-cloud
ssh-add "$HOME/.ssh/smithers-dev-cloud"
jq -n --rawfile key "$HOME/.ssh/smithers-dev-cloud.pub" \
  '{title:"burndown-operator",key:($key|rtrimstr("\n"))}' \
  | curl -fsS "$SMITHERS_API_ORIGIN/api/user/keys" \
      -H "Authorization: Bearer $SMITHERS_TOKEN" -H 'Content-Type: application/json' \
      --data-binary @-
```

## Repository access

An organization owner imports the GitHub repositories. Private sources require
that importing owner's GitHub login/App access. The resulting repositories live
at `smithersai/smithers` and `smithersai/plue`; the development user receives write
access through an organization team. Ordinary membership alone gives no repository
write permission.

```sh
curl -fsS "$SMITHERS_API_ORIGIN/api/orgs/smithersai/members" \
  -H "Authorization: Bearer $cloud_owner_token" -H 'Content-Type: application/json' \
  -d '{"user_id":20,"role":"member"}'
curl -fsS "$SMITHERS_API_ORIGIN/api/orgs/smithersai/teams" \
  -H "Authorization: Bearer $cloud_owner_token" -H 'Content-Type: application/json' \
  -d '{"name":"development","permission":"write"}'
curl -fsS -X PUT "$SMITHERS_API_ORIGIN/api/orgs/smithersai/teams/development/members/smithers-dev" \
  -H "Authorization: Bearer $cloud_owner_token"
for cloud_repo in smithers plue; do
  curl -fsS "$SMITHERS_API_ORIGIN/api/github/import" \
    -H "Authorization: Bearer $cloud_owner_token" -H 'Content-Type: application/json' \
    -d "{\"owner\":\"smithersai\",\"repo\":\"$cloud_repo\",\"branch\":\"main\"}"
  curl -fsS -X PUT "$SMITHERS_API_ORIGIN/api/orgs/smithersai/teams/development/repos/smithersai/$cloud_repo" \
    -H "Authorization: Bearer $cloud_owner_token"
done
# Poll each returned importJobId as its importing owner:
# GET /api/github/import/IMPORT_ID; acceptance is not completion.
# Refresh GitHub main through POST /api/repos/OWNER/REPO/github/main-pull,
# then poll GET of that path and compare the workspace's Git HEAD to GitHub main.
```

The Free plan permits one running sandbox. Infrastructure granted the development
user an audited, expiring Max entitlement with the existing operator command:

```sh
kubectl exec -n smithers deploy/smithers-api -c api -- \
  /smithers-cloud-backend plans grant -owner user:smithers-dev -plan max \
  -key burndown-lane-b-20260929 -expires 2026-10-29T23:59:59Z \
  -actor burndown-lane-B -reason 'Smithers Cloud burndown development account; smithersai/smithers#2924'
```

Plan permission does not establish fleet capacity. Physical capacity and rolling
worker availability are tracked by [plue#708](https://github.com/smithersai/plue/issues/708)
and [plue#603](https://github.com/smithersai/plue/issues/603).

## Agent commands

Install native binaries in `/home/developer/bin`; keep downloaded archives on
disk under `/home/developer`, not the guest's RAM-backed `/tmp`.

```sh
mkdir -p /home/developer/bin /home/developer/.cache/burndown
curl -fsSL -o /home/developer/.cache/burndown/codex.tgz \
  https://github.com/openai/codex/releases/latest/download/codex-x86_64-unknown-linux-musl.tar.gz
tar -xzf /home/developer/.cache/burndown/codex.tgz -C /home/developer/bin
mv /home/developer/bin/codex-x86_64-unknown-linux-musl /home/developer/bin/codex
rm /home/developer/.cache/burndown/codex.tgz
curl -fsSL -o /home/developer/.cache/burndown/claude.tgz \
  https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.285.tgz
tar -xzf /home/developer/.cache/burndown/claude.tgz -C /home/developer/.cache/burndown
mv /home/developer/.cache/burndown/package/claude /home/developer/bin/claude
rm -rf /home/developer/.cache/burndown/package /home/developer/.cache/burndown/claude.tgz
```

For each command, send the local `codex-5/auth.json` over SSH standard input,
write the guest's `~/.codex/auth.json` with mode `0600`, and remove it on completion
or interruption. Send Claude's locally read `claude-9` access token over standard
input and set `CLAUDE_CODE_OAUTH_TOKEN` only in the command's environment. Neither
credential belongs in a flow payload, workspace-create request, repository secret,
server-side credential store, SSH argv or retained log. Use temporary guest config
and remove it with the command. Do not run `claude auth login` in the guest:
`claude.ai` login endpoints are blocked there.

```sh
codex exec -m gpt-6.1-sol --dangerously-bypass-approvals-and-sandbox \
  'Reply with CLOUD-CODEX-OK only.'
claude -p --model claude-opus-5-5 --dangerously-skip-permissions \
  'Reply with CLOUD-CLAUDE-OK only.'
```

## Validation

```sh
SMITHERS_CLOUD_SANDBOX_SMOKE=1 \
SMITHERS_CLOUD_SANDBOX_REPOSITORY=smithersai/smithers \
pnpm --filter @smthrs/cli exec vitest run test/CloudSandbox.test.ts --coverage.enabled=false
```

This gated smoke creates a workspace, executes a command, transfers binary bytes,
and deletes its workspace at scope release. Deterministic API lifecycle tests use
a fake control API and real `CommandSandbox` host services. Backend tests use real
PostgreSQL for same-name races, twenty distinct names, and bookmark separation.
On 2026-09-29, production accepted `smithers-dev` (user 20), its dedicated SSH
key, both organization team repository grants, and the expiring Max entitlement.
Codex 0.159.1 answered `CLOUD-CODEX-OK` with `gpt-6.1-sol`; Claude 2.1.285
answered `CLOUD-CLAUDE-OK` with `claude-opus-5-5`. Both ran in a Cloud guest
using command-local credentials that were removed afterward.

Production returned the same running workspace ID for two different names before
the backend fix. Deployment and post-release concurrency receipts belong on
[#2924](https://github.com/smithersai/smithers/issues/2924) and
[plue#738](https://github.com/smithersai/plue/issues/738). A release or live
concurrency check remains incomplete until its receipt exists.

## Worker placement and handoff

`flows/burndown/worker/flow.ts` provides the placement dispatcher. Select Cloud
in the flow payload and configure the launcher's explicit Cloud environment:

```sh
# SMITHERS_TOKEN is supplied in memory from smithers-dev-cloud-token above.
export SMITHERS_API_ORIGIN=https://api.jjhub.tech
export BURNDOWN_REVIEW_ACCOUNT='<selected local Claude account ID>'
smthrs flow start burndown --data '{"repos":["smithersai/smithers","smithersai/plue"],"placement":"cloud","startAgents":20,"maxAgents":20}' -d
```

The launcher checks `/api/user` is `smithers-dev` and refreshes each canonical
repository through `/github/main-pull`, requiring its receipt to match current
GitHub main before workspace admission. Only the assigned local account is read
for a coding command. Native Codex 0.159.1 includes `codex-code-mode-host`;
Claude uses the native 2.1.285 binary. Archive digests are verified against
published GitHub/npm metadata, and large archives use the guest home cache.
The Cloud provider defaults guest `HOME` to `/home/developer` and preserves
explicit child overrides.

Agent credentials travel on SSH stdin and live in temporary guest configs.
The coding guest receives no reviewer credential: the trusted host runs Fable
with source-only stdin and tools disabled. Before deletion, committed trees are
retained on the launcher with before/after bytes, modes and symlink targets.
Local reconstruction runs under the existing VCS lock and returns local commit
IDs to the merge queue. Review or reconstruction failure leaves a retained
artifact and refuses READY. See [Cloud workers](docs/cloud-execution.md).

Deterministic checks cover real command transport, credential redaction,
interruption cleanup, binary/mode/symlink exports and durable local handoff.
`BURNDOWN_CLOUD_SMOKE=1` gates the paid sequential native-agent command smoke;
supply the explicit Cloud environment and the selected test logins locally.
