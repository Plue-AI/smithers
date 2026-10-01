package repohostserver

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// forkWithAllowance forks alice/demo to bob/repo through the direct fork
// route; an empty allowance sends none.
func forkWithAllowance(t *testing.T, f *laneHTTPFixture, repo, allowance string) *httptest.ResponseRecorder {
	t.Helper()
	headers := map[string]string{}
	if allowance != "" {
		headers[repohost.GitBytesAllowanceHeader] = allowance
	}
	return routerCovServeWithHeaders(t, f.srv.Handler(), http.MethodPost, "/repos/fork",
		routerCovJSONBody(t, forkRepoRequest{SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: repo}), headers)
}

// smithersai/plue#768: the direct fork route admits a copy as the staged
// fork does (TestStagedForkStorageAllowance): the source's git bytes must fit
// the destination owner's allowance before anything is copied.
func TestForkStorageAllowance(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	tip := f.largeCommit("source", 256<<10)
	rec := postReceivePack(t, f, f.pushBody(f.base, tip, "refs/heads/main"))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	sourceBytes := f.gitSize().GitBytes

	for i, tc := range []struct {
		name, allowance string
		status          int
	}{
		{"owner at the limit", "0", http.StatusRequestEntityTooLarge},
		{"one byte short", strconv.FormatInt(sourceBytes-1, 10), http.StatusRequestEntityTooLarge},
		{"negative", "-1", http.StatusBadRequest},
		{"malformed", "lots", http.StatusBadRequest},
		{"exactly fits", strconv.FormatInt(sourceBytes, 10), http.StatusCreated},
		{"unlimited", "", http.StatusCreated},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := fmt.Sprintf("fork-%d", i)

			rec := forkWithAllowance(t, f, repo, tc.allowance)

			require.Equal(t, tc.status, rec.Code, rec.Body.String())
			if tc.status != http.StatusCreated {
				assertExists(t, f.srv.config.RepoPath("bob", repo), false)
				if tc.status == http.StatusRequestEntityTooLarge {
					assert.Equal(t, repohost.StorageLimitCode, rec.Header().Get("X-Smithers-Error-Code"))
					assert.Contains(t, rec.Body.String(), "this fork would exceed the storage limit for the current plan")
				}
				return
			}
			measured := routerCovServe(t, f.srv.Handler(), http.MethodGet, "/repos/bob/"+repo+"/git/size", nil)
			require.Equal(t, http.StatusOK, measured.Code, measured.Body.String())
			var copied repohost.GitSize
			require.NoError(t, json.Unmarshal(measured.Body.Bytes(), &copied))
			assert.Equal(t, sourceBytes, copied.GitBytes, "the copy occupies what the source measured")
		})
	}
	assert.Equal(t, sourceBytes, f.gitSize().GitBytes, "forking never changes its source")
}
