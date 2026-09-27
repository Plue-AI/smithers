#!/usr/bin/env bash
set -euo pipefail

image=${1:-smithers-issue12:local}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
suffix="$$-$(date +%s)"
prefix="smithers-issue12-${suffix}"
network="${prefix}-net"
postgres="${prefix}-postgres"
provider="${prefix}-provider"
restored_postgres="${prefix}-postgres-restored"
app="${prefix}-app"
restored_app="${prefix}-app-restored"
refusal_app="${prefix}-app-refusal"
data_volume="${prefix}-data"
restored_data_volume="${prefix}-data-restored"
postgres_volume="${prefix}-pg"
restored_postgres_volume="${prefix}-pg-restored"
backup_volume="${prefix}-backups"
keys_volume="${prefix}-keys"
database_user=smithers
database_name=smithers
database_password="issue12-${suffix}"
bootstrap_token="issue12-bootstrap-${suffix}-0123456789abcdef0123456789abcdef"
owner_username=issue12owner
owner_password="Issue12 acceptance password ${suffix}"
repository_name="distribution-${suffix}"

container_exists() { docker container inspect "$1" >/dev/null 2>&1; }

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ]; then
    if container_exists "$postgres"; then
      docker exec "$postgres" psql -U "$database_user" -d "$database_name" -x -c \
        'SELECT id, workflow_run_id, status, last_error FROM workflow_tasks ORDER BY id' >&2 || true
      # Native hosts select PostgreSQL in the packaged deployment. Read its
      # terminal evidence as well as the SQLite fallback below.
      docker exec -i "$postgres" psql -U "$database_user" -d "$database_name" -At >&2 <<'SQL' || true
SELECT format('SELECT json_build_object(''schema'', %L, ''run'', run_id, ''state'', state_json)::text FROM %I.flows_runs WHERE status = ''failed''', table_schema, table_schema)
FROM information_schema.tables WHERE table_name = 'flows_runs' AND table_schema LIKE 'flows_%' ORDER BY table_schema
\gexec
SELECT format('SELECT json_build_object(''schema'', %L, ''run'', run_id, ''cause'', payload_json::jsonb->>''cause'')::text FROM %I.flows_journal_events WHERE event_type = ''control.run.failed'' ORDER BY seq', table_schema, table_schema)
FROM information_schema.tables WHERE table_name = 'flows_journal_events' AND table_schema LIKE 'flows_%' ORDER BY table_schema
\gexec
SQL
    fi
    if container_exists "$app"; then
      docker exec -i "$app" /opt/smithers/bin/node --input-type=module >&2 <<'NODE' || true
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !['.git', '.jj'].includes(entry.name)) await inspect(path);
    else if (entry.isFile() && entry.name === 'engine.db') {
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        for (const row of database.prepare("SELECT run_id, state_json FROM flows_runs WHERE status = 'failed'").all()) {
          console.error(JSON.stringify({ run: row.run_id, result: JSON.parse(row.state_json).result }));
        }
      } finally { database.close(); }
    }
  }
}
await inspect('/var/lib/smithers/workspaces');
NODE
    fi
    for container in "$app" "$restored_app" "$refusal_app" "$provider" "$postgres" "$restored_postgres"; do
      if container_exists "$container"; then
        printf '\n--- %s logs ---\n' "$container" >&2
        docker logs "$container" >&2 || true
      fi
    done
  fi
  docker rm -f "$app" "$restored_app" "$refusal_app" "$provider" "$postgres" "$restored_postgres" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$data_volume" "$restored_data_volume" "$postgres_volume" "$restored_postgres_volume" "$backup_volume" "$keys_volume" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT INT TERM
trap 'printf "test-image failed at line %s\n" "$LINENO" >&2' ERR

wait_postgres() {
  local container=$1
  for _ in $(seq 1 90); do
    if docker exec "$container" pg_isready -h 127.0.0.1 -U "$database_user" -d "$database_name" >/dev/null 2>&1; then
      return
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$container")" != true ]; then
      return 1
    fi
    sleep 1
  done
  return 1
}

published_origin() {
  local container=$1 mapping port
  mapping=$(docker port "$container" 4000/tcp | head -n 1)
  port=${mapping##*:}
  printf 'http://127.0.0.1:%s\n' "$port"
}

wait_http() {
  local container=$1 origin=$2
  for _ in $(seq 1 120); do
    if curl -fsS "$origin/readyz" >/dev/null 2>&1; then
      return
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$container")" != true ]; then
      return 1
    fi
    sleep 1
  done
  return 1
}

start_postgres() {
  local name=$1 volume=$2
  docker run -d --name "$name" --network "$network" \
    -e POSTGRES_USER="$database_user" \
    -e POSTGRES_PASSWORD="$database_password" \
    -e POSTGRES_DB="$database_name" \
    -v "$volume:/var/lib/postgresql" \
    postgres:18.6-bookworm >/dev/null
  wait_postgres "$name"
}

