package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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

func InstallRepositoryEgressPatchSubject(repository int64, input RepositoryEgressPatchInput) (InstallSubject, error) {
	subject := InstallRepositoryEgressSubject(repository)
	raw, err := json.Marshal(input)
	if err != nil {
		return subject, err
	}
	digest := sha256.Sum256(raw)
	subject.PayloadDigest = hex.EncodeToString(digest[:])
	return subject, nil
}

func (s *RepositoryEgressPolicyService) patchInstallEgressPolicy(ctx context.Context, actor *db.User, repository int64, input RepositoryEgressPatchInput) (RepositoryEgressPolicyUpdate, error) {
	if actor == nil || s.install.pool == nil {
		return RepositoryEgressPolicyUpdate{}, confirmationPermission()
	}
	var result RepositoryEgressPolicyUpdate
	err := withRepositoryEgressConnection(ctx, s.install.pool, repository, func(conn *pgxpool.Conn) error {
		tx, err := conn.Begin(ctx)
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
		q := db.New(tx)
		subject, err := InstallRepositoryEgressPatchSubject(repository, input)
		if err != nil {
			return err
		}
		decision, err := Authorize(ctx, q, "egress.update", subject)
		if err != nil {
			return err
		}
		if decision.UserID != actor.ID {
			return confirmationPermission()
		}
		admitted := WithInstallAuthorization(ctx, "egress.update", decision, subject)
		if err = lockInstallRepositoryAdminMutation(admitted, tx, repository); err != nil {
			return err
		}
		if err = guardInstallMemberCredential(admitted, tx, repository, actor.ID, false); err != nil {
			return err
		}
		normalized, err := normalizeRepositoryEgressPatch(input)
		if err != nil {
			return err
		}
		row, ids, err := writeRepositoryEgressPolicy(admitted, q, actor, repository, normalized)
		if err != nil {
			return err
		}
		if err = guardInstallMemberCredential(admitted, tx, repository, actor.ID, false); err != nil {
			return err
		}
		if err = tx.Commit(admitted); err != nil {
			return err
		}
		// Reloads apply committed desired state. Their effects cannot be rolled back
		// with the request. Keep the existing session lock through every reload so
		// a newer policy cannot be overwritten by this request's older list.
		result = RepositoryEgressPolicyUpdate{RepositoryEgressPolicy: repositoryEgressPolicy(row), Reloads: s.reload(admitted, ids, row.AllowDomains)}
		final, err := conn.Begin(admitted)
		if err != nil {
			return err
		}
		defer func() { _ = final.Rollback(context.WithoutCancel(admitted)) }()
		return guardInstallMemberCredential(admitted, final, repository, actor.ID, false)
	})
	if err != nil {
		return RepositoryEgressPolicyUpdate{}, err
	}
	return result, nil
}
