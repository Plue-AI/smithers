package services

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func InstallRepoArchiveSubject(repository int64, archived bool) InstallSubject {
	resource := "unarchive"
	if archived {
		resource = "archive"
	}
	return InstallSubject{RepositoryID: repository, Resource: resource}
}

func (s *RepoService) withInstallRepoArchive(ctx context.Context, actor *db.User, owner, name string, archived bool) (db.Repository, error) {
	subject := InstallRepoArchiveSubject(0, archived)
	return withInstallRepositoryMutation(ctx, s, actor, owner, name, "repo."+subject.Resource, func(repository int64) (InstallSubject, error) {
		return InstallRepoArchiveSubject(repository, archived), nil
	}, func(ctx context.Context, scoped *RepoService) (db.Repository, error) {
		if archived {
			return scoped.ArchiveRepo(ctx, actor, owner, name)
		}
		return scoped.UnarchiveRepo(ctx, actor, owner, name)
	})
}