database_url() {
  printf 'postgres://%s:%s@%s:5432/%s?sslmode=disable\n' \
    "$database_user" "$database_password" "$1" "$database_name"
}

start_app() {
  local name=$1 volume=$2 database_host=$3
  # Flow hosts never see a provider key: they reach the fake provider through
  # the backend's metered model proxy with a per-binding credential (#2187).
  docker run -d --name "$name" --network "$network" \
    --cap-drop ALL --security-opt no-new-privileges \
    -p 127.0.0.1::4000 \
    -e DATABASE_URL="$(database_url "$database_host")" \
    -e SMITHERS_AUTH_BOOTSTRAP_TOKEN="$bootstrap_token" \
    -e SMITHERS_WORKSPACE_CODING_DEFAULT_MODEL=cerebras:gpt-oss-120b \
    -e SMITHERS_PLATFORM_MODEL_KEYS_FILE=/etc/smithers-keys/platform-model-keys.json \
    -v "$keys_volume:/etc/smithers-keys:ro" \
    -e "SMITHERS_MODEL_PROXY_UPSTREAMS={\"cerebras\":\"http://$provider:8080\",\"vercel\":\"http://$provider:8080\"}" \
    -v "$volume:/var/lib/smithers" \
    "$image" >/dev/null
}

build_sha=${SMITHERS_BUILD_SHA:-}
if [ -z "$build_sha" ] && [ "${SMITHERS_DOCKER_SKIP_BUILD:-0}" != 1 ] && command -v jj >/dev/null 2>&1; then
  build_sha=$(cd "$root" && jj log -r @ --no-graph -T commit_id)
fi
if [ "${SMITHERS_DOCKER_SKIP_BUILD:-0}" != 1 ]; then
  if [ -z "$build_sha" ]; then build_sha=$(jj -R "$root" log -r @ --no-graph -T commit_id); fi
  test -n "$build_sha" || { printf 'BUILD_SHA is required\n' >&2; exit 1; }
  docker build --progress=plain --build-arg "BUILD_SHA=$build_sha" -f "$root/distribution/Dockerfile" -t "$image" "$root"
fi

docker network create "$network" >/dev/null
for volume in "$data_volume" "$restored_data_volume" "$postgres_volume" "$restored_postgres_volume" "$backup_volume" "$keys_volume"; do
  docker volume create "$volume" >/dev/null
done
docker run -d --name "$provider" --network "$network" --no-healthcheck \
  -v "$root/distribution/fake-coding-provider.mjs:/provider.mjs:ro" \
  --entrypoint /opt/smithers/bin/node "$image" /provider.mjs >/dev/null
docker run --rm --user 0 -v "$backup_volume:/backups" \
  --entrypoint /bin/sh "$image" -eu -c 'chown smithers:smithers /backups; chmod 0700 /backups'
printf '%s' '{"cerebras":"scripted-provider-key","vercel":"scripted-evaluator-key"}' |
  docker run --rm -i --user 0 -v "$keys_volume:/keys" --entrypoint /bin/sh "$image" -eu -c \
    'umask 077; cat >/keys/platform-model-keys.json; chown smithers:smithers /keys/platform-model-keys.json'


start_postgres "$postgres" "$postgres_volume"
start_app "$app" "$data_volume" "$postgres"
origin=$(published_origin "$app")
wait_http "$app" "$origin"

test "$(docker exec "$app" id -u)" != 0
if docker run --rm --entrypoint /bin/sh "$image" -c 'command -v python3 >/dev/null 2>&1'; then
  printf 'distribution image unexpectedly contains python3\n' >&2
  exit 1
fi
docker exec "$app" sh -eu -c '
  test ! -w /opt/smithers
  test -x /opt/smithers/bin/node
  test -x /opt/smithers/bin/smithers-backend
  test -x /opt/smithers/bin/smithers-coding-host
  test -x /opt/smithers/bin/smithers-librarian-host
  test -x /opt/smithers/bin/smithers-model-host
  test -x /opt/smithers/bin/smithers-jj-export
  test -x /opt/smithers/bin/jj
  test -x /opt/smithers/git/bin/git
  test -r /opt/smithers/bin/flow-hosts.json
  test -r /opt/smithers/lib/libsmithers_ffi.so
  cd /opt/smithers/bin
  sha256sum -c smithers-coding-host.sha256 smithers-librarian-host.sha256 smithers-model-host.sha256 >/dev/null
  ./jj --version | grep -Fx "jj 0.44.0-47589ada70c12b3e829b5c98ab32503abad49eac"
  /opt/smithers/git/bin/git --version | grep -Fx "git version 2.50.1"
  PATH=/opt/smithers/bin:$PATH ./smithers-model-host --help >/dev/null
