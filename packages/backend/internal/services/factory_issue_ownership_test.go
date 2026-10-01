package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestFactoryIssueOwnershipEligibility(t *testing.T) {
	cases := []struct {
		name, mode, label, source, event string
		factory                          bool
		number                           int64
		want                             bool
	}{
		{"implementation label", "enabled", "todo", "github", "issues", true, 1, true},
		{"implementation reply", "enabled", "todo", "github", "issue_comment", true, 1, true},
		{"ordinary explicit implementation trigger", "enabled", "TODO", "github", "issue", false, 1, true},
		{"direct factory event", "enabled", "", "github", "issues", true, 1, false},
		{"reading role", "enabled", "review", "github", "issues", true, 1, false},
		{"outsider trial", "trial", "todo", "github", "issues", true, 1, false},
		{"native trial", "trial", "todo", "smithers-cloud", "issue", false, 1, false},
		{"schedule", "enabled", "todo", "schedule", "schedule", true, 1, false},
		{"manual", "enabled", "todo", "github", "manual", true, 1, false},
		{"pull request", "enabled", "todo", "github", "pull_request", true, 1, false},
		{"missing issue", "enabled", "todo", "github", "issues", true, 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			config := RegisterRepositoryJobInput{Mode: c.mode, Label: c.label}
			if c.factory {
				config.FactoryRevision = "approved-main"
			}
			dispatch := db.RepositoryJobDispatch{Source: c.source, EventType: c.event, IssueNumber: c.number}
			require.Equal(t, c.want, repositoryJobOwnsIssue(config, dispatch))
			if !c.want {
				require.NoError(t, (&RepositoryJobService{}).repositoryJobCurrentIssueApproval(context.Background(), db.RepositoryJobRegistration{}, dispatch, config), "non-implementation events never acquire a new approval prerequisite")
			}
		})
	}
}
func TestFactoryIssueOwnershipTypedConflict(t *testing.T) {
	valid := `{"claimId":"retained-claim","ownerKind":"repository-job","ownerId":"original-dispatch","approvedDigest":"approved-text"}`
	err := fmt.Errorf("canonical admission: %w", &pgconn.PgError{Code: "P2081", Detail: valid})
	owner, ok := factoryIssueOwned(err)
	require.True(t, ok)
	require.Equal(t, "Deferred to repository-job original-dispatch (claim retained-claim, approved text approved-text)", owner.reason())
	for _, err := range []error{nil, errors.New("factory issue is owned"), &pgconn.PgError{Code: "P2082", Detail: valid}, &pgconn.PgError{Code: "P2081", Detail: `{`}, &pgconn.PgError{Code: "P2081", Detail: `{"ownerKind":"mythical","ownerId":"item"}`}, &pgconn.PgError{Code: "P2081", Detail: `{"claimId":"claim","ownerKind":"mythical","ownerId":"item"}`}} {
		_, ok := factoryIssueOwned(err)
		require.False(t, ok, "only the complete canonical owner receipt is a scheduling deferral")
	}
}

type factoryIssueSnapshotStore struct {
	RepositoryJobStore
	claim        db.FactoryIssueClaim
	err          error
	continuation bool
}

