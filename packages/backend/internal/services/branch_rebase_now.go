package services

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// BranchRebaseInput is the system rebase door. Done names the retained change
// and onto revision; Rebase now never accepts a caller-selected destination.
type BranchRebaseInput struct {
	Rebase         bool   `json:"rebase,omitempty"`
	ConflictChange string `json:"conflict_change,omitempty"`
	OntoRevision   string `json:"onto_revision,omitempty"`
	Request        string `json:"-"`
}

func (in BranchRebaseInput) Validate() error {
	validID := func(value string) bool {
		return value != "" && len(value) <= 128 && utf8.ValidString(value) && !strings.ContainsAny(value, " \t\r\n\x00")
	}
	if len(in.Request) > 256 || (in.Rebase && (in.ConflictChange != "" || in.OntoRevision != "")) ||
		(!in.Rebase && (!validID(in.ConflictChange) || !validID(in.OntoRevision))) {
		return &BranchError{400, "invalid_rebase", "user", "Invalid rebase request"}
	}
	return nil
}

// RebaseBranch admits a bound request to the existing stack worker. The HTTP
// request never waits for the rewrite, verification or GitHub publication.
func (s *MythicalService) RebaseBranch(ctx context.Context, repository, actor int64, branch string, input BranchRebaseInput) (TodoControlReceipt, error) {
	if err := input.Validate(); err != nil {
		return TodoControlReceipt{}, err
	}
	if branch == "" || len(branch) > 1024 || strings.ContainsAny(branch, "\x00\r\n") {
		return TodoControlReceipt{}, &BranchError{400, "invalid_branch", "user", "Invalid branch"}
	}
	if s == nil || s.store == nil {
		return TodoControlReceipt{}, &BranchError{503, "rebase_unavailable", "infra", "Rebase unavailable"}
	}
	command := "branch.rebase"
	if input.Rebase {
		command = "branch.rebase-now"
	}
	decision, err := Authorize(ctx, s.queries(), command)
	if err != nil {
		return TodoControlReceipt{}, err
	}
	resolved, err := InstallRepositoryID(ctx, s.queries())
	if err != nil {
		return TodoControlReceipt{}, err
	}
	if decision.UserID != actor || resolved != repository {
		return TodoControlReceipt{}, &BranchError{403, "permission", "permission", "Access denied"}
	}
	// Refuse machine/run authority even when a caller bypasses the HTTP route.
	if _, err := todoRequestCredential(ctx, actor); err != nil {
		return TodoControlReceipt{}, err
	}
	if !input.Rebase || s.host == nil || s.launcher == nil {
		return TodoControlReceipt{}, &BranchError{503, "rebase_execution_unavailable", "infra", "Rebase execution unavailable"}
	}
	return s.requestBranchRebase(ctx, repository, actor, branch, input)
}

