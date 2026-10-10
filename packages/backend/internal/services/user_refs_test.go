package services

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type fakeUserRefHost struct {
	refs     map[string]string // UserRef -> commit
	retained []repohost.RetainUserRefRequest
	users    []int64
}

func (h *fakeUserRefHost) ListUserRefs(context.Context, string, string, int64) (repohost.UserRefList, error) {
	return repohost.UserRefList{}, nil
}

func (h *fakeUserRefHost) RenewUserRef(context.Context, string, string, int64, string) (repohost.UserRefInfo, error) {
	return repohost.UserRefInfo{}, nil
}

func (h *fakeUserRefHost) RetainUserRef(_ context.Context, _, _ string, userID int64, req repohost.RetainUserRefRequest) (repohost.RetainedUserRef, error) {
	h.retained = append(h.retained, req)
	h.users = append(h.users, userID)
	ref := repohost.UserRef(userID, req.Name)
	commit, ok := h.refs[ref]
	if !ok {
		return repohost.RetainedUserRef{}, &repohost.StatusError{StatusCode: http.StatusNotFound, Code: "user_ref_missing", Message: ref + " does not exist or expired"}
	}
	return repohost.RetainedUserRef{UserRefInfo: repohost.UserRefInfo{Name: req.Name, Ref: ref, CommitID: commit},
		SourceRef: repohost.WorkspaceSourceRef(req.WorkspaceID, commit)}, nil
}

// A change starts from its caller's own pushed ref, in the caller's own
// workspace, on the migrated product schema.
func TestUserRefStartFromOnMigratedProductDatabase(t *testing.T) {
	p := newProductTestPool(t)
	ctx := t.Context()
	// Migration 0108 seeds the machine service user, so ids are assigned, and
	// keeps one active machine per branch, so each workspace has its own.
	var alice, bob int64
	require.NoError(t, p.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES ('alice','alice') RETURNING id`).Scan(&alice))
	require.NoError(t, p.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES ('bob','bob') RETURNING id`).Scan(&bob))
	var repoID int64
	require.NoError(t, p.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'demo','demo') RETURNING id`, alice).Scan(&repoID))
	var alices, bobs string
	require.NoError(t, p.QueryRow(ctx, `INSERT INTO workspaces (repository_id, user_id, target_bookmark) VALUES ($1, $2, 'alice') RETURNING id::text`, repoID, alice).Scan(&alices))
	require.NoError(t, p.QueryRow(ctx, `INSERT INTO workspaces (repository_id, user_id, target_bookmark) VALUES ($1, $2, 'bob') RETURNING id::text`, repoID, bob).Scan(&bobs))

	commit := strings.Repeat("c", 40)
	host := &fakeUserRefHost{refs: map[string]string{repohost.UserRef(alice, "head"): commit, repohost.UserRef(alice, "spike"): commit}}
	s := NewUserRefService(host, db.New(p))

	// No name: the caller's head.
	source, err := s.StartFrom(ctx, "alice", "demo", repoID, alice, alices, "")
	require.NoError(t, err)
	assert.Equal(t, "head", source.Name)
	require.NotNil(t, source.Base)
	assert.Equal(t, UserRefBase{CommitID: commit, Ref: repohost.WorkspaceSourceRef(alices, commit)}, *source.Base)

	// A named ref of the caller.
	source, err = s.StartFrom(ctx, "alice", "demo", repoID, alice, alices, "spike")
	require.NoError(t, err)
	assert.Equal(t, "spike", source.Name)
	require.NotNil(t, source.Base)

	// Bob has no head: his change starts from his workspace as it is.
	source, err = s.StartFrom(ctx, "alice", "demo", repoID, bob, bobs, "")
	require.NoError(t, err)
	assert.Nil(t, source.Base)
	// A name Bob never pushed is refused, and never resolves in Alice's namespace.
	_, err = s.StartFrom(ctx, "alice", "demo", repoID, bob, bobs, "spike")
	requireAPICode(t, err, pkgerrors.CodeUserRefMissing)
	assert.Equal(t, []int64{alice, alice, bob, bob}, host.users)

	// No one pins a ref into someone else's workspace.
	calls := len(host.retained)
	_, err = s.StartFrom(ctx, "alice", "demo", repoID, bob, alices, "")
	requireAPICode(t, err, pkgerrors.CodeNotFound)
	_, err = s.StartFrom(ctx, "alice", "demo", repoID, alice, "not-a-uuid", "")
	requireAPICode(t, err, pkgerrors.CodeNotFound)
	_, err = s.StartFrom(ctx, "alice", "demo", repoID, alice, alices, "../head")
	requireAPICode(t, err, pkgerrors.CodeBadRequest)
	assert.Len(t, host.retained, calls)

	// A repository that lands through its mythical stack starts lanes from its tip.
	_, err = p.Exec(ctx, `INSERT INTO mythical_stacks(repository_id, actor_user_id) VALUES ($1, $2)`, repoID, alice)
	require.NoError(t, err)
	source, err = s.StartFrom(ctx, "alice", "demo", repoID, alice, alices, "")
	require.NoError(t, err)
	assert.Nil(t, source.Base)
	_, err = s.StartFrom(ctx, "alice", "demo", repoID, alice, alices, "spike")
	requireAPICode(t, err, pkgerrors.CodeUserRefStack)
	assert.Len(t, host.retained, calls)
}

func requireAPICode(t *testing.T, err error, code pkgerrors.Code) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(err, &apiErr), "want %s, got %v", code, err)
	assert.Equal(t, code, apiErr.Code)
}
