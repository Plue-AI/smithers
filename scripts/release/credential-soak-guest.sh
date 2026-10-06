# Sourced only by the production terminal, under Ben's personal machine user.
# expected_uid and nonce are fixed by the host recording tool, not repository data.
set +x
set +e
report() { printf '\nSOAK:%s:%s\n' "$nonce" "$1"; }
if [ "$(id -u)" != "$expected_uid" ] || [ "$(id -u)" -lt 20000 ]; then
  report "refused:$(date +%s):1"
  exit 78
fi
# Subscription and gh logins must be the independently created home logins,
# never injected provider or GitHub tokens from a shared environment.
if [ -n "${ANTHROPIC_API_KEY:-}${OPENAI_API_KEY:-}${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
  report "refused:$(date +%s):5"
  exit 78
fi
command -v timeout >/dev/null || { report "refused:$(date +%s):2"; exit 69; }
start=$(date +%s)
report "begin:$start:$(id -u)"
for tool in claude codex gh; do
  # Never emit version banners: even wrappers may print credentials. Store only
  # a numeric version tuple. Missing/unparseable versions refuse the capture.
  version=$(timeout 30 "$tool" --version 2>/dev/null)
  status=$?
  numbers=$(printf '%s\n' "$version" | sed -nE 's/^[^0-9]*([0-9]+)\.([0-9]+)\.([0-9]+).*$/\1:\2:\3/p' | head -1)
  unset version
  if [ "$status" != 0 ] || [ -z "$numbers" ]; then
    report "refused:$(date +%s):3"; exit 69
  fi
  # Version records have their own strict numeric grammar in the host filter.
  printf '\nSOAK:%s:version:%s:%s\n' "$nonce" "$tool" "$numbers"
done
failed=0
for iteration in $(seq 0 144); do
  target=$((start + iteration * 600))
  now=$(date +%s)
  if [ "$now" -lt "$target" ]; then sleep "$((target - now))"; fi
  # A suspend/transport gap must not silently become missed observations.
  now=$(date +%s)
  if [ "$now" -gt "$((target + 60))" ]; then
    report "refused:$now:4"; exit 75
  fi
  for tool in claude codex gh; do
    at=$(date +%s)
    case "$tool" in
      claude) output=$(timeout 120 claude -p "ok" </dev/null 2>&1); status=$? ;;
      codex) output=$(timeout 120 codex exec "ok" </dev/null 2>&1); status=$? ;;
      gh) output=$(timeout 120 gh api user </dev/null 2>&1); status=$? ;;
    esac
    login=0
    if printf '%s' "$output" | grep -Eiq '(not logged in|not signed in|authentication failed|login required|please log in|please sign in|device code|device.auth|oauth/authorize|invalid.*token|expired.*token)'; then login=1; fi
    unset output
    report "call:$tool:$at:$status:$login"
    if [ "$status" != 0 ] || [ "$login" != 0 ]; then failed=1; fi
  done
done
report "end:$(date +%s):$failed"
exit "$failed"
