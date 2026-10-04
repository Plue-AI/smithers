package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// landingTodo is a proposed TODO #number whose pull request is open for
// review, in an orchestration whose person is GitHub account 42
// (roninjin10, a maintainer the policy names).
func landingTodo(t *testing.T, number int64, file string) (*mythicalOrchestration, db.MythicalItem) {
	t.Helper()
	o := filingTodos(t)
	issue := mythicalIssue{Number: number, Title: "Land", State: "open", TextByMaintainer: true, Labels: []string{"todo"}}
	require.NoError(t, seedMythicalIssue(o.service, context.Background(), o.repoID, issue, maintainerTodo))
	o.propose(number, file)
	item := o.item(number)
	require.Equal(t, "proposed", item.State, item.Reason)
	return o, item
}

// appLabeled records that the App applied automerge for a person: GitHub
// names the App as the label's applier.
func (o *mythicalOrchestration) appLabeled(number int64) {
	o.github.mu.Lock()
	defer o.github.mu.Unlock()
	if o.github.labelEvents == nil {
		o.github.labelEvents = map[string]mythicalLabelApplier{}
	}
	o.github.labelEvents[fmt.Sprintf("%d/%s", number, automergeLabel)] = mythicalLabelApplier{
		Actor: gitHubActor{Login: "smithers[bot]", Type: "Bot"}, ViaApp: true, EventID: number}
}

// A maintainer lands a proposed TODO through Smithers: the App applies the
// automerge label for them, the item records their Land for the head they
// saw, and the stack merges it exactly as for their own label, at the
// reviewed head once the review approves and CI is green.
func TestMythicalLandTodoMergesAtTheReviewedHead(t *testing.T) {
	o, item := landingTodo(t, 90, "ninety.md")
	ctx := context.Background()

	view, err := o.service.LandTodo(ctx, o.repoID, o.userID, uuidString(item.ID), MythicalLandInput{Head: item.PRHead})
	require.NoError(t, err)
	assert.True(t, view.Automerge)
	require.NotNil(t, view.PullRequest)
	assert.Equal(t, item.PRHead, view.PullRequest.Head)
	assert.Contains(t, o.github.added, "#90 automerge", "the App applies the label for the person")
	assert.Empty(t, o.github.merges, "Land itself never merges")
	checks := mythicalChecksOf(o.item(90))
	assert.True(t, checks.Automerge)
	assert.Equal(t, &mythicalLand{By: "roninjin10", Account: 42, Head: item.PRHead}, checks.Land)

	// The label's own event names the App: the Land keeps automerge on.
	o.appLabeled(90)
	issue := mythicalIssue{Number: 90, Title: "Land", State: "open", TextByMaintainer: true, Labels: []string{"todo", "automerge"}}
	require.NoError(t, seedMythicalIssue(o.service, ctx, o.repoID, issue, gitHubLabelApplication{Label: automergeLabel, By: "smithers[bot]"}))
	assert.True(t, mythicalChecksOf(o.item(90)).Automerge)

	o.answerReviews(`"approve"`)
	landed := o.item(90)
	require.Equal(t, "landed", landed.State, landed.Reason)
	assert.Equal(t, map[int64]string{landed.PRNumber.Int64: item.PRHead}, o.github.merges)
}

// The App's automerge label counts only as the Land it records: without a
// Land, or for a head the person never saw, it holds like any label that
// is not a maintainer's, and the stale Land is dropped.
func TestMythicalAppAutomergeWithoutALandHolds(t *testing.T) {
	o, item := landingTodo(t, 91, "ninety-one.md")
	ctx := context.Background()
	next := item
	checks := mythicalChecksOf(next)
	checks.Automerge = true
	checks.Land = &mythicalLand{By: "roninjin10", Account: 42, Head: strings.Repeat("0", 40)}
	next.Checks = checks.encode()
	_, err := db.New(o.pool).SaveMythicalItem(ctx, next)
	require.NoError(t, err)
	o.appLabeled(91)

	o.answerReviews(`"approve"`)
	held := o.item(91)
	assert.Equal(t, "proposed", held.State)
	assert.Equal(t, "a maintainer's automerge label is no longer on the issue", held.Reason)
	assert.Nil(t, mythicalChecksOf(held).Land)
	assert.False(t, mythicalChecksOf(held).Automerge)
	assert.Empty(t, o.github.merges)
}

