package compose

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type machineHost struct {
	pool       *pgxpool.Pool
	repository *repohost.Client
}

func newMachineHost(pool *pgxpool.Pool, repository *repohost.Client) *machineHost {
	return &machineHost{pool: pool, repository: repository}
}
func (h *machineHost) head(ctx context.Context, branch string) (string, error) {
	return machineBranchHead(h.pool, h.repository)(ctx, branch)
}
