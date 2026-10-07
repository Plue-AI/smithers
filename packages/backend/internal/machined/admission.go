package machined

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"time"
)

// AdmitReady transfers the host head before wake while its event dispatcher
// drains concurrently. It never marks an RPC response as
// ready: wake, the current roster, and the daemon's actual status must agree.
// The caller must stop the VM/admission on failure; no helper fallback is used.
func (r *Registry) AdmitReady(ctx context.Context, branch, head string, members []SessionUser) error {
	link, err := r.Current(branch)
	if err != nil {
		return err
	}
	r.mu.Lock()
	syncRoster := r.rosterSync
	r.mu.Unlock()
	// Revocation must not wait for an expensive wake/rewrite reconciliation.
	if syncRoster != nil {
		if err = syncRoster(ctx, branch); err != nil {
			return err
		}
	}
	if _, err = link.wakeReconcile(ctx, branch, head); err != nil {
		return err
	}
	if syncRoster == nil {
		if err = r.SetRoster(ctx, branch, members); err != nil {
			return err
		}
	}
	// Wake settles before its durable event receipt. Admission waits for the
	// actual drained daemon status while the event pump commits concurrently.
	wait, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for {
		fields, err := link.call(wait, branch, wire.Status)
		if err != nil {
			return err
		}
		if fields[1][0] == 3 {
			return link.Reconciled()
		}
		if fields[1][0] != 2 {
			return ErrNotReady
		}
		select {
		case <-wait.Done():
			return wait.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
}
