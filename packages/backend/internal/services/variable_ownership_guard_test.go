package services

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type guardVariableQuerier struct {
	VariableQuerier
	writes, deletes int
	writeErr        error
}

func (m *guardVariableQuerier) GetRepoByOwnerAndLowerName(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	return guardedTestRepo(), nil
}
func (m *guardVariableQuerier) ListVariables(context.Context, int64) ([]db.RepositoryVariable, error) {
	return nil, nil
}
func (m *guardVariableQuerier) CreateOrUpdateVariable(_ context.Context, arg db.CreateOrUpdateVariableParams) (db.RepositoryVariable, error) {
	m.writes++
	return db.RepositoryVariable{Name: arg.Name, Value: arg.Value}, m.writeErr
}
func (m *guardVariableQuerier) DeleteVariable(context.Context, db.DeleteVariableParams) error {
	m.deletes++
	return m.writeErr
}

func TestSetVariable_OwnershipGuardBlocksStaleWrite(t *testing.T) {
	q := &guardVariableQuerier{}
	guard := &fakeOwnershipGuard{err: pkgerrors.Conflict("repository ownership changed concurrently")}
	svc := NewVariableService(q, WithVariableOwnershipGuard(guard))
	_, err := svc.SetVariable(context.Background(), &db.User{ID: 1}, "owner", "repo", "CONFIG", "v")
	assert.Equal(t, 409, apiStatus(t, err))
	assert.Equal(t, 1, guard.calls)
	assert.Equal(t, 0, q.writes)
}

func TestDeleteVariable_OwnershipGuardBlocksStaleWrite(t *testing.T) {
	q := &guardVariableQuerier{}
	guard := &fakeOwnershipGuard{err: pkgerrors.Conflict("repository ownership changed concurrently")}
	svc := NewVariableService(q, WithVariableOwnershipGuard(guard))
	err := svc.DeleteVariable(context.Background(), &db.User{ID: 1}, "owner", "repo", "CONFIG")
	assert.Equal(t, 409, apiStatus(t, err))
	assert.Equal(t, 0, q.deletes)
}

func TestVariableService_OwnershipGuardAllowsWrite(t *testing.T) {
	q := &guardVariableQuerier{}
	guard := &fakeOwnershipGuard{}
	svc := NewVariableService(q, WithVariableOwnershipGuard(guard))
	value, err := svc.SetVariable(context.Background(), &db.User{ID: 1}, "owner", "repo", "CONFIG", "original")
	require.NoError(t, err)
	assert.Equal(t, "original", value.Value)
	require.NoError(t, svc.DeleteVariable(context.Background(), &db.User{ID: 1}, "owner", "repo", "CONFIG"))
	assert.Equal(t, 2, guard.calls)
	assert.Equal(t, 1, q.writes)
	assert.Equal(t, 1, q.deletes)
}

func TestVariableService_OwnershipGuardPreservesErrors(t *testing.T) {
	for _, operation := range []string{"set", "delete"} {
		t.Run(operation, func(t *testing.T) {
			for _, guardErr := range []error{pkgerrors.NotFound("repository not found"), pkgerrors.Conflict("ownership changed"), pkgerrors.Internal("lock failed")} {
				q := &guardVariableQuerier{}
				svc := NewVariableService(q, WithVariableOwnershipGuard(&fakeOwnershipGuard{err: guardErr}))
				var err error
				if operation == "set" {
					_, err = svc.SetVariable(context.Background(), &db.User{ID: 1}, "owner", "repo", "CONFIG", "v")
				} else {
					err = svc.DeleteVariable(context.Background(), &db.User{ID: 1}, "owner", "repo", "CONFIG")
				}
				require.ErrorIs(t, err, guardErr)
				assert.Zero(t, q.writes+q.deletes)
			}
			cause := errors.New("SQL write failed")
			q := &guardVariableQuerier{writeErr: cause}
			svc := NewVariableService(q, WithVariableOwnershipGuard(&fakeOwnershipGuard{}))
			var err error
			if operation == "set" {
				_, err = svc.SetVariable(context.Background(), &db.User{ID: 1}, "owner", "repo", "CONFIG", "v")
			} else {
				err = svc.DeleteVariable(context.Background(), &db.User{ID: 1}, "owner", "repo", "CONFIG")
			}
			assert.Equal(t, 500, apiStatus(t, err))
			var apiErr *pkgerrors.APIError
			require.ErrorAs(t, err, &apiErr)
			require.ErrorIs(t, apiErr.Cause(), cause)
		})
	}
}