// A Land by a person the policy stopped naming before the merge holds; with
// no maintainer list, GitHub's word on the person decides, read live.
func TestMythicalLandRereadsThePersonAtTheMerge(t *testing.T) {
	o, item := landingTodo(t, 92, "ninety-two.md")
	ctx := context.Background()
	_, err := o.service.LandTodo(ctx, o.repoID, o.userID, uuidString(item.ID), MythicalLandInput{Head: item.PRHead})
	require.NoError(t, err)
	o.appLabeled(92)
	// The policy now names no one: the stack asks GitHub, which no longer
	// counts the person a maintainer.
	o.service.SetPolicyReader(policyHost{openPolicy(t)})
	o.github.mu.Lock()
	o.github.readOnly = map[string]bool{"roninjin10": true}
	o.github.mu.Unlock()
	o.answerReviews(`"approve"`)
	held := o.item(92)
	assert.Equal(t, "proposed", held.State)
	assert.Equal(t, "a maintainer's automerge label is no longer on the issue", held.Reason)
	assert.Empty(t, o.github.merges)

	// GitHub counts them again and they land it again: it merges.
	o.github.mu.Lock()
	o.github.readOnly = nil
	o.github.mu.Unlock()
	_, err = o.service.LandTodo(ctx, o.repoID, o.userID, uuidString(item.ID), MythicalLandInput{Head: item.PRHead})
	require.NoError(t, err)
	o.wake()
	landed := o.item(92)
	require.Equal(t, "landed", landed.State, landed.Reason)
}

func openPolicy(t *testing.T) string {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"on": []any{}, "github": map[string]any{"mirror": "pull", "issues": "two-way",
		"changes": "send-upstream", "dailyTokens": 1_000_000_000_000}})
	require.NoError(t, err)
	return string(raw)
}

// Land refuses, before GitHub is written, anything but a person who
// maintains, landing an open TODO at the head they saw.
func TestMythicalLandTodoRefusals(t *testing.T) {
	o, item := landingTodo(t, 93, "ninety-three.md")
	ctx := context.Background()
	id := uuidString(item.ID)
	head := item.PRHead
	refuse := func(ctx context.Context, userID int64, id string, input MythicalLandInput, status int, message string) {
		t.Helper()
		_, err := o.service.LandTodo(ctx, o.repoID, userID, id, input)
		code, text := apiCode(t, err)
		assert.Equal(t, status, code, text)
		if message != "" {
			assert.Equal(t, message, text)
		}
	}
	agent := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: o.userID}, IsTokenAuth: true, TokenSystemIssued: true})
	refuse(agent, o.userID, id, MythicalLandInput{Head: head}, http.StatusForbidden, "")
	refuse(ctx, o.userID, "not-a-uuid", MythicalLandInput{Head: head}, http.StatusBadRequest, "invalid item id")
	refuse(ctx, o.userID, id, MythicalLandInput{Head: "HEAD"}, http.StatusUnprocessableEntity, "")
	refuse(ctx, o.userID, "00000000-0000-4000-8000-000000000000", MythicalLandInput{Head: head}, http.StatusNotFound, "item not found")
	refuse(ctx, o.userID, id, MythicalLandInput{Head: strings.Repeat("0", 40)}, http.StatusConflict, "the pull request changed since you saw it")

	o.github.mu.Lock()
	o.github.readOnly = map[string]bool{"roninjin10": true}
	o.github.mu.Unlock()
	refuse(ctx, o.userID, id, MythicalLandInput{Head: head}, http.StatusForbidden, "only a maintainer of smithersai/smithers on GitHub may land a TODO")
	o.github.mu.Lock()
	o.github.readOnly = nil
	o.github.accounts[42] = gitHubActor{ID: 42, Login: "stranger", Type: "User"}
	o.github.mu.Unlock()
	refuse(ctx, o.userID, id, MythicalLandInput{Head: head}, http.StatusForbidden, "only a maintainer the factory's policy names may land a TODO")
	_, err := o.pool.Exec(ctx, `DELETE FROM oauth_accounts WHERE user_id = $1`, o.userID)
	require.NoError(t, err)
	refuse(ctx, o.userID, id, MythicalLandInput{Head: head}, http.StatusForbidden, "connect your GitHub account to land a TODO")

	// A queued TODO has no pull request to land; a landed one is done.
	require.NoError(t, seedMythicalIssue(o.service, ctx, o.repoID, mythicalIssue{Number: 94, Title: "Queued", State: "open",
		TextByMaintainer: true, Labels: []string{"todo"}}, maintainerTodo))
	queued := o.item(94)
	refuse(ctx, o.userID, uuidString(queued.ID), MythicalLandInput{Head: head}, http.StatusConflict, "only a TODO whose pull request is open is landed")
	assert.NotContains(t, o.github.added, "#93 automerge")
	assert.NotContains(t, o.github.added, "#94 automerge")
	assert.Nil(t, mythicalChecksOf(o.item(93)).Land)
}
