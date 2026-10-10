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
	// A store without the stack contract is refused. The shared mock answers
	// "no stack", so hide that reader to model such a store.
	_, err = newWorkspaceServiceForTests(forkStoreWithoutStackReader{mock}, WithWorkspaceUserRefs(host)).createUserRefWorkspace(ctx, input, "main", workspaceCreateMetadata{})
	requireAPICode(t, err, pkgerrors.CodeInternal)
	require.Contains(t, err.Error(), "cannot read mythical stacks")
	stack.stackErr = errors.New("database down")
	_, err = newWorkspaceServiceForTests(stack, WithWorkspaceUserRefs(host)).createUserRefWorkspace(ctx, input, "main", workspaceCreateMetadata{})
	requireAPICode(t, err, pkgerrors.CodeInternal)
	stack.stackErr = pgx.ErrNoRows
	retainedBeforeQuota := len(host.retained)
	mock.countActiveWorkspacesByUserFn = func(context.Context, int64) (int64, error) { return MaxActiveWorkspacesPerUser, nil }
	_, err = newWorkspaceServiceForTests(stack, WithWorkspaceUserRefs(host)).createUserRefWorkspace(ctx, input, "main", workspaceCreateMetadata{})
	requireAPICode(t, err, pkgerrors.CodeQuotaExceeded)
	require.Len(t, host.retained, retainedBeforeQuota, "quota must not add a pinned ref")
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

	// A valid retained pin still cannot bypass canonical machine admission.
	// Creation with real providers is covered at the composed install boundary.
	beforeValid := len(host.retained)
	// The refusal keeps its own status (7d00373587), not a 500.
	_, err = newWorkspaceServiceForTests(stack, WithWorkspaceUserRefs(host)).createUserRefWorkspace(ctx, input, "", workspaceCreateMetadata{})
	requireAPICode(t, err, pkgerrors.CodeServiceUnavailable)
	require.Contains(t, err.Error(), "branch machine providers unavailable")
	require.Len(t, host.retained, beforeValid+1)
	require.NotEmpty(t, host.retained[len(host.retained)-1].WorkspaceID)
	require.Zero(t, created)
}
