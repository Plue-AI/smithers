package microsandbox

import (
	"context"
	"errors"
	"slices"
	"sort"
	"strings"
	"time"
)

// AdmissionRequest is actor demand, not a second VM or durable queue.
// This extends Runtime's existing capacity mutex; providers must be supplied by
// the install before the dark scheduler can grant repository-backed work.
type AdmissionRequest struct {
	// RetainOnly is a reconstruction hint: completed/paused demand may retain
	// an existing VM but must never queue a new wake. Live queue rows omit it.
	RetainOnly                          bool
	RecoveryTodoScope                   string
	Holder, Actor, Reason, Class, State string
	Position                            int
	sequence                            uint64
}

type admissionHolder struct {
	rows          map[string]*AdmissionRequest
	held          bool
	machine       string
	releasing     time.Time
	idlePreparing bool
}

// AdmissionProviders keeps missing authority fail-closed. Ready must verify the
// unique branch binding, launcher security receipts and durable TODO/publication
// adapters for the particular request. It must not perform a VM start.
// ErrAdmissionNotReady marks authority that has not been published yet. Demand
// remains queued; this never grants a VM or treats missing authority as success.
var ErrAdmissionNotReady = errors.New("admission authority not ready")

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
	if !h.held {
		// A live retained VM already owns capacity, including after recovery.
		// Registering demand must reuse it rather than reserve a second slot.
		if id, ok := strings.CutPrefix(holder, "workspace:"); ok {
			if ws := r.workspaces[id]; ws != nil && ws.Machine != "" && ws.State != "stopped" && ws.State != "recovery_required" {
				h.held, h.machine = true, ws.Machine
				if ws.State == "stopping" {
					h.releasing = time.Now()
				}
			}
		}
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
	if h.held && (!h.releasing.IsZero() || h.idlePreparing) && row.State == "granted" {
		r.admissionSequence++
		row.State = "waiting"
		row.sequence = r.admissionSequence
	}
	if h.held && h.releasing.IsZero() && !h.idlePreparing {
		row.State = "granted"
	}
	r.rankAdmissionLocked()
	r.notifyAdmissionLocked()
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

// AdmissionHeld reports ownership, including cancelled grants awaiting an
// observed stop. Request state alone cannot establish that capacity is free.
func (r *Runtime) AdmissionHeld(holder string) bool {
	held, _ := r.AdmissionOwnership(holder)
	return held
}

// AdmissionOwnership distinguishes confirmed release from unknown ownership
// after recovery. Missing runtime metadata is not a stop receipt.
func (r *Runtime) AdmissionOwnership(holder string) (held, known bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if h := r.admission[holder]; h != nil && h.held {
		return true, true
	}
	if id, ok := strings.CutPrefix(holder, "workspace:"); ok {
		if ws := r.workspaces[id]; ws != nil {
			return ws.Machine != "" && ws.State != "stopped" && ws.State != "recovery_required", true
		}
	}
	if h := r.admission[holder]; h != nil {
		for _, row := range h.rows {
			if row.State == "released" {
				return false, true
			}
		}
	}
	return false, false
}

// ReorderTodoAdmission updates existing, ungranted stack demand in place.
// It creates no demand, changes no grant, and leaves person priority intact.
func (r *Runtime) ReorderTodoAdmission(holders []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	wanted := []string{}
	eligible := map[string]bool{}
	for _, head := range r.rankAdmissionLocked() {
		if head.Class == "todo" {
			eligible[head.Holder] = true
		}
	}
	seen := map[string]bool{}
	for _, holder := range holders {
		if seen[holder] {
			continue
		}
		seen[holder] = true
		if h := r.admission[holder]; eligible[holder] && h != nil && !h.held {
			for _, row := range h.rows {
				if row.Class == "todo" && row.State == "waiting" {
					wanted = append(wanted, holder)
					break
				}
			}
		}
	}
	current := []string{}
	for _, row := range r.rankAdmissionLocked() {
		if slices.Contains(wanted, row.Holder) {
			current = append(current, row.Holder)
		}
	}
	if slices.Equal(current, wanted) {
		return
	}
	for _, holder := range wanted {
		r.admissionSequence++
		for _, row := range r.admission[holder].rows {
			if row.Class == "todo" && row.State == "waiting" {
				row.sequence = r.admissionSequence
			}
		}
	}
	r.rankAdmissionLocked()
	r.notifyAdmissionLocked()
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
	r.mu.Unlock()
	if err := p.Ready(ctx, candidate); err != nil {
		return AdmissionRequest{}, err
	}
	// Retry failed auxiliary removals through the existing reconciliation path.
	// A failed removal remains counted, so this cannot manufacture capacity.
	if _, err := r.prepareAdmission(ctx); err != nil {
		return AdmissionRequest{}, err
	}
	maximum, err := r.admissionMaximum(ctx, p.FreeDisk)
	if err != nil {
		return AdmissionRequest{}, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return AdmissionRequest{}, errors.New("microsandbox runtime is closed")
	}
	if err := ctx.Err(); err != nil {
		return AdmissionRequest{}, err
	}
	heads = r.rankAdmissionLocked()
	// Demand can be cancelled/promoted while providers do I/O. Retry on the next event.
	if len(heads) == 0 || heads[0].sequence != candidate.sequence || heads[0].Class != candidate.Class {
		return AdmissionRequest{}, nil
	}
	h := r.admission[candidate.Holder]
	if h.held || h.idlePreparing || r.inUseLocked() >= maximum {
		return AdmissionRequest{}, nil
	}
	h.held = true
	for _, row := range h.rows {
		if row.State == "waiting" {
			row.State = "granted"
		}
	}
	r.rankAdmissionLocked()
	r.notifyAdmissionLocked()
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
		r.notifyAdmissionLocked()
	}
	r.rankAdmissionLocked()
	for _, row := range h.rows {
		if row.State == "waiting" || row.State == "granted" {
			return false
		}
	}
	if h.held && h.releasing.IsZero() && !h.idlePreparing {
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
	if h == nil || !h.held || !h.releasing.IsZero() || h.idlePreparing || machine == "" {
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
	r.notifyAdmissionLocked()
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

// ReconcileAdmissionReleases requests normal stops, escalating after 60 seconds,
// without relinquishing the slot on a CLI acknowledgment. Only an observed
// stopped or missing VM frees it.
func (r *Runtime) ReconcileAdmissionReleases(ctx context.Context, now time.Time) error {
	var errs []error
	r.mu.Lock()
	// Presence and session reconstruction own the first thirty seconds. Even
	// a cancelled boot cannot make another holder's slot reusable early.
	if r.admissionStarted.IsZero() || now.Sub(r.admissionStarted) < 30*time.Second {
		r.mu.Unlock()
		return nil
	}
	holders := []string{}
	for holder, h := range r.admission {
		if h.held && !h.releasing.IsZero() {
			holders = append(holders, holder)
		}
	}
	r.mu.Unlock()
	sort.Strings(holders)
	for _, holder := range holders {
		r.mu.Lock()
		h := r.admission[holder]
		machine := h.machine
		overdue := !h.releasing.IsZero() && now.Sub(h.releasing) >= time.Minute
		r.mu.Unlock()
		if machine == "" {
			continue // A preparing grant still owns its reservation.
		}
		if r.cli == nil {
			errs = append(errs, ErrUnavailable)
			continue
		}
		grace := "10"
		if overdue {
			grace = "0"
		}
		stopCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		_, stopErr := r.cli.run(stopCtx, nil, "stop", "-t", grace, "-q", machine)
		cancel()
		status, found, err := r.cli.sandboxStatus(ctx, machine)
		if err != nil || found && status != "stopped" {
			if err != nil {
				errs = append(errs, err)
			} else if stopErr != nil {
				errs = append(errs, stopErr)
			}
			continue
		}
		r.mu.Lock()
		// Another observer can have completed release while transport ran.
		booting := false
		// Auxiliary creation has no workspace boot flag. Its owner keeps the
		// reservation until finishAuxVM returns, even when list has not yet
		// observed the prepare VM. A failed cleanup has returned to its caller.
		if _, active := r.auxVMs[machine]; active {
			_, cleanup := r.auxCleanup[machine]
			booting = !cleanup
		}
		for _, ws := range r.workspaces {
			if ws.Machine == machine && ws.booting {
				booting = true
			}
		}
		if current := r.admission[holder]; !booting && current != nil && current.held && current.machine == machine && !current.releasing.IsZero() {
			for _, ws := range r.workspaces {
				if ws.Machine == machine {
					ws.State = "stopped"
					ws.recovering = false
					ws.guestOK = false
					if err := writeMetadata(ws); err != nil {
						errs = append(errs, err)
					}
				}
			}
			delete(r.auxVMs, machine)
			delete(r.auxCleanup, machine)
			r.detachAdmissionMachineLocked(machine, true)
		}
		r.mu.Unlock()
	}
	return errors.Join(errs...)
}

// Release observation and deadline retries belong to the runtime's lifetime,
// including when the last caller has left and there is no waiting demand.
func (r *Runtime) startAdmissionReconciler(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	r.mu.Lock()
	if r.closed || r.admissionCancel != nil {
		r.mu.Unlock()
		cancel()
		return
	}
	r.admissionCancel = cancel
	r.mu.Unlock()
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				observe, done := context.WithTimeout(ctx, 10*time.Second)
				_ = r.ReconcileAdmissionReleases(observe, time.Now())
				_ = r.reconcileConfiguredAdmissionIdle(observe, time.Now())
				done()
			}
		}
	}()
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
	return r.admissionIdleCandidateLocked(now, observations, true, true, r.config.MaxRunningVMs)
}

