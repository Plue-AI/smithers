package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

type mythicalForeignBring struct {
	Checkpoint bool                    `json:"checkpoint,omitempty"`
	Workspace  string                  `json:"workspace"`
	SHA        string                  `json:"sha"`
	Wait       string                  `json:"wait"`
	Onto       string                  `json:"onto"`
	Request    *mythicalRebaseRequest  `json:"request"`
	Native     *machined.RewriteResult `json:"native,omitempty"`
}

// Bring in is durable admission only. The stack worker consumes the retained
// push at a safe boundary; the person's HTTP request never fetches or rewrites.
func (s *MythicalService) requestForeignBring(ctx context.Context, tx pgx.Tx, q *db.Queries, item db.MythicalItem, input TodoControlInput, person db.User, credential string, index int, receipt *TodoControlReceipt) error {

	if item.Reason == "rebase_conflict_pending" {
		return &TodoControlError{409, "rebase_conflict_pending", "conflict", "Resolve the conflict"}
	}
	if pending := mythicalChecksOf(item).ForeignBring; pending != nil && pending.Wait == input.Wait && pending.SHA == input.Revision {
		return todoControlConflict("Bring in is pending")
	}

	if s.host == nil || s.launcher == nil {
		return &TodoControlError{503, "checkpoint_rebase_unavailable", "infra", "Checkpoint rebase unavailable"}
	}
	if len(item.PendingOp) != 0 {
		pending, err := decodeMythicalOutbound(item.PendingOp)
		if err != nil {
			return err
		}
		if pending.State != "done" && pending.State != "conflict" {
			return todoControlConflict("Publication is recovering; try again")
		}
		item.PendingOp = nil
	}
	if item.CandidateHead == "" && item.WorkspaceID == "" || !item.StackPosition.Valid {
		return todoControlConflict("Branch publication is in progress")
	}
	if err := AuthorizeTodoBranch(ctx, q, item.RepositoryID, item.Number.Int64); err != nil {
		return err
	}
	stack, err := q.GetMythicalStack(ctx, item.RepositoryID)
	if err != nil {
		return err
	}
	if stack.State != "active" {
		return todoControlUnavailable()
	}
	order, err := q.LockMythicalStackOrder(ctx, item.RepositoryID)
	if err != nil {
		return err
	}
	step := mythicalItemStep{r: &mythicalRun{row: stack, mainTip: stack.LandedMain}, items: order}
	branch, err := q.GetMythicalTodoBranchWorkspace(ctx, item)
	if err != nil {
		return &TodoControlError{503, "checkpoint_rebase_unavailable", "infra", "Checkpoint rebase unavailable"}
	}
	checks := mythicalChecksOf(item)
	info := middleware.AuthInfoFromContext(ctx)
	checks.ForeignBring = &mythicalForeignBring{Workspace: branch.ID, SHA: input.Revision, Wait: input.Wait, Onto: step.prefix(item), Request: &mythicalRebaseRequest{Head: item.CandidateHead, Generation: item.Generation, User: person.ID, Credential: middleware.CredentialOf(info), RawScopes: info.RawScopes, Via: info.ViaHint, By: todoActorRef(ctx, person)}}
	checks.Waits[index].AnsweredBy, checks.Waits[index].Answer = person.Username, "bring-in"
	checks.Land = nil
	if item.PRHead != "" {
		checks.ApprovalCleared = item.PRHead
	}
	item.Checks, item.NextAttemptAt.Valid = checks.encode(), false
	saved, err := q.SaveMythicalItem(ctx, item)
	if err != nil {
		return err
	}
	if item.FlowDigest.Valid && item.WorkspaceID != "" {
		if _, ok := s.launcher.(mythicalSignaler); !ok || s.branchRebase == nil || item.RequestRunID == "" || branch.ID != item.WorkspaceID {
			return &TodoControlError{503, "checkpoint_rebase_unavailable", "infra", "Checkpoint rebase unavailable"}
		}
		if err := s.signalForeignBring(ctx, tx, saved, stack, input.Revision, "bring_in"); err != nil {
			return err
		}
	}
	*receipt = TodoControlReceipt{State: "accepted", Number: item.Number.Int64}
	if err := s.recordTodoControl(ctx, tx, saved, input, credential, "todo.foreign_bring-in", *receipt, map[string]any{"item": uuidString(item.ID), "n": item.Number.Int64, "wait": input.Wait, "sha": input.Revision, "by": todoActorRef(ctx, person), "actor": todoActor(ctx, person), "from": todoState(item), "to": todoState(saved), "onto": checks.ForeignBring.Onto}); err != nil {
		return err
	}
	_, err = q.RequestMythicalStack(ctx, item.RepositoryID)
	return err
}

