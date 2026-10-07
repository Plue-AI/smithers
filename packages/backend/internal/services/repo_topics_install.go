package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type installRepositoryMutationStore struct{ pool *pgxpool.Pool }

func WithRepoInstallAuthorization(pool *pgxpool.Pool) RepoServiceOption {
	return func(s *RepoService) { s.install = &installRepositoryMutationStore{pool: pool} }
}

type ReplaceRepoTopicsInput struct {
	Topics []string `json:"topics"`
}

func InstallRepoTopicsSubject(repository int64, input ReplaceRepoTopicsInput) (InstallSubject, error) {
	subject := InstallSubject{RepositoryID: repository, Resource: "topics"}
	if _, err := normalizeTopics(input.Topics); err != nil {
		return subject, err
	}
	raw, _ := json.Marshal(input)
	digest := sha256.Sum256(raw)
	subject.PayloadDigest = hex.EncodeToString(digest[:])
	return subject, nil
}

func (s *RepoService) withInstallRepoTopics(ctx context.Context, actor *db.User, owner, name string, topics []string) ([]string, error) {
	info := middleware.AuthInfoFromContext(ctx)
	if actor == nil || info == nil || info.User == nil {
		return nil, &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Sign in again"}
	}
	if s.install.pool == nil {
		return nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "repository store unavailable")
	}
	tx, err := s.install.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	installed, err := InstallRepositoryID(ctx, q)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, repoOwnershipSharedLockSQL, installed); err != nil {
		return nil, err
	}
	if err := lockInstallRepositoryAdminMutation(ctx, tx, installed); err != nil {
		return nil, err
	}
	if err := guardInstallMemberCredential(ctx, tx, installed, info.User.ID, false); err != nil {
		return nil, err
	}
	scoped := *s
	scoped.queries = q
	repository, lookup := scoped.resolveRepoByOwnerAndName(ctx, owner, name)
	subject, validation := InstallRepoTopicsSubject(repository.ID, ReplaceRepoTopicsInput{Topics: topics})
	decision, err := Authorize(ctx, q, "repo.topics.update", subject)
	if err != nil {
		return nil, err
	}
	if lookup != nil {
		return nil, lookup
	}
	if validation != nil {
		return nil, validation
	}
	if repository.ID != installed || actor.ID != decision.UserID || actor.ID != info.User.ID {
		return nil, confirmationPermission()
	}
	scoped.installAdmitted = true
	ctx = WithInstallAuthorization(ctx, "repo.topics.update", decision, subject)
	result, err := scoped.ReplaceRepoTopics(ctx, actor, owner, name, topics)
	if err != nil {
		return nil, err
	}
	if err := guardInstallMemberCredential(ctx, tx, installed, info.User.ID, false); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}
