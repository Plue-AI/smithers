package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// previewAuthorizeQuerier is the production store shape
// AuthorizeWorkspacePreview needs: users and repository grants on top of the
// workspace queries.
type previewAuthorizeQuerier struct {
	*mockWorkspaceQuerier
	user          db.User
	collaborator  string
	shareRevoked  bool
	shareGrantee  int64
	repoPrivateTo int64
}

func (q *previewAuthorizeQuerier) GetUserByID(_ context.Context, id int64) (db.User, error) {
	if id != q.user.ID {
		return db.User{}, pgx.ErrNoRows
	}
	return q.user, nil
}

func (q *previewAuthorizeQuerier) IsOrgOwnerForRepoUser(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
	return false, nil
}

func (q *previewAuthorizeQuerier) GetHighestTeamPermissionForRepoUser(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	return "", nil
}

func (q *previewAuthorizeQuerier) GetCollaboratorPermissionForRepoUser(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	// The query answers "" (COALESCE) when the user holds no grant.
	return q.collaborator, nil
}

func newPreviewAuthorizeQuerier() *previewAuthorizeQuerier {
	q := &previewAuthorizeQuerier{
		user:          db.User{ID: 42, IsActive: true},
		collaborator:  "read",
		shareGrantee:  42,
		repoPrivateTo: 1,
	}
	q.mockWorkspaceQuerier = &mockWorkspaceQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, UserID: pgtype.Int8{Int64: q.repoPrivateTo, Valid: true}}, nil
		},
		getWorkspaceShareFn: func(_ context.Context, arg db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			if q.shareRevoked || arg.GranteeUserID != q.shareGrantee {
				return db.WorkspaceShare{}, pgx.ErrNoRows
			}
			return db.WorkspaceShare{WorkspaceID: arg.WorkspaceID, GranteeUserID: arg.GranteeUserID, Level: "read"}, nil
		},
	}
	return q
}

// The gateway's grant recheck: a shared viewer keeps the preview while the
// share, the account and the repository grant hold, and loses it the moment
// any of them goes.
func TestAuthorizeWorkspacePreviewRechecksEveryGrant(t *testing.T) {
	t.Parallel()
	const workspaceID = "11111111-1111-4111-8111-111111111111"

	for name, tc := range map[string]struct {
		mutate func(*previewAuthorizeQuerier)
		denied bool
	}{
		"shared viewer":          {mutate: func(*previewAuthorizeQuerier) {}},
		"share removed":          {mutate: func(q *previewAuthorizeQuerier) { q.shareRevoked = true }, denied: true},
		"user suspended":         {mutate: func(q *previewAuthorizeQuerier) { q.user.ProhibitLogin = true }, denied: true},
		"user deactivated":       {mutate: func(q *previewAuthorizeQuerier) { q.user.IsActive = false }, denied: true},
		"user deleted":           {mutate: func(q *previewAuthorizeQuerier) { q.user.DeletedAt = pgtype.Timestamptz{Valid: true} }, denied: true},
		"repository access lost": {mutate: func(q *previewAuthorizeQuerier) { q.collaborator = "" }, denied: true},
		"unknown user":           {mutate: func(q *previewAuthorizeQuerier) { q.user.ID = 7 }, denied: true},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			q := newPreviewAuthorizeQuerier()
			tc.mutate(q)
			err := newWorkspaceServiceForTests(q).AuthorizeWorkspacePreview(context.Background(), workspaceID, 101, 42)
			if !tc.denied {
				require.NoError(t, err)
				return
			}
			var apiErr *pkgerrors.APIError
			require.ErrorAs(t, err, &apiErr)
			assert.Equal(t, 403, apiErr.Status)
		})
	}

	t.Run("a store without user and grant queries fails closed", func(t *testing.T) {
		t.Parallel()
		err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}).AuthorizeWorkspacePreview(context.Background(), workspaceID, 101, 1)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 500, apiErr.Status)
	})
}
