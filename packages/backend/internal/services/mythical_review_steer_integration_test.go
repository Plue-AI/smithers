package services

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
)

// githubSteers are TODO n's steers that came from GitHub reviews.
func (f *publicationFixture) githubSteers(number int64) []todoSteer {
	f.t.Helper()
	var out []todoSteer
	for _, steer := range mythicalChecksOf(f.item(number)).Steers {
		if steer.GitHub != "" {
			out = append(out, steer)
		}
	}
	return out
}

// backInReview puts TODO n in review again on its pull request, as its next
// attempt's proposal does.
func (f *publicationFixture) backInReview(number int64) db.MythicalItem {
	f.t.Helper()
	_, err := f.pool.Exec(context.Background(), `UPDATE mythical_items SET state = 'proposed', pr_state = 'open', reason = '' WHERE repository_id = $1 AND number = $2`, f.repoID, number)
	require.NoError(f.t, err)
	return f.item(number)
}

// steeredFacts are TODO n's todo.steered facts that came from GitHub.
func (f *publicationFixture) steeredFacts(number int64) []map[string]any {
	f.t.Helper()
	rows, err := f.pool.Query(context.Background(), `SELECT data FROM product_job_events WHERE principal_id = $1 AND event_type = 'todo.steered' ORDER BY sequence`,
		todoOperationScope(f.item(number)).PrincipalID)
	require.NoError(f.t, err)
	defer rows.Close()
	var out []map[string]any
	for rows.Next() {
		var data []byte
		require.NoError(f.t, rows.Scan(&data))
		var fact map[string]any
		require.NoError(f.t, json.Unmarshal(data, &fact))
		if fact["source"] == "github_review" {
			out = append(out, fact)
		}
	}
	require.NoError(f.t, rows.Err())
	return out
}

// J10.2 on real PostgreSQL and the GitHub fake: a teammate's "Request
// changes" review with a line comment becomes one steer attributed to their
// login, the TODO goes back to Working for its next attempt with the review
// as its first input, and the same review never steers again: not on the
// next poll, not after the next proposal, not after a restart.
func TestGitHubReviewSteersTheTodoOnce(t *testing.T) {
	f := newPublicationFixture(t, false)
	item, pull := f.inReview()
	attempt := item.Attempt
	f.fake.SubmitReview("rehearsal-owner/app", pull.Number, githubfake.ReviewSubmission{Login: "alice", State: "CHANGES_REQUESTED",
		Body: "Greet by name", Comments: []githubfake.ReviewLine{{Path: "JOURNEY.md", Line: 1, Body: "Say hello to Alice"}}})

	f.wake()
	item = f.item(item.Number.Int64)
	assert.Equal(t, "queued", item.State, "the TODO left review for its next attempt, which starts as Working")
	steers := f.githubSteers(item.Number.Int64)
	require.Len(t, steers, 1)
	assert.Equal(t, "Greet by name\n\nJOURNEY.md:1 @ "+pull.Head.SHA+"\nSay hello to Alice", steers[0].Text)
	assert.JSONEq(t, `{"kind":"github","login":"alice","color_index":7}`, string(steers[0].By))
	assert.Equal(t, attempt+1, steers[0].Attempt, "held for the next attempt")
	assert.Contains(t, todoFeedback(item, attempt+1), "Say hello to Alice", "the next attempt's first input carries the review")
	assert.Equal(t, pull.Number, item.PRNumber.Int64, "the pull request stays the TODO's")
	assert.Equal(t, "open", f.pull(pull.Number).State, "the pull request stays open")
	facts := f.steeredFacts(item.Number.Int64)
	require.Len(t, facts, 1)
	assert.Equal(t, map[string]any{"kind": "github", "login": "alice"}, facts[0]["actor"])
	assert.Equal(t, "in_review", facts[0]["from"])
	assert.Equal(t, "next_attempt", facts[0]["delivery"])

	card := f.card(item.Number.Int64)
	assert.Contains(t, fmtJSON(t, card["steers"]), `"by":{"color_index":7,"kind":"github","login":"alice"}`)

	// The next proposal puts the TODO in review again: the review is seen.
	f.backInReview(item.Number.Int64)
	f.wake()
	f.wake()
	assert.Equal(t, "proposed", f.item(item.Number.Int64).State, "a seen review never steers again")
	assert.Len(t, f.githubSteers(item.Number.Int64), 1)

	assert.Len(t, f.steeredFacts(item.Number.Int64), 1, "seen ids are in the TODO's row, so a restart reads them too")

	// A second review is a second steer.
	f.fake.SubmitReview("rehearsal-owner/app", pull.Number, githubfake.ReviewSubmission{Login: "bea", State: "COMMENTED", Body: "Also a test"})
	f.wake()
	steers = f.githubSteers(item.Number.Int64)
	require.Len(t, steers, 2)
	assert.Equal(t, []string{"alice", "bea"}, []string{reviewLogin(t, steers[0]), reviewLogin(t, steers[1])})
	assert.Equal(t, "queued", f.item(item.Number.Int64).State)
	assert.Len(t, f.steeredFacts(item.Number.Int64), 2)
}