'
docker exec "$app" sh -eu -c '
  work=$(mktemp -d)
  trap '\''rm -rf "$work"'\'' EXIT
  git -C "$work" init --quiet
  git -C "$work" config user.name "Smithers Package Test"
  git -C "$work" config user.email package-test@smithers.invalid
  printf "packaged git and jj\n" >"$work/README"
  git -C "$work" add README
  git -C "$work" commit --quiet -m "package smoke"
  cd "$work"
  jj git init --colocate >/dev/null
  jj log --no-graph -r @ -T commit_id >/dev/null
'
home_html=$(curl -fsS "$origin/")
case "$home_html" in
  *'<div id="root"'*) ;;
  *) printf 'unexpected web index: %.200s\n' "$home_html" >&2; exit 1 ;;
esac
docker exec -i "$app" /opt/smithers/bin/node --input-type=module - "$build_sha" <<'NODE'
import assert from 'node:assert/strict';
const read = async path => {
  const response = await fetch(`http://127.0.0.1:4000${path}`);
  assert.equal(response.status, 200, `${path} must be served`);
  return response.text();
};
const [bootstrapText, stampText, html] = await Promise.all([
  read('/api/bootstrap'), read('/__build.json'), read('/')
]);
const bootstrap = JSON.parse(bootstrapText);
const stamp = JSON.parse(stampText);
assert.equal(bootstrap.apiVersion, 1);
assert.match(bootstrap.buildSha, /^[0-9a-f]{40,64}$/, 'backend must identify its source');
assert.equal(stamp.app, 'smithers-app');
assert.equal(stamp.gitSha, bootstrap.buildSha, 'web and backend revisions must agree');
if (process.argv[2]) assert.equal(stamp.gitSha, process.argv[2], 'image must match the requested revision');
const meta = (html.match(/<meta\b[^>]*>/gi) ?? []).find(tag => /\bname=["']smithers-build-sha["']/i.test(tag));
assert.equal(meta?.match(/\bcontent=["']([^"']*)["']/i)?.[1], stamp.gitSha, 'HTML and build asset revisions must agree');
console.log(`BUILD_STAMP_OK revision=${stamp.gitSha}`);
NODE
curl -fsS "$origin/api/auth/local/status" | grep '"initialized":false' >/dev/null
curl -fsS -X POST "$origin/api/auth/local/bootstrap" \
  -H 'Content-Type: application/json' \
  -H "X-Smithers-Bootstrap-Token: $bootstrap_token" \
  --data "{\"username\":\"$owner_username\",\"email\":\"$owner_username@example.test\",\"password\":\"$owner_password\"}" \
  | grep "\"username\":\"$owner_username\"" >/dev/null
token_response=$(curl -fsS -X POST "$origin/api/auth/local/token" \
  -H 'Content-Type: application/json' \
  --data "{\"username\":\"$owner_username\",\"password\":\"$owner_password\",\"name\":\"distribution-acceptance\"}")
api_token=$(printf '%s' "$token_response" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
test -n "$api_token"
docker exec "$app" /opt/smithers/bin/smithers-backend credits grant -owner "user:$owner_username" -usd 5 -key distribution-acceptance >/dev/null
created_repository=$(curl -fsS -X POST "$origin/api/user/repos" \
  -H 'Content-Type: application/json' \
  -H "Authorization: token $api_token" \
  --data "{\"name\":\"$repository_name\",\"description\":\"issue 12 image acceptance\",\"private\":true,\"auto_init\":true}")
printf '%s' "$created_repository" | grep "\"full_name\":\"$owner_username/$repository_name\"" >/dev/null
curl -fsS -H "Authorization: token $api_token" \
  "$origin/api/repos/$owner_username/$repository_name" \
  | grep "\"full_name\":\"$owner_username/$repository_name\"" >/dev/null
session_response=$(curl -fsS -X POST "$origin/api/repos/$owner_username/$repository_name/agent/sessions" \
  -H 'Content-Type: application/json' -H "Authorization: token $api_token" \
  --data '{"title":"Container coding proof"}')
session_id=$(printf '%s' "$session_response" | sed -n 's/^{"id":"\([^"]*\)".*/\1/p')
test -n "$session_id"
curl -fsS -X POST "$origin/api/repos/$owner_username/$repository_name/agent/sessions/$session_id/messages" \
  -H 'Content-Type: application/json' -H "Authorization: token $api_token" \
  --data '{"role":"user","parts":[{"type":"text","content":"Write flow-proof.txt with the requested proof text, then read it back."}],"agent_provider":"smithers","agent_transport":"workflow"}' >/dev/null
flow_completed=0
for _ in $(seq 1 120); do
  session_response=$(curl -fsS -H "Authorization: token $api_token" \
    "$origin/api/repos/$owner_username/$repository_name/agent/sessions/$session_id")
  case "$session_response" in
    *'"status":"completed"'*) flow_completed=1; break ;;
    *'"status":"failed"'*) printf 'coding Flow failed: %s\n' "$session_response" >&2; exit 1 ;;
  esac
  sleep 1
done
test "$flow_completed" = 1 || { printf 'coding Flow did not complete: %s\n' "$session_response" >&2; exit 1; }
workspace_id=$(printf '%s' "$session_response" | sed -n 's/.*"workspace_id":"\([^"]*\)".*/\1/p')
test -n "$workspace_id"
curl -fsS -H "Authorization: token $api_token" \
  "$origin/api/repos/$owner_username/$repository_name/workspaces/$workspace_id/files/content?path=flow-proof.txt" \
  | grep '"content":"The coding Flow wrote this file through the packaged host.\\n"' >/dev/null
docker exec "$app" test -s /var/lib/smithers/config/secrets.json
secret_checksum=$(docker exec "$app" sha256sum /var/lib/smithers/config/secrets.json | awk '{print $1}')
table_count=$(docker exec "$postgres" psql -U "$database_user" -d "$database_name" -Atqc "select count(*) from pg_catalog.pg_tables where schemaname not in ('pg_catalog','information_schema')")
test "$table_count" -gt 0

docker restart "$app" >/dev/null
origin=$(published_origin "$app")
wait_http "$app" "$origin"
test "$(docker exec "$app" sha256sum /var/lib/smithers/config/secrets.json | awk '{print $1}')" = "$secret_checksum"
curl -fsS -H "Authorization: token $api_token" \
  "$origin/api/repos/$owner_username/$repository_name" \
  | grep "\"full_name\":\"$owner_username/$repository_name\"" >/dev/null

if docker run --rm --network "$network" \
  -e DATABASE_URL="$(database_url "$postgres")" \
  -e SMITHERS_BACKUP_ROOT=/backups \
  -v "$data_volume:/var/lib/smithers" \
  -v "$backup_volume:/backups" \
  --entrypoint /opt/smithers/backup.sh \
  "$image" >/dev/null 2>&1; then
  printf 'backup acquired the maintenance lock while the app was running\n' >&2
  exit 1
fi

docker stop "$app" >/dev/null
backup_path=$(docker run --rm --network "$network" \
  -e DATABASE_URL="$(database_url "$postgres")" \
  -e SMITHERS_BACKUP_ROOT=/backups \
  -v "$data_volume:/var/lib/smithers" \
  -v "$backup_volume:/backups" \
  --entrypoint /opt/smithers/backup.sh \
  "$image" | tail -n 1)
case "$backup_path" in /backups/smithers-*) ;; *) printf 'unexpected backup path: %s\n' "$backup_path" >&2; exit 1 ;; esac

