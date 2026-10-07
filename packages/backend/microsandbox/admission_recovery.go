package microsandbox

import (
	"context"
	"errors"
	"strings"
)

// ReconstructAdmission consumes one consistent snapshot of existing durable
// jobs and sessions. It creates no persistence of its own. Retained VMs keep
// their slots; machines with no surviving demand stop before grants resume.
// Repeated startup calls are no-ops after successful reconciliation.
func (r *Runtime) ReconstructAdmission(ctx context.Context, demand []AdmissionRequest) error {
	r.admissionRecoveryMu.Lock()
	defer r.admissionRecoveryMu.Unlock()
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return errors.New("microsandbox runtime is closed")
	}
	pending := r.admissionRecoveryPending
	r.mu.Unlock()
	if !pending {
		return nil
	}
	wanted := map[string]bool{}
	for _, row := range demand {
		if !strings.HasPrefix(row.Holder, "workspace:") || len(row.Holder) == len("workspace:") || admissionPriority(row.Class) == 3 || row.Actor == "" || row.Reason == "" {
			return errors.New("invalid reconstructed admission demand")
		}
		wanted[row.Holder] = true
	}
	r.mu.Lock()
	orphaned := []*workspace{}
	for _, ws := range r.workspaces {
		if ws.recovering && !wanted["workspace:"+ws.ID] {
			orphaned = append(orphaned, ws)
		}
	}
	r.mu.Unlock()
	for _, ws := range orphaned {
		if err := r.stopMachine(ctx, ws.Machine); err != nil {
			return err
		}
		r.mu.Lock()
		ws.State = "stopped"
		ws.recovering = false
		r.detachAdmissionMachineLocked(ws.Machine, true)
		err := writeMetadata(ws)
		r.mu.Unlock()
		if err != nil {
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	for _, row := range demand {
		if row.RetainOnly {
			r.mu.Lock()
			holder := r.admission[row.Holder]
			retained := holder != nil && holder.held && holder.machine != ""
			r.mu.Unlock()
			if !retained {
				continue
			}
		}
		r.mu.Lock()
		_, err := r.requestLocked(row.Class, row.Holder, row.Actor, row.Reason)
		if err == nil && row.Class == "todo" {
			// Stack order and the saved parallel limit are reconciled by the
			// stack service before recovered waiting TODOs can grant.
			h := r.admission[row.Holder]
			h.todoScope, h.todoNeedsSync = row.RecoveryTodoScope, true
		}
		r.mu.Unlock()
		if err != nil {
			return err
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return errors.New("microsandbox runtime is closed")
	}
	r.admissionRecoveryPending = false
	r.rankAdmissionLocked()
	r.notifyAdmissionLocked()
	return nil
}

// NeedsWorkspaceReattachment distinguishes a recovered boot from another
// caller's in-flight Start. Reads never perform the reattachment themselves.
func (r *Runtime) NeedsWorkspaceReattachment(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws := r.workspaces[id]
	return !r.admissionRecoveryPending && ws != nil && ws.recovering && !ws.booting && ws.State == "starting"
}
