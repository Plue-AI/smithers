package routes

import (
	"context"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func (m mockRepoRouteService) GetRepoTopics(ctx context.Context, viewer *db.User, owner, repo string) ([]string, error) {
	return nil, nil
}

func (m mockRepoRouteService) ReplaceRepoTopics(ctx context.Context, actor *db.User, owner, repo string, topics []string) ([]string, error) {
	return nil, nil
}

func (m mockRepoRouteService) ListRepoStargazers(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]db.User, int64, error) {
	return nil, 0, nil
}

func (m mockRepoRouteService) StarRepo(ctx context.Context, actor *db.User, owner, repo string) error {
	return nil
}

func (m mockRepoRouteService) UnstarRepo(ctx context.Context, actor *db.User, owner, repo string) error {
	return nil
}

func (m mockRepoRouteService) GetRepoContents(ctx context.Context, viewer *db.User, owner, repo, ref, path string) (services.RepoContent, error) {
	if m.getContentsFn != nil {
		return m.getContentsFn(ctx, viewer, owner, repo, ref, path)
	}
	return services.RepoContent{}, errors.NotFound("content not found")
}

func (m mockRepoRouteService) ListRepoContents(ctx context.Context, viewer *db.User, owner, repo, ref, dirPath string) ([]services.RepoContent, error) {
	if m.listContentsFn != nil {
		return m.listContentsFn(ctx, viewer, owner, repo, ref, dirPath)
	}
	return nil, nil
}

func (m mockRepoRouteService) ListGitRefs(ctx context.Context, viewer *db.User, owner, repo string) ([]services.GitRef, error) {
	return nil, nil
}

func (m mockRepoRouteService) ArchiveRepo(ctx context.Context, actor *db.User, owner, repo string) (db.Repository, error) {
	return db.Repository{}, nil
}

func (m mockRepoRouteService) UnarchiveRepo(ctx context.Context, actor *db.User, owner, repo string) (db.Repository, error) {
	return db.Repository{}, nil
}

func (m mockRepoRouteService) TransferRepo(ctx context.Context, actor *db.User, owner, repo, newOwner string) (services.RepoTransferResult, error) {
	if m.transferRepoFn != nil {
		return m.transferRepoFn(ctx, actor, owner, repo, newOwner)
	}
	return services.RepoTransferResult{}, nil
}

func (m mockRepoRouteService) ListRepoTransfers(ctx context.Context, actor *db.User) ([]db.RepositoryTransferRequest, error) {
	if m.listTransfersFn != nil {
		return m.listTransfersFn(ctx, actor)
	}
	return nil, nil
}
func (m mockRepoRouteService) AcceptRepoTransfer(ctx context.Context, actor *db.User, id int64) (db.Repository, error) {
	if m.acceptTransferFn != nil {
		return m.acceptTransferFn(ctx, actor, id)
	}
	return db.Repository{}, nil
}
func (m mockRepoRouteService) DeclineRepoTransfer(ctx context.Context, actor *db.User, id int64) error {
	if m.declineTransferFn != nil {
		return m.declineTransferFn(ctx, actor, id)
	}
	return nil
}
func (m mockRepoRouteService) CancelRepoTransfer(ctx context.Context, actor *db.User, id int64) error {
	if m.cancelTransferFn != nil {
		return m.cancelTransferFn(ctx, actor, id)
	}
	return nil
}
