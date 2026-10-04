package repohostserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func deleteWorkspaceRefsRequest(t *testing.T, f *laneHTTPFixture, repoID, workspaceID string) (int, repohost.DeletedWorkspaceRefs) {
	t.Helper()
	req := httptest.NewRequest(http.MethodDelete, "/repos/"+repoID+"/workspace-refs/"+workspaceID, nil)
	req.Header.Set("Authorization", validAuth())
	rec := httptest.NewRecorder()
	f.srv.Handler().ServeHTTP(rec, req)
	var result repohost.DeletedWorkspaceRefs
	if rec.Code == http.StatusOK {
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
	}
	return rec.Code, result
}

// #1990: a deleted workspace's head and retained sources are deleted; other
// workspaces' refs and user refs stay.
func TestDeleteWorkspaceRefsRemovesOnlyThatWorkspacesRefs(t *testing.T) {
	const other = "33333333-3333-3333-3333-333333333333"
	f := newLaneHTTPFixture(t, nil)
	tip := f.commit("local work", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "work.txt"), []byte("work\n"), 0o644))
	})
	rec := pushAs(t, f, "42", f.userRefPush(laneZeroOID, tip, repohost.UserRef(42, "head")))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	for _, workspace := range []string{userRefWorkspace, other} {
		rec = userRefRequest(t, f, http.MethodPost, "42/retain", repohost.RetainUserRefRequest{Name: "head", WorkspaceID: workspace})
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		out, err := exec.Command("git", "--git-dir", f.repo.gitDir, "update-ref", repohost.BranchHeadRef(workspace), tip).CombinedOutput()
		require.NoError(t, err, string(out))
	}

	code, result := deleteWorkspaceRefsRequest(t, f, "alice:demo", userRefWorkspace)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, []string{repohost.BranchHeadRef(userRefWorkspace), repohost.WorkspaceSourceRef(userRefWorkspace, tip)}, result.Refs)
	refs := f.repo.refs()
	for ref := range refs {
		assert.NotContains(t, ref, userRefWorkspace)
	}
	assert.Equal(t, tip, refs[repohost.BranchHeadRef(other)])
	assert.Equal(t, tip, refs[repohost.WorkspaceSourceRef(other, tip)])
	assert.Equal(t, tip, refs[repohost.UserRef(42, "head")])

	// Idempotent, and a repository that is gone has nothing left to delete.
	code, result = deleteWorkspaceRefsRequest(t, f, "alice:demo", userRefWorkspace)
	require.Equal(t, http.StatusOK, code)
	assert.Empty(t, result.Refs)
	code, result = deleteWorkspaceRefsRequest(t, f, "alice:gone", userRefWorkspace)
	require.Equal(t, http.StatusOK, code)
	assert.Empty(t, result.Refs)

	for _, bad := range []string{"not-a-uuid", "00000000-0000-0000-0000-000000000000", "33333333-3333-3333-3333-33333333333A"} {
		code, _ = deleteWorkspaceRefsRequest(t, f, "alice:demo", bad)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
	assert.Equal(t, tip, f.repo.refs()[repohost.BranchHeadRef(other)])
}
