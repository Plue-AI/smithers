package repohostserver

import (
	"bytes"
	"fmt"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// stagedImportPushBody builds a stateless receive-pack request creating ref at
// a fresh commit, with the pack that carries it.
func stagedImportPushBody(t *testing.T, ref string) []byte {
	t.Helper()
	dir := t.TempDir()
	run := func(stdin string, args ...string) []byte {
		cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.invalid"}, args...)...)
		cmd.Stdin = strings.NewReader(stdin)
		out, err := cmd.Output()
		require.NoError(t, err, "git %v", args)
		return out
	}
	run("", "init", "-q")
	run("", "commit", "-q", "--allow-empty", "-m", "seed")
	oid := strings.TrimSpace(string(run("", "rev-parse", "HEAD")))
	var body bytes.Buffer
	line := fmt.Sprintf("%s %s %s\x00report-status\n", laneZeroOID, oid, ref)
	fmt.Fprintf(&body, "%04x%s0000", len(line)+4, line)
	body.Write(run(oid+"\n", "pack-objects", "--revs", "--stdout", "-q"))
	return body.Bytes()
}

func TestStagedImportReceivePackRefusesReservedRefs(t *testing.T) {
	srv := newTestServerWithMock(t, provisionMock(t, true))
	token := strings.Repeat("e5", deleteStageTokenBytes)
	stageProvisionForTest(t, srv, stageProvisionRequest{
		Token: token, OperationType: provisionTypeImport, Owner: "alice", Repo: "mirror", DefaultBookmark: "main",
	}, http.StatusCreated)
	path := "/repos/provision-stages/" + token + "/git/git-receive-pack"
	headers := map[string]string{
		"Authorization": "Bearer " + repohost.StagedProvisionBearer(testAuthToken, token),
		"Content-Type":  "application/x-git-receive-pack-request",
	}
	gitDir := filepath.Join(srv.provisionStageDir(token), provisionRepositoryDir, ".jj", "repo", "store", "git")
	stagedRefs := func() map[string]string {
		refs, err := listGitRefs(t.Context(), gitDir)
		require.NoError(t, err)
		return refs
	}

	for _, ref := range []string{
		"refs/smithers/workspaces/11111111-1111-1111-1111-111111111111/head",
		"refs/smithers/workspaces/11111111-1111-1111-1111-111111111111/sources/deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		"refs/smithers/anything",
	} {
		rec := routerCovServeWithHeaders(t, srv.Handler(), http.MethodPost, path, bytes.NewReader(stagedImportPushBody(t, ref)), headers)
		routerCovRequireStatus(t, rec, http.StatusForbidden)
		assert.NotContains(t, stagedRefs(), ref)
	}

	rec := routerCovServeWithHeaders(t, srv.Handler(), http.MethodPost, path, strings.NewReader("ZZZZnot a command list"), headers)
	routerCovRequireStatus(t, rec, http.StatusBadRequest)

	rec = routerCovServeWithHeaders(t, srv.Handler(), http.MethodPost, path, bytes.NewReader(stagedImportPushBody(t, "refs/heads/main")), headers)
	routerCovRequireStatus(t, rec, http.StatusOK)
	assert.Contains(t, stagedRefs(), "refs/heads/main")
}

// Issue #2344: a staged import's pack past the global cap is a 413.
func TestStagedImportReceivePackPastTheGlobalCapIs413(t *testing.T) {
	srv := newTestServerWithMock(t, provisionMock(t, true))
	token := strings.Repeat("f6", deleteStageTokenBytes)
	stageProvisionForTest(t, srv, stageProvisionRequest{
		Token: token, OperationType: provisionTypeImport, Owner: "alice", Repo: "mirror", DefaultBookmark: "main",
	}, http.StatusCreated)
	srv.config.MaxGitRequestBytes = 16

	rec := routerCovServeWithHeaders(t, srv.Handler(), http.MethodPost, "/repos/provision-stages/"+token+"/git/git-receive-pack",
		bytes.NewReader(stagedImportPushBody(t, "refs/heads/main")), map[string]string{
			"Authorization": "Bearer " + repohost.StagedProvisionBearer(testAuthToken, token),
			"Content-Type":  "application/x-git-receive-pack-request",
		})
	routerCovRequireStatus(t, rec, http.StatusRequestEntityTooLarge)
	assert.Equal(t, "push_too_large", rec.Header().Get("X-Smithers-Error-Code"))
	refs, err := listGitRefs(t.Context(), filepath.Join(srv.provisionStageDir(token), provisionRepositoryDir, ".jj", "repo", "store", "git"))
	require.NoError(t, err)
	assert.NotContains(t, refs, "refs/heads/main")
}
