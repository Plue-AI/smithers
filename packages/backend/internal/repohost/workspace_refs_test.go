package repohost

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClientDeleteWorkspaceRefs(t *testing.T) {
	t.Parallel()
	const workspaceID = "22222222-2222-2222-2222-222222222222"
	var method, path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.EscapedPath()
		_, _ = w.Write([]byte(`{"refs":["` + WorkspaceHeadRef(workspaceID) + `"]}`))
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	result, err := client.DeleteWorkspaceRefs(context.Background(), "alice", "demo", workspaceID)
	require.NoError(t, err)
	assert.Equal(t, http.MethodDelete, method)
	assert.Equal(t, "/repos/alice:demo/workspace-refs/"+workspaceID, path)
	assert.Equal(t, []string{WorkspaceHeadRef(workspaceID)}, result.Refs)

	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusBadGateway) }))
	t.Cleanup(down.Close)
	_, err = NewClient(&StaticStorageSetResolver{URL: down.URL}, "test-token").DeleteWorkspaceRefs(context.Background(), "alice", "demo", workspaceID)
	require.ErrorContains(t, err, "502")
}
