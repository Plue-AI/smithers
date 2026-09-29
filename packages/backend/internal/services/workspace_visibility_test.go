package services

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
	"strings"
	"testing"
)

type visibilityQuerier struct {
	*previewAuthorizeQuerier
	values   map[int32]bool
	storeErr error
	calls    int
}

func (q *visibilityQuerier) SetWorkspaceServicePublic(_ context.Context, p db.SetWorkspaceServicePublicParams) error {
	q.calls++
	if q.storeErr != nil {
		return q.storeErr
	}
	q.values[p.Port] = p.Public
	return nil
}
func (q *visibilityQuerier) WorkspaceServicePublic(_ context.Context, p db.WorkspaceServicePublicParams) (bool, error) {
	return q.values[p.Port], q.storeErr
}
func (q *visibilityQuerier) AuthorizePublicWorkspaceService(_ context.Context, p db.AuthorizePublicWorkspaceServiceParams) (bool, error) {
	q.calls++
	return q.values[p.Port] && q.user.IsActive && !q.user.ProhibitLogin && !q.user.DeletedAt.Valid, q.storeErr
}
func newVisibilityQuerier() *visibilityQuerier {
	q := &visibilityQuerier{previewAuthorizeQuerier: newPreviewAuthorizeQuerier(), values: map[int32]bool{}}
	q.mockWorkspaceQuerier.getWorkspaceFn = func(_ context.Context, id string) (db.Workspace, error) {
		return db.Workspace{ID: id, RepositoryID: 101, UserID: 42}, nil
	}
	q.mockWorkspaceQuerier.getWorkspaceByRepoFn = func(_ context.Context, p db.GetWorkspaceByRepoParams) (db.Workspace, error) {
		return db.Workspace{ID: p.ID, RepositoryID: p.RepositoryID, UserID: 42}, nil
	}
	return q
}
func TestWorkspaceVisibilityOwnerAndRevocation(t *testing.T) {
	ctx := context.Background()
	const id = "11111111-1111-4111-8111-111111111111"
	const domain = "3000-" + id + ".preview.jjhub.tech"
	q := newVisibilityQuerier()
	s := newWorkspaceServiceForTests(q)
	public, err := s.WorkspaceServicePublic(ctx, id, 101, 42, 3000)
	require.NoError(t, err)
	require.False(t, public)
	require.Error(t, s.AuthorizePublicPreview(ctx, domain))
	require.NoError(t, s.SetWorkspaceServicePublic(ctx, id, 101, 42, 3000, true))
	require.NoError(t, s.AuthorizePublicPreview(ctx, domain))
	require.NoError(t, s.AuthorizePublicPreview(ctx, "3000-"+id+".preview.example.test"))
	q.collaborator = ""
	require.Error(t, s.AuthorizePublicPreview(ctx, domain))
	q.collaborator = "read"
	require.Error(t, s.AuthorizePublicPreview(ctx, "3001-"+id+".preview.jjhub.tech"))
	q.user.ProhibitLogin = true
	require.Error(t, s.AuthorizePublicPreview(ctx, domain))
	require.Error(t, s.SetWorkspaceServicePublic(ctx, id, 101, 42, 3000, true))
	q.user.ProhibitLogin = false
	q.user.IsActive = false
	require.Error(t, s.AuthorizePublicPreview(ctx, domain))
	q.user.IsActive = true
	q.user.DeletedAt = pgtype.Timestamptz{Valid: true}
	require.Error(t, s.AuthorizePublicPreview(ctx, domain))
	q.user.DeletedAt = pgtype.Timestamptz{}
	require.NoError(t, s.SetWorkspaceServicePublic(ctx, id, 101, 42, 3000, false))
	require.Error(t, s.AuthorizePublicPreview(ctx, domain))
	q.shareGrantee = 99
	for _, level := range []string{"read", "write"} {
		q.mockWorkspaceQuerier.getWorkspaceShareFn = func(_ context.Context, p db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{WorkspaceID: p.WorkspaceID, GranteeUserID: p.GranteeUserID, Level: level}, nil
		}
		before := q.calls
		require.Error(t, s.SetWorkspaceServicePublic(ctx, id, 101, 99, 3000, true), level)
		require.Equal(t, before, q.calls, level)
	}
	require.Error(t, s.SetWorkspaceServicePublic(ctx, id, 101, 42, 0, true))
	q.storeErr = errors.New("down")
	storageErr := q.storeErr
	assertStorageError := func(err error, message string) {
		t.Helper()
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		require.Equal(t, 500, apiErr.Status)
		require.Equal(t, message, apiErr.Message)
		require.Same(t, storageErr, apiErr.Cause())
	}
	assertStorageError(s.SetWorkspaceServicePublic(ctx, id, 101, 42, 3000, true), "save workspace visibility")
	_, err = s.WorkspaceServicePublic(ctx, id, 101, 42, 3000)
	assertStorageError(err, "load workspace visibility")
	assertStorageError(s.AuthorizePublicPreview(ctx, domain), "authorize public preview")
	q.storeErr = nil
	q.values[3000] = true
	q.mockWorkspaceQuerier.getWorkspaceFn = func(context.Context, string) (db.Workspace, error) {
		return db.Workspace{}, storageErr
	}
	assertStorageError(s.AuthorizePublicPreview(ctx, domain), "load public preview workspace")
}
func TestPublicPreviewRejectsNoncanonicalDomains(t *testing.T) {
	q := newVisibilityQuerier()
	s := newWorkspaceServiceForTests(q)
	for _, domain := range []string{"", "smithers-desk-vm.preview.jjhub.tech", "0-11111111-1111-4111-8111-111111111111.preview.jjhub.tech", "65536-11111111-1111-4111-8111-111111111111.preview.jjhub.tech", "03000-11111111-1111-4111-8111-111111111111.preview.jjhub.tech", "3000-11111111-1111-4111-8111-111111111111.preview..evil"} {
		require.Error(t, s.AuthorizePublicPreview(context.Background(), domain))
	}
	for _, suffix := range []string{"-example.test", "example-.test", "Example.test", "example.test.", strings.Repeat("a", 64) + ".test", strings.Repeat("a.", 130) + "test"} {
		require.Error(t, s.AuthorizePublicPreview(context.Background(), "3000-11111111-1111-4111-8111-111111111111."+suffix))
	}
	require.Zero(t, q.calls)
}
