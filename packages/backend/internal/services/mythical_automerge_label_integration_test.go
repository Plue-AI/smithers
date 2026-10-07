package services

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func TestMythicalAutomergeLabelAuthenticatedInstallIntake(t *testing.T) {
	for _, pullLabel := range []bool{false, true} {
		t.Run(fmt.Sprintf("pull=%t", pullLabel), func(t *testing.T) {
			testMythicalAutomergeLabelAuthenticatedInstallIntake(t, pullLabel)
		})
	}
}

func testMythicalAutomergeLabelAuthenticatedInstallIntake(t *testing.T, pullLabel bool) {
	h := newMergeHarness(t)
	n, head, pr := h.first("Label approval")
	h.freezeClock()
	// The candidate is published normally; fixture linkage supplies an existing
	// issue TODO while the behavior under test starts at GitHub's label door.
	issue := h.fake.OpenIssue("rehearsal-owner/app", "rehearsal-owner", "Label approval", "Merge when ready")
	h.exec(`UPDATE mythical_items SET issue_number=$2 WHERE repository_id=$1 AND number=$3`, h.repoID, issue, n)
	if pullLabel {
		issue = pr
	}
	h.fake.RequireCheck("unit")
	h.fake.SetCheck("rehearsal-owner/app", head, "unit", "in_progress", "")
	synced, row := configureInboundPullPolling(t, h.publicationFixture)
	defer runFetchedFixture(t, synced)()
	readChecks := func() {
		require.NoError(t, synced.pollInstallPull(context.Background(), row, pr))
		require.NoError(t, synced.ReadInstallPullFacts(context.Background(), row, pr, head, "checks"))
		require.Eventually(t, func() bool {
			return fetchedCount(t, h.pool.(*pgxpool.Pool), `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND principal_id IN ('pulls','checks') AND state<>'completed'`) == 0
		}, 10*time.Second, 20*time.Millisecond)
	}
	gh, err := h.service.stackGitHub(context.Background(), h.repoID)
	require.NoError(t, err)
	api := h.service.github.(*mythicalGitHubAPI)
	read := func() {
		require.NoError(t, synced.backfillIssueEvents(context.Background(), row, api.api.issueEventPages(gh.Token, gh.Owner, gh.Name)))
		require.Eventually(t, func() bool {
			return fetchedCount(t, h.pool.(*pgxpool.Pool), `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND principal_id='issues/events' AND state<>'completed'`) == 0
		}, 10*time.Second, 20*time.Millisecond)
	}
	h.fake.LabelIssue("rehearsal-owner/app", issue, "outsider", "automerge")
	read()
	require.Nil(t, mythicalChecksOf(h.item(n)).Preapproval, "an outsider label is no approval")
	h.fake.UnlabelIssue("rehearsal-owner/app", issue, "rehearsal-owner", "automerge")
	read()
	token, err := h.connections.CreateGitHubInstallationTokenForRepositoryOwner(context.Background(), h.userID, 0, "rehearsal-owner", "app", map[string]string{"issues": "write"})
	require.NoError(t, err)
	request, err := http.NewRequest(http.MethodPost, h.fake.URL+fmt.Sprintf("/repos/rehearsal-owner/app/issues/%d/labels", issue), strings.NewReader(`{"labels":["automerge"]}`))
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer "+token.Token)
	response, err := h.fake.Client().Do(request)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, response.StatusCode)
	response.Body.Close()
	read()
	require.Nil(t, mythicalChecksOf(h.item(n)).Preapproval, "an App cannot pre-approve")
	h.exec(`UPDATE users SET is_active=false WHERE id=$1`, h.userID)
	h.fake.LabelIssue("rehearsal-owner/app", issue, "rehearsal-owner", "automerge")
	read()
	require.Nil(t, mythicalChecksOf(h.item(n)).Preapproval, "revoked person cannot grant approval")
	h.exec(`UPDATE users SET is_active=true WHERE id=$1`, h.userID)
	h.fake.LabelIssue("rehearsal-owner/app", issue, "rehearsal-owner", "automerge")
	read()
	checks := mythicalChecksOf(h.item(n))
	require.NotNil(t, checks.Preapproval)
	require.Equal(t, h.userID, checks.Preapproval.StandingUser)
	require.Equal(t, issue, checks.Preapproval.LabelIssue)
	require.Equal(t, "github", checks.PreapprovalEvents[len(checks.PreapprovalEvents)-1].Via)
	read()
	require.Equal(t, checks.PreapprovalEvents, mythicalChecksOf(h.item(n)).PreapprovalEvents, "replay records no second approval")
	readChecks()
	h.pass()
	require.Empty(t, h.merges(), "checks still gate a label approval")
	// Even a removal by an ineligible actor blocks dispatch through the live
	// label read, without granting that actor the ability to approve anything.
	events, _, err := api.IssueEvents(context.Background(), gh, 0)
	require.NoError(t, err)
	var earlier mythicalIssueEvent
	for _, event := range events {
		if event.Actor.Login == "rehearsal-owner" && event.Event == "labeled" {
			earlier = event
		}
	}
	require.Positive(t, earlier.ID)
	h.fake.UnlabelIssue("rehearsal-owner/app", issue, "outsider", "automerge")
	read()
	require.Nil(t, mythicalChecksOf(h.item(n)).Preapproval)
	require.NoError(t, h.service.observeAutomergeLabel(context.Background(), nil, h.repoID, gh, earlier))
	require.Nil(t, mythicalChecksOf(h.item(n)).Preapproval, "out-of-order replay cannot revive an approval")
	h.fake.LabelIssue("rehearsal-owner/app", issue, "outsider", "automerge")
	read()
	require.Nil(t, mythicalChecksOf(h.item(n)).Preapproval, "outsider reapplication cannot revive a person grant")
	h.fake.SetCheck("rehearsal-owner/app", head, "unit", "completed", "success")
	h.pass()
	require.Empty(t, h.merges())
	h.fake.LabelIssue("rehearsal-owner/app", issue, "rehearsal-owner", "automerge")
	read()
	readChecks()
	deliveries := fetchedCount(t, h.pool.(*pgxpool.Pool), `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND principal_id='checks'`)
	require.Equal(t, 2, deliveries, "pending and green snapshots each reach durable ingestion")
	readChecks()
	require.Equal(t, deliveries, fetchedCount(t, h.pool.(*pgxpool.Pool), `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND principal_id='checks'`), "duplicate green polling creates no second delivery")
	for i := 0; i < 5; i++ {
		h.pass()
	}
	require.Len(t, h.merges(), 1)
	require.Equal(t, "landed", h.item(n).State)
}