start_postgres "$restored_postgres" "$restored_postgres_volume"
docker run --rm --network "$network" \
  -e DATABASE_URL="$(database_url "$restored_postgres")" \
  -v "$restored_data_volume:/var/lib/smithers" \
  -v "$backup_volume:/backups:ro" \
  --entrypoint /opt/smithers/restore.sh \
  "$image" "$backup_path" >/dev/null

start_app "$restored_app" "$restored_data_volume" "$restored_postgres"
restored_origin=$(published_origin "$restored_app")
wait_http "$restored_app" "$restored_origin"
test "$(docker exec "$restored_app" sha256sum /var/lib/smithers/config/secrets.json | awk '{print $1}')" = "$secret_checksum"
curl -fsS "$restored_origin/api/bootstrap" | grep '"apiVersion":1' >/dev/null
curl -fsS -H "Authorization: token $api_token" \
  "$restored_origin/api/repos/$owner_username/$repository_name" \
  | grep "\"full_name\":\"$owner_username/$repository_name\"" >/dev/null

docker stop "$restored_app" >/dev/null
docker run --rm -v "$restored_data_volume:/var/lib/smithers" --entrypoint /bin/sh "$image" -eu -c \
  "sed -i 's/^SMITHERS_DISTRIBUTION_VERSION=.*/SMITHERS_DISTRIBUTION_VERSION=0.0.0/' /var/lib/smithers/version.env"
if docker run --name "$refusal_app" --network "$network" \
  -e DATABASE_URL="$(database_url "$restored_postgres")" \
  -e SMITHERS_AUTH_BOOTSTRAP_TOKEN="$bootstrap_token" \
  -v "$restored_data_volume:/var/lib/smithers" \
  "$image"; then
  printf 'container accepted a mismatched persisted distribution version\n' >&2
  exit 1
fi
docker logs "$refusal_app" 2>&1 | grep 'requires an explicit upgrade' >/dev/null

printf 'IMAGE_ACCEPTANCE_OK image=%s origin=%s backup=%s\n' "$image" "$origin" "$backup_path"
