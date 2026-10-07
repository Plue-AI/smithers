package repohost

import (
	"context"
	"errors"
)

// MachineRepository is an install-local host capability. The engine holds its
// repository write lock for the visit; no guest chooses a host filesystem path.
type MachineRepository func(context.Context, string, string, func(string) error) error

func (c *Client) BindMachineRepository(visit MachineRepository) { c.machineRepository = visit }

func (c *Client) WithMachineRepository(ctx context.Context, owner, repo string, visit func(string) error) error {
	if c == nil || c.machineRepository == nil || visit == nil {
		return errors.New("installed machine object store unavailable")
	}
	return c.machineRepository(ctx, owner, repo, visit)
}
