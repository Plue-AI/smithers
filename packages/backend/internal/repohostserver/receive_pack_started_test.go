package repohostserver

import (
	"bytes"
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/stretchr/testify/require"
)

// repo-host tells a push that asks when it holds the repository's lock for
// it, and the push then completes.
func TestReceivePackReportsWhenThePushStarts(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	server := httptest.NewServer(f.srv.Handler())
	t.Cleanup(server.Close)
	tip := f.commit("started", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "s.txt"), []byte("s\n"), 0o644))
	})
	client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, testAuthToken)
	started := false
	var out bytes.Buffer
	ctx := repohost.WithPushStarted(context.Background(), func() { started = true })
	err := client.ProxyReceivePack(ctx, "alice", "demo", bytes.NewReader(f.pushBody(f.base, tip, "refs/heads/main")), &out)
	require.NoError(t, err)
	require.True(t, started)
	require.Equal(t, tip, f.repo.refs()["refs/heads/main"])
}
