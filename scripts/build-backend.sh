#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  printf 'usage: sh scripts/build-backend.sh OUTPUT BUILD_SHA\n' >&2
  exit 2
fi

# The CLI reads this same manifest for `smthrs --version`.
version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' packages/smithers/package.json)
case "$version" in
  ''|*[!0-9A-Za-z.+-]*) printf 'invalid @smthrs/cli package version\n' >&2; exit 1 ;;
esac

go build -trimpath \
  -ldflags="-s -w -X github.com/smithersai/smithers/packages/backend/internal/compose.BuildSHA=$2 -X github.com/smithersai/smithers/packages/backend/internal/compose.BuildVersion=$version" \
  -o "$1" ./apps/backend
