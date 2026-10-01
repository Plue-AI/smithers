#!/bin/sh
# Runs vm-capacity.ts for each N and samples the host every 2 s while it runs.
#   BOOTS=8 HOLD=60 sh flows/issue-sweep/test/vm-capacity.sh <out-dir> [memoryMib] [cpus] [N...]
# Per N: <out-dir>/<N>.json (benchmark) and <out-dir>/<N>.samples.tsv
# (time, load1, memorystatus level %, compressor GiB, swap used MiB,
#  cumulative swapouts, msb process count, msb %cpu sum, msb RSS GiB).
set -eu
out=$1; mem=${2:-3072}; cpus=${3:-2}; shift 3 2>/dev/null || shift $#
[ $# -gt 0 ] || set -- 8 16 32 48 64
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out"
sample() {
  page=$(sysctl -n hw.pagesize)
  while :; do
    load=$(sysctl -n vm.loadavg | awk '{print $2}')
    level=$(sysctl -n kern.memorystatus_level)
    comp=$(vm_stat | awk -v p="$page" '/occupied by compressor/ {gsub("\\.","",$5); printf "%.1f", $5*p/1073741824}')
    swapouts=$(vm_stat | awk '/Swapouts/ {gsub("\\.","",$2); print $2}')
    swap=$(sysctl -n vm.swapusage | awk '{gsub("M","",$6); print $6}')
    msb=$(ps -A -o %cpu=,rss=,comm= | awk '/bin\/msb$/ {n++; c+=$1; r+=$2} END {printf "%d\t%.0f\t%.1f", n, c, r/1048576}')
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date +%s)" "$load" "$level" "$comp" "$swap" "$swapouts" "$msb"
    sleep 2
  done
}
for n in "$@"; do
  sample > "$out/$n.samples.tsv" &
  sampler=$!
  node "$here/vm-capacity.ts" "$n" "$mem" "$cpus" "${BOOTS:-8}" > "$out/$n.json" 2> "$out/$n.err" || true
  kill $sampler
  cat "$out/$n.json"
  sleep 20
done
