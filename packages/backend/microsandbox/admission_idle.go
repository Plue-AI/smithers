package microsandbox

import (
	"context"
	"errors"
	"time"
)

// AdmissionIdleProviders reads the existing authorities; it stores no queue or
// machine state. Prepare must hold the branch lifecycle barrier, recheck safety,
// flush and capture, publish the verified head and drain the acknowledged outbox.
// A failed Prepare must reopen that barrier and must never issue a VM stop.
// Stop consumes the barrier after successful preparation. It must use the normal
// runtime stop observer: a transport acknowledgment cannot release the slot.
type AdmissionIdleProviders struct {
	Now      func() time.Time // optional test clock; production uses time.Now
	FreeDisk func(context.Context) (int64, error)
	Safety   func(context.Context) ([]AdmissionSafety, error)
	Prepare  func(context.Context, string) error
	Stop     func(context.Context, string) error
}

// ReconcileAdmissionIdle runs one safe-idle release. The install invokes it on
// admission events and its one-second tick. Missing safety or capture adapters
// refuse release, including after restart. Provider I/O never holds the VM mutex.
func (r *Runtime) ReconcileAdmissionIdle(ctx context.Context, now, hostStarted time.Time, p AdmissionIdleProviders) error {
	if p.FreeDisk == nil || p.Safety == nil || p.Prepare == nil || p.Stop == nil {
		return errors.New("admission idle providers unavailable")
	}
	if !r.admissionIdleMu.TryLock() {
		return nil
	}
	defer r.admissionIdleMu.Unlock()
	if hostStarted.IsZero() || now.Sub(hostStarted) < 30*time.Second {
		return nil
	}
	maximum, err := r.admissionMaximum(ctx, p.FreeDisk)
	if err != nil {
		return err
	}
	observations, err := p.Safety(ctx)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return errors.New("microsandbox runtime is closed")
	}
	holder := r.admissionIdleCandidateLocked(now, observations, false, false, maximum)
	if holder == "" {
		r.mu.Unlock()
		return nil
	}
	h := r.admission[holder]
	h.idlePreparing = true
	r.mu.Unlock()
	// Preparing is separate from releasing: a capture failure must never start
	// the sixty-second force-stop timer and discard acknowledged edits.
	err = p.Prepare(ctx, holder)
	r.mu.Lock()
	h.idlePreparing = false
	if err != nil {
		changed := false
		if h.held && h.releasing.IsZero() {
			for _, row := range h.rows {
				if row.State == "waiting" {
					row.State = "granted"
					changed = true
				}
			}
		}
		// Wake callers whose demand arrived during capture. An unchanged
		// failure must retry on the tick rather than spin the waiting queue.
		if changed {
			r.rankAdmissionLocked()
			r.notifyAdmissionLocked()
		}
		r.mu.Unlock()
		return err
	}
	if h.held && h.releasing.IsZero() {
		h.releasing = time.Now()
		if p.Now != nil {
			h.releasing = p.Now()
		}
	}
	r.notifyAdmissionLocked()
	r.mu.Unlock()
	stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
	defer cancel()
	return p.Stop(stopCtx, holder)
}

// SetAdmissionIdleProviders mounts authoritative safety and the existing sleep
// lifecycle. Partial composition is rejected; no synthetic empty safety is used.
func (r *Runtime) SetAdmissionIdleProviders(p AdmissionIdleProviders) error {
	if p.FreeDisk == nil || p.Safety == nil || p.Prepare == nil || p.Stop == nil {
		return errors.New("admission idle providers unavailable")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return errors.New("microsandbox runtime is closed")
	}
	r.admissionIdle = &p
	if r.admissionStarted.IsZero() {
		r.admissionStarted = time.Now()
	}
	return nil
}

func (r *Runtime) reconcileConfiguredAdmissionIdle(ctx context.Context, now time.Time) error {
	r.mu.Lock()
	p, start := r.admissionIdle, r.admissionStarted
	r.mu.Unlock()
	if p == nil {
		return nil
	}
	if p.Now != nil {
		now = p.Now()
	}
	return r.ReconcileAdmissionIdle(ctx, now, start, *p)
}

func (r *Runtime) admissionMaximum(ctx context.Context, freeDisk func(context.Context) (int64, error)) (int, error) {
	r.mu.Lock()
	reader, profile := r.capacityReader, r.config.HostProfile
	r.mu.Unlock()
	if reader == nil || profile == nil || freeDisk == nil {
		return 0, errors.New("admission host profile or owner capacity unavailable")
	}
	maximum, err := reader(ctx)
	if err != nil {
		return 0, err
	}
	free, err := freeDisk(ctx)
	if err != nil {
		return 0, err
	}
	sizing := ComputeSizing(*profile)
	return min(maximum, sizing.MemoryCapacity, sizing.CoreCapacity, int(max(int64(0), free-MinFreeDiskBytes)/MachineDiskBytes)), nil
}
