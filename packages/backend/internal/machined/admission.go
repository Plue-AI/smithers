package machined

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// RetainedConflict is selected from the stack's committed conflict reservation.
// It is never a caller-selected wake destination or permission to move main.
type RetainedConflict struct{ Change, Onto string }

// BindHostHeadReader reuses the install's authoritative private-ref reader.
// A guest observation can never select a replacement wake head.
func (r *Registry) BindHostHeadReader(read func(context.Context, string) (string, error)) {
	r.mu.Lock()
	r.hostHeadReader = read
	r.mu.Unlock()
}

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
		// SQL commits a replayed capture before its native acknowledgment. A
		// restart can select that committed host head while the retained daemon
		// still has the corresponding event queued. Drain that exact replay;
		// never inspect a different acknowledged head or invent readiness.
		drain, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		for {
			status, err := l.call(drain, branch, wire.Status)
			if err != nil {
				return err
			}
			if bytes.Equal(status[5], selected) {
				break
			}
			if binary.BigEndian.Uint32(status[4]) == 0 {
				return fmt.Errorf("retained conflict acknowledgment differs from host head: %w", ErrNotReady)
			}
			select {
			case <-drain.Done():
				return drain.Err()
			case <-time.After(20 * time.Millisecond):
			}
		}
		ctx = context.WithValue(ctx, retainedAdmissionKey{}, branch)
		_, err = l.call(ctx, branch, wire.InspectConflict, wire.Field(1, change), wire.Field(2, onto))
		if err != nil {
			return fmt.Errorf("retained conflict native inspection: %w", err)
		}
		return nil
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
		for attempt := 0; attempt < 3; attempt++ {
			err = link.recoverRetainedConflict(ctx, branch, head, retained[0])
			if !errors.Is(err, ErrNotReady) {
				break
			}
			r.mu.Lock()
			read := r.hostHeadReader
			r.mu.Unlock()
			if read == nil {
				break
			}
			// Replaying an earlier capture can commit a newer host head during
			// startup. Retry only that independently authorized revision, with
			// the same retained conflict and exact native acknowledgment check.
			current, readErr := read(ctx, branch)
			if readErr != nil {
				return readErr
			}
			if current == head {
				break
			}
			head = current
		}
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
