package microsandbox

import (
	"context"
	"errors"
	"sort"
	"time"
)

// AdmissionRequest is actor demand, not a second VM or durable queue.
// This extends Runtime's existing capacity mutex; providers must be supplied by
// the install before the dark scheduler can grant repository-backed work.
type AdmissionRequest struct {
	Holder, Actor, Reason, Class, State string
	Position                            int
	sequence                            uint64
}

type admissionHolder struct {
	rows      map[string]*AdmissionRequest
	held      bool
	machine   string
	releasing time.Time
}

// AdmissionProviders keeps missing authority fail-closed. Ready must verify the
// unique branch binding, launcher security receipts and durable TODO/publication
// adapters for the particular request. It must not perform a VM start.
type AdmissionProviders struct {
	Ready    func(context.Context, AdmissionRequest) error
	FreeDisk func(context.Context) (int64, error)
}

func admissionPriority(class string) int {
	switch class {
	case "person":
		return 0
	case "todo":
		return 1
	case "background":
		return 2
	}
	return 3
}

// Request coalesces by holder while retaining cancellation per actor. Repeated
// demand from an actor is idempotent; a higher class promotes it with a new age.
func (r *Runtime) Request(class, holder, actor, reason string) (AdmissionRequest, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return AdmissionRequest{}, errors.New("microsandbox runtime is closed")
	}
	if admissionPriority(class) == 3 || holder == "" || actor == "" || reason == "" {
		return AdmissionRequest{}, errors.New("admission requires class, holder, actor and reason")
	}
	if r.admission == nil {
		r.admission = map[string]*admissionHolder{}
	}
	h := r.admission[holder]
	if h == nil {
		h = &admissionHolder{rows: map[string]*AdmissionRequest{}}
		r.admission[holder] = h
	}
	row := h.rows[actor]
	if row == nil || row.State == "cancelled" || row.State == "released" {
		r.admissionSequence++
		row = &AdmissionRequest{Holder: holder, Actor: actor, Reason: reason, Class: class, State: "waiting", sequence: r.admissionSequence}
		h.rows[actor] = row
	} else if admissionPriority(class) < admissionPriority(row.Class) {
		r.admissionSequence++
		row.Class = class
		row.sequence = r.admissionSequence
	}
	if h.held && h.releasing.IsZero() {
		row.State = "granted"
	}
	r.rankAdmissionLocked()
	return *row, nil
}

func (r *Runtime) rankAdmissionLocked() []*AdmissionRequest {
	heads := []*AdmissionRequest{}
	for _, h := range r.admission {
		var head *AdmissionRequest
		for _, row := range h.rows {
			row.Position = 0
			if row.State != "waiting" {
				continue
			}
			if head == nil || admissionPriority(row.Class) < admissionPriority(head.Class) || (row.Class == head.Class && row.sequence < head.sequence) {
				head = row
			}
		}
		if head != nil {
			heads = append(heads, head)
		}
	}
	sort.Slice(heads, func(i, j int) bool {
		a, b := heads[i], heads[j]
		if a.Class != b.Class {
			return admissionPriority(a.Class) < admissionPriority(b.Class)
		}
		return a.sequence < b.sequence
	})
	for i, head := range heads {
		for _, row := range r.admission[head.Holder].rows {
			if row.State == "waiting" {
				row.Position = i + 1
			}
		}
	}
	return heads
}

// AdmissionSnapshot copies rows so callers cannot mutate runtime ownership.
func (r *Runtime) AdmissionSnapshot() []AdmissionRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	rows := []AdmissionRequest{}
	for _, h := range r.admission {
		for _, row := range h.rows {
			rows = append(rows, *row)
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].sequence < rows[j].sequence })
	return rows
}

