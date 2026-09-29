#!/bin/sh
# Compile the public app API as a module outside this repository. A local
# replace points at this source checkout; there is no Plue or sibling checkout.
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
consumer_dir=$(mktemp -d)
trap 'rm -rf "$consumer_dir"' EXIT HUP INT TERM
cat > "$consumer_dir/go.mod" <<EOF
module example.net/smithers-public-consumer

go 1.26.8

require github.com/smithersai/smithers v0.0.0

replace github.com/smithersai/smithers => $repo_dir
EOF
cat > "$consumer_dir/main.go" <<'EOF'
package main

import (
    "context"
	"io"
	"net/http"
	"time"

    "github.com/smithersai/smithers/packages/backend/app"
    "github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/repository"
)

// A deployment outside the Smithers module must be able to implement the
// public storage port without importing packages/backend/internal/blob.
type externalStore struct{}
func (externalStore) SignedUploadURL(context.Context, string, string, int64, time.Duration) (string, error) { return "", nil }
func (externalStore) SignedDownloadURL(context.Context, string, time.Duration) (string, error) { return "", nil }
func (externalStore) Delete(context.Context, string) error { return nil }
func (externalStore) Exists(context.Context, string) (bool, error) { return false, nil }
func (externalStore) Stat(context.Context, string) (ports.ObjectAttrs, error) { return ports.ObjectAttrs{}, nil }
func (externalStore) NewReader(context.Context, string) (io.ReadCloser, error) { return nil, nil }
var _ ports.BlobStore = externalStore{}

func main() {
    var launch func(context.Context, app.Config) error = app.Run
	var migrate func(context.Context, string) error = app.Migrate
	var start func(context.Context, app.Config) (*app.Instance, error) = app.Start
	var handler func(*app.Instance) http.Handler = (*app.Instance).Handler
	var runtime ports.WorkspaceRuntime
	var repo *repository.Client
	_, _, _, _, _, _, _ = launch, migrate, start, handler, runtime, repo, externalStore{}
}
EOF
# Seed the checksums the root module already verified, so an offline runner
# never needs the checksum database.
cp "$repo_dir/go.sum" "$consumer_dir/go.sum"
cd "$consumer_dir"
GOWORK=off go mod tidy
GOWORK=off go build ./...
