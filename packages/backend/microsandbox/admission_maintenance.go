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
	for _, h := range r.admission {
		if h.health != nil {
			return errors.New("maintenance health wake in progress")
		}
	}
	r.admissionFrozen = false
	r.notifyAdmissionLocked()
	return nil
}

// MaintenanceHealthWake reserves the freeze's only slot for a retained warm
// machine. It uses the ordinary start/guest/stop path and never resumes normal
// admission. The installing-owner boundary must authorize the frozen operation
// before calling this method; the private context capability cannot be supplied
// by an HTTP caller or reused after this call.
func (r *Runtime) MaintenanceHealthWake(ctx context.Context, id, op string, p AdmissionProviders) (err error) {
	ctx, cancelWake := context.WithTimeout(ctx, 30*time.Second)
	defer cancelWake()
	if op == "" || id == "" || p.Ready == nil || p.FreeDisk == nil {
		return errors.New("maintenance health providers unavailable")
	}
	holder := "maintenance:" + op
	request := AdmissionRequest{Holder: "workspace:" + id, Actor: holder, Class: "background", Reason: "health", State: "granted"}
	if err := p.Ready(ctx, request); err != nil {
		return err
	}
	maximum, err := r.admissionMaximum(ctx, p.FreeDisk)
	if err != nil {
		return err
	}
	r.mu.Lock()
	if err := ctx.Err(); err != nil {
		r.mu.Unlock()
		return err
	}
	ws, err := r.workspaceLocked(id)
	if err != nil {
		r.mu.Unlock()
		return err
	}
	if r.closed || !r.admissionFrozen || r.admissionRecoveryPending || r.inUseLocked() != 0 || maximum < 1 || ws.State != "stopped" || ws.Reclaimed {
		r.mu.Unlock()
		return errors.New("maintenance health requires frozen admission, free capacity and a retained stopped machine")
	}
	if r.admission == nil {
		r.admission = map[string]*admissionHolder{}
	}
	h := r.admission[holder]
	if h == nil {
		h = &admissionHolder{rows: map[string]*AdmissionRequest{}}
		r.admission[holder] = h
	}
	token := &maintenanceHealthGrant{}
	h.health, h.held, h.machine, h.releasing = token, true, "", time.Time{}
	r.admissionSequence++
	request.sequence = r.admissionSequence
	// The branch binding was validated above, but health owns a separate holder.
	// It must never make an ordinary TODO look machine-granted while frozen.
	request.Holder = holder
	h.rows[request.Actor] = &request
	r.notifyAdmissionLocked()
	r.mu.Unlock()
	granted := context.WithValue(WithAdmissionHolder(ctx, holder), maintenanceHealthKey{}, token)
	defer func() {
		// Cancellation cannot release capacity without a runtime stop observation.
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		stopErr := r.StopWorkspace(cleanup, id)
		r.mu.Lock()
		h.health = nil
		// A start refused before binding created no VM. A bound VM is released only
		// by StartWorkspace/StopWorkspace's independently confirmed stop.
		if h.machine == "" {
			h.held = false
			request.State = "released"
		}
		r.notifyAdmissionLocked()
		r.mu.Unlock()
		err = errors.Join(err, stopErr)
	}()
	_, err = r.StartWorkspace(granted, id)
	return err
}