// GrantNext grants at most one holder, allowing the install to commit source
// cursors before requesting the next grant. Call on demand events and a 1 s tick.
// No provider means no side effect; the production adapter remains dark.
func (r *Runtime) GrantNext(ctx context.Context, p AdmissionProviders) (AdmissionRequest, error) {
	if p.Ready == nil || p.FreeDisk == nil {
		return AdmissionRequest{}, errors.New("admission providers unavailable")
	}
	r.mu.Lock()
	heads := r.rankAdmissionLocked()
	if len(heads) == 0 {
		r.mu.Unlock()
		return AdmissionRequest{}, nil
	}
	candidate := *heads[0]
	reader := r.capacityReader
	profile := r.config.HostProfile
	r.mu.Unlock()
	if reader == nil || profile == nil {
		return AdmissionRequest{}, errors.New("admission host profile or owner capacity unavailable")
	}
	if err := p.Ready(ctx, candidate); err != nil {
		return AdmissionRequest{}, err
	}
	maximum, err := reader(ctx)
	if err != nil {
		return AdmissionRequest{}, err
	}
	free, err := p.FreeDisk(ctx)
	if err != nil {
		return AdmissionRequest{}, err
	}
	sizing := ComputeSizing(*profile)
	maximum = min(maximum, sizing.MemoryCapacity, sizing.CoreCapacity, int(max(int64(0), free-MinFreeDiskBytes)/MachineDiskBytes))
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return AdmissionRequest{}, errors.New("microsandbox runtime is closed")
	}
	heads = r.rankAdmissionLocked()
	// Demand can be cancelled/promoted while providers do I/O. Retry on the next event.
	if len(heads) == 0 || heads[0].sequence != candidate.sequence || heads[0].Class != candidate.Class {
		return AdmissionRequest{}, nil
	}
	h := r.admission[candidate.Holder]
	if h.held || r.inUseLocked() >= maximum {
		return AdmissionRequest{}, nil
	}
	h.held = true
	for _, row := range h.rows {
		if row.State == "waiting" {
			row.State = "granted"
		}
	}
	r.rankAdmissionLocked()
	return *h.rows[candidate.Actor], nil
}

// CancelAdmission never frees a granted slot. The returned bool asks the owner
// to stop its VM; ConfirmAdmissionStop is required even during a cancelled boot.
func (r *Runtime) CancelAdmission(holder, actor string, now time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	h := r.admission[holder]
	if h == nil {
		return false
	}
	if row := h.rows[actor]; row != nil {
		row.State = "cancelled"
	}
	r.rankAdmissionLocked()
	for _, row := range h.rows {
		if row.State == "waiting" || row.State == "granted" {
			return false
		}
	}
	if h.held && h.releasing.IsZero() {
		h.releasing = now
		return true
	}
	return false
}

// BindAdmissionMachine transfers a reservation to a VM already counted by the
// runtime. Preparation and branch VMs use the same holder, after confirmed stop.
func (r *Runtime) BindAdmissionMachine(holder, machine string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	h := r.admission[holder]
	if h == nil || !h.held || !h.releasing.IsZero() || machine == "" {
		return errors.New("machine requires a held admission slot")
	}
	if h.machine != "" && h.machine != machine {
		return errors.New("previous admission machine has not confirmed stop")
	}
	for id, other := range r.admission {
		if id != holder && other.held && other.machine == machine {
			return errors.New("machine already belongs to another holder")
		}
	}
	h.machine = machine
	return nil
}

// ConfirmAdmissionStop must only follow the runtime's observed stop/deletion.
// transfer retains the grant while a prepare VM hands its slot to a branch VM.
func (r *Runtime) ConfirmAdmissionStop(holder string, transfer bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	h := r.admission[holder]
	if h == nil {
		return
	}
	h.machine = ""
	if transfer && h.releasing.IsZero() {
		return
	}
	h.held = false
	h.releasing = time.Time{}
	for _, row := range h.rows {
		if row.State == "granted" {
			row.State = "released"
		}
	}
	r.rankAdmissionLocked()
}

