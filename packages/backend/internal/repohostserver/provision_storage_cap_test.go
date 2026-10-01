package repohostserver

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// smithersai/plue#768: staged imports and forks add to their owner's storage,
// so they are capped by the allowance pushes are (smithersai/plue#593). Only
// jj's FFI is mocked; packs, copies and measurements are real git.

// stagedImportCap is a staged import of alice/mirror fed from the lane
// fixture's client clone.
type stagedImportCap struct {
	*laneHTTPFixture
	token  string
	gitDir string
}

func newStagedImportCap(t *testing.T) *stagedImportCap {
	t.Helper()
	f := newLaneHTTPFixture(t, nil)
	f.srv.ffi.(*mockFFI).initRepoFn = provisionMock(t, true).initRepoFn
	token := strings.Repeat("6c", deleteStageTokenBytes)
	stageProvisionForTest(t, f.srv, stageProvisionRequest{
		Token: token, OperationType: provisionTypeImport, Owner: "alice", Repo: "mirror", DefaultBookmark: "main",
	}, http.StatusCreated)
	return &stagedImportCap{laneHTTPFixture: f, token: token,
		gitDir: repoGitDir(filepath.Join(f.srv.provisionStageDir(token), provisionRepositoryDir))}
}

// body builds a receive-pack request setting ref from oldOID to newOID, with
// a pack of what newOID reaches and have, which the import already holds,
// does not.
func (f *stagedImportCap) body(oldOID, newOID, ref, have string) []byte {
	f.t.Helper()
	line := fmt.Sprintf("%s %s %s\x00report-status\n", oldOID, newOID, ref)
	revs := newOID + "\n"
	if have != laneZeroOID {
		revs += "^" + have + "\n"
	}
	cmd := exec.Command("git", "-C", f.clientDir, "pack-objects", "--revs", "--stdout", "-q")
	cmd.Stdin = strings.NewReader(revs)
	pack, err := cmd.Output()
	require.NoError(f.t, err)
	return append([]byte(fmt.Sprintf("%04x%s0000", len(line)+4, line)), pack...)
}

// push posts body to the staged import; an empty allowance sends none.
func (f *stagedImportCap) push(body []byte, allowance string) *httptest.ResponseRecorder {
	f.t.Helper()
	headers := map[string]string{
		"Authorization": "Bearer " + repohost.StagedProvisionBearer(testAuthToken, f.token),
		"Content-Type":  "application/x-git-receive-pack-request",
	}
	if allowance != "" {
		headers[repohost.GitBytesAllowanceHeader] = allowance
	}
	return routerCovServeWithHeaders(f.t, f.srv.Handler(), http.MethodPost,
		"/repos/provision-stages/"+f.token+"/git/git-receive-pack", bytes.NewReader(body), headers)
}

// allowance leaves room bytes for a push to the staged import.
func (f *stagedImportCap) allowance(room int64) string {
	f.t.Helper()
	gitBytes, err := measureGitBytes(f.t.Context(), f.gitDir)
	require.NoError(f.t, err)
	return strconv.FormatInt(gitBytes+room, 10)
}

func (f *stagedImportCap) refs() map[string]string {
	f.t.Helper()
	refs, err := listGitRefs(f.t.Context(), f.gitDir)
	require.NoError(f.t, err)
	return refs
}

func TestStagedImportPastRemainingStorageIsRefusedLikeAPush(t *testing.T) {
	f := newStagedImportCap(t)
	tip := f.largeCommit("import", 256<<10)
	pushed := postReceivePack(t, f.laneHTTPFixture, f.pushBody(f.base, tip, "refs/heads/main"),
		repohost.GitBytesAllowanceHeader, f.laneHTTPFixture.allowance(64<<10))
	require.Equal(t, http.StatusRequestEntityTooLarge, pushed.Code, pushed.Body.String())

	imported := f.push(f.body(laneZeroOID, tip, "refs/heads/main", laneZeroOID), f.allowance(64<<10))

	assert.Equal(t, pushed.Code, imported.Code, imported.Body.String())
	assert.Equal(t, repohost.StorageLimitCode, imported.Header().Get("X-Smithers-Error-Code"))
	assert.Equal(t, pushed.Body.String(), imported.Body.String())
	assert.NotContains(t, f.refs(), "refs/heads/main")
	assert.Empty(t, f.importedRefs(), "a refused import never reaches jj")
	gitBytes, err := measureGitBytes(t.Context(), f.gitDir)
	require.NoError(t, err)
	assert.Less(t, gitBytes, int64(256<<10), "git kept none of the refused pack")
}

