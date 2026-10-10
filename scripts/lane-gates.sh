#!/usr/bin/env bash
# Pre-push gates for lanes that land on main (agreed with smithers-22, 2026-10-06; review fixes applied).
#   lane-gates.sh             run in a lane worktree after rebasing onto origin/main; exit 0 = push allowed
#   lane-gates.sh --integration <base> [--allow-deleted <glob>]  reject lost main additions
#   lane-gates.sh --baseline  run on a checkout of main; writes every failing name to $HOME/lanes/main-baseline-failures.txt
# Rule: no new failing names. Only name-free tool failures may use a tool-failure baseline.
set -u
# Failing names: Node spec/TAP, Go tests and subtests (TestX, TestX/sub), bun "(fail) name", vitest "FAIL|× name".
normalize_names() { sed -E 's/ \([0-9.]+m?s\)$//; s/ [0-9.]+m?s$//; s/ # (TODO|SKIP).*//'; }
extract() { local esc=$'\033'; sed -E "s/${esc}\\[[0-9;]*[mK]//g" | sed -n -E '/^ *✖ failing tests:$/d; s/^ *--- FAIL: ([^ ]+).*/\1/p; s/^\(fail\) (.*) \[[0-9.]+m?s\]$/\1/p; s/^ *(FAIL|×) +(.*)$/\2/p; s/^ *✖ +(.*)$/\1/p; s/^ *not ok [0-9]+ - (.*)$/\1/p' | normalize_names | sort -u; }
check() {
  local name=$1 cmd=$2 out rc names n known
  echo "== $name: $cmd" >> "$log"
  out=$(bash -o pipefail -c "$cmd" 2>&1); rc=$?
  printf '%s\n' "$out" >> "$log"
  [ $rc -eq 0 ] && { echo "PASS $name" >> "$log"; return 0; }
  names=$(printf '%s\n' "$out" | extract)
  if [ $mode = baseline ]; then
    if [ -n "$names" ]; then printf '%s\n' "$names" >> "$allfails"
    elif printf '%s\n' "$out" | grep -qE '(tests? failed|fail(ed|ures)?[ :]+[1-9]|# fail [1-9]|not ok|✖|✔|✓|√|^# Subtest:|^ok [0-9]+|--- (FAIL|PASS):|\((fail|pass)\))'; then
      echo "$name: unnamed test failure" >> "$allfails"
    else echo "$name: tool-failure" >> "$allfails"; fi
    echo "FAIL $name (baseline records it)" >> "$log"; return 0
  fi
  if [ -z "$names" ]; then
    # An unnamed failing test is never a tool failure, even with a matching baseline.
    if printf '%s\n' "$out" | grep -qE '(tests? failed|fail(ed|ures)?[ :]+[1-9]|# fail [1-9]|not ok|✖|✔|✓|√|^# Subtest:|^ok [0-9]+|--- (FAIL|PASS):|\((fail|pass)\))'; then
      echo "FAIL $name (tests failed without extractable names)" >> "$log"
      newreds+=("$name: unnamed test failure"); return 1
    fi
    if grep -qxF "$name: tool-failure" "$baseline"; then echo "FAIL $name (no test names; main fails this check the same way: allowed)" >> "$log"; return 0; fi
    echo "FAIL $name (no test names: build or tool failure)" >> "$log"; newreds+=("$name"); return 1
  fi
  # Older receipts retained reporter timings. Compare the same name identity
  # on both sides without rewriting the shared baseline.
  if ! known=$(normalize_names < "$baseline"); then
    echo "FAIL $name (unreadable baseline)" >> "$log"
    newreds+=("$name: unreadable baseline"); return 1
  fi
  while IFS= read -r n; do grep -qxF "$n" <<< "$known" || newreds+=("$name: $n"); done <<< "$names"
  echo "FAIL $name (compared with main's baseline)" >> "$log"
}

