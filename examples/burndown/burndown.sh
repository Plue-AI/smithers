#!/bin/sh
set -eu
fail() { printf '%s\n' "$1" >&2; exit 1; }
[ "$#" -gt 0 ] || fail 'Usage: burndown.sh INPUT_FILE [TICKS [INTERVAL_SECONDS]] [-- COMMAND args...]'
input=$1
shift
ticks=1
interval=60
if [ "$#" -gt 0 ] && [ "$1" != -- ]; then ticks=$1; shift; fi
if [ "$#" -gt 0 ] && [ "$1" != -- ]; then interval=$1; shift; fi
case $ticks in ''|*[!0-9]*) fail 'TICKS must be a positive integer';; esac
case $interval in ''|*[!0-9]*) fail 'INTERVAL_SECONDS must be a nonnegative integer';; esac
# Bound arithmetic to portable signed 32-bit shell integers.
[ "${#ticks}" -le 9 ] && [ "$ticks" -gt 0 ] || fail 'TICKS must be between 1 and 999999999'
[ "${#interval}" -le 9 ] || fail 'INTERVAL_SECONDS must be at most 999999999'
if [ "$#" -gt 0 ]; then
  [ "$1" = -- ] || fail 'Expected -- before COMMAND'
  shift
  [ "$#" -gt 0 ] || fail 'Missing COMMAND after --'
fi
script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
tick=0
while [ "$tick" -lt "$ticks" ]; do
  result=$(node "$script_dir/pacer.mjs" < "$input")
  printf '%s\n' "$result"
  concurrency=$(printf '%s\n' "$result" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>console.log(JSON.parse(s).concurrency))')
  if [ "$#" -gt 0 ] && [ "$concurrency" != 0 ]; then
    BURNDOWN_CONCURRENCY=$concurrency "$@" >&2
  fi
  tick=$((tick + 1))
  if [ "$tick" -lt "$ticks" ]; then sleep "$interval"; fi
done