func (s *MythicalService) requestBranchRebase(ctx context.Context, repository, actor int64, branch string, input BranchRebaseInput) (TodoControlReceipt, error) {
	control := TodoControlInput{Op: "rebase", Repository: repository, Actor: actor, Request: input.Request, Revision: branch}
	var receipt TodoControlReceipt
	err := pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		q := db.New(tx)
		person, credential, err := lockTodoRequest(ctx, tx, q, "branch.rebase-now", control)
		if err != nil {
			return err
		}
		stack, err := q.GetMythicalStack(ctx, repository)
		if err != nil {
			return err
		}
		if stack.State != "active" {
			return &BranchError{503, "rebase_unavailable", "infra", "Stack unavailable"}
		}
		order, err := q.LockMythicalStackOrder(ctx, repository)
		if err != nil {
			return err
		}
		// Resolve both the durable workspace ID and the published branch name.
		// A retired review lane cannot select a different item's candidate.
		var number int64
		err = tx.QueryRow(ctx, `SELECT i.number FROM mythical_items i
          WHERE i.repository_id=$1 AND i.source='todo' AND (i.workspace_id=$2 OR i.checks->>'branch'=$2
            OR EXISTS (SELECT 1 FROM mythical_lanes l JOIN workspaces w ON w.id::text=l.workspace_id
              WHERE l.item_id=i.id AND (w.id::text=$2 OR (w.target_bookmark=$2 AND w.target_bookmark <> 'mythical'))))
          ORDER BY i.created_at DESC LIMIT 1`, repository, branch).Scan(&number)
		if errors.Is(err, pgx.ErrNoRows) {
			return &BranchError{503, "rebase_execution_unavailable", "infra", "Rebase execution unavailable"}
		}
		if err != nil {
			return err
		}
		item, err := q.GetMythicalItemByNumber(ctx, repository, number)
		if err != nil {
			return err
		}
		if prior, found, err := todoControlReplay(ctx, tx, q, item, control, credential, "todo.rebase-requested"); found || err != nil {
			receipt = prior
			return err
		}
		if _, parseErr := uuid.Parse(branch); parseErr == nil {
			workspace, err := q.GetMythicalTodoBranchWorkspace(ctx, item)
			if err != nil || workspace.ID != branch {
				return &BranchError{409, "rebase_target_changed", "conflict", "Branch changed"}
			}
		}
		if mythicalMergeFenced(item) || len(item.PendingOp) != 0 {
			return &BranchError{409, "merging", "conflict", "Branch publication is in progress"}
		}
		checks := mythicalChecksOf(item)
		pending := checks.Rebase
		if item.Reason == "rebase_conflict_pending" {
			return &BranchError{409, "rebase_conflict_pending", "conflict", "Resolve the conflict"}
		}
		if !item.StackPosition.Valid || item.State != "integrating" || item.PausedAt.Valid || pending == nil || pending.Rebased || item.CandidateHead == "" {
			return &BranchError{409, "rebase_not_pending", "conflict", "No rebase pending"}
		}
		// Folding main waits for these items to rebase. Its recorded landed
		// main therefore remains the old head during admission; bind the same
		// mirrored bookmark the stack worker actually uses, never that receipt.
		repo, err := q.GetRepoByID(ctx, repository)
		if err != nil {
			return err
		}
		owner, err := mythicalRepositoryOwner(ctx, q, repo)
		if err != nil {
			return err
		}
		bookmark := strings.TrimSpace(repo.DefaultBookmark)
		if bookmark == "" {
			bookmark = "main"
		}
		main, err := s.MainHead(ctx, owner, repo.Name, bookmark)
		if err != nil || main == "" {
			return &BranchError{503, "rebase_unavailable", "infra", "Stack unavailable"}
		}
		step := mythicalItemStep{r: &mythicalRun{row: stack, mainTip: main}, items: order}
		if pending.Onto != step.prefix(item) {
			return &BranchError{409, "rebase_target_changed", "conflict", "Rebase target changed"}
		}
		// Distinct presses while this exact rewrite is pending coalesce too.
		if pending.Request == nil || pending.Request.Head != item.CandidateHead || pending.Request.Generation != item.Generation || !s.rebaseRequestAuthorized(ctx, q, item, pending.Request) {
			info := middleware.AuthInfoFromContext(ctx)
			pending.Request = &mythicalRebaseRequest{Head: item.CandidateHead, Generation: item.Generation, By: todoActorRef(ctx, person), User: person.ID, Credential: middleware.CredentialOf(info), RawScopes: info.RawScopes, Via: info.ViaHint}
			checks.Land = nil
			if item.PRHead != "" {
				checks.ApprovalCleared = item.PRHead
			}
			item.Checks = checks.encode()
			item.NextAttemptAt.Valid = false
			item, err = q.SaveMythicalItem(ctx, item)
			if err != nil {
				return err
			}
		}
		receipt = TodoControlReceipt{State: "accepted", Number: number}
		if err = s.recordTodoControl(ctx, tx, item, control, credential, "todo.rebase-requested", receipt, map[string]any{
			"item": uuidString(item.ID), "n": number, "onto": pending.Onto, "head": item.CandidateHead,
			"generation": item.Generation, "actor": map[string]string{"kind": "system", "id": "stack"}, "by": todoActorRef(ctx, person),
		}); err != nil {
			return err
		}
		_, err = q.RequestMythicalStack(ctx, repository)
		return err
	})
	return receipt, err
}
