package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type userRefStackQuerier struct {
	*mockWorkspaceQuerier
	stackErr error
}

func (q *userRefStackQuerier) GetMythicalStack(context.Context, int64) (db.MythicalStack, error) {
	return db.MythicalStack{}, q.stackErr
}

type fixedUserRefHost struct {
	fakeUserRefHost
	retained repohost.RetainedUserRef
}

func (h *fixedUserRefHost) RetainUserRef(context.Context, string, string, int64, repohost.RetainUserRefRequest) (repohost.RetainedUserRef, error) {
	return h.retained, nil
}

// Every refusal of a pushed-ref workspace happens before a row exists.
func TestCreateUserRefWorkspaceRefusals(t *testing.T) {
	ctx := context.Background()
	commit := strings.Repeat("e", 40)
	input := CreateWorkspaceInput{RepositoryID: 3, UserID: 4, RepoOwner: "o", RepoName: "r", SourceRef: "spike"}
	created := 0
	mock := &mockWorkspaceQuerier{createWorkspaceFn: func(_ context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
		created++
		return db.Workspace{}, errors.New("insert failed")
	}}
	stack := &userRefStackQuerier{mockWorkspaceQuerier: mock, stackErr: pgx.ErrNoRows}
	host := &fakeUserRefHost{refs: map[string]string{repohost.UserRef(4, "spike"): commit}}

	_, err := newWorkspaceServiceForTests(stack).createUserRefWorkspace(ctx, input, "main", workspaceCreateMetadata{})
	requireAPICode(t, err, pkgerrors.CodeServiceUnavailable)
	_, err = newWorkspaceServiceForTests(mock, WithWorkspaceUserRefs(host)).createUserRefWorkspace(ctx, input, "main", workspaceCreateMetadata{})
	requireAPICode(t, err, pkgerrors.CodeInternal)
	stack.stackErr = errors.New("database down")
	_, err = newWorkspaceServiceForTests(stack, WithWorkspaceUserRefs(host)).createUserRefWorkspace(ctx, input, "main", workspaceCreateMetadata{})
	requireAPICode(t, err, pkgerrors.CodeInternal)
	stack.stackErr = pgx.ErrNoRows
	mock.countActiveWorkspacesByUserFn = func(context.Context, int64) (int64, error) { return MaxActiveWorkspacesPerUser, nil }
	_, err = newWorkspaceServiceForTests(stack, WithWorkspaceUserRefs(host)).createUserRefWorkspace(ctx, input, "main", workspaceCreateMetadata{})
	requireAPICode(t, err, pkgerrors.CodeQuotaExceeded)
	require.Empty(t, host.retained, "quota is checked before the ref is pinned")
	mock.countActiveWorkspacesByUserFn = nil

	// A host answer that is not the requested workspace's pin is refused.
	for _, retained := range []repohost.RetainedUserRef{
		{UserRefInfo: repohost.UserRefInfo{CommitID: "short"}, SourceRef: repohost.WorkspaceSourceRef("x", "short")},
		{UserRefInfo: repohost.UserRefInfo{CommitID: commit}, SourceRef: repohost.WorkspaceSourceRef("another-workspace", commit)},
	} {
		_, err = newWorkspaceServiceForTests(stack, WithWorkspaceUserRefs(&fixedUserRefHost{retained: retained})).
			createUserRefWorkspace(ctx, input, "main", workspaceCreateMetadata{})
		requireAPICode(t, err, pkgerrors.CodeInternal)
	}
	require.Zero(t, created)

	// The row carries the pinned commit and the requested workspace ID.
	var params db.CreateWorkspaceParams
	mock.createWorkspaceFn = func(_ context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
		params = arg
		return db.Workspace{}, errors.New("insert failed")
	}
	_, err = newWorkspaceServiceForTests(stack, WithWorkspaceUserRefs(host)).createUserRefWorkspace(ctx, input, "", workspaceCreateMetadata{})
	requireAPICode(t, err, pkgerrors.CodeInternal)
	require.Equal(t, commit, params.SourceCommit)
	require.True(t, params.ID.Valid)
	require.Equal(t, "main", params.TargetBookmark)
	require.True(t, params.IsFork)
	require.Equal(t, UUIDString(params.ID), host.retained[0].WorkspaceID)
}
