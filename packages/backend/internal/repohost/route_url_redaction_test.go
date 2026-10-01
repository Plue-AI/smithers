package repohost

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// routeCapability stands for the capability a storage route URL carries in
// its path (smithersai/plue#786).
const routeCapability = "c4p4b1l1ty5ecret"

const capabilityRouteURL = "http://router.test/route/set/1/node/storage-set/" + routeCapability

// smithersai/plue#786: a failed request's error names its URL, and a route
// URL's path carries a capability. No client error may carry it.
func TestFailedRequestsNeverNameTheRouteCapability(t *testing.T) {
	client := NewClient(&StaticStorageSetResolver{URL: capabilityRouteURL}, "secret")
	client.httpClient.Transport = timeoutRoundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("connection refused")
	})
	ctx := context.Background()
	staged := StagedProvision{StorageSetID: "local", Token: "stage-token", OperationType: provisionOperationFork, Owner: "bob", Repo: "copy"}

	for name, call := range map[string]func() error{
		"health":       func() error { return client.Health(ctx, capabilityRouteURL) },
		"delete":       func() error { return client.DeleteRepo(ctx, "alice", "demo") },
		"wiki":         func() error { return client.InitWikiRepo(ctx, "alice", "demo") },
		"docs":         func() error { return client.InitDocsRepo(ctx, "alice", "demo") },
		"import refs":  func() error { return client.ImportRefs(ctx, "alice", "demo") },
		"json":         func() error { return client.ExecuteStagedProvision(ctx, staged) },
		"json, by ctx": func() error { _, err := client.GitSize(ctx, "alice", "demo"); return err },
		"paginated": func() error {
			_, _, err := client.ListBookmarks(ctx, "alice", "demo", "", 10)
			return err
		},
		"info/refs": func() error {
			_, err := client.InfoRefs(ctx, "alice", "demo", "git-upload-pack", io.Discard)
			return err
		},
		"receive-pack": func() error {
			return client.ProxyReceivePack(ctx, "alice", "demo", bytes.NewReader(nil), io.Discard)
		},
	} {
		t.Run(name, func(t *testing.T) {
			err := call()

			require.Error(t, err)
			assert.NotContains(t, err.Error(), routeCapability)
			assert.Contains(t, err.Error(), "http://router.test", "the error still names the host it could not reach")
			assert.Contains(t, err.Error(), "connection refused")
		})
	}
}

// A route URL that does not parse fails before it is sent, and its error
// keeps none of it.
func TestUnparsableRouteURLsNeverNameTheRouteCapability(t *testing.T) {
	client := NewClient(&StaticStorageSetResolver{URL: capabilityRouteURL + "%zz"}, "secret")
	ctx := context.Background()

	for name, call := range map[string]func() error{
		"request": func() error { return client.DeleteRepo(ctx, "alice", "demo") },
		"paginated": func() error {
			_, _, err := client.ListBookmarks(ctx, "alice", "demo", "", 10)
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			err := call()

			require.Error(t, err)
			assert.NotContains(t, err.Error(), routeCapability)
			assert.False(t, strings.Contains(err.Error(), "router.test/route"), err.Error())
		})
	}
}
