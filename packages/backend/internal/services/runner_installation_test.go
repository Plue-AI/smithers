package services

import "context"

type mockRunnerInstallationResolver struct {
	resolveFn func(ctx context.Context, ownerUserID, ownerOrgID int64, owner, repo string) (int64, error)
}

func (m *mockRunnerInstallationResolver) GetGitHubRepositoryForRepositoryOwner(ctx context.Context, ownerUserID int64, ownerOrgID int64, owner, repo string) (int64, int64, error) {
	if m.resolveFn != nil {
		id, err := m.resolveFn(ctx, ownerUserID, ownerOrgID, owner, repo)
		return id, testRepositoryID, err
	}
	return 0, 0, nil
}