func (st *mythicalItemStep) consumeForeignBring(ctx context.Context, item db.MythicalItem) (*db.MythicalItem, bool, error) {
	if item.Reason == "rebase_conflict_pending" {
		return st.integrate(ctx, item)
	}
	checks := mythicalChecksOf(item)
	pending := checks.ForeignBring
	if pending == nil || pending.Request == nil || item.PausedAt.Valid || mythicalMergeFenced(item) || len(item.PendingOp) > 0 {
		return nil, false, nil
	}
	request := pending.Request
	if checks.ForeignHead != pending.SHA || request.Head != item.CandidateHead || request.Generation != item.Generation || pending.Onto != st.prefix(item) || !st.s.storedBranchRequestAuthorized(ctx, st.s.queries(), item, request, "branch.bring-in") {
		return nil, false, nil
	}
	index, err := foreignPushAnswerWait(item, pending.Wait, pending.SHA)
	if err != nil {
		return nil, false, nil
	}
	// Occupied branches wait for the inspected native boundary. Never rewrite
	// an active working copy on the host, even after an explicit choice.
	if item.WorkspaceID != "" {
		if item.FlowDigest.Valid && !pending.Checkpoint {
			return nil, false, nil
		}
		return st.consumeNativeForeignBring(ctx, item, *pending, index)
	}
	branch, err := st.s.queries().GetWorkspace(ctx, pending.Workspace)
	if err != nil || branch.RepositoryID != item.RepositoryID || (branch.Status != "stopped" && branch.Status != "suspended" && branch.Status != "running") || st.s.branchRebase == nil || st.s.lanes == nil {
		return nil, false, nil
	}
	// Re-admit released work through the existing stack machine placement. The
	// retained commit is source data; only the newly admitted guest rewrites it.
	if !st.slot(item) {
		return nil, false, nil
	}
	placement, refused := st.place(ctx, item)
	if refused != nil {
		return refused, false, nil
	}
	workspace, err := st.lane(context.WithValue(ctx, mythicalInitialSourceKey{}, item.CandidateHead), item, fmt.Sprintf("TODO %d Bring in g%d", item.Number.Int64, item.Generation), placement)
	if err != nil {
		return nil, false, err
	}
	next := item
	checks.ForeignBring.Workspace = workspace
	next.WorkspaceID, next.Checks = workspace, checks.encode()
	return &next, false, nil
}

