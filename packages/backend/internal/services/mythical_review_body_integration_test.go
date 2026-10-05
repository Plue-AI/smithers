package services

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
)

// pull reads the pull request as GitHub serves it now.
func (f *publicationFixture) pull(number int64) githubfake.Pull {
	f.t.Helper()
	token, err := f.connections.CreateGitHubInstallationTokenForRepositoryOwner(context.Background(), f.userID, 0, "rehearsal-owner", "app", map[string]string{"pull_requests": "read"})
	require.NoError(f.t, err)
	request, err := http.NewRequest(http.MethodGet, f.fake.URL+"/repos/rehearsal-owner/app/pulls/"+strconv.FormatInt(number, 10), nil)
	require.NoError(f.t, err)
	request.Header.Set("Authorization", "Bearer "+token.Token)
	response, err := f.fake.Client().Do(request)
	require.NoError(f.t, err)
	defer response.Body.Close()
	var pull githubfake.Pull
	require.NoError(f.t, json.NewDecoder(response.Body).Decode(&pull))
	return pull
}

// bodyWrites lists the App's pull request updates as "path status", in order.
func (f *publicationFixture) bodyWrites() []string {
	var out []string
	for _, write := range f.fake.Writes() {
		if write.Method == http.MethodPatch && strings.HasPrefix(write.Path, "/repos/rehearsal-owner/app/pulls/") {
			out = append(out, write.Path+" "+strconv.Itoa(write.Status))
		}
	}
	return out
}

// reviewed records a finished review of TODO n's pull request head, as
// ProjectFlowRuntime projects the review/change run's verdict.
func (f *publicationFixture) reviewed(number int64, verdict string) db.MythicalItem {
	f.t.Helper()
	item := f.item(number)
	checks := mythicalChecksOf(item)
	checks.Review = &mythicalReview{Head: item.PRHead, Candidate: item.CandidateHead, RunID: "run-review", Verdict: verdict}
	item.Checks = checks.encode()
	saved, err := db.New(f.pool).SaveMythicalItem(context.Background(), item)
	require.NoError(f.t, err)
	return saved
}

// fmtJSON is v as JSON text.
func fmtJSON(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	require.NoError(t, err)
	return string(raw)
}

// inReview publishes a TODO and answers it in review with its opened body.
func (f *publicationFixture) inReview() (db.MythicalItem, githubfake.Pull) {
	f.t.Helper()
	todo := f.todo("Add a greeting to JOURNEY.md", "Say hello", f.main, "JOURNEY.md", "Hello from T1\n")
	f.wake()
	item := f.item(todo.Number.Int64)
	require.Equal(f.t, "proposed", item.State, item.Reason)
	return item, f.pull(item.PRNumber.Int64)
}

// The review's verdict reaches the pull request body through the "body"
// outbound operation: one PATCH after a lookup, settled by another lookup in
// the same pass, and never repeated.
func TestTodoPublicationPutsTheReviewOnThePullRequestBody(t *testing.T) {
	for verdict, shown := range map[string]string{"approve": "Approved", "request-changes": "Changes requested"} {
		t.Run(verdict, func(t *testing.T) {
			f := newPublicationFixture(t, false)
			item, opened := f.inReview()
			assert.NotContains(t, opened.Body, "Review:", "the review runs after the pull request opens")
			assert.Equal(t, mythicalBodyDigest(opened.Body), mythicalChecksOf(item).PRBody, "Smithers records the body it opened with")

			f.reviewed(item.Number.Int64, verdict)
			f.wake()
			item = f.item(item.Number.Int64)
			assert.Empty(t, item.PendingOp, "the operation settles in the pass that sends it")
			updated := f.pull(item.PRNumber.Int64)
			assert.Contains(t, updated.Body, "\n\nReview: "+shown+"\n\n", "the body carries the card's review line")
			assert.True(t, strings.HasPrefix(updated.Body, "Say hello\n\nAcceptance:\n- JOURNEY.md greets"), "the prompt still leads the body")
			assert.Equal(t, []string{"/repos/rehearsal-owner/app/pulls/" + strconv.FormatInt(item.PRNumber.Int64, 10) + " 200"}, f.bodyWrites())
			checks := mythicalChecksOf(item)
			require.NotNil(t, checks.Review)
			assert.True(t, checks.Review.Posted)
			assert.Equal(t, mythicalBodyDigest(updated.Body), checks.PRBody, "the written body is the one Smithers last wrote")
			card := f.card(item.Number.Int64)
			assert.Equal(t, "in_review", card["state"])
			assert.Contains(t, fmtJSON(t, card["evidence"]), `{"kind":"review","summary":"`+shown+`"}`, "the card shows the same verdict")

			f.wake()
			assert.Len(t, f.bodyWrites(), 1, "a posted verdict is never written again")
		})
	}
}

