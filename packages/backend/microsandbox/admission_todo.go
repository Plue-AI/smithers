package microsandbox

import (
	"context"
	"errors"
	"slices"
	"strings"
)

// SyncTodoAdmission reconciles stack demand in the runtime's sole waiting set.
// All waiting TODOs retain positions; only the ordered prefix fitting the owner
// limit can grant. Existing grants survive a lower limit or removal from a stack.
func (r *Runtime) SyncTodoAdmission(scope string, holders []string, limit int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if scope == "" || r.closed {
		return errors.New("TODO admission scope unavailable")
	}
	resolved := make([]string, 0, len(holders))
	for _, holder := range holders {
		resolved = append(resolved, r.todoAdmissionHolderLocked(holder))
	}
	holders = resolved
	for _, h := range r.admission {
		if h.todoScope != scope {
			continue
		}
		h.todoLimit = max(0, limit)
		h.todoEligible = false
		if !h.held {
			for _, row := range h.rows {
				if row.Class == "todo" && !slices.Contains(holders, row.Holder) && row.State == "waiting" {
					row.State = "cancelled"
				}
			}
		}
	}
	for _, holder := range holders {
		if _, err := r.requestLocked("todo", holder, holder, "machine"); err != nil {
			return err
		}
		h := r.admission[holder]
		h.todoScope, h.todoLimit = scope, max(0, limit)
	}
	r.reorderTodoAdmissionLocked(holders)
	r.refreshTodoEligibilityLocked(scope, limit)
	r.rankAdmissionLocked()
	r.notifyAdmissionLocked()
	return nil
}

func (r *Runtime) grantableAdmissionLocked() []*AdmissionRequest {
	if r.admissionFrozen {
		return nil
	}
	heads := r.rankAdmissionLocked()
	return slices.DeleteFunc(heads, func(row *AdmissionRequest) bool {
		h := r.admission[row.Holder]
		if strings.HasPrefix(row.Holder, "todo:") {
			return true
		}
		if row.Class != "todo" {
			return false
		}
		if h.todoScope == "" {
			// Recovered workspace demand must wait for authoritative stack order
			// on an install, even before the first engine/projection pass.
			return r.todoParallelReader != nil
		}
		if !h.todoEligible {
			return true
		}
		held := 0
		for _, other := range r.admission {
			if other.todoScope == h.todoScope && other.held {
				held++
			}
		}
		return held >= h.todoLimit
	})
}

// TodoAdmissionEligible is the launch cutoff, not a separate capacity counter.
func (r *Runtime) TodoAdmissionEligible(holder string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	h := r.admission[r.todoAdmissionHolderLocked(holder)]
	return h != nil && h.todoEligible
}

// TransferTodoAdmission moves demand and any unbound reservation to the branch
// after its durable lane binding, before asynchronous provisioning can request it.
func (r *Runtime) TransferTodoAdmission(from, to string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	from = r.todoAdmissionHolderLocked(from)
	h := r.admission[from]
	if h == nil || h.todoScope == "" || h.machine != "" || !h.releasing.IsZero() || r.admission[to] != nil {
		return errors.New("TODO admission handoff unavailable")
	}
	row := h.rows[from]
	if row == nil || row.State != "waiting" && row.State != "granted" && row.State != "released" {
		return errors.New("TODO demand is no longer active")
	}
	h.todoOrigins = append(h.todoOrigins, from)
	delete(r.admission, from)
	if row.State == "released" {
		row.State = "waiting"
		r.admissionSequence++
		row.sequence = r.admissionSequence
	}
	delete(h.rows, from)
	row.Holder, row.Actor = to, to
	h.rows[to] = row
	r.admission[to] = h
	r.rankAdmissionLocked()
	r.notifyAdmissionLocked()
	return nil
}

// TodoAdmissionHolder resolves the handoff while the engine commits the new
// workspace id. The alias belongs to the same runtime holder, never another queue.
func (r *Runtime) TodoAdmissionHolder(holder string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.todoAdmissionHolderLocked(holder)
}
func (r *Runtime) todoAdmissionHolderLocked(holder string) string {
	if r.admission[holder] != nil {
		return holder
	}
	for id, h := range r.admission {
		if slices.Contains(h.todoOrigins, holder) {
			return id
		}
	}
	return holder
}

// SetTodoParallelReader rechecks the saved owner request at each TODO grant,
// including when a setting changes between stack engine passes.
func (r *Runtime) SetTodoParallelReader(reader func(context.Context) (int, error)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.todoParallelReader = reader
}

func (r *Runtime) refreshTodoEligibilityLocked(scope string, limit int) {
	held := 0
	for _, h := range r.admission {
		if h.todoScope == scope {
			h.todoLimit = max(0, limit)
			h.todoEligible = h.held
			if h.held {
				held++
			}
		}
	}
	available := max(0, limit-held)
	for _, row := range r.rankAdmissionLocked() {
		h := r.admission[row.Holder]
		if h.todoScope != scope || row.Class != "todo" || h.held {
			continue
		}
		h.todoEligible = available > 0
		if available > 0 {
			available--
		}
	}
}
