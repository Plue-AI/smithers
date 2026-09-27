package compose

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// A person's current request-changes review blocks landing for everyone,
// the landing's author and its runs included, until the same person later
// approves or comments, or someone allowed to dismiss it does. An agent's
// request-changes review (a run credential's) blocks no one.
func TestChangesRequestedBlocksLandingPostgres(t *testing.T) {
	commits := map[string]string{
		"agentnoteaaaaaaa": "1111111111111111111111111111111111111111",
		"approvedbbbbbbbb": "2222222222222222222222222222222222222222",
		"commentedccccccc": "3333333333333333333333333333333333333333",
		"dismissedddddddd": "4444444444444444444444444444444444444444",
	}
	f := newLandingGateFixture(t, commits)
	write := string(middleware.ScopeWriteRepository)
	author := f.token(f.owner, "cr-author", write, false)
	authorRun := f.token(f.owner, "cr-author-run", write, true)
	reviewer := f.token(f.other, "cr-reviewer", write, false)
	reviewerRun := f.token(f.other, "cr-reviewer-run", write, true)

	path := func(changeID string) (string, string) {
		landing := f.landing(changeID, f.owner.ID, changeID)
		return fmt.Sprintf("/landings/%d", landing.Number), commits[changeID]
	}
	review := func(bearer, landing, kind, commit string) int64 {
		t.Helper()
		rec := f.serve(bearer, http.MethodPost, landing+"/reviews", fmt.Sprintf(`{"type":%q,"body":"see line 3","commit_id":%q}`, kind, commit))
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
		return f.idOf(rec)
	}
	land := func(bearer, landing, commit string) (int, string) {
		rec := f.serve(bearer, http.MethodPut, landing+"/land", fmt.Sprintf(`{"commit_id":%q}`, commit))
		return rec.Code, rec.Body.String()
	}
	const blocked = "changes requested by gate-other"

	// An agent's request-changes review does not block a person's landing.
	landing, commit := path("agentnoteaaaaaaa")
	review(reviewerRun, landing, "request_changes", commit)
	code, body := land(author, landing, commit)
	assert.Equal(t, http.StatusAccepted, code, body)

	// A person's does, for the author and the author's run, and the landing
	// states it; the reviewer's run commenting does not supersede it. The
	// reviewer's later approval does.
	landing, commit = path("approvedbbbbbbbb")
	review(reviewer, landing, "request_changes", commit)
	for _, bearer := range []string{author, authorRun} {
		code, body = land(bearer, landing, commit)
		assert.Equal(t, http.StatusUnprocessableEntity, code, body)
		assert.Contains(t, body, blocked)
	}
	rec := f.serve(author, http.MethodGet, landing, ``)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `{"kind":"review","name":"gate-other","missing":"changes_requested"}`)
	review(reviewerRun, landing, "comment", commit)
	code, body = land(author, landing, commit)
	assert.Equal(t, http.StatusUnprocessableEntity, code, body)
	review(reviewer, landing, "approve", commit)
	code, body = land(author, landing, commit)
	assert.Equal(t, http.StatusAccepted, code, body)

	// The reviewer's later comment supersedes it too.
	landing, commit = path("commentedccccccc")
	review(reviewer, landing, "request_changes", commit)
	code, body = land(author, landing, commit)
	require.Equal(t, http.StatusUnprocessableEntity, code, body)
	review(reviewer, landing, "comment", commit)
	code, body = land(author, landing, commit)
	assert.Equal(t, http.StatusAccepted, code, body)

	// A person may dismiss it; a run credential may not.
	landing, commit = path("dismissedddddddd")
	id := review(reviewer, landing, "request_changes", commit)
	dismiss := fmt.Sprintf("%s/reviews/%d", landing, id)
	rec = f.serve(authorRun, http.MethodPatch, dismiss, `{"message":"done"}`)
	assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	code, body = land(author, landing, commit)
	require.Equal(t, http.StatusUnprocessableEntity, code, body)
	rec = f.serve(author, http.MethodPatch, dismiss, `{"message":"done"}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	code, body = land(author, landing, commit)
	assert.Equal(t, http.StatusAccepted, code, body)
}