# Resolve touched packages and their reverse dependencies within this module only.
select_go_packages() {
  local mod=$1 touched=$2 data selected
  data=$(cd "$mod" && go list -f '{{.ImportPath}} {{join .Deps " "}}' ./...) || return 1
  local imports
  imports=$(cd "$mod" && go list $touched) || return 1
  selected=$(set -o pipefail; printf '%s\n' "$data" | SMITHERS_GATE_TOUCHED_IMPORTS="$imports" awk '
    BEGIN { split(ENVIRON["SMITHERS_GATE_TOUCHED_IMPORTS"], paths, "\n"); for (i in paths) changed[paths[i]]=1 }
    { for (i=1; i<=NF; i++) if ($i in changed) { print $1; break } }
  ' | sort -u) || return 1
  [ -n "$selected" ] || { echo "No Go packages selected in $mod" >&2; return 1; }
  printf 'Selected Go packages (%s):\n%s\n' "$mod" "$selected" >> "$log"
  printf '%s\n' "$selected"
}

# Formatting failures are never grandfathered by a test-failure baseline.
check_go_format() {
  local target=$1 out
  out=$(gofmt -l "$target" 2>&1) || { printf '%s\n' "$out" >> "$log"; newreds+=("gofmt:$target: tool failure"); return 1; }
  if [ -n "$out" ]; then
    printf 'FAIL gofmt:%s\n%s\n' "$target" "$out" >> "$log"
    newreds+=("gofmt:$target"); return 1
  fi
  echo "PASS gofmt:$target" >> "$log"
}

# //scripts:lint and //:jsdocTree share the root eslint.config.js. A lane owns the lint of every operator
# script and package source it touches, so this is never grandfathered by a baseline (#3765).
# Reads changed paths on stdin; files outside those trees, and deleted files, are skipped.
check_root_lint() {
  local files=() f out
  while IFS= read -r f; do
    [[ "$f" =~ ^scripts/.*\.mjs$ || "$f" =~ ^packages/([^/]+/){1,3}src/.*\.ts$ ]] && [ -f "$f" ] && files+=("$f")
  done
  [ ${#files[@]} -eq 0 ] && return 0
  # The workspace's own ESLint binary: `pnpm exec` may verify or install dependencies first.
  if out=$(node_modules/.bin/eslint --config eslint.config.js --max-warnings 0 --no-warn-ignored "${files[@]}" 2>&1); then
    echo "PASS root-eslint (${#files[@]} files)" >> "$log"; return 0
  fi
  printf 'FAIL root-eslint\n%s\n' "$out" >> "$log"
  newreds+=("root-eslint"); return 1
}

# Sourcing exposes the same parser/check used by the executable to regression fixtures.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then return 0; fi

if [ "${1:-}" = --integration ]; then
  shift
  node --input-type=module - "$@" <<'NODE'
import { execFileSync } from 'node:child_process';
import { matchesGlob } from 'node:path';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
const [base, ...args] = process.argv.slice(2);
if (!base) throw new Error('usage: --integration <merge-base> [--allow-deleted <path-glob>]');
const allowances = [];
for (let i = 0; i < args.length; i += 2) {
  if (args[i] !== '--allow-deleted' || !args[i + 1]) throw new Error('expected --allow-deleted <path-glob>');
  allowances.push(args[i + 1]);
}
git('rev-parse', '--verify', base + '^{commit}');
const changed = ref => new Set(git('diff', '--no-renames', '--name-only', '-z', base, ref).split('\0').filter(Boolean));
const headFiles = new Set(git('ls-tree', '-r', '--name-only', '-z', 'HEAD').split('\0').filter(Boolean));
const mainFiles = changed('origin/main');
let total = 0;
for (const file of changed('HEAD')) {
  if (!mainFiles.has(file)) continue;
  if (!headFiles.has(file) && allowances.some(pattern => matchesGlob(file, pattern))) continue;
  const lines = new Set(headFiles.has(file) ? git('show', 'HEAD:' + file).split('\n') : []);
  const diff = git('diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--unified=0', base, 'origin/main', '--', file);
  const added = [];
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@ ')) inHunk = true;
    else if (inHunk && line.startsWith('+')) added.push(line.slice(1));
  }
  const missing = added.filter(line => !lines.has(line)).length;
  if (missing) { console.log(`${file}\t${missing}`); total += missing; }
}
console.log(total ? `BLOCKED: ${total} main-added lines absent from HEAD` : 'INTEGRATION PASS');
process.exitCode = total ? 1 : 0;
NODE
  exit $?
fi
mode=gate; [ "${1:-}" = "--baseline" ] && mode=baseline
# Only ~/lanes/baseline-run.sh (LANE=fr-baseline-main) may write the shared baseline; a lane that writes it corrupts every host's gate.
[ $mode = baseline ] && [ "${LANE:-}" != fr-baseline-main ] && { echo "REFUSED: only ~/lanes/baseline-run.sh writes the main baseline. Wait for it (see ~/lanes/fr-baseline.log); never run --baseline from a lane." >&2; exit 2; }
root=$(git rev-parse --show-toplevel) || exit 2
cd "$root"
lane=${LANE:-lane}
log=$HOME/lanes/$lane.gates.log; : > "$log"
baseline=$HOME/lanes/main-baseline-failures.txt
if [ $mode = gate ]; then
  git fetch -q origin main
  [ -s "$baseline" ] || { echo "BLOCKED: $baseline is missing or empty; generate it with --baseline on main first" | tee -a "$log"; exit 1; }
  changed=$(git diff --name-only origin/main...HEAD)
else
  changed=$(git ls-files)   # every file: the baseline covers all suites
  allfails=$(mktemp)
fi
source "$root/scripts/lane-prerequisites.sh" || { echo "BLOCKED: test prerequisites failed" | tee -a "$log"; exit 1; }
newreds=()

# PostgreSQL is required: database tests must run, never skip.
export SMITHERS_TEST_DATABASE_URL=${SMITHERS_TEST_DATABASE_URL:-postgres://smithers@127.0.0.1:${FR_PG_PORT:-55440}/postgres?sslmode=disable}
export SMITHERS_REQUIRE_DATABASE_TESTS=1
if ! psql "$SMITHERS_TEST_DATABASE_URL" -Atc 'select 1' >/dev/null 2>&1 && ! pg_isready -d "$SMITHERS_TEST_DATABASE_URL" >/dev/null 2>&1; then
  echo "BLOCKED: no PostgreSQL at $SMITHERS_TEST_DATABASE_URL (database tests must run, not skip)" | tee -a "$log"; exit 1
fi

# 1. The gates scripts/commit.mjs requires before any push to main.
check migration-gate "go test -run 'TestMigrationGate|TestMigrationRegistry' ./packages/backend/db/product/"
[ -f scripts/check-sqlc-drift.sh ] && check sqlc-drift "bash scripts/check-sqlc-drift.sh"
check lane-gates "node --test scripts/lane-gates.test.mjs scripts/lane-prerequisites.test.mjs"
check tracked-hygiene "node scripts/check-tracked-hygiene.mjs"
# A here-string, not a pipe: a piped function runs in a subshell and its newreds would be lost.
[ $mode = gate ] && check_root_lint <<< "$changed"
if command -v smthrs >/dev/null; then check drift "smthrs lint //:driftCi //:targetIndex //:ci //scripts:trackedHygiene //scripts:conflictMarkers"
else echo "SKIP drift: smthrs unavailable on this host" >> "$log"; fi

# 2. Go: map each changed .go file to its nearest go.mod; build and vet each touched module and test its touched packages
#    and their transitive importers, bounded to the module. Baseline mode tests every module fully.
gomap=$(printf '%s\n' "$changed" | grep -E '\.go$' | while read f; do d=$(dirname "$f"); [ -d "$d" ] || continue
  m=$d; while [ "$m" != . ] && [ ! -f "$m/go.mod" ]; do m=$(dirname "$m"); done; [ -f "$m/go.mod" ] && echo "$m $d"; done | sort -u)
if [ $mode = baseline ]; then gomap=$(git ls-files '*go.mod' | xargs -r -n1 dirname | sort -u | sed 's/$/ ALL/'); fi
for mod in $(printf '%s\n' "$gomap" | awk 'NF{print $1}' | sort -u); do
  if [ $mode = baseline ]; then pkgs="./..."
  else pkgs=$(printf '%s\n' "$gomap" | awk -v m="$mod" '$1==m{print $2}' | while read d; do r=${d#"$mod"}; r=${r#/}; echo "./$r"; done | sed 's#^\./$#.#' | tr '\n' ' '); fi
  par=1
  if [ $mode = gate ]; then
    if [ "$mod" = . ] && printf '%s\n' "$changed" | grep -q '^packages/backend/.*\.go$'; then check_go_format packages/backend; fi
    # Other modules are checked in full; root-module files outside backend individually.
    if [ "$mod" != . ]; then check_go_format "$mod"
    else
      while IFS= read -r f; do
        [[ "$f" = packages/backend/* ]] && continue
        [ -f "$f" ] && check_go_format "$f"
      done < <(printf '%s\n' "$changed" | grep -E '\.go$')
    fi
    if selected=$(select_go_packages "$mod" "$pkgs"); then
      pkgs=$(printf '%s\n' "$selected" | tr '\n' ' ')
      count=$(printf '%s\n' "$selected" | awk 'NF{n++} END{print n+0}')
      # Overlap packages once a selection grows (internal/compose alone takes minutes).
      # Hosts tune it with LANE_GATES_GO_P; only a positive integer is honored.
      gop=${LANE_GATES_GO_P:-}; [[ "$gop" =~ ^[1-9][0-9]*$ ]] || gop=""
      if [ "$count" -gt 60 ]; then par=${gop:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)}
      elif [ "$count" -gt 5 ]; then par=${gop:-4}; fi
      echo "go-test parallelism: -p $par for $count packages" >> "$log"
    else
      echo "FAIL Go package selection:$mod" >> "$log"
      newreds+=("go-selection:$mod"); continue
    fi
  else par=4; fi
  check "go-build:$mod" "cd $mod && go build ./... && go vet $pkgs"
  check "go-test:$mod" "cd $mod && go test -p $par $pkgs"
done

# 3. TypeScript: the app, rpc, and any other touched package with its own test script.
if printf '%s\n' "$changed" | grep -q '^apps/app/'; then
  check app-typecheck "cd apps/app && pnpm typecheck"
  if [ $mode = baseline ]; then check app-tests "cd apps/app && bun test --isolate src"
  else files=$(printf '%s\n' "$changed" | grep -E '^apps/app/.*\.test\.tsx?$' | while read f; do [ -f "$f" ] && echo "${f#apps/app/}"; done | tr '\n' ' ')
    [ -n "$files" ] && check app-tests "cd apps/app && bun test --isolate $files"; fi
fi
# The production site mounts the app as an island with its own Vite config; build it whenever either changes
# (2026-10-06: #3559 added an app-only Vite plugin and every deploy failed at the site build).
if printf '%s\n' "$changed" | grep -qE '^apps/(app|site)/'; then check site-build "cd apps/site && pnpm build"; fi
for dir in $(printf '%s\n' "$changed" | grep -E '^(packages/[^/]+|flows)/' | sed -E 's#^(packages/[^/]+|flows)/.*#\1#' | sort -u); do
  [ "$dir" = packages/backend ] && continue
  [ -f "$dir/package.json" ] || continue
  if [ "$dir" = packages/rpc ]; then check rpc-tests "cd packages/rpc && pnpm exec vitest run"
  elif node -e "process.exit(require('./$dir/package.json').scripts?.test ? 0 : 1)" 2>/dev/null; then check "tests:$dir" "cd $dir && pnpm run test"; fi
done

# 4. The first journey when composition, services or the coding flows changed (needs the FFI library: Mac mini only).
if printf '%s\n' "$changed" | grep -qE '^(packages/backend/internal/(compose|services)/|flows/(coding|todo)/)'; then
  ffi=$HOME/lanes/f6-walk/ffi/libsmithers_ffi.dylib
  if [ -f "$ffi" ]; then check j1 "SMITHERS_FFI_LIBRARY_PATH=$ffi J1_REHEARSAL_CONTINUE=1 node packages/backend/run-journey-todo-label.mjs --j1"
  else echo "SKIP j1: no FFI library on this host; the mini's journey guard covers main" >> "$log"; fi
fi

if [ $mode = baseline ]; then
  sort -u "$allfails" > "$baseline"; echo "BASELINE $(wc -l < "$baseline") failing names at $(git rev-parse --short HEAD) -> $baseline" | tee -a "$log"; exit 0
fi
if [ ${#newreds[@]} -gt 0 ]; then
  { echo "BLOCKED: new failures compared with main:"; printf '  %s\n' "${newreds[@]}"; } | tee -a "$log"; exit 1
fi
echo "GATES PASS (log $log)" | tee -a "$log"
