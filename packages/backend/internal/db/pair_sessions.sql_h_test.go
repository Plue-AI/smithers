package db

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPairSessionsSQL_H_SessionMemberInviteAndLinkRoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	ownerID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	visitorID := mustCreateUser(t, pool, uniqueTestUsername(t))
	session := pairSessionsSQLHCreateSession(t, q, pool, ownerID, repoID)

	gotSession, err := q.GetPairSession(ctx, session.ID)
	require.NoError(t, err)
	assert.Equal(t, session.ID, gotSession.ID)

	activeStatus, err := q.SetPairSessionStatus(ctx, SetPairSessionStatusParams{ID: session.ID, Status: "active"})
	require.NoError(t, err)
	assert.Equal(t, "active", activeStatus.Status)
	_, err = q.SetPairSessionStatus(ctx, SetPairSessionStatusParams{ID: session.ID, Status: "provisioning"})
	require.NoError(t, err)

	forkWorkspaceID := mustCreateForkWorkspace(t, pool, ownerID, repoID, session.SourceWorkspaceID)
	bound, err := q.SetPairSessionForkBound(ctx, SetPairSessionForkBoundParams{
		ID:          session.ID,
		WorkspaceID: pgtype.UUID{Bytes: uuid.MustParse(forkWorkspaceID), Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, "active", bound.Status)
	assert.True(t, bound.WorkspaceID.Valid)

	_, err = q.SetPairSessionForkBound(ctx, SetPairSessionForkBoundParams{
		ID:          session.ID,
		WorkspaceID: pgtype.UUID{Bytes: uuid.MustParse(forkWorkspaceID), Valid: true},
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	ownerMember, err := q.UpsertPairSessionMember(ctx, UpsertPairSessionMemberParams{SessionID: session.ID, UserID: ownerID, Role: "owner"})
	require.NoError(t, err)
	assert.Equal(t, "owner", ownerMember.Role)

	visitorMember, err := q.UpsertPairSessionMember(ctx, UpsertPairSessionMemberParams{SessionID: session.ID, UserID: visitorID, Role: "editor"})
	require.NoError(t, err)
	assert.Equal(t, "editor", visitorMember.Role)

	gotMember, err := q.GetLivePairSessionMember(ctx, GetLivePairSessionMemberParams{SessionID: session.ID, UserID: visitorID})
	require.NoError(t, err)
	assert.Equal(t, visitorID, gotMember.UserID)

	viewerMember, err := q.SetPairSessionMemberRole(ctx, SetPairSessionMemberRoleParams{SessionID: session.ID, UserID: visitorID, Role: "viewer"})
	require.NoError(t, err)
	assert.Equal(t, "viewer", viewerMember.Role)

	presence := json.RawMessage(`{"cursor":{"path":"README.md","line":7}}`)
	presentMember, err := q.UpdatePairSessionMemberPresence(ctx, UpdatePairSessionMemberPresenceParams{SessionID: session.ID, UserID: visitorID, Presence: presence})
	require.NoError(t, err)
	assert.JSONEq(t, string(presence), string(presentMember.Presence))
	assert.True(t, presentMember.PresenceUpdatedAt.Valid)

	liveMembers, err := q.ListLivePairSessionMembers(ctx, session.ID)
	require.NoError(t, err)
	require.Len(t, liveMembers, 2)
	assert.True(t, pairSessionsSQLHHasMember(liveMembers, ownerID))
	assert.True(t, pairSessionsSQLHHasMember(liveMembers, visitorID))

	profiles, err := q.ListLivePairSessionMemberProfiles(ctx, session.ID)
	require.NoError(t, err)
	require.Len(t, profiles, 2)

	emailInvite, err := q.CreatePairSessionInvite(ctx, CreatePairSessionInviteParams{
		SessionID:  session.ID,
		LowerEmail: pgtype.Text{String: "visitor-h@example.com", Valid: true},
		Role:       "editor",
		TokenHash:  "tok-email-" + randSlug(t),
		InvitedBy:  ownerID,
		ExpiresAt:  time.Now().Add(time.Hour),
	})
	require.NoError(t, err)

	liveEmailInvite, err := q.GetLivePairSessionInviteForEmail(ctx, GetLivePairSessionInviteForEmailParams{SessionID: session.ID, LowerEmail: "visitor-h@example.com"})
	require.NoError(t, err)
	assert.Equal(t, emailInvite.ID, liveEmailInvite.ID)

	inviteByID, err := q.GetPairSessionInvite(ctx, GetPairSessionInviteParams{ID: emailInvite.ID, SessionID: session.ID})
	require.NoError(t, err)
	assert.Equal(t, emailInvite.ID, inviteByID.ID)

	inviteByToken, err := q.GetPairSessionInviteByTokenHash(ctx, emailInvite.TokenHash)
	require.NoError(t, err)
	assert.Equal(t, emailInvite.ID, inviteByToken.ID)

	acceptedMember, err := q.AcceptPairSessionInvite(ctx, AcceptPairSessionInviteParams{
		ID:               emailInvite.ID,
		SessionID:        session.ID,
		AcceptedByUserID: pgtype.Int8{Int64: visitorID, Valid: true},
		UserID:           visitorID,
	})
	require.NoError(t, err)
	assert.Equal(t, "editor", acceptedMember.Role)
	assert.True(t, acceptedMember.InvitedViaInviteID.Valid)

	_, err = q.AcceptPairSessionInvite(ctx, AcceptPairSessionInviteParams{
		ID:               emailInvite.ID,
		SessionID:        session.ID,
		AcceptedByUserID: pgtype.Int8{Int64: visitorID, Valid: true},
		UserID:           visitorID,
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	_, err = q.GetLivePairSessionInviteForEmail(ctx, GetLivePairSessionInviteForEmailParams{SessionID: session.ID, LowerEmail: "visitor-h@example.com"})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	usernameInvite, err := q.CreatePairSessionInvite(ctx, CreatePairSessionInviteParams{
		SessionID:           session.ID,
		LowerGithubUsername: pgtype.Text{String: "visitor-h", Valid: true},
		Role:                "viewer",
		TokenHash:           "tok-user-" + randSlug(t),
		InvitedBy:           ownerID,
		ExpiresAt:           time.Now().Add(time.Hour),
	})
	require.NoError(t, err)

	liveUsernameInvite, err := q.GetLivePairSessionInviteForUsername(ctx, GetLivePairSessionInviteForUsernameParams{SessionID: session.ID, LowerGithubUsername: "visitor-h"})
	require.NoError(t, err)
	assert.Equal(t, usernameInvite.ID, liveUsernameInvite.ID)

	marked, err := q.MarkPairSessionInviteAccepted(ctx, MarkPairSessionInviteAcceptedParams{
		ID: usernameInvite.ID, AcceptedByUserID: pgtype.Int8{Int64: visitorID, Valid: true},
	})
	require.NoError(t, err)
	assert.True(t, marked.AcceptedAt.Valid)

	revokeEmailInvite, err := q.CreatePairSessionInvite(ctx, CreatePairSessionInviteParams{
		SessionID:  session.ID,
		LowerEmail: pgtype.Text{String: "revoke-h@example.com", Valid: true},
		Role:       "viewer",
		TokenHash:  "tok-revoke-email-" + randSlug(t),
		InvitedBy:  ownerID,
		ExpiresAt:  time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	revokedEmail, err := q.RevokePairSessionInvite(ctx, RevokePairSessionInviteParams{SessionID: session.ID, LowerEmail: revokeEmailInvite.LowerEmail.String})
	require.NoError(t, err)
	assert.True(t, revokedEmail.RevokedAt.Valid)

	revokeUsernameInvite, err := q.CreatePairSessionInvite(ctx, CreatePairSessionInviteParams{
		SessionID:           session.ID,
		LowerGithubUsername: pgtype.Text{String: "revoke-user-h", Valid: true},
		Role:                "viewer",
		TokenHash:           "tok-revoke-user-" + randSlug(t),
		InvitedBy:           ownerID,
		ExpiresAt:           time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	revokedUsername, err := q.RevokePairSessionInviteByUsername(ctx, RevokePairSessionInviteByUsernameParams{SessionID: session.ID, LowerGithubUsername: revokeUsernameInvite.LowerGithubUsername.String})
	require.NoError(t, err)
	assert.True(t, revokedUsername.RevokedAt.Valid)

	invites, err := q.ListPairSessionInvites(ctx, session.ID)
	require.NoError(t, err)
	require.NotEmpty(t, invites)
	for _, invite := range invites {
		assert.False(t, invite.RevokedAt.Valid)
	}

	alpha, err := q.UpsertAlphaWhitelistUsername(ctx, UpsertAlphaWhitelistUsernameParams{
		Username: "Visitor-H", LowerUsername: "visitor-h", CreatedBy: pgtype.Int8{Int64: ownerID, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, "username", alpha.IdentityType)
	alphaAgain, err := q.UpsertAlphaWhitelistUsername(ctx, UpsertAlphaWhitelistUsernameParams{
		Username: "Visitor-H", LowerUsername: "visitor-h", CreatedBy: pgtype.Int8{Int64: ownerID, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, alpha.ID, alphaAgain.ID)

	viewerLink, err := q.CreatePairSessionLink(ctx, CreatePairSessionLinkParams{SessionID: session.ID, Slug: "viewer-" + randSlug(t), Role: "viewer", CreatedBy: ownerID})
	require.NoError(t, err)
	links, err := q.ListLivePairSessionLinks(ctx, session.ID)
	require.NoError(t, err)
	require.Len(t, links, 1)
	assert.Equal(t, viewerLink.ID, links[0].ID)

	require.NoError(t, q.RevokeLivePairSessionLinksForRole(ctx, RevokeLivePairSessionLinksForRoleParams{SessionID: session.ID, Role: "viewer"}))
	links, err = q.ListLivePairSessionLinks(ctx, session.ID)
	require.NoError(t, err)
	assert.Empty(t, links)

	editorLink, err := q.CreatePairSessionLink(ctx, CreatePairSessionLinkParams{SessionID: session.ID, Slug: "editor-" + randSlug(t), Role: "editor", CreatedBy: ownerID})
	require.NoError(t, err)
	revokedLink, err := q.RevokePairSessionLink(ctx, RevokePairSessionLinkParams{ID: editorLink.ID, SessionID: session.ID})
	require.NoError(t, err)
	assert.True(t, revokedLink.RevokedAt.Valid)
	_, err = q.RevokePairSessionLink(ctx, RevokePairSessionLinkParams{ID: editorLink.ID, SessionID: session.ID})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	_, err = q.SetPairSessionMemberRole(ctx, SetPairSessionMemberRoleParams{SessionID: session.ID, UserID: 999999999, Role: "viewer"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.UpdatePairSessionMemberPresence(ctx, UpdatePairSessionMemberPresenceParams{SessionID: session.ID, UserID: 999999999, Presence: json.RawMessage(`{}`)})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	_, err = q.RevokePairSessionMember(ctx, RevokePairSessionMemberParams{SessionID: session.ID, UserID: visitorID})
	require.NoError(t, err)
	_, err = q.GetLivePairSessionMember(ctx, GetLivePairSessionMemberParams{SessionID: session.ID, UserID: visitorID})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	ended, err := q.EndPairSessionForOwner(ctx, EndPairSessionForOwnerParams{ID: session.ID, OwnerUserID: ownerID})
	require.NoError(t, err)
	assert.Equal(t, "ended", ended.Status)
	assert.True(t, ended.EndedAt.Valid)

	_, err = q.EndPairSessionForOwner(ctx, EndPairSessionForOwnerParams{ID: session.ID, OwnerUserID: ownerID})
	require.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestPairSessionsSQL_H_PromptQueueDraftAndSweepRoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	ownerID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	session := pairSessionsSQLHCreateSession(t, q, pool, ownerID, repoID)

	prompt, err := q.EnqueuePairPrompt(ctx, EnqueuePairPromptParams{SessionID: session.ID, AuthorUserID: ownerID, Source: "solo", Body: "first"})
	require.NoError(t, err)
	assert.Equal(t, int64(1), prompt.Seq)

	gotPrompt, err := q.GetPairPrompt(ctx, prompt.ID)
	require.NoError(t, err)
	assert.Equal(t, prompt.ID, gotPrompt.ID)

	queue, err := q.ListPairPromptQueue(ctx, session.ID)
	require.NoError(t, err)
	require.Len(t, queue, 1)

	claimed, err := q.ClaimPairPrompt(ctx, ClaimPairPromptParams{
		ID: prompt.ID, SessionID: session.ID, ExecutorClientID: "client-a",
		ClaimExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, "claimed", claimed.Status)

	started, err := q.StartPairPrompt(ctx, StartPairPromptParams{ID: prompt.ID, SessionID: session.ID, ExecutorClientID: "client-a", RunID: "run-h-1"})
	require.NoError(t, err)
	assert.Equal(t, "running", started.Status)
	assert.Equal(t, "run-h-1", started.RunID.String)

	finished, err := q.FinishPairPrompt(ctx, FinishPairPromptParams{ID: prompt.ID, SessionID: session.ID, ExecutorClientID: "client-a", Status: "done"})
	require.NoError(t, err)
	assert.Equal(t, "done", finished.Status)
	_, err = q.FinishPairPrompt(ctx, FinishPairPromptParams{ID: prompt.ID, SessionID: session.ID, ExecutorClientID: "client-a", Status: "done"})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	cancelPrompt, err := q.EnqueuePairPrompt(ctx, EnqueuePairPromptParams{SessionID: session.ID, AuthorUserID: ownerID, Source: "together", Body: "cancel"})
	require.NoError(t, err)
	canceled, err := q.CancelAnyPendingPairPrompt(ctx, CancelAnyPendingPairPromptParams{
		ID: cancelPrompt.ID, SessionID: session.ID, CanceledBy: pgtype.Int8{Int64: ownerID, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, "canceled", canceled.Status)
	_, err = q.CancelAnyPendingPairPrompt(ctx, CancelAnyPendingPairPromptParams{
		ID: cancelPrompt.ID, SessionID: session.ID, CanceledBy: pgtype.Int8{Int64: ownerID, Valid: true},
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	sweepPrompt, err := q.EnqueuePairPrompt(ctx, EnqueuePairPromptParams{SessionID: session.ID, AuthorUserID: ownerID, Source: "solo", Body: "sweep"})
	require.NoError(t, err)
	_, err = q.ClaimPairPrompt(ctx, ClaimPairPromptParams{
		ID: sweepPrompt.ID, SessionID: session.ID, ExecutorClientID: "client-expired",
		ClaimExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(-time.Hour), Valid: true},
	})
	require.NoError(t, err)
	swept, err := q.SweepStalePairPromptClaims(ctx)
	require.NoError(t, err)
	require.Len(t, swept, 1)
	assert.Equal(t, sweepPrompt.ID, swept[0].ID)
	assert.Equal(t, "queued", swept[0].Status)

	takeoverPrompt, err := q.EnqueuePairPrompt(ctx, EnqueuePairPromptParams{SessionID: session.ID, AuthorUserID: ownerID, Source: "solo", Body: "takeover"})
	require.NoError(t, err)
	_, err = q.ClaimPairPrompt(ctx, ClaimPairPromptParams{
		ID: takeoverPrompt.ID, SessionID: session.ID, ExecutorClientID: "client-old",
		ClaimExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(-time.Hour), Valid: true},
	})
	require.NoError(t, err)
	taken, err := q.ClaimPairPrompt(ctx, ClaimPairPromptParams{
		ID: takeoverPrompt.ID, SessionID: session.ID, ExecutorClientID: "client-new",
		ClaimExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, "client-new", taken.ExecutorClientID.String)
	_, err = q.CancelAnyPendingPairPrompt(ctx, CancelAnyPendingPairPromptParams{
		ID: takeoverPrompt.ID, SessionID: session.ID, CanceledBy: pgtype.Int8{Int64: ownerID, Valid: true},
	})
	require.NoError(t, err)

	staleRunningPrompt, err := q.EnqueuePairPrompt(ctx, EnqueuePairPromptParams{SessionID: session.ID, AuthorUserID: ownerID, Source: "solo", Body: "stale-running"})
	require.NoError(t, err)
	_, err = q.ClaimPairPrompt(ctx, ClaimPairPromptParams{
		ID: staleRunningPrompt.ID, SessionID: session.ID, ExecutorClientID: "client-stale",
		ClaimExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(-time.Hour), Valid: true},
	})
	require.NoError(t, err)
	_, err = q.StartPairPrompt(ctx, StartPairPromptParams{ID: staleRunningPrompt.ID, SessionID: session.ID, ExecutorClientID: "client-stale", RunID: "run-stale"})
	require.NoError(t, err)
	failedRunning, err := q.FailStaleRunningPairPrompts(ctx, 1)
	require.NoError(t, err)
	require.Len(t, failedRunning, 1)
	assert.Equal(t, staleRunningPrompt.ID, failedRunning[0].ID)
	assert.Equal(t, "failed", failedRunning[0].Status)

	staleSession := pairSessionsSQLHCreateSession(t, q, pool, ownerID, repoID)
	mustExec(t, pool, `UPDATE pair_sessions SET created_at = NOW() - INTERVAL '2 hours' WHERE id = $1`, staleSession.ID)
	failedSessions, err := q.FailStalePairSessions(ctx, time.Now())
	require.NoError(t, err)
	assert.True(t, pairSessionsSQLHHasSession(failedSessions, staleSession.ID))

	draft, err := q.UpsertPairSessionDraft(ctx, UpsertPairSessionDraftParams{
		SessionID: session.ID, Content: "v1", Version: 1, UpdatedBy: pgtype.Int8{Int64: ownerID, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, "v1", draft.Content)

	gotDraft, err := q.GetPairSessionDraft(ctx, session.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), gotDraft.Version)

	_, err = q.UpsertPairSessionDraft(ctx, UpsertPairSessionDraftParams{
		SessionID: session.ID, Content: "stale", Version: 1, UpdatedBy: pgtype.Int8{Int64: ownerID, Valid: true},
	})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	draft, err = q.UpsertPairSessionDraft(ctx, UpsertPairSessionDraftParams{
		SessionID: session.ID, Content: "v2", Version: 2, UpdatedBy: pgtype.Int8{Int64: ownerID, Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, "v2", draft.Content)
}

func TestPairSessionsSQL_H_MissingRowsAndConstraintErrors(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	ownerID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	session := pairSessionsSQLHCreateSession(t, q, pool, ownerID, repoID)
	missingID := "00000000-0000-0000-0000-000000000000"

	_, err := q.GetPairSession(ctx, "missing-session")
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetPairPrompt(ctx, missingID)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetPairSessionDraft(ctx, session.ID)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetPairSessionInvite(ctx, GetPairSessionInviteParams{ID: missingID, SessionID: session.ID})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetPairSessionInviteByTokenHash(ctx, "missing-token")
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetLivePairSessionInviteForUsername(ctx, GetLivePairSessionInviteForUsernameParams{SessionID: session.ID, LowerGithubUsername: "missing"})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.StartPairPrompt(ctx, StartPairPromptParams{ID: missingID, SessionID: session.ID, ExecutorClientID: "missing", RunID: "missing"})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreatePairSession(ctx, CreatePairSessionParams{
			ID: "bad-owner-" + randSlug(t), OwnerUserID: 999999999, SourceWorkspaceID: missingID, AccessMode: "restricted",
		})
		return err
	})
	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.EnqueuePairPrompt(ctx, EnqueuePairPromptParams{SessionID: "missing-session", AuthorUserID: ownerID, Source: "solo", Body: "bad"})
		return err
	})
	mustExpectQueryError(t, pool, func(spQ *Queries) error {
		_, err := spQ.CreatePairSessionInvite(ctx, CreatePairSessionInviteParams{
			SessionID: session.ID, Role: "viewer", TokenHash: "bad-invite-" + randSlug(t), InvitedBy: ownerID, ExpiresAt: time.Now().Add(time.Hour),
		})
		return err
	})
}

func TestPairSessionsSQL_H_ManyErrorBranches(t *testing.T) {
	sentinel := errors.New("pair sessions h rows failed")
	cases := []struct {
		name string
		call func(*Queries) error
	}{
		{"FailStalePairSessions", func(q *Queries) error {
			_, err := q.FailStalePairSessions(context.Background(), time.Now())
			return err
		}},
		{"FailStaleRunningPairPrompts", func(q *Queries) error { _, err := q.FailStaleRunningPairPrompts(context.Background(), 1); return err }},
		{"ListLivePairSessionLinks", func(q *Queries) error {
			_, err := q.ListLivePairSessionLinks(context.Background(), "session")
			return err
		}},
		{"ListLivePairSessionMemberProfiles", func(q *Queries) error {
			_, err := q.ListLivePairSessionMemberProfiles(context.Background(), "session")
			return err
		}},
		{"ListLivePairSessionMembers", func(q *Queries) error {
			_, err := q.ListLivePairSessionMembers(context.Background(), "session")
			return err
		}},
		{"ListPairPromptQueue", func(q *Queries) error { _, err := q.ListPairPromptQueue(context.Background(), "session"); return err }},
		{"ListPairSessionInvites", func(q *Queries) error {
			_, err := q.ListPairSessionInvites(context.Background(), "session")
			return err
		}},
		{"SweepStalePairPromptClaims", func(q *Queries) error { _, err := q.SweepStalePairPromptClaims(context.Background()); return err }},
	}

	for _, tc := range cases {
		t.Run(tc.name+"_query", func(t *testing.T) {
			err := tc.call(New(pairSessionsSQLHDB{queryErr: sentinel}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_scan", func(t *testing.T) {
			err := tc.call(New(pairSessionsSQLHDB{rows: &pairSessionsSQLHRows{next: true, scanErr: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
		t.Run(tc.name+"_rows_err", func(t *testing.T) {
			err := tc.call(New(pairSessionsSQLHDB{rows: &pairSessionsSQLHRows{err: sentinel}}))
			require.ErrorIs(t, err, sentinel)
		})
	}
}

func TestPairSessionsSQL_H_ExecErrorBranches(t *testing.T) {
	sentinel := errors.New("pair sessions h exec failed")
	q := New(pairSessionsSQLHDB{execErr: sentinel})
	err := q.RevokeLivePairSessionLinksForRole(context.Background(), RevokeLivePairSessionLinksForRoleParams{SessionID: "session", Role: "viewer"})
	require.ErrorIs(t, err, sentinel)
}

func pairSessionsSQLHCreateSession(t *testing.T, q *Queries, pool DBTX, ownerID, repoID int64) PairSession {
	t.Helper()
	sourceWorkspaceID := mustCreateWorkspace(t, pool, ownerID, repoID)
	session, err := q.CreatePairSession(context.Background(), CreatePairSessionParams{
		ID:                "pair-h-" + randSlug(t),
		OwnerUserID:       ownerID,
		SourceWorkspaceID: sourceWorkspaceID,
		AccessMode:        "restricted",
	})
	require.NoError(t, err)
	return session
}

func pairSessionsSQLHHasMember(members []PairSessionMember, userID int64) bool {
	for _, member := range members {
		if member.UserID == userID {
			return true
		}
	}
	return false
}

func pairSessionsSQLHHasSession(sessions []PairSession, id string) bool {
	for _, session := range sessions {
		if session.ID == id {
			return true
		}
	}
	return false
}

type pairSessionsSQLHDB struct {
	execErr  error
	queryErr error
	rows     pgx.Rows
	row      pgx.Row
}

func (db pairSessionsSQLHDB) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, db.execErr
}

func (db pairSessionsSQLHDB) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	if db.queryErr != nil {
		return nil, db.queryErr
	}
	if db.rows != nil {
		return db.rows, nil
	}
	return &pairSessionsSQLHRows{}, nil
}

func (db pairSessionsSQLHDB) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	if db.row != nil {
		return db.row
	}
	return pairSessionsSQLHRow{err: errors.New("pair sessions h row failed")}
}

type pairSessionsSQLHRow struct {
	err error
}

func (r pairSessionsSQLHRow) Scan(...any) error {
	return r.err
}

type pairSessionsSQLHRows struct {
	next    bool
	scanErr error
	err     error
}

func (r *pairSessionsSQLHRows) Close() {}

func (r *pairSessionsSQLHRows) Err() error {
	return r.err
}

func (r *pairSessionsSQLHRows) CommandTag() pgconn.CommandTag {
	return pgconn.CommandTag{}
}

func (r *pairSessionsSQLHRows) FieldDescriptions() []pgconn.FieldDescription {
	return nil
}

func (r *pairSessionsSQLHRows) Next() bool {
	if r.next {
		r.next = false
		return true
	}
	return false
}

func (r *pairSessionsSQLHRows) Scan(...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	return errors.New("pair sessions h scan unexpectedly succeeded")
}

func (r *pairSessionsSQLHRows) Values() ([]any, error) {
	return nil, r.err
}

func (r *pairSessionsSQLHRows) RawValues() [][]byte {
	return nil
}

func (r *pairSessionsSQLHRows) Conn() *pgx.Conn {
	return nil
}
