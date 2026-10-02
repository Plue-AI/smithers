package services

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A database outage must surface as a server failure, never as "repository
// not found" or "permission denied" that hides it from operators and users.
func TestSecretAndVariableLookupsReportDatabaseFailuresAsInternal(t *testing.T) {
	outage := errors.New("connection reset")
	secrets := &SecretService{queries: &mockSecretQuerier{
		getRepoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, outage
		},
		getOrgFn: func(context.Context, string) (db.Organization, error) { return db.Organization{}, outage },
		getOrgMemberFn: func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{}, outage
		},
	}}
	variables := &VariableService{queries: &mockVariableQuerier{
		getRepoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, outage
		},
		getOrgFn: func(context.Context, string) (db.Organization, error) { return db.Organization{}, outage },
		getOrgMemberFn: func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{}, outage
		},
	}}
	ctx := context.Background()

	_, err := secrets.resolveRepoByOwnerAndName(ctx, "alice", "demo")
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	_, err = secrets.requireOrgOwner(ctx, &db.User{ID: 1}, "acme")
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	_, err = secrets.requireOrgOwner(ctx, &db.User{ID: 1, IsAdmin: true}, "acme")
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)

	_, err = variables.resolveRepoByOwnerAndName(ctx, "alice", "demo")
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	_, err = variables.requireOrgOwner(ctx, &db.User{ID: 1}, "acme")
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	_, err = variables.requireOrgOwner(ctx, &db.User{ID: 1, IsAdmin: true}, "acme")
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)
}
