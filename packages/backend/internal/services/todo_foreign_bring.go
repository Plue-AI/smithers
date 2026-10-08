package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type mythicalForeignBring struct {
	Workspace string                 `json:"workspace"`
	SHA       string                 `json:"sha"`
	Wait      string                 `json:"wait"`
	Onto      string                 `json:"onto"`
	Request   *mythicalRebaseRequest `json:"request"`
}

// Bring in is durable admission only. The stack worker consumes the retained
// push at a safe boundary; the person's HTTP request never fetches or rewrites.
func (s *MythicalService) requestForeignBring(ctx context.Context, tx pgx.Tx, q *db.Queries, item db.MythicalItem, input TodoControlInput, person db.User, credential string, index int, receipt *TodoControlReceipt) error {
	if item.Reason == "rebase_conflict_pending" {
		return &TodoControlError{409, "rebase_conflict_pending", "conflict", "Resolve the conflict"}
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
	if item.CandidateHead == "" || !item.StackPosition.Valid {
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
	*receipt = TodoControlReceipt{State: "accepted", Number: item.Number.Int64}
	if err := s.recordTodoControl(ctx, tx, saved, input, credential, "todo.foreign_bring-in", *receipt, map[string]any{"item": uuidString(item.ID), "n": item.Number.Int64, "wait": input.Wait, "sha": input.Revision, "by": todoActorRef(ctx, person), "onto": checks.ForeignBring.Onto}); err != nil {
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
		return nil, false, nil
	}
	branch, err := st.s.queries().GetWorkspace(ctx, pending.Workspace)
	if err != nil || branch.RepositoryID != item.RepositoryID || (branch.Status != "stopped" && branch.Status != "suspended") {
		return nil, false, nil
	}
	if err = st.fetchCandidate(ctx, item); err != nil {
		return nil, false, err
	}
	if err = st.fetchOnto(ctx, pending.Onto); err != nil {
		return nil, false, err
	}
	if err = st.r.g.fetch(ctx, st.r.bridge.URL(), 0, 0, repohost.KeptCommitRefPrefix+checks.ForeignHead); err != nil {
		return nil, false, fmt.Errorf("fetch retained push: %w", err)
	}
	// Use the stack's existing rebase engine. The foreign commit becomes part
	// of this item's change, which remains based on its stack prefix.
	head, err := st.r.g.rebaseCandidate(ctx, checks.ForeignHead, mythicalCandidate{ItemID: uuidString(item.ID), Issue: item.IssueNumber.Int64, Base: item.CandidateBase, Head: item.CandidateHead}, mythicalChainLimit)
	var conflict *errMythicalConflict
	if errors.As(err, &conflict) {
		reservation, e := st.reserveConflict(ctx, item, conflict.Head, checks.ForeignHead)
		if e != nil {
			return nil, false, e
		}
		if e = st.s.pin(ctx, st.r, conflict.Head); e != nil {
			return nil, false, e
		}
		next := item
		next.Integration, _ = json.Marshal(map[string]any{"conflict": map[string]any{"paths": conflict.Paths, "onto": checks.ForeignHead, "head": conflict.Head, "tree": conflict.Tree, "base": item.CandidateBase, "pre_rebase_head": item.CandidateHead}})
		checks.ConflictReservation = reservation
		next.Checks, next.State, next.Reason = checks.encode(), "integrating", "rebase_conflict_pending"
		return &next, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	commit, err := st.r.g.readCommit(ctx, head)
	if err != nil {
		return nil, false, err
	}
	written, err := st.r.g.replant(ctx, pending.Onto, []mythicalCommit{commit}, "bring-in", false)
	if err != nil {
		return nil, false, err
	}
	head = written[0].ID
	next := item
	next.CandidateHead = head
	if paths, e := st.protectedChanges(ctx, next); e != nil {
		return nil, false, e
	} else if len(paths) > 0 {
		return nil, false, errors.New("foreign push changes protected paths")
	}
	now := st.now
	checks.Waits[index].SettledAt = &now
	checks.ForeignBring, checks.ForeignHead, checks.Review, checks.Land = nil, "", nil, nil
	next.PRHead, next.Checks = checks.Waits[index].SHA, checks.encode()
	return st.verifyCandidate(ctx, item, next, pending.Onto, head, nil)
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
	if err := tx.QueryRow(ctx, `SELECT repository_id,status FROM workspaces WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, pending.Workspace).Scan(&repository, &status); err != nil {
		return err
	}
	if repository != current.RepositoryID || current.WorkspaceID != "" || (status != "stopped" && status != "suspended") {
		return errors.New("branch woke before Bring in verification")
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
