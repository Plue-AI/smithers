package microsandbox

import (
	"context"
	"errors"
	"time"
)

var ErrAdmissionFrozen = errors.New("machine admission frozen for maintenance")

// DrainMachineAdmission fences both queued grants and launches using grants
// issued before the freeze. Existing boots settle before capture enumerates
// awake machines. Auxiliary VMs retain their slots until confirmed removal.
func (r *Runtime) DrainMachineAdmission(ctx context.Context) error {
	r.mu.Lock()
	r.admissionFrozen = true
	r.notifyAdmissionLocked()
	r.mu.Unlock()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		r.mu.Lock()
		busy := len(r.auxVMs) != 0
		for _, ws := range r.workspaces {
			busy = busy || ws.booting
		}
		r.mu.Unlock()
		if !busy {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// StopMachineAdmission must not manufacture a stop receipt for an in-flight
// launcher. Capture may proceed only after the same boot boundary settles.
func (r *Runtime) StopMachineAdmission(ctx context.Context) error {
	return r.DrainMachineAdmission(ctx)
}

func (r *Runtime) ResumeMachineAdmission(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.admissionFrozen = false
	r.notifyAdmissionLocked()
	return nil
}
