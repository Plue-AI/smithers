package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

type installDeployKeyStore struct{ pool *pgxpool.Pool }
type DeployKeyServiceOption func(*DeployKeyService)

func WithDeployKeyInstallAuthorization(pool *pgxpool.Pool) DeployKeyServiceOption {
	return func(s *DeployKeyService) { s.install = &installDeployKeyStore{pool: pool} }
}
func InstallDeployKeySubject(repository int64, command string, id int64, input any) (InstallSubject, error) {
	subject := InstallSubject{RepositoryID: repository, Resource: "deploy-key:" + strconv.FormatInt(id, 10)}
	valid := false
	switch command {
	case "deploy-keys.create":
		_, valid = input.(CreateDeployKeyRequest)
		valid = valid && id == 0
	case "deploy-keys.read":
		_, valid = input.(struct{})
		valid = valid && id == 0
	case "deploy-keys.delete":
		_, valid = input.(struct{})
		valid = valid && id > 0
	}
	if !valid {
		return subject, pkgerrors.BadRequest("invalid deploy key request")
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return subject, pkgerrors.BadRequest("invalid deploy key request")
	}
	digest := sha256.Sum256(raw)
	subject.PayloadDigest = hex.EncodeToString(digest[:])
	return subject, nil
}
func withInstallDeployKey[T any](s *DeployKeyService, ctx context.Context, owner, name, command string, id int64, input any, effect func(*DeployKeyService, context.Context) (T, error)) (T, error) {
	var zero T
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || info.User == nil {
		return zero, &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Sign in again"}
	}
	if s.install.pool == nil {
		return zero, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "deploy key store unavailable")
	}
	tx, err := s.install.pool.Begin(ctx)
	if err != nil {
		return zero, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	installed, err := InstallRepositoryID(ctx, q)
	if err != nil {
		return zero, err
	}
	if command != "deploy-keys.read" {
		if _, err := tx.Exec(ctx, repoOwnershipSharedLockSQL, installed); err != nil {
			return zero, err
		}
		if err := lockInstallRepositoryAdminMutation(ctx, tx, installed); err != nil {
			return zero, err
		}
	}
	if err := guardInstallMemberCredential(ctx, tx, installed, info.User.ID, false); err != nil {
		return zero, err
	}
	scoped := *s
	scoped.queries = q
	repository, lookup := scoped.loadRepository(ctx, owner, name)
	subject, validation := InstallDeployKeySubject(repository.ID, command, id, input)
	decision, err := Authorize(ctx, q, command, subject)
	if err != nil {
		return zero, err
	}
	if lookup != nil {
		return zero, lookup
	}
	if validation != nil {
		return zero, validation
	}
	if repository.ID != installed || decision.UserID != info.User.ID {
		return zero, confirmationPermission()
	}
	ctx = WithInstallAuthorization(ctx, command, decision, subject)
	scoped.installAdmitted = true
	// Deletion and its durable revocation commit together. NOTIFY is delivered
	// after commit, so a rolled-back deletion cannot terminate a live SSH session.
	scoped.revocations = revocation.NewTransactionalDBPublisher(q)
	result, err := effect(&scoped, ctx)
	if err != nil {
		return zero, err
	}
	if err := guardInstallMemberCredential(ctx, tx, installed, info.User.ID, false); err != nil {
		return zero, err
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, err
	}
	return result, nil
}
