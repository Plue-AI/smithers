package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
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
	return withInstallRepositoryMutation(ctx, s, actor, owner, name, "repo.topics.update", func(repository int64) (InstallSubject, error) {
		return InstallRepoTopicsSubject(repository, ReplaceRepoTopicsInput{Topics: topics})
	}, func(ctx context.Context, scoped *RepoService) ([]string, error) {
		return scoped.ReplaceRepoTopics(ctx, actor, owner, name, topics)
	})
}
