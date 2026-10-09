package compose

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/workspace"
)

type machineHost struct {
	registry   *machined.Registry
	pool       *pgxpool.Pool
	repository *repohost.Client
}

func newMachineHost(pool *pgxpool.Pool, repository *repohost.Client) *machineHost {
	return &machineHost{pool: pool, repository: repository}
}
func (h *machineHost) head(ctx context.Context, branch string) (string, error) {
	return machineBranchHead(h.pool, h.repository)(ctx, branch)
}

// The allowance is a Go test-composition option, never install configuration.
func requireMachineAdmissionIsolation(options runOptions) error {
	if options.Workspace != nil {
		isolation := options.Workspace.Isolation()
		if isolation == workspace.IsolationSandboxed || isolation == workspace.IsolationTrustedProcess && options.FlowHostConfig.AllowTrustedProcessForTests {
			return nil
		}
	}
	return errors.New("machine admission requires a sandboxed workspace runtime")
}

func (h *machineHost) agentMachine(branch string, boot [16]byte) (string, error) {
	if h.registry == nil {
		return "", machined.ErrUnauthorized
	}
	link, err := h.registry.Current(branch)
	if err != nil || boot != [16]byte{} && link.BootID() != boot {
		return "", machined.ErrUnauthorized
	}
	return link.Machine(), nil
}
