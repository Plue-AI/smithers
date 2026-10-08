package services

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type installRepositoryEgressStore struct{ pool *pgxpool.Pool }
type RepositoryEgressPolicyServiceOption func(*RepositoryEgressPolicyService)

func WithRepositoryEgressInstallAuthorization(pool *pgxpool.Pool) RepositoryEgressPolicyServiceOption {
	return func(s *RepositoryEgressPolicyService) { s.install = &installRepositoryEgressStore{pool} }
}
func InstallRepositoryEgressSubject(repository int64) InstallSubject {
	return InstallSubject{RepositoryID: repository, Resource: "egress-policy"}
}

func (s *RepositoryEgressPolicyService) getInstallEgressPolicy(ctx context.Context, repository int64) (RepositoryEgressPolicy, error) {
	if s.install.pool == nil {
		return RepositoryEgressPolicy{}, confirmationPermission()
	}
	tx, err := s.install.pool.Begin(ctx)
	if err != nil {
		return RepositoryEgressPolicy{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	subject := InstallRepositoryEgressSubject(repository)
	decision, err := Authorize(ctx, q, "egress.read", subject)
	if err != nil {
		return RepositoryEgressPolicy{}, err
	}
	ctx = WithInstallAuthorization(ctx, "egress.read", decision, subject)
	if err = guardInstallMemberCredential(ctx, tx, repository, decision.UserID, false); err != nil {
		return RepositoryEgressPolicy{}, err
	}
	result, err := readRepositoryEgressPolicy(ctx, q, repository)
	if err != nil {
		return RepositoryEgressPolicy{}, err
	}
	if err = guardInstallMemberCredential(ctx, tx, repository, decision.UserID, false); err != nil {
		return RepositoryEgressPolicy{}, err
	}
	return result, nil
}