// An owner at the limit may only point refs at objects the import has.
func TestStagedImportAtTheStorageLimitOnlyMovesRefs(t *testing.T) {
	f := newStagedImportCap(t)
	rec := f.push(f.body(laneZeroOID, f.base, "refs/heads/main", laneZeroOID), "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	atLimit := f.allowance(0)
	tip := f.largeCommit("over", 1<<10)

	rec = f.push(f.body(f.base, tip, "refs/heads/main", f.base), atLimit)
	assert.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, rec.Body.String())
	assert.Equal(t, repohost.StorageLimitCode, rec.Header().Get("X-Smithers-Error-Code"))
	assert.Equal(t, f.base, f.refs()["refs/heads/main"])

	rec = f.push(f.body(laneZeroOID, f.base, "refs/heads/copy", f.base), atLimit)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, f.base, f.refs()["refs/heads/copy"])
}

func TestStagedImportWithinRemainingStorageLands(t *testing.T) {
	f := newStagedImportCap(t)
	tip := f.largeCommit("fits", 256<<10)

	rec := f.push(f.body(laneZeroOID, tip, "refs/heads/main", laneZeroOID), f.allowance(8<<20))

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), "unpack ok")
	assert.Equal(t, tip, f.refs()["refs/heads/main"])
	imports := f.importedRefs()
	require.Len(t, imports, 1)
	assert.Equal(t, tip, imports[0]["refs/heads/main"])
}

func TestStagedImportWithMalformedAllowanceIsRefused(t *testing.T) {
	f := newStagedImportCap(t)
	for _, allowance := range []string{"-1", "lots", "9223372036854775808"} {
		rec := f.push(f.body(laneZeroOID, f.base, "refs/heads/main", laneZeroOID), allowance)
		assert.Equal(t, http.StatusBadRequest, rec.Code, "%s: %s", allowance, rec.Body.String())
	}
	assert.NotContains(t, f.refs(), "refs/heads/main")
	assert.Empty(t, f.importedRefs())
}

// stageForkWithAllowance stages a fork of alice/demo to bob/repo; an empty
// allowance sends none.
func stageForkWithAllowance(t *testing.T, f *laneHTTPFixture, token, repo, allowance string) *httptest.ResponseRecorder {
	t.Helper()
	headers := map[string]string{}
	if allowance != "" {
		headers[repohost.GitBytesAllowanceHeader] = allowance
	}
	return routerCovServeWithHeaders(t, f.srv.Handler(), http.MethodPost, "/repos/provision-stages",
		routerCovJSONBody(t, stageProvisionRequest{
			Token: token, OperationType: provisionTypeFork, Owner: "bob", Repo: repo, SrcOwner: "alice", SrcRepo: "demo",
		}), headers)
}

// A fork copies every source object to the destination owner, so the source's
// git bytes must fit the owner's allowance before anything is copied.
func TestStagedForkStorageAllowance(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	tip := f.largeCommit("source", 256<<10)
	rec := postReceivePack(t, f, f.pushBody(f.base, tip, "refs/heads/main"))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	sourceBytes := f.gitSize().GitBytes
	fits := strconv.FormatInt(sourceBytes, 10)

	for i, tc := range []struct {
		name, allowance string
		status          int
	}{
		{"owner at the limit", "0", http.StatusRequestEntityTooLarge},
		{"one byte short", strconv.FormatInt(sourceBytes-1, 10), http.StatusRequestEntityTooLarge},
		{"malformed", "lots", http.StatusBadRequest},
		{"exactly fits", fits, http.StatusCreated},
		{"unlimited", "", http.StatusCreated},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token := strings.Repeat(fmt.Sprintf("%02x", 0xd0+i), deleteStageTokenBytes)
			repo := fmt.Sprintf("fork-%d", i)
			stagedGitDir := repoGitDir(filepath.Join(f.srv.provisionStageDir(token), provisionRepositoryDir))

			rec := stageForkWithAllowance(t, f, token, repo, tc.allowance)

			require.Equal(t, tc.status, rec.Code, rec.Body.String())
			assertExists(t, f.srv.config.RepoPath("bob", repo), false)
			if tc.status != http.StatusCreated {
				assertExists(t, stagedGitDir, false)
				if tc.status == http.StatusRequestEntityTooLarge {
					assert.Equal(t, repohost.StorageLimitCode, rec.Header().Get("X-Smithers-Error-Code"))
					assert.Contains(t, rec.Body.String(), "this fork would exceed the storage limit for the current plan")
				}
				// The refusal leaves the stage reserved: the same token
				// succeeds once the owner has room.
				rec = stageForkWithAllowance(t, f, token, repo, fits)
				require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
			}
			copied, err := measureGitBytes(t.Context(), stagedGitDir)
			require.NoError(t, err)
			assert.Equal(t, sourceBytes, copied, "the copy occupies what the source measured")
		})
	}
	assert.Equal(t, sourceBytes, f.gitSize().GitBytes, "forking never changes its source")
}