// AdmissionForceStops reports releases past the 60 s deadline. Reporting never
// drops ownership: even a forced stop must be confirmed by the runtime.
func (r *Runtime) AdmissionForceStops(now time.Time) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	holders := []string{}
	for id, h := range r.admission {
		if h.held && !h.releasing.IsZero() && now.Sub(h.releasing) >= time.Minute {
			holders = append(holders, id)
		}
	}
	sort.Strings(holders)
	return holders
}

// AdmissionSafety is an observation from the existing presence/session/run
// adapters. Unknown or stale observations cannot establish safe-idle.
type AdmissionSafety struct {
	Holder, TODOState                           string
	IdleSince                                   time.Time
	PresenceKnown, SessionsKnown, RunKnown      bool
	Presence, Terminal, SSH, RunningStep        bool
	BurstsEnabled, BurstsKnown, BurstOpen       bool
	DocumentsEnabled, DocumentsKnown, Unflushed bool
	CaptureConfirmed                            bool
}

// AdmissionIdleRelease selects, but never stops, a machine. Capture and stop
// remain the existing lifecycle's responsibility. Unknown features fail closed.
func (r *Runtime) AdmissionIdleRelease(now, hostStarted time.Time, observations []AdmissionSafety) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if hostStarted.IsZero() || now.Sub(hostStarted) < 30*time.Second {
		return ""
	}
	waiting := len(r.rankAdmissionLocked()) > 0
	selected := ""
	var oldest time.Time
	for _, s := range observations {
		h := r.admission[s.Holder]
		if h == nil || !h.held || !h.releasing.IsZero() || s.IdleSince.IsZero() || s.IdleSince.After(now) {
			continue
		}
		if !s.PresenceKnown || !s.SessionsKnown || !s.RunKnown || s.Presence || s.Terminal || s.SSH || s.RunningStep {
			continue
		}
		if s.BurstsEnabled && (!s.BurstsKnown || s.BurstOpen || !s.CaptureConfirmed) {
			continue
		}
		if s.DocumentsEnabled && (!s.DocumentsKnown || s.Unflushed || !s.CaptureConfirmed) {
			continue
		}
		timeout := 30 * time.Minute
		switch s.TODOState {
		case "in_review", "needs_you", "paused":
			timeout = 2 * time.Minute
		}
		if !waiting && now.Sub(s.IdleSince) < timeout {
			continue
		}
		if selected == "" || s.IdleSince.Before(oldest) || (s.IdleSince.Equal(oldest) && s.Holder < selected) {
			selected = s.Holder
			oldest = s.IdleSince
		}
	}
	if selected != "" {
		r.admission[selected].releasing = now
	}
	return selected
}

type admissionContextKey struct{}

// WithAdmissionHolder carries an already granted slot through layer resolution
// and VM boot. It grants no authority; an ungranted holder is refused under mu.
func WithAdmissionHolder(ctx context.Context, holder string) context.Context {
	return context.WithValue(ctx, admissionContextKey{}, holder)
}

func (r *Runtime) admitMachineLocked(ctx context.Context, maximum int, machine string) error {
	holder, _ := ctx.Value(admissionContextKey{}).(string)
	if holder == "" {
		return r.admitRunningLocked(maximum)
	}
	h := r.admission[holder]
	if h == nil || !h.held || !h.releasing.IsZero() {
		return errors.New("machine has no active admission grant")
	}
	if h.machine != "" {
		return errors.New("admission slot already has a machine")
	}
	h.machine = machine
	return nil
}

func (r *Runtime) detachAdmissionMachineLocked(machine string, release bool) {
	for _, h := range r.admission {
		if h.machine != machine {
			continue
		}
		h.machine = ""
		if release {
			h.held = false
			h.releasing = time.Time{}
			for _, row := range h.rows {
				if row.State == "granted" {
					row.State = "released"
				}
			}
		}
	}
	r.rankAdmissionLocked()
}