func (st *mythicalItemStep) lockForeignBring(ctx context.Context, tx pgx.Tx, item db.MythicalItem, pending mythicalForeignBring) error {
	var live bool
	if err := tx.QueryRow(ctx, `SELECT state='active' AND running AND claim=$2 AND lease_expires_at>clock_timestamp() FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, item.RepositoryID, st.r.row.Claim).Scan(&live); err != nil {
		return err
	}
	if !live {
		return db.ErrMythicalLeaseLost
	}
	q := db.New(tx)
	order, err := q.LockMythicalStackOrder(ctx, item.RepositoryID)
	if err != nil {
		return err
	}
	stack, err := q.GetMythicalStack(ctx, item.RepositoryID)
	if err != nil {
		return err
	}
	current, err := q.GetMythicalItem(ctx, item.ID)
	if err != nil {
		return err
	}
	step := mythicalItemStep{r: &mythicalRun{row: stack, mainTip: stack.LandedMain}, items: order}
	if current.Version != item.Version || pending.Onto != step.prefix(current) || !st.s.storedBranchRequestAuthorized(ctx, q, current, pending.Request, "branch.bring-in") {
		return errors.New("Bring in binding changed before verification")
	}
	var repository int64
	var status string
	// Fence wake and capture updates while allowing native session identity
	// readers to take KEY SHARE before the daemon acknowledges its rewrite.
	if err := tx.QueryRow(ctx, `SELECT repository_id,status FROM workspaces WHERE id=$1 AND deleted_at IS NULL FOR NO KEY UPDATE`, pending.Workspace).Scan(&repository, &status); err != nil {
		return err
	}
	occupied := current.WorkspaceID != ""
	if repository != current.RepositoryID || (occupied && (current.WorkspaceID != pending.Workspace || status != "running" || current.PausedAt.Valid || mythicalMergeFenced(current))) || (!occupied && status != "stopped" && status != "suspended" && status != "running") {
		return errors.New("branch woke before Bring in verification")
	}
	if current.FlowDigest.Valid && occupied {
		fresh := mythicalChecksOf(current).ForeignBring
		if fresh == nil || !fresh.Checkpoint || fresh.SHA != pending.SHA || fresh.Wait != pending.Wait || fresh.Request == nil || fresh.Request.Head != current.CandidateHead || fresh.Request.Generation != current.Generation {
			return errors.New("Bring in checkpoint changed")
		}
	}
	_, err = foreignPushAnswerWait(current, pending.Wait, pending.SHA)
	return err
}

func foreignBringPusher(item db.MythicalItem, id string) json.RawMessage {
	for _, wait := range mythicalChecksOf(item).Waits {
		if wait.ID == id && wait.Kind == "foreign_push" {
			return wait.By
		}
	}
	return nil
}

// The occupied branch uses the daemon's mutation lock and inspected checkpoint.
// Persist the rewrite result before capture/verification so retries never issue
// a second rewrite after capture or launcher failure.
func (st *mythicalItemStep) consumeNativeForeignBring(ctx context.Context, item db.MythicalItem, pending mythicalForeignBring, index int) (*db.MythicalItem, bool, error) {
	if st.s.branchRebase == nil || (item.WorkspaceID != "" && pending.Workspace != item.WorkspaceID) {
		return nil, false, nil
	}
	if item.FlowDigest.Valid && item.CandidateBase != pending.Onto {
		return nil, false, nil
	}
	if pending.Native == nil {
		var tx pgx.Tx
		defer func() {
			if tx != nil {
				_ = tx.Rollback(context.WithoutCancel(ctx))
			}
		}()
		result, err := st.s.branchRebase.Rebase(ctx, pending.Workspace, pending.Request.User, pending.SHA, item.CandidateBase,
			func(tx pgx.Tx) error { return st.lockForeignBring(ctx, tx, item, pending) },
			func(rewrite func() error) error {
				var err error
				tx, err = st.s.store.Begin(ctx)
				if err != nil {
					return err
				}
				if err = st.lockForeignBring(ctx, tx, item, pending); err != nil {
					return err
				}
				return rewrite()
			})
		if err != nil {
			return nil, false, err
		}
		if tx == nil || !result.Inspected || !codingCommitID.MatchString(result.Head) {
			return nil, false, machined.ErrNotReady
		}
		next := item
		checks := mythicalChecksOf(next)
		checks.ForeignBring.Native = &result
		next.Checks = checks.encode()
		saved, err := db.New(tx).SaveMythicalItem(ctx, next)
		if err != nil {
			return nil, false, err
		}
		if err = tx.Commit(ctx); err != nil {
			return nil, false, err
		}
		return &saved, true, nil
	}
	result := pending.Native
	if len(result.Paths) != 0 {
		reservation, err := st.reserveConflict(ctx, item, result.Head, pending.SHA)
		if err != nil {
			return nil, false, err
		}
		next := item
		checks := mythicalChecksOf(next)
		checks.ConflictReservation = reservation
		next.Checks = checks.encode()
		next.Integration, _ = json.Marshal(map[string]any{"conflict": map[string]any{"head": result.Head, "onto": pending.SHA, "paths": result.Paths, "base": item.CandidateBase, "pre_rebase_head": item.CandidateHead}})
		next.State, next.Reason = "integrating", "rebase_conflict_pending"
		return &next, false, nil
	}
	capture, err := st.s.branchRebase.Capture(ctx, pending.Workspace)
	if err != nil {
		return nil, false, err
	}
	current, err := st.s.queries().GetMythicalItem(ctx, item.ID)
	if err != nil {
		return nil, false, err
	}
	binding := mythicalChecksOf(current).ForeignBring
	if binding == nil || binding.Native == nil || binding.Native.Head != result.Head || binding.SHA != pending.SHA || current.WorkspaceID != item.WorkspaceID || current.CandidateHead != item.CandidateHead || current.Generation != item.Generation {
		return nil, false, errors.New("Bring in capture binding changed")
	}
	if current.FlowDigest.Valid && !binding.Checkpoint {
		return nil, false, errors.New("Bring in checkpoint changed")
	}
	if capture.Head != result.Head {
		return nil, false, errors.New("Bring in capture differs from inspected rebase")
	}
	index, err = foreignPushAnswerWait(current, pending.Wait, pending.SHA)
	if err != nil {
		return nil, false, err
	}
	ref := "refs/smithers/branches/" + pending.Workspace + "/captures/" + capture.Head
	if err = st.r.g.fetch(ctx, st.r.bridge.URL(), 0, 0, ref); err != nil {
		return nil, false, err
	}
	commit, err := st.r.g.readCommit(ctx, result.Head)
	if err != nil {
		return nil, false, err
	}
	if len(commit.Parents) != 1 || commit.Parents[0] != pending.SHA {
		return nil, false, errors.New("Bring in result has a different target")
	}
	next := current
	next.CandidateHead = result.Head
	if paths, err := st.protectedChanges(ctx, next); err != nil {
		return nil, false, err
	} else if len(paths) > 0 {
		return nil, false, errors.New("foreign push changes protected paths")
	}
	checks := mythicalChecksOf(next)
	now := st.now
	checks.Waits[index].SettledAt = &now
	checks.ForeignBring, checks.ForeignHead, checks.Review, checks.Land, checks.Capture = nil, "", nil, nil, nil
	next.PRHead, next.Checks = pending.SHA, checks.encode()
	if current.State == "running" && current.RequestOutcome == "" {
		// Planning can be waiting for an independent answer before it has a
		// candidate. Keep that pinned composition running on the rebased guest;
		// its normal route→deliver path will verify and publish its result.
		next.CandidateHead = ""
		tx, err := st.s.store.Begin(ctx)
		if err != nil {
			return nil, false, err
		}
		defer tx.Rollback(context.WithoutCancel(ctx))
		if err = st.lockForeignBring(ctx, tx, current, pending); err != nil {
			return nil, false, err
		}
		saved, err := db.New(tx).SaveMythicalItem(ctx, next)
		if err != nil {
			return nil, false, err
		}
		if _, err = tx.Exec(ctx, `UPDATE workspaces SET capture_pending=NULL WHERE id=$1`, pending.Workspace); err != nil {
			return nil, false, err
		}
		fact, _ := json.Marshal(map[string]any{"item": uuidString(saved.ID), "n": saved.Number.Int64, "sha": pending.SHA, "head": result.Head, "by": pending.Request.By, "pusher": foreignBringPusher(current, pending.Wait), "actor": foreignBringPusher(current, pending.Wait)})
		if _, err = st.s.recordTodoFact(ctx, tx, saved, uuid.NewString(), "todo.foreign_brought-in", todoState(saved), fact); err != nil {
			return nil, false, err
		}
		if current.FlowDigest.Valid {
			if err = st.s.signalForeignBring(ctx, tx, saved, st.r.row, pending.SHA, "bring_in_complete"); err != nil {
				return nil, false, err
			}
		}
		if err = tx.Commit(ctx); err != nil {
			return nil, false, err
		}
		return &saved, true, nil
	}
	return st.verifyCandidate(ctx, current, next, pending.Onto, result.Head, nil)
}

// Control signals use the offering run's current sponsor and retained target.
// Admission and completion are journaled in the same transactions as their
// item projections; a replay cannot strand the run between two writes.
func (s *MythicalService) signalForeignBring(ctx context.Context, tx pgx.Tx, item db.MythicalItem, stack db.MythicalStack, sha, name string) error {
	signaler, ok := s.launcher.(mythicalSignaler)
	if !ok {
		return errors.New("Bring in signal unavailable")
	}
	sponsor := mythicalExecutionSponsor(item, stack)
	scope := jobs.Scope{TenantID: "repository:" + strconv.FormatInt(item.RepositoryID, 10), PrincipalID: "user:" + strconv.FormatInt(sponsor, 10)}
	target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: item.WorkspaceID, BindingKind: mythicalBindingKind, BindingID: uuidString(item.ID)}
	wait := ""
	if pending := mythicalChecksOf(item).ForeignBring; pending != nil {
		wait = pending.Wait
	}
	// Verification saved the settled wait and cleared the pending request.
	if wait == "" {
		for _, entry := range mythicalChecksOf(item).Waits {
			if entry.Kind == "foreign_push" && entry.SHA == sha && entry.Answer == "bring-in" {
				wait = entry.ID
			}
		}
	}
	payload, _ := json.Marshal(map[string]string{"sha": sha, "wait": wait})
	projection, _ := json.Marshal(map[string]any{"kind": "mythical-bring", "itemId": uuidString(item.ID), "run": item.RequestRunID, "attempt": item.Attempt})
	authorization, _ := json.Marshal(map[string]any{"repositoryId": item.RepositoryID, "userId": sponsor, "itemId": uuidString(item.ID), "workspaceId": item.WorkspaceID})
	if name == "bring_in_complete" {
		name += "#" + wait
	}
	_, err := signaler.SignalInTx(ctx, tx, flowdispatch.SignalRequest{Scope: scope, Target: target, RequestID: "todo-" + name + ":" + item.RequestRunID + ":" + wait, FlowID: flowdispatch.TodoFlow, RunID: item.RequestRunID, Name: name, Payload: payload, Projection: projection, AuthorizationContext: authorization})
	return err
}

func projectForeignBringCheckpoint(next *db.MythicalItem, projection mythicalProjection, update flowdispatch.ProjectionUpdate) {
	checks := mythicalChecksOf(*next)
	pending := checks.ForeignBring
	run := update.Checkpoint.Run
	if pending == nil || projection.Phase != "todo" || run == nil || run.RunID != next.RequestRunID || update.Checkpoint.Target.WorkspaceID != pending.Workspace {
		return
	}
	pending.Checkpoint = false
	if !update.State.Terminal() {
		for _, wait := range run.PendingWaits {
			raw := wait.Request
			var text string
			if json.Unmarshal(raw, &text) == nil {
				raw = json.RawMessage(text)
			}
			var request struct {
				Kind string `json:"kind"`
				SHA  string `json:"sha"`
				Wait string `json:"wait"`
			}
			if json.Unmarshal(raw, &request) == nil && wait.Reason == "event" && request.Kind == "bring_in" && request.SHA == pending.SHA && request.Wait == pending.Wait {
				pending.Checkpoint = true
			}
		}
	}
	next.Checks = checks.encode()
}
