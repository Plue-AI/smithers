package microsandbox

import (
	"context"
	"fmt"
)

// InUse includes preparation and verification; a failed stop keeps its machine held.
func (r *Runtime) InUse() int { r.mu.Lock(); defer r.mu.Unlock(); return r.inUseLocked() }

func (r *Runtime) inUseLocked() int {
	count := len(r.auxVMs)
	for _, ws := range r.workspaces {
		if ws.State != "stopped" && ws.State != "recovery_required" {
			count++
		}
	}
	for _, h := range r.admission {
		if !h.held {
			continue
		}
		counted := false
		if _, ok := r.auxVMs[h.machine]; h.machine != "" && ok {
			counted = true
		}
		for _, ws := range r.workspaces {
			if h.machine != "" && ws.Machine == h.machine && ws.State != "stopped" && ws.State != "recovery_required" {
				counted = true
			}
		}
		if !counted {
			count++
		}
	}
	return count
}

func (r *Runtime) reserveAuxVM(ctx context.Context, name string) error {
	maximum, err := r.prepareAdmission(ctx)
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.admitMachineLocked(ctx, maximum, name); err != nil {
		return err
	}
	if r.auxVMs == nil {
		r.auxVMs = map[string]struct{}{}
	}
	r.auxVMs[name] = struct{}{}
	return nil
}

func (r *Runtime) releaseAuxVM(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.auxVMs, name)
	delete(r.auxCleanup, name)
	r.detachAdmissionMachineLocked(name, false)
}

func (r *Runtime) finishAuxVM(name string) error {
	if err := r.removeMachine(context.Background(), name); err != nil {
		r.mu.Lock()
		if r.auxCleanup == nil {
			r.auxCleanup = map[string]struct{}{}
		}
		r.auxCleanup[name] = struct{}{}
		r.mu.Unlock()
		return err
	}
	r.releaseAuxVM(name)
	return nil
}

// SetCapacityReader binds the install's owner setting. Lowering never stops a
// held machine; it only refuses another boot. The reader runs outside the runtime mutex.
func (r *Runtime) SetCapacityReader(reader func(context.Context) (int, error)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.capacityReader = reader
}

// prepareAdmission performs transport and persistence work without holding mu.
// Pending removals remain counted until the CLI confirms removal; admission's
// count and insertion are still atomic under mu.
func (r *Runtime) prepareAdmission(ctx context.Context) (int, error) {
	r.mu.Lock()
	names := make([]string, 0, len(r.auxCleanup))
	for name := range r.auxCleanup {
		names = append(names, name)
	}
	reader := r.capacityReader
	maximum := r.config.MaxRunningVMs
	r.mu.Unlock()
	for _, name := range names {
		if err := r.removeMachine(ctx, name); err == nil {
			r.releaseAuxVM(name)
		}
	}
	if reader != nil {
		capacity, err := reader(ctx)
		if err != nil {
			return 0, err
		}
		if capacity < 0 {
			return 0, fmt.Errorf("capacity reader returned a negative limit")
		}
		maximum = min(maximum, capacity)
	}
	return maximum, nil
}