// A person's edit of the pull request body stands: the lookup finds a body
// Smithers did not write, so nothing is sent, the TODO is not held, and the
// verdict is not tried again.
func TestTodoPublicationNeverOverwritesAPersonsPullRequestBody(t *testing.T) {
	f := newPublicationFixture(t, false)
	item, _ := f.inReview()
	f.fake.UpdatePull("rehearsal-owner/app", item.PRNumber.Int64, func(p *githubfake.Pull) { p.Body = "Alice's description" })

	f.reviewed(item.Number.Int64, "approve")
	f.wake()
	item = f.item(item.Number.Int64)
	assert.Empty(t, item.PendingOp)
	assert.Empty(t, f.bodyWrites(), "nothing overwrites a person's body")
	assert.Equal(t, "Alice's description", f.pull(item.PRNumber.Int64).Body)
	assert.True(t, mythicalChecksOf(item).Review.Posted)
	assert.Equal(t, "proposed", item.State)
	assert.Empty(t, item.Reason, "the TODO is not held for it")

	f.wake()
	assert.Empty(t, f.bodyWrites())
}

// The body write is journaled (T-GH-09): a write GitHub accepted whose
// answer was lost settles by lookup and is never sent twice; a write GitHub
// refused is looked up, found unwritten, and sent again.
func TestTodoPublicationBodyRecoversByLookup(t *testing.T) {
	t.Run("lost answer", func(t *testing.T) {
		f := newPublicationFixture(t, false)
		item, _ := f.inReview()
		path := "/repos/rehearsal-owner/app/pulls/" + strconv.FormatInt(item.PRNumber.Int64, 10)
		f.fake.LoseNextResponses(path, 1)
		f.reviewed(item.Number.Int64, "approve")
		f.wake()
		item = f.item(item.Number.Int64)
		op, err := decodeMythicalOutbound(item.PendingOp)
		require.NoError(t, err, "the uncertain write keeps its slot")
		assert.Equal(t, "body", op.Kind)
		assert.Equal(t, "unknown", op.State)
		assert.Contains(t, f.pull(item.PRNumber.Int64).Body, "Review: Approved")

		f.wake()
		item = f.item(item.Number.Int64)
		assert.Empty(t, item.PendingOp, "lookup settles the write GitHub took")
		assert.True(t, mythicalChecksOf(item).Review.Posted)
		assert.Equal(t, []string{path + " 502"}, f.bodyWrites(), "never sent twice")
	})
	t.Run("refused write", func(t *testing.T) {
		f := newPublicationFixture(t, false)
		item, _ := f.inReview()
		path := "/repos/rehearsal-owner/app/pulls/" + strconv.FormatInt(item.PRNumber.Int64, 10)
		f.fake.FailNextWrites(path, 1)
		f.reviewed(item.Number.Int64, "approve")
		f.wake()
		assert.NotContains(t, f.pull(item.PRNumber.Int64).Body, "Review:")
		for pass := 0; pass < 2; pass++ {
			f.wake()
		}
		item = f.item(item.Number.Int64)
		assert.Empty(t, item.PendingOp)
		assert.Contains(t, f.pull(item.PRNumber.Int64).Body, "Review: Approved")
		assert.Equal(t, []string{path + " 502", path + " 200"}, f.bodyWrites())
		assert.True(t, mythicalChecksOf(item).Review.Posted)
	})
}
