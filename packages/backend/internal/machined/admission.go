package machined

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// AdmitReady runs only after host objects have reached the daemon and while its
// event dispatcher is draining concurrently. It never marks an RPC response as
// ready: wake, the current roster, and the daemon's actual status must agree.
// The caller must stop the VM/admission on failure; no helper fallback is used.
func (r *Registry) AdmitReady(ctx context.Context, branch, head string, members []SessionUser) error {
	link, err := r.Current(branch)
	if err != nil {
		return err
	}
	if _, err = r.WakeReconcile(ctx, branch, head); err != nil {
		return err
	}
	if err = r.SetRoster(ctx, branch, members); err != nil {
		return err
	}
	fields, err := link.call(ctx, branch, wire.Status)
	if err != nil {
		return err
	}
	if fields[1][0] != 3 {
		return ErrNotReady
	}
	return link.Reconciled()
}