func (s factoryIssueSnapshotStore) GetFactoryIssueClaimByOwner(context.Context, db.GetFactoryIssueClaimByOwnerParams) (db.FactoryIssueClaim, error) {
	if s.continuation {
		return db.FactoryIssueClaim{}, pgx.ErrNoRows
	}
	return s.claim, s.err
}
func (s factoryIssueSnapshotStore) GetFactoryIssueClaimByContinuation(context.Context, string) (db.FactoryIssueClaim, error) {
	return s.claim, s.err
}
func TestFactoryIssueOwnershipSnapshotAuthority(t *testing.T) {
	reg := db.RepositoryJobRegistration{ID: "registration", RepositoryID: 4, UserID: 7, WorkspaceID: "original-workspace", Revision: 1, Digest: "original-digest", FlowID: "engineering", Configuration: json.RawMessage(`{}`)}
	dispatch := db.RepositoryJobDispatch{ID: "original-dispatch", RegistrationID: reg.ID, Revision: reg.Revision, Digest: reg.Digest}
	operation := pgtype.UUID{Bytes: uuid.New(), Valid: true}
	makeClaim := func(reg db.RepositoryJobRegistration) db.FactoryIssueClaim {
		raw, err := json.Marshal(map[string]any{"registration": reg})
		require.NoError(t, err)
		return db.FactoryIssueClaim{ID: "claim", RepositoryID: 4, Authority: raw, OperationID: operation}
	}
	valid := makeClaim(reg)
	replaced := reg
	replaced.Revision++
	replaced.UserID = 8
	replaced.WorkspaceID = "replacement"
	service := &RepositoryJobService{q: factoryIssueSnapshotStore{claim: valid}}
	original, binding, err := service.originalRepositoryJobRegistration(context.Background(), dispatch, replaced)
	require.NoError(t, err)
	require.Equal(t, reg, original)
	require.Equal(t, uuidString(operation), binding.OperationID)
	require.False(t, binding.Signal)
	for _, mutate := range []func(*db.RepositoryJobRegistration){func(r *db.RepositoryJobRegistration) { r.ID = "foreign" }, func(r *db.RepositoryJobRegistration) { r.RepositoryID = 5 }, func(r *db.RepositoryJobRegistration) { r.Revision++ }, func(r *db.RepositoryJobRegistration) { r.Digest = "foreign" }, func(r *db.RepositoryJobRegistration) { r.WorkspaceID = "" }} {
		bad := reg
		mutate(&bad)
		service.q = factoryIssueSnapshotStore{claim: makeClaim(bad)}
		_, binding, err := service.originalRepositoryJobRegistration(context.Background(), dispatch, replaced)
		require.Error(t, err)
		require.NotNil(t, binding, "invalid authority stays fenced")
	}
	for _, raw := range []string{`{`, `{}`, `{"registration":null}`} {
		bad := valid
		bad.Authority = []byte(raw)
		service.q = factoryIssueSnapshotStore{claim: bad}
		_, binding, err = service.originalRepositoryJobRegistration(context.Background(), dispatch, replaced)
		require.Error(t, err)
		require.NotNil(t, binding)
	}
	service.q = factoryIssueSnapshotStore{err: pgx.ErrNoRows}
	original, binding, err = service.originalRepositoryJobRegistration(context.Background(), dispatch, replaced)
	require.NoError(t, err)
	require.Nil(t, binding)
	require.Equal(t, replaced, original)
	unavailable := errors.New("database unavailable")
	service.q = factoryIssueSnapshotStore{err: unavailable}
	_, _, err = service.originalRepositoryJobRegistration(context.Background(), dispatch, replaced)
	require.ErrorIs(t, err, unavailable)
	replyOperation := uuid.NewString()
	raw, err := json.Marshal(map[string]any{"registration": reg, "continuations": map[string]any{dispatch.ID: map[string]any{"registration": reg, "operationId": replyOperation}}})
	require.NoError(t, err)
	valid.Authority = raw
	service.q = factoryIssueSnapshotStore{claim: valid, continuation: true}
	original, binding, err = service.originalRepositoryJobRegistration(context.Background(), dispatch, replaced)
	require.NoError(t, err)
	require.Equal(t, reg, original)
	require.True(t, binding.Signal)
	require.Equal(t, replyOperation, binding.OperationID)
	valid.Authority = []byte(`{"continuations":{}}`)
	service.q = factoryIssueSnapshotStore{claim: valid, continuation: true}
	_, binding, err = service.originalRepositoryJobRegistration(context.Background(), dispatch, replaced)
	require.Error(t, err)
	require.NotNil(t, binding)
}
