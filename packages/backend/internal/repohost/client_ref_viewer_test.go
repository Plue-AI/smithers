package repohost

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

// Git reads carry the ref viewer as the pusher id repo-host reads; a read
// without one carries none, so repo-host shows it no user ref.
func TestClientGitReadsCarryTheRefViewer(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen[r.URL.Path] = r.Header.Get("X-Smithers-Pusher-Id")
		mu.Unlock()
	}))
	defer server.Close()
	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")

	viewer := WithRefViewer(context.Background(), 42)
	_, err := client.InfoRefs(viewer, "alice", "demo", "git-upload-pack", io.Discard)
	require.NoError(t, err)
	require.NoError(t, client.ProxyUploadPack(viewer, "alice", "demo", bytes.NewReader(nil), io.Discard))
	require.Equal(t, map[string]string{"/repos/alice/demo/git/info-refs": "42", "/repos/alice/demo/git/upload-pack": "42"}, seen)

	_, err = client.InfoRefs(context.Background(), "alice", "demo", "git-upload-pack", io.Discard)
	require.NoError(t, err)
	require.NoError(t, client.ProxyUploadPackBody(context.Background(), "alice", "demo", bytes.NewReader(nil), io.Discard))
	require.Equal(t, map[string]string{"/repos/alice/demo/git/info-refs": "", "/repos/alice/demo/git/upload-pack": ""}, seen)
}
