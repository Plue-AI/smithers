package db

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"
)

func TestChangesetCreationRollsBackEveryMemberOnFailure(t *testing.T) {
	q, conn := newQueries(t)
	user := mustCreateUser(t, conn, uniqueTestUsername(t))
	org := mustCreateOrganization(t, conn, uniqueTestRepoName(t))
	super := mustCreateOrgRepo(t, conn, org, "superproject", false)
	member := mustCreateOrgRepo(t, conn, org, "api", false)
	members, _ := json.Marshal([]AddChangesetMemberParams{
		{RepositoryID: member, Path: "api", ChangeID: "a", CommitID: "a", TargetBookmark: "main"},
		{RepositoryID: member, Path: "duplicate", ChangeID: "b", CommitID: "b", TargetBookmark: "main"},
	})
	err := mustExpectQueryError(t, conn, func(q *Queries) error {
		_, err := q.CreateChangesetWithMembers(t.Context(), CreateChangesetWithMembersParams{OrganizationID: org, SuperprojectRepositoryID: super, ChangeID: "atomic", CommitID: "atomic", ParentChangeIds: []byte(`[]`), TargetBookmark: "main", CreatedBy: pgtype.Int8{Int64: user, Valid: true}, Members: members})
		return err
	})
	require.Error(t, err)
	rows, err := q.ListChangesetsByOrg(t.Context(), ListChangesetsByOrgParams{OrganizationID: org, PageSize: 100})
	require.NoError(t, err)
	require.Empty(t, rows)
}

func TestOAuthBulkDeletionRecordsRevocationsTransactionally(t *testing.T) {
	q, conn := newQueries(t)
	ctx := context.Background()
	user := mustCreateUser(t, conn, uniqueTestUsername(t))
	app, err := q.CreateOAuth2Application(ctx, CreateOAuth2ApplicationParams{ClientID: fmt.Sprintf("review-%d", user), Name: "Review test", OwnerID: user, Scopes: []string{"read:repository"}, RedirectUris: []string{"https://example.invalid/callback"}})
	require.NoError(t, err)
	after, err := q.LatestRevocationEventID(ctx)
	require.NoError(t, err)
	for i := range 2 {
		_, err = q.CreateOAuth2AccessToken(ctx, CreateOAuth2AccessTokenParams{TokenHash: fmt.Sprintf("review-%d-%d", user, i), AppID: app.ID, UserID: user, Scopes: []string{"read:repository"}, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	}
	require.NoError(t, q.DeleteOAuth2AccessTokensByAppAndUser(ctx, DeleteOAuth2AccessTokensByAppAndUserParams{AppID: app.ID, UserID: user}))
	events, err := q.ListRevocationEventsAfter(ctx, ListRevocationEventsAfterParams{AfterID: after, LimitCount: 100})
	require.NoError(t, err)
	matched := 0
	for _, event := range events {
		if event.UserID.Int64 == user {
			require.Equal(t, "token_revoked", event.Kind)
			require.NotEmpty(t, event.TokenHash)
			matched++
		}
	}
	require.Equal(t, 2, matched)
}

func TestLandingChecksRequireSuccessOnEveryPinnedRevision(t *testing.T) {
	q, conn := newQueries(t)
	_, repo := mustCreateUserAndRepo(t, conn, uniqueTestUsername(t), uniqueTestRepoName(t))
	status := func(change, commit, result string) {
		t.Helper()
		_, err := q.CreateCommitStatus(t.Context(), CreateCommitStatusParams{RepositoryID: repo, ChangeID: pgtype.Text{String: change, Valid: true}, CommitSha: pgtype.Text{String: commit, Valid: true}, Context: "ci", Status: result})
		require.NoError(t, err)
	}
	check := func(pins string, expected []string) {
		t.Helper()
		failures, err := q.ListFailingLandingRevisionChecks(t.Context(), ListFailingLandingRevisionChecksParams{RepositoryID: repo, Revisions: []byte(pins), Contexts: []string{"ci"}})
		require.NoError(t, err)
		require.Equal(t, expected, failures)
	}
	status("a", "a1", "failure")
	status("b", "b1", "success")
	check(`{"a":"a1","b":"b1"}`, []string{"ci"})
	status("a", "a1", "success")
	check(`{"a":"a1","b":"b1"}`, []string{})
	check(`{"a":"a1","b":"b2"}`, []string{"ci"})
	status("b", "b2", "success")
	check(`{"a":"a1","b":"b2"}`, []string{})
}

func TestUserAccessChangesPublishInTheirTransaction(t *testing.T) {
	q, conn := newQueries(t)
	user := mustCreateUser(t, conn, uniqueTestUsername(t))
	after, err := q.LatestRevocationEventID(t.Context())
	require.NoError(t, err)
	_, err = q.SetUserSuspended(t.Context(), SetUserSuspendedParams{UserID: user, Suspended: true})
	require.NoError(t, err)
	_, err = q.SetUserSuspended(t.Context(), SetUserSuspendedParams{UserID: user, Suspended: false})
	require.NoError(t, err)
	require.NoError(t, q.SuspendUser(t.Context(), user))
	// A soft-deleted account cannot be restored by toggling suspension (#2832).
	_, err = q.SetUserSuspended(t.Context(), SetUserSuspendedParams{UserID: user, Suspended: false})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	deleted, err := q.GetUserByID(t.Context(), user)
	require.NoError(t, err)
	require.False(t, deleted.IsActive)
	require.True(t, deleted.ProhibitLogin)
	events, err := q.ListRevocationEventsAfter(t.Context(), ListRevocationEventsAfterParams{AfterID: after, LimitCount: 100})
	require.NoError(t, err)
	var kinds []string
	for _, event := range events {
		if event.UserID.Int64 == user {
			kinds = append(kinds, event.Kind)
		}
	}
	require.Equal(t, []string{"user_disabled", "user_enabled", "user_disabled"}, kinds)
}
