#!/bin/sh
set -eu

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  printf 'usage: sh scripts/build-backend.sh OUTPUT BUILD_SHA [preview]\n' >&2
  exit 2
fi

if [ "$#" -eq 3 ]; then
case "$3" in
  preview) set -- "$1" "$2" -tags smithers_preview ;;
  *) printf 'unknown backend build mode: %s\n' "$3" >&2; exit 2 ;;
esac
fi
output=$1
build_sha=$2
shift 2

# The CLI reads this same manifest for `smthrs --version`.
version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' packages/smithers/package.json)
case "$version" in
  ''|*[!0-9A-Za-z.+-]*) printf 'invalid @smthrs/cli package version\n' >&2; exit 1 ;;
esac

go build -trimpath "$@" \
  -ldflags="-s -w -X github.com/smithersai/smithers/packages/backend/internal/compose.BuildSHA=$build_sha -X github.com/smithersai/smithers/packages/backend/internal/compose.BuildVersion=$version" \
  -o "$output" ./apps/backend
