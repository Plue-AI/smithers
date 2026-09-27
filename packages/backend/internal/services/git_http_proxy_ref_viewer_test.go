package services

import (
	"bytes"
	"context"
	"io"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// #2253: a git read shows a person their own refs/smithers/users/<id>/ refs
// and no other user's; a workspace credential and an anonymous reader see no
// user ref. Repo-host hides the rest from the viewer the API names.
func TestGitHTTPProxyService_ReadsNameTheRefViewer(t *testing.T) {
	for _, tc := range []struct {
		name   string
		token  string
		scopes string
		viewer int64
	}{
		{"person", "smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "read:repository", 10},
		{"workspace credential", "smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
			"read:repository," + middleware.WorkspaceRestrictionScope("0b7e3c9e-4d2f-4a51-9c8e-1f2a3b4c5d6e"), 0},
		{"anonymous", "", "", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &mockGitHTTPProxyQuerier{
				getAuthInfoByTokenHashFn: func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
					return db.GetAuthInfoByTokenHashRow{ID: 10, Username: "alice", TokenID: 900, TokenScopes: tc.scopes}, nil
				},
			}
			viewers := []int64{}
			repoHost := &mockGitHTTPRepoHostClient{
				infoRefsFn: func(ctx context.Context, _, _, _ string, _ io.Writer) (string, error) {
					viewers = append(viewers, repohost.RefViewer(ctx))
					return "", nil
				},
				proxyUploadFn: func(ctx context.Context, _, _ string, _ io.Reader, _ io.Writer) error {
					viewers = append(viewers, repohost.RefViewer(ctx))
					return nil
				},
			}
			svc := NewGitHTTPProxyService(q, &mockGitHTTPAuthorizer{}, repoHost)
			_, err := svc.ProxyInfoRefs(context.Background(), "alice", "demo", "git-upload-pack", tc.token, io.Discard)
			require.NoError(t, err)
			require.NoError(t, svc.ProxyUploadPack(context.Background(), "alice", "demo", tc.token, bytes.NewBufferString("want"), io.Discard))
			require.Equal(t, []int64{tc.viewer, tc.viewer}, viewers)
		})
	}
}
