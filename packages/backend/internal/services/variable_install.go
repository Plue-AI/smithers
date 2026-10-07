package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type installVariableStore struct{ pool *pgxpool.Pool }
type SetVariableInput struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

func WithVariableInstallAuthorization(pool *pgxpool.Pool) VariableServiceOption {
	return func(s *VariableService) { s.install = &installVariableStore{pool: pool} }
}

func InstallVariableSubject(repository int64, command, name string, input any) (InstallSubject, error) {
	subject := InstallSubject{RepositoryID: repository, Resource: "variable:" + strings.TrimSpace(name)}
	switch command {
	case "variables.set":
		value, ok := input.(SetVariableInput)
		if !ok || value.Name != name {
			return subject, pkgerrors.BadRequest("invalid variable request")
		}
		if _, err := validateVariableWrite(value.Name, value.Value); err != nil {
			return subject, err
		}
	case "variables.read", "variables.delete":
		if _, ok := input.(struct{}); !ok || command == "variables.delete" && strings.TrimSpace(name) == "" {
			return subject, pkgerrors.BadRequest("invalid variable request")
		}
	default:
		return subject, confirmationPermission()
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return subject, pkgerrors.BadRequest("invalid variable request")
	}
	sum := sha256.Sum256(raw)
	subject.PayloadDigest = hex.EncodeToString(sum[:])
	return subject, nil
}

func withInstallVariable[T any](s *VariableService, ctx context.Context, actor *db.User, owner, repo, command, name string, input any, effect func(*VariableService, context.Context) (T, error)) (T, error) {
	var zero T
	info := middleware.AuthInfoFromContext(ctx)
	if actor == nil || info == nil || info.User == nil {
		return zero, &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Sign in again"}
	}
	if s.install.pool == nil {
		return zero, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "variable store unavailable")
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
	if command != "variables.read" {
		// Ownership transitions take this advisory lock before their row locks.
		// Keep that order and reuse this transaction inside the existing guard.
		if _, err := tx.Exec(ctx, repoOwnershipSharedLockSQL, installed); err != nil {
			return zero, err
		}
		if err := lockInstallRepositoryAdminMutation(ctx, tx, installed); err != nil {
			return zero, err
		}
	}
	if err := guardInstallMemberCredential(ctx, tx, installed, actor.ID, false); err != nil {
		return zero, err
	}
	scoped := *s
	scoped.queries = q
	repository, lookup := scoped.resolveRepoByOwnerAndName(ctx, owner, repo)
	subject, validation := InstallVariableSubject(repository.ID, command, name, input)
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
	if repository.ID != installed || actor.ID != decision.UserID {
		return zero, confirmationPermission()
	}
	ctx = WithInstallAuthorization(ctx, command, decision, subject)
	ctx = withRepoOwnershipTransaction(ctx, s.install.pool, tx)
	if command != "variables.read" {
		if _, err := tx.Exec(ctx, `SELECT name FROM repository_variables WHERE repository_id=$1 AND name=$2 FOR UPDATE`, repository.ID, strings.TrimSpace(name)); err != nil {
			return zero, err
		}
		if err := guardInstallMemberCredential(ctx, tx, installed, actor.ID, false); err != nil {
			return zero, err
		}
	}
	scoped.installAdmitted = true
	scoped.installRepository = &repository
	result, err := effect(&scoped, ctx)
	if err != nil {
		return zero, err
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, err
	}
	return result, nil
}
