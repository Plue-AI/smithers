package services

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Landing a changeset lands member changes whoever wrote them, so it is a
// person's decision: a run credential (an agent run's token or the
// platform's sync token) is refused before the service reads anything, and
// a person's token or session lands it.
func TestLandChangesetRefusesRunCredentials(t *testing.T) {
	t.Parallel()
	actor := &db.User{ID: 1, Username: "alice"}

	// No queries: the refusal must come first.
	unread := &ChangesetService{}
	for name, info := range map[string]*middleware.AuthInfo{
		"agent run": {User: actor, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "write:repository"},
		"sync":      {User: actor, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "write:repository," + middleware.SyncCredentialScope()},
	} {
		_, err := unread.LandChangeset(middleware.ContextWithAuthInfo(context.Background(), info), actor, "acme", 1)
		var apiErr *pkgerrors.APIError
		require.True(t, errors.As(err, &apiErr), "%s: %v", name, err)
		assert.Equal(t, http.StatusForbidden, apiErr.Status, name)
		assert.Contains(t, apiErr.Message, "run credential", name)
	}

	for name, info := range map[string]*middleware.AuthInfo{
		"person token": {User: actor, IsTokenAuth: true, RawScopes: "write:repository"},
		"session":      {User: actor},
	} {
		_, _, svc := seedChangesetFixture(t)
		ctx := middleware.ContextWithAuthInfo(context.Background(), info)
		created, err := svc.CreateChangeset(ctx, actor, "acme", CreateChangesetInput{
			Description: "ship api",
			Members:     []ChangesetMemberInput{{Repo: "api", ChangeID: "aaaa"}},
		})
		require.NoError(t, err, name)
		landed, err := svc.LandChangeset(ctx, actor, "acme", created.ID)
		require.NoError(t, err, name)
		assert.Equal(t, "landed", landed.State, name)
	}
}

// A person's requested changes on a member's landing block the changeset
// whatever the target, as they block that landing (D-21).
func TestLandChangesetBlocksOnChangesRequested(t *testing.T) {
	t.Parallel()
	actor := &db.User{ID: 1, Username: "alice"}
	q, _, _ := seedChangesetFixture(t)
	q.landings = map[string]db.LandingRequest{"aaaa": {ID: 42, State: "open", TargetBookmark: "main"}}
	policy := &LandingService{queries: &mockLandingQuerier{
		changesRequestedFn: func(_ context.Context, landingRequestID int64) ([]string, error) {
			assert.EqualValues(t, 42, landingRequestID)
			return []string{"bob"}, nil
		},
	}}
	rh := newSeededChangesetRepoHost()
	svc := NewChangesetService(q, rh, nil, nil, WithChangesetLandingPolicy(policy))
	created, err := svc.CreateChangeset(context.Background(), actor, "acme", CreateChangesetInput{
		Description: "ship api",
		Members:     []ChangesetMemberInput{{Repo: "api", ChangeID: "aaaa"}},
	})
	require.NoError(t, err)
	_, err = svc.LandChangeset(context.Background(), actor, "acme", created.ID)
	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(err, &apiErr), "%v", err)
	assert.Equal(t, http.StatusConflict, apiErr.Status)
	assert.Equal(t, "changeset member has changes requested by bob", apiErr.Message)
	assert.Empty(t, rh.landCalls, "no member landed")
}
