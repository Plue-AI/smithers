package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

// A writer that races past the count pre-check hits the database cap
// trigger; the caller must see the same quota refusal, not a 500.
func TestSecretService_CapTriggerRaceIsAQuotaRefusal(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	actor := &db.User{ID: 1, IsAdmin: true}
	wantStatus := pkgerrors.QuotaExceeded("x").Status

	repoSvc := NewSecretService(&mockSecretQuerier{
		createOrUpdateFn: func(context.Context, db.CreateOrUpdateSecretParams) (db.RepositorySecret, error) {
			return db.RepositorySecret{}, &pgconn.PgError{Code: "23514", ConstraintName: "repository_secrets_repo_cap"}
		},
	}, webhook.NoopSecretCodec{})
	_, err := repoSvc.SetSecret(ctx, actor, "alice", "demo", "TOKEN", "v", nil)
	requireAPIErrorStatus(t, err, wantStatus)

	orgSvc := NewSecretService(&mockSecretQuerier{
		getOrgMemberFn: func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{Role: "owner"}, nil
		},
		createOrgSecretFn: func(context.Context, db.CreateOrUpdateOrgSecretParams) (db.OrganizationSecret, error) {
			return db.OrganizationSecret{}, &pgconn.PgError{Code: "23514", ConstraintName: "organization_secrets_org_cap"}
		},
	}, webhook.NoopSecretCodec{})
	_, err = orgSvc.SetOrgSecret(ctx, actor, "acme", "TOKEN", "v")
	requireAPIErrorStatus(t, err, wantStatus)
}
