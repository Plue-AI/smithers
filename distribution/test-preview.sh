#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
image=${1:-smithers-preview:local}
BUILD_SHA=${SMITHERS_BUILD_SHA:-$(git -C "$root" rev-parse HEAD)}
container="smithers-preview-$$"
scratch=$(mktemp -d)
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then docker logs "$container" >&2 || true; fi
  docker rm -fv "$container" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
if [ "${SMITHERS_DOCKER_SKIP_BUILD:-0}" != 1 ]; then
  docker buildx build --platform linux/amd64 --build-arg "BUILD_SHA=$BUILD_SHA" -f "$root/distribution/Dockerfile" --load -t "$image" "$root"
fi
# Inspect names only; never print a credential value.
docker image inspect "$image" > "$scratch/image.json"
node - "$scratch/image.json" "$BUILD_SHA" <<'JS'
const fs = require('node:fs');
const [image] = JSON.parse(fs.readFileSync(process.argv[2]));
if (image.Config.Env.some(e => /TOKEN|KEY|SECRET|PASSWORD/i.test(e.split('=')[0]))) throw Error('secret-shaped image environment');
if (image.Config.Labels['org.opencontainers.image.revision'] !== process.argv[3]) throw Error('revision mismatch');
JS
# Build inputs must never include credential mounts or credential build args.
docker history --no-trunc --format '{{.CreatedBy}}' "$image" > "$scratch/history"
node - "$scratch/history" <<'JS'
const fs = require('node:fs');
const history = fs.readFileSync(process.argv[2], 'utf8');
if (/--mount=type=(secret|ssh)/i.test(history)) throw Error('credential build mount');
for (const line of history.split('\n')) {
  const arg = line.match(/\bARG\s+([A-Za-z_][A-Za-z_0-9]*)/);
  if (arg && arg[1] !== 'BUILD_SHA') throw Error('unexpected build argument');
  const values = line.match(/\|\d+\s+(.*?)\s+(?:\/bin\/sh|RUN)/);
  if (values && values[1].split(/\s+/).some(v => !v.startsWith('BUILD_SHA='))) throw Error('unexpected build argument value');
}
JS
start=$SECONDS
docker run -d --name "$container" -e PORT=8080 --memory 4g --cpus 2 --cap-drop ALL -p 127.0.0.1:4100:8080 "$image" >/dev/null
test "$(docker inspect --format '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostIp}}' "$container")" = 127.0.0.1
until curl --connect-timeout 1 --max-time 2 --fail --silent http://127.0.0.1:4100/readyz >/dev/null; do
  if (( SECONDS - start >= 120 )); then echo 'readiness timeout' >&2; exit 1; fi
  sleep 1
done
ready=$((SECONDS - start))
curl --fail --silent http://127.0.0.1:4100/ > "$scratch/home"
rg -qi '<!doctype html|<html' "$scratch/home"
curl --fail --silent http://127.0.0.1:4100/api/bootstrap > "$scratch/bootstrap"
node - "$scratch/bootstrap" <<'JS'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2]));
if (!Array.isArray(value.capabilities) || !value.capabilities.includes('install')) throw Error('bootstrap does not list install');
JS
status=$(curl --silent --output "$scratch/workspace" --write-out '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:4100/api/repos/o/r/workspaces)
test "$status" = 503
node - "$scratch/workspace" <<'JS'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (value.code !== 'machines_disabled' || value.message !== 'Machines are off in this preview.') throw Error('machine door did not refuse');
JS
test "$(docker exec "$container" id -u)" != 0
docker exec "$container" cat /proc/1/status > "$scratch/process"
node - "$scratch/process" <<'JS'
const fs = require('node:fs');
const uid = fs.readFileSync(process.argv[2], 'utf8').match(/^Uid:\s+(.*)$/m);
if (!uid || uid[1].trim().split(/\s+/).some(v => Number(v) === 0)) throw Error('root container process');
JS
docker inspect "$container" > "$scratch/container.json"
node - "$scratch/container.json" <<'JS'
const fs = require('node:fs');
const [container] = JSON.parse(fs.readFileSync(process.argv[2]));
if (container.Config.Env.some(e => /TOKEN|KEY|SECRET|PASSWORD/i.test(e.split('=')[0]))) throw Error('secret-shaped runtime environment');
JS
# Check all listening TCP sockets, including PostgreSQL, through the kernel boundary.
docker exec "$container" cat /proc/net/tcp /proc/net/tcp6 > "$scratch/sockets"
node - "$scratch/sockets" <<'JS'
const fs = require('node:fs');
let exposed = 0;
for (const line of fs.readFileSync(process.argv[2], 'utf8').trim().split('\n')) {
  const fields = line.trim().split(/\s+/);
  if (fields[3] !== '0A') continue;
  const [addr, port] = fields[1].split(':');
  if (addr.endsWith('7F') || addr === '00000000000000000000000001000000') continue;
  if (parseInt(port, 16) !== 8080) throw Error('unexpected non-loopback listener');
  exposed++;
}
if (exposed === 0) throw Error('PORT is not listening');
JS
start=$SECONDS
docker stop -t 10 "$container" >/dev/null
stop=$((SECONDS - start))
test "$stop" -lt 10
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" != 137
mb=$(docker image inspect --format '{{.Size}}' "$image" | awk '{printf "%.0f", $1/1000000}')
printf 'image %s MB · ready %ss · stop %ss\n' "$mb" "$ready" "$stop"