// Reviews that are not steers leave the TODO in review: an approval with or
// without words, a comment review with nothing in it, and any review by a
// bot, the install's own App included.
func TestGitHubReviewsThatAreNotSteersLeaveTheTodoInReview(t *testing.T) {
	f := newPublicationFixture(t, false)
	item, pull := f.inReview()
	for _, review := range []githubfake.ReviewSubmission{
		{Login: "owner", State: "APPROVED"},
		{Login: "dana", State: "APPROVED", Body: "LGTM"},
		{Login: "ben", State: "COMMENTED"},
		{Login: "smithers-install", Bot: true, State: "CHANGES_REQUESTED", Body: "the App never steers"},
		{Login: "dependabot", Bot: true, State: "COMMENTED", Body: "nor another bot"},
	} {
		f.fake.SubmitReview("rehearsal-owner/app", pull.Number, review)
	}
	f.wake()
	f.wake()
	item = f.item(item.Number.Int64)
	assert.Equal(t, "proposed", item.State, item.Reason)
	assert.Empty(t, f.githubSteers(item.Number.Int64))
	assert.Empty(t, f.steeredFacts(item.Number.Int64))
}

// A GitHub read that fails changes nothing and is read again on the next
// poll, which then steers once; a TODO dropped before its review is read is
// never steered.
func TestGitHubReviewReadFailureRetriesAndADroppedTodoIsNotSteered(t *testing.T) {
	f := newPublicationFixture(t, false)
	item, pull := f.inReview()
	path := "/repos/rehearsal-owner/app/pulls/" + strconv.FormatInt(pull.Number, 10) + "/reviews"
	f.fake.FailNextReads(path, 1)
	f.fake.SubmitReview("rehearsal-owner/app", pull.Number, githubfake.ReviewSubmission{Login: "alice", State: "CHANGES_REQUESTED", Body: "Fix it"})
	f.wake()
	assert.Equal(t, "proposed", f.item(item.Number.Int64).State, "GitHub did not answer: nothing changed")
	assert.Empty(t, f.githubSteers(item.Number.Int64))

	f.wake()
	assert.Len(t, f.githubSteers(item.Number.Int64), 1, "read again on the next poll")
	assert.Equal(t, "queued", f.item(item.Number.Int64).State)

	// Drop: a cancelled TODO's later review steers nothing.
	_, err := f.pool.Exec(context.Background(), `UPDATE mythical_items SET state = 'cancelled', reason = 'dropped' WHERE repository_id = $1 AND number = $2`, f.repoID, item.Number.Int64)
	require.NoError(t, err)
	f.fake.SubmitReview("rehearsal-owner/app", pull.Number, githubfake.ReviewSubmission{Login: "bea", State: "CHANGES_REQUESTED", Body: "Too late"})
	f.wake()
	assert.Equal(t, "cancelled", f.item(item.Number.Int64).State)
	assert.Len(t, f.githubSteers(item.Number.Int64), 1)
}

func reviewLogin(t *testing.T, steer todoSteer) string {
	t.Helper()
	var by struct {
		Login string `json:"login"`
	}
	require.NoError(t, json.Unmarshal(steer.By, &by))
	return by.Login
}
