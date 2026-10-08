package machined

import (
	"bytes"
	"context"
	"fmt"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// RetainedConflict is selected from the stack's committed conflict reservation.
// It is never a caller-selected wake destination or permission to move main.
type RetainedConflict struct{ Change, Onto string }

type retainedAdmissionKey struct{}

// Recover only the stack's persisted rebase through the existing inspection
// call. Ordinary inspections still require ready admission. The acknowledged
// native head must be the host-selected head before any inspection can warm it.
func (l *Link) recoverRetainedConflict(ctx context.Context, branch, head string, retained *RetainedConflict) error {
	selected, err := oid(head)
	if err != nil {
		return err
	}
	change, err := oid(retained.Change)
	if err != nil {
		return err
	}
	onto, err := oid(retained.Onto)
	if err != nil {
		return err
	}
	return l.withWake(ctx, branch, head, func(ctx context.Context) error {
		status, err := l.call(ctx, branch, wire.Status)
		if err != nil {
			return err
		}
		if !bytes.Equal(status[5], selected) {
			return ErrNotReady
		}
		ctx = context.WithValue(ctx, retainedAdmissionKey{}, branch)
		_, err = l.call(ctx, branch, wire.InspectConflict, wire.Field(1, change), wire.Field(2, onto))
		return err
	})
}

// AdmitReady transfers the host head before wake while its event dispatcher
// drains concurrently. It never marks an RPC response as
// ready: wake, the current roster, and the daemon's actual status must agree.
// The caller must stop the VM/admission on failure; no helper fallback is used.
func (r *Registry) AdmitReady(ctx context.Context, branch, head string, members []SessionUser, retained ...*RetainedConflict) error {
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
	if len(retained) > 1 {
		return fmt.Errorf("multiple retained conflicts")
	}
	if len(retained) == 1 && retained[0] != nil {
		err = link.recoverRetainedConflict(ctx, branch, head, retained[0])
	} else {
		_, err = link.wakeReconcile(ctx, branch, head)
	}
	if err != nil {
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