func (r *Runtime) admissionIdleCandidateLocked(now time.Time, observations []AdmissionSafety, requireCapture, mark bool, maximum int) string {
	waiting := len(r.rankAdmissionLocked()) > 0 && r.inUseLocked() >= maximum
	selected := ""
	var oldest time.Time
	for _, s := range observations {
		h := r.admission[s.Holder]
		if h == nil || !h.held || !h.releasing.IsZero() || h.idlePreparing || s.IdleSince.IsZero() || s.IdleSince.After(now) {
			continue
		}
		if !s.PresenceKnown || !s.SessionsKnown || !s.RunKnown || s.Presence || s.Terminal || s.SSH || s.RunningStep {
			continue
		}
		if s.BurstsEnabled && (!s.BurstsKnown || s.BurstOpen || (requireCapture && !s.CaptureConfirmed)) {
			continue
		}
		if s.DocumentsEnabled && (!s.DocumentsKnown || s.Unflushed || (requireCapture && !s.CaptureConfirmed)) {
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
	if selected != "" && mark {
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
	if h == nil || !h.held || !h.releasing.IsZero() || h.idlePreparing {
		return errors.New("machine has no active admission grant")
	}
	if h.machine != "" {
		if h.machine == machine {
			for _, ws := range r.workspaces {
				if ws.Machine == machine && ws.recovering && !ws.booting {
					return nil
				}
			}
		}
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
	r.notifyAdmissionLocked()
}

// WaitAdmission wakes on demand and retries disk/owner changes every second.
// The grant context carries the same slot through preparation and branch boot.
// Caller authority is checked by Ready on every grant; a missing adapter fails closed.
func (r *Runtime) WaitAdmission(ctx context.Context, p AdmissionProviders, class, holder, actor, reason string) (context.Context, error) {
	r.mu.Lock()
	recovering := r.admissionRecoveryPending
	r.mu.Unlock()
	if recovering {
		return ctx, ErrAdmissionNotReady
	}
	if p.Ready == nil || p.FreeDisk == nil {
		return ctx, errors.New("admission providers unavailable")
	}
	request := AdmissionRequest{Class: class, Holder: holder, Actor: actor, Reason: reason}
	readyErr := p.Ready(ctx, request)
	if readyErr != nil && !errors.Is(readyErr, ErrAdmissionNotReady) {
		return ctx, readyErr
	}
	if _, err := r.Request(class, holder, actor, reason); err != nil {
		return ctx, err
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		if err := ctx.Err(); err != nil {
			r.abandonAdmission(holder, actor)
			return ctx, err
		}
		r.mu.Lock()
		h := r.admission[holder]
		cancelled := r.closed || h == nil || h.rows[actor] == nil || h.rows[actor].State == "cancelled" || h.rows[actor].State == "released"
		r.mu.Unlock()
		if cancelled {
			return ctx, context.Canceled
		}
		if readyErr != nil {
			readyErr = p.Ready(ctx, request)
			if readyErr != nil && !errors.Is(readyErr, ErrAdmissionNotReady) {
				r.abandonAdmission(holder, actor)
				return ctx, readyErr
			}
			if readyErr != nil {
				select {
				case <-ctx.Done():
				case <-ticker.C:
				}
				continue
			}
		}
		if r.admissionGranted(holder, actor) {
			return WithAdmissionHolder(ctx, holder), nil
		}
		if _, err := r.GrantNext(ctx, p); err != nil && !errors.Is(err, ErrAdmissionNotReady) {
			r.abandonAdmission(holder, actor)
			return ctx, err
		}
		if err := ctx.Err(); err != nil {
			r.abandonAdmission(holder, actor)
			return ctx, err
		}
		r.mu.Lock()
		changed := r.admissionChanged
		r.mu.Unlock()
		if r.admissionGranted(holder, actor) {
			return WithAdmissionHolder(ctx, holder), nil
		}
		if err := r.reconcileConfiguredAdmissionIdle(ctx, time.Now()); err != nil {
			r.abandonAdmission(holder, actor)
			return ctx, err
		}
		select {
		case <-ctx.Done():
		case <-changed:
		case <-ticker.C:
		}
	}
}

// abandonAdmission releases only an unbound reservation. A live or failed-stop
// VM retains ownership until the lifecycle observes its stop.
func (r *Runtime) abandonAdmission(holder, actor string) {
	// A failed operation on an already awake machine is not proof that the
	// machine is safe to stop. Keep release decisions behind the safety adapter.
	r.mu.Lock()
	h := r.admission[holder]
	if h != nil && h.machine != "" {
		for _, ws := range r.workspaces {
			if ws.Machine == h.machine && ws.State == "running" {
				if row := h.rows[actor]; row != nil {
					row.State = "cancelled"
				}
				r.rankAdmissionLocked()
				r.notifyAdmissionLocked()
				r.mu.Unlock()
				return
			}
		}
	}
	r.mu.Unlock()
	r.CancelAdmission(holder, actor, time.Now())
	r.mu.Lock()
	defer r.mu.Unlock()
	h = r.admission[holder]
	if h == nil || !h.held || h.machine != "" {
		return
	}
	for _, row := range h.rows {
		if row.State == "granted" || row.State == "waiting" {
			return
		}
	}
	h.held = false
	h.releasing = time.Time{}
	r.rankAdmissionLocked()
	r.notifyAdmissionLocked()
}

func (r *Runtime) admissionGranted(holder, actor string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	h := r.admission[holder]
	return h != nil && h.held && h.releasing.IsZero() && !h.idlePreparing && h.rows[actor] != nil && h.rows[actor].State == "granted"
}

// CancelFailedAdmission cancels the actor after a failed wake. A bound VM keeps
// the slot until observed stop; an unbound grant can be relinquished immediately.
func (r *Runtime) CancelFailedAdmission(holder, actor string) {
	r.abandonAdmission(holder, actor)
}

func (r *Runtime) notifyAdmissionLocked() {
	if r.admissionChanged != nil {
		close(r.admissionChanged)
	}
	r.admissionChanged = make(chan struct{})
}
