package services

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// Scratch requests belong to the existing branch activity stream. Their private
// execution binding is retained with the request, never in a synthetic item,
// coding run, machine payload or public event.
type scratchRebaseIntent struct {
	Workspace       string                  `json:"workspace"`
	Branch          string                  `json:"branch"`
	Before          string                  `json:"before"`
	Published       string                  `json:"published"`
	Base            string                  `json:"base"`
	Onto            string                  `json:"onto"`
	TargetRef       string                  `json:"target_ref"`
	Phase           string                  `json:"phase"`
	BlockingBoot    string                  `json:"blocking_boot,omitempty"`
	BlockingSession uint32                  `json:"blocking_session,omitempty"`
	Head            string                  `json:"head,omitempty"`
	Native          *machined.RewriteResult `json:"native,omitempty"`
	ConflictChange  string                  `json:"conflict_change,omitempty"`
	Done            *scratchRebaseDone      `json:"done,omitempty"`
	Authority       *mythicalRebaseRequest  `json:"authority"`
	Command         string                  `json:"command"`
	Credential      string                  `json:"credential"`
	Request         string                  `json:"request"`
	Input           BranchRebaseInput       `json:"input"`
}

type scratchRebaseDone struct {
	Credential string                 `json:"credential"`
	Request    string                 `json:"request"`
	Input      BranchRebaseInput      `json:"input"`
	Authority  *mythicalRebaseRequest `json:"authority"`
}

func (in scratchRebaseIntent) executionAuthority() (*mythicalRebaseRequest, string) {
	if in.Done != nil {
		return in.Done.Authority, "branch.rebase"
	}
	return in.Authority, in.Command
}

type scratchRebasePrivate struct {
	Rebase scratchRebaseIntent `json:"scratch_rebase"`
}

type BranchRebaseExecution struct {
	Onto  string `json:"onto"`
	State string `json:"state"`
}

func (s *MythicalService) scratchWorkspaces(q *db.Queries, tx pgx.Tx) (*WorkspaceService, error) {
	lanes, ok := s.lanes.(*workspaceMythicalLanes)
	if !ok || lanes.workspaces == nil {
		return nil, &BranchError{503, "rebase_execution_unavailable", "infra", "Rebase execution unavailable"}
	}
	w := *lanes.workspaces
	w.q, w.installQueries = q, q
	if tx != nil {
		w.transactions = tx
	}
	return &w, nil
}

func scratchWorkspace(ctx context.Context, tx pgx.Tx, q *db.Queries, repository int64, branch string) (db.Workspace, error) {
	if _, err := uuid.Parse(branch); err == nil {
		return q.GetWorkspaceByRepo(ctx, db.GetWorkspaceByRepoParams{ID: branch, RepositoryID: repository})
	}
	return branchWorkspaceByName(ctx, tx, q, repository, branch)
}

// The initial delta is measured from the actual fork tip, including its source
// TODO's bytes. Later rebases use their completed source revision, without
// changing the immutable source_commit used to authenticate machine startup.
func scratchRebaseBase(ctx context.Context, tx pgx.Tx, row db.Workspace) (string, error) {
	var base string
	err := tx.QueryRow(ctx, `SELECT authorization_context->'scratch_rebase'->>'onto' FROM product_job_requests
 WHERE tenant_id=$1 AND principal_id=$2 AND operation='branch.rebase-requested'
 AND (authorization_context->'scratch_rebase'->>'phase'='completed'
 OR (authorization_context->'scratch_rebase'->>'phase'='failed'
 AND authorization_context->'scratch_rebase'->'native'->>'Inspected'='true'
 AND authorization_context->'scratch_rebase'->>'workspace'=$3
 AND authorization_context->'scratch_rebase'->>'branch'=$4
 AND authorization_context->'scratch_rebase'->'native'->>'Head'=authorization_context->'scratch_rebase'->>'head'
 AND COALESCE(authorization_context->'scratch_rebase'->'native'->>'receipt_id','')<>''))
 ORDER BY created_at DESC,id DESC LIMIT 1`, strconv.FormatInt(row.RepositoryID, 10), "branch:"+row.ID, row.ID, row.TargetBookmark).Scan(&base)
	if errors.Is(err, pgx.ErrNoRows) {
		return row.SourceCommit, nil
	}
	return base, err
}

func (s *MythicalService) scratchRebaseTarget(ctx context.Context, q *db.Queries, row db.Workspace) (string, string, error) {
	repository, owner, err := s.repository(ctx, row.RepositoryID)
	if err != nil {
		return "", "", err
	}
	if row.ParentWorkspaceID.Valid || row.ForkedFromItem.Valid {
		var parent db.Workspace
		if row.ParentWorkspaceID.Valid {
			parent, err = q.GetWorkspace(ctx, uuid.UUID(row.ParentWorkspaceID.Bytes).String())
		} else {
			var item db.MythicalItem
			item, err = q.GetMythicalItem(ctx, row.ForkedFromItem)
			if err == nil {
				parent, err = q.GetMythicalTodoBranchWorkspace(ctx, item)
			}
		}
		if err != nil || parent.RepositoryID != row.RepositoryID || parent.DeletedAt.Valid {
			return "", "", &BranchError{409, "rebase_target_changed", "conflict", "Branch changed"}
		}
		ref := repohost.BranchHeadRef(parent.ID)
		head, err := s.refCommit(ctx, owner, repository.Name, ref)
		if err != nil {
			return "", "", err
		}
		if head == "" {
			head = parent.HeadCommitID
		}
		if !isLowerHexRevision(head) {
			return "", "", &BranchError{503, "rebase_target_unavailable", "infra", "Rebase target unavailable"}
		}
		return ref, head, nil
	}
	ref := "refs/heads/" + mythicalDefaultBranch(repository)
	head, err := s.MainHead(ctx, owner, repository.Name, mythicalDefaultBranch(repository))
	return ref, head, err
}

func (s *MythicalService) requestScratchRebase(ctx context.Context, repository, actor int64, branch string, input BranchRebaseInput) (TodoControlReceipt, error) {
	if s.branchRebase == nil {
		return TodoControlReceipt{}, &BranchError{503, "rebase_execution_unavailable", "infra", "Rebase execution unavailable"}
	}
	var receipt TodoControlReceipt
	var inspection scratchConflictInspection
	admit := func(tx pgx.Tx) error {
		q := db.New(tx)
		person, credential, err := lockTodoRequest(ctx, tx, q, "branch.rebase-now", TodoControlInput{Repository: repository, Actor: actor, Request: input.Request})
		if err != nil {
			return err
		}
		stack, err := q.GetMythicalStack(ctx, repository)
		if err != nil {
			return err
		}
		if stack.State != "active" || len(stack.PendingOp) != 0 {
			return &BranchError{503, "rebase_unavailable", "infra", "Stack unavailable"}
		}
		if _, err = q.LockMythicalStackOrder(ctx, repository); err != nil {
			return err
		}
		row, err := scratchWorkspace(ctx, tx, q, repository, branch)
		if err != nil {
			return err
		}
		if !row.IsFork || branchKind(row.TargetBookmark) != "scratch" || row.BranchArchivedAt.Valid {
			return &BranchError{409, "rebase_target_changed", "conflict", "Branch changed"}
		}
		w, err := s.scratchWorkspaces(q, tx)
		if err != nil {
			return err
		}
		if _, err = w.loadWorkspaceWithAccess(ctx, row.ID, repository, actor, WorkspaceAccessWrite); err != nil {
			return err
		}
		if err = w.authorizeBranchFileRead(ctx, row, actor); err != nil {
			return err
		}
		var raw []byte
		err = tx.QueryRow(ctx, `SELECT authorization_context FROM product_job_requests WHERE tenant_id=$1
 AND principal_id=$2 AND operation='branch.rebase-requested' AND authorization_context->'scratch_rebase'->>'credential'=$3
 AND authorization_context->'scratch_rebase'->>'request'=$4`, strconv.FormatInt(repository, 10), "branch:"+row.ID, credential, input.Request).Scan(&raw)
		if err == nil {
			var prior scratchRebasePrivate
			if err = json.Unmarshal(raw, &prior); err != nil {
				return err
			}
			body := input
			body.Request = ""
			if prior.Rebase.Input != body {
				return todoRequestMismatch()
			}
			receipt = TodoControlReceipt{State: "accepted", Branch: row.ID, Onto: prior.Rebase.Onto}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if row.Status != "running" && row.Status != "stopped" && row.Status != "suspended" {
			return &BranchError{409, "rebase_not_ready", "conflict", "Branch unavailable"}
		}
		base, err := scratchRebaseBase(ctx, tx, row)
		if err != nil {
			return err
		}
		ref, onto, err := s.scratchRebaseTarget(ctx, q, row)
		if err != nil {
			return err
		}
		var pendingID string
		var pendingRaw []byte
		err = tx.QueryRow(ctx, `SELECT id,authorization_context FROM product_job_requests WHERE tenant_id=$1 AND principal_id=$2
 AND operation='branch.rebase-requested' AND authorization_context->'scratch_rebase'->>'phase' IN ('requested','prepared','conflict','resolved') ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`, strconv.FormatInt(repository, 10), "branch:"+row.ID).Scan(&pendingID, &pendingRaw)
		if err == nil {
			var prior scratchRebasePrivate
			if err = json.Unmarshal(pendingRaw, &prior); err != nil {
				return err
			}
			old := prior.Rebase
			if old.Phase != "conflict" || old.Onto == onto || old.Workspace != row.ID || old.Branch != row.TargetBookmark {
				return &BranchError{409, "rebase_pending", "conflict", "Rebase pending"}
			}
			// Only an explicit new request replaces a stale conflict target.
			// The retained receipt remains intact for old-key replay and audit.
			base = old.Base
			if old.Native != nil && old.Native.Inspected {
				if old.Native.Head != old.ConflictChange || old.Native.ReceiptID == "" {
					return machined.ErrNotReady
				}
				if row.Status != "running" {
					return machined.ErrNotReady
				}
				if !inspection.Verified {
					inspection = scratchConflictInspection{ID: pendingID, Workspace: row.ID, Change: old.ConflictChange, Onto: old.Onto, Binding: append([]byte{}, pendingRaw...)}
					return nil
				}
				if !inspection.matches(pendingID, row.ID, pendingRaw) {
					return &BranchError{409, "stale_conflict", "conflict", "The conflict target changed"}
				}
				base = old.Onto
			}
			old.Phase = "failed"
			if err = saveScratchIntent(ctx, tx, pendingID, old); err != nil {
				return err
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if !isLowerHexRevision(base) || !isLowerHexRevision(onto) || !isLowerHexRevision(row.HeadCommitID) {
			return &BranchError{503, "rebase_target_unavailable", "infra", "Rebase target unavailable"}
		}
		repo, owner, err := s.repository(ctx, repository)
		if err != nil {
			return err
		}
		published, err := s.refCommit(ctx, owner, repo.Name, scratchRef(row.TargetBookmark))
		if err != nil {
			return err
		}
		info := middleware.AuthInfoFromContext(ctx)
		intent := scratchRebaseIntent{Workspace: row.ID, Branch: row.TargetBookmark, Before: row.HeadCommitID, Published: published, Base: base, Onto: onto, TargetRef: ref, Phase: "requested", Command: "branch.rebase-now", Credential: credential, Request: input.Request, Input: input,
			Authority: &mythicalRebaseRequest{User: actor, Credential: middleware.CredentialOf(info), RawScopes: info.RawScopes, Via: info.ViaHint, Head: row.HeadCommitID, By: todoActorRef(ctx, person)}}
		// Request is stored separately; JSON deliberately omits its transport-only field.
		intent.Input.Request = ""
		fact, _ := json.Marshal(map[string]any{"branch": row.TargetBookmark, "workspace": row.ID, "onto": onto, "actor": map[string]string{"kind": "system", "id": "stack"}, "by": intent.Authority.By})
		id := uuid.NewString()
		if _, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: strconv.FormatInt(repository, 10), PrincipalID: "branch:" + row.ID}, id, "branch.rebase-requested", "requested", fact); err != nil {
			return err
		}
		private, err := json.Marshal(scratchRebasePrivate{Rebase: intent})
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE product_job_requests SET authorization_context=$2::jsonb WHERE id=$1`, id, private); err != nil {
			return err
		}
		if _, err = q.RequestMythicalStack(ctx, repository); err != nil {
			return err
		}
		receipt = TodoControlReceipt{State: "accepted", Branch: row.ID, Onto: onto}
		return nil
	}
	err := s.admitScratchAfterInspection(ctx, &inspection, &receipt, admit)
	return receipt, err
}

func (s *MythicalService) ScratchRebaseExecution(ctx context.Context, repository, actor int64, branch, key string) (BranchRebaseExecution, error) {
	credential, err := todoRequestCredential(ctx, actor)
	if err != nil {
		return BranchRebaseExecution{}, err
	}
	var result BranchRebaseExecution
	err = pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		q := db.New(tx)
		if err := guardInstallMemberCredential(ctx, tx, repository, actor, false); err != nil {
			return err
		}
		row, err := scratchWorkspace(ctx, tx, q, repository, branch)
		if err != nil {
			return err
		}
		w, err := s.scratchWorkspaces(q, tx)
		if err != nil {
			return err
		}
		if _, err = w.loadWorkspaceWithAccess(ctx, row.ID, repository, actor, WorkspaceAccessRead); err != nil {
			return err
		}
		var onto, phase string
		err = tx.QueryRow(ctx, `SELECT authorization_context->'scratch_rebase'->>'onto',authorization_context->'scratch_rebase'->>'phase' FROM product_job_requests
 WHERE tenant_id=$1 AND principal_id=$2 AND operation='branch.rebase-requested'
 AND ((authorization_context->'scratch_rebase'->>'credential'=$3 AND authorization_context->'scratch_rebase'->>'request'=$4)
 OR (authorization_context->'scratch_rebase'->'done'->>'credential'=$3 AND authorization_context->'scratch_rebase'->'done'->>'request'=$4))`, strconv.FormatInt(repository, 10), "branch:"+row.ID, credential, key).Scan(&onto, &phase)
		if errors.Is(err, pgx.ErrNoRows) {
			return &BranchError{404, "rebase_not_found", "user", "Rebase receipt unavailable"}
		}
		if err != nil {
			return err
		}
		if phase == "requested" || phase == "prepared" || phase == "resolved" {
			phase = "running"
		}
		result = BranchRebaseExecution{Onto: onto, State: phase}
		return nil
	})
	return result, err
}

func scratchRef(branch string) string { return "refs/heads/" + strings.TrimSpace(branch) }

// Reconnect only an already-running Scratch daemon. A rebase never wakes it
// implicitly or creates an agent session to obtain a machine binding.
func (s *WorkspaceService) EnsureScratchRebaseDaemon(ctx context.Context, branch string) error {
	actor := middleware.UserFromContext(ctx)
	if actor == nil {
		return machined.ErrUnauthorized
	}
	row, err := s.q.GetWorkspace(ctx, branch)
	if err != nil {
		return err
	}
	if !row.IsFork || branchKind(row.TargetBookmark) != "scratch" || row.Status != "running" || row.BranchArchivedAt.Valid {
		return machined.ErrNotReady
	}
	if _, err = s.loadWorkspaceWithAccess(ctx, row.ID, row.RepositoryID, actor.ID, WorkspaceAccessWrite); err != nil {
		return err
	}
	runtime, ok := s.runtime.(interface {
		EnsureMachined(context.Context, string) error
	})
	if !ok {
		return machined.ErrNotReady
	}
	return runtime.EnsureMachined(ctx, row.ID)
}

// Called only after the shared branch metadata authorizer admits the row.
// The projection selects public conflict fields, never request credentials.
func (s *WorkspaceService) BranchRebaseState(ctx context.Context, row db.Workspace) (map[string]any, error) {
	if branchKind(row.TargetBookmark) != "scratch" || s.transactions == nil {
		return nil, nil
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT authorization_context FROM product_job_requests WHERE tenant_id=$1 AND principal_id=$2 AND operation='branch.rebase-requested'
 AND authorization_context->'scratch_rebase'->>'phase' IN ('requested','prepared','conflict','resolved') ORDER BY created_at DESC,id DESC LIMIT 1`, strconv.FormatInt(row.RepositoryID, 10), "branch:"+row.ID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		if !row.IsFork || s.branchHeads == nil {
			return nil, nil
		}
		base, err := scratchRebaseBase(ctx, tx, row)
		if err != nil {
			return nil, err
		}
		slug, err := s.workspaceRepoSlug(ctx, row.RepositoryID)
		if err != nil {
			return nil, err
		}
		owner, repo, _ := strings.Cut(slug, "/")
		advertisement, err := s.branchHeads.InfoRefsUploadPack(ctx, owner, repo)
		if err != nil {
			return nil, err
		}
		refs, err := parseUploadPackAdvertisement(advertisement)
		if err != nil {
			return nil, err
		}
		repository, err := db.New(tx).GetRepoByID(ctx, row.RepositoryID)
		if err != nil {
			return nil, err
		}
		name, ref := mythicalDefaultBranch(repository), "refs/heads/"+mythicalDefaultBranch(repository)
		if row.ParentWorkspaceID.Valid {
			parent, err := db.New(tx).GetWorkspace(ctx, uuid.UUID(row.ParentWorkspaceID.Bytes).String())
			if err != nil {
				return nil, err
			}
			if parent.RepositoryID != row.RepositoryID || parent.DeletedAt.Valid {
				return nil, nil
			}
			name, ref = parent.TargetBookmark, repohost.BranchHeadRef(parent.ID)
		}
		if row.ForkedFromItem.Valid {
			item, err := db.New(tx).GetMythicalItem(ctx, row.ForkedFromItem)
			if err != nil {
				return nil, err
			}
			name = "T" + strconv.FormatInt(item.Number.Int64, 10)
			if !row.ParentWorkspaceID.Valid {
				parent, err := db.New(tx).GetMythicalTodoBranchWorkspace(ctx, item)
				if err != nil {
					return nil, err
				}
				ref = repohost.BranchHeadRef(parent.ID)
			}
		}
		for _, candidate := range refs {
			if candidate.name == ref && isLowerHexRevision(candidate.oid) && candidate.oid != base {
				return map[string]any{"state": "pending", "onto": name}, nil
			}
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var private scratchRebasePrivate
	if err = json.Unmarshal(raw, &private); err != nil {
		return nil, err
	}
	in := private.Rebase
	name := "main"
	if row.ForkedFromItem.Valid {
		item, err := db.New(tx).GetMythicalItem(ctx, row.ForkedFromItem)
		if err != nil {
			return nil, err
		}
		name = "T" + strconv.FormatInt(item.Number.Int64, 10)
	} else if row.ParentWorkspaceID.Valid {
		parent, err := db.New(tx).GetWorkspace(ctx, uuid.UUID(row.ParentWorkspaceID.Bytes).String())
		if err != nil {
			return nil, err
		}
		name = parent.TargetBookmark
	}
	state := "pending"
	if in.Phase == "prepared" || in.Phase == "resolved" {
		state = "rebasing"
	}
	projection := map[string]any{"state": state, "onto": name}
	if state == "pending" {
		if writer := rebaseWaitingFor(ctx, s.rebaseBlocker, row.ID, in.BlockingBoot, in.BlockingSession); writer != nil {
			projection["waiting_for"] = writer
		}
	}
	if in.Phase == "conflict" && in.Native != nil {
		projection["state"], projection["paths"] = "conflict", append([]string{}, in.Native.Paths...)
		if in.Native.Inspected && in.Native.ReceiptID != "" {
			projection["conflict_change"], projection["onto_revision"] = in.ConflictChange, in.Onto
		}
	}
	return projection, nil
}

func (s *MythicalService) answerScratchConflict(ctx context.Context, repository, actor int64, branch string, input BranchRebaseInput) (TodoControlReceipt, error) {
	_, ok := s.branchRebase.(scratchConflictInspector)
	if !ok {
		return TodoControlReceipt{}, &BranchError{503, "conflict_validation_unavailable", "infra", "Conflict validation unavailable"}
	}
	var receipt TodoControlReceipt
	var inspection scratchConflictInspection
	admit := func(tx pgx.Tx) error {
		q := db.New(tx)
		person, credential, err := lockTodoRequest(ctx, tx, q, "branch.rebase", TodoControlInput{Repository: repository, Actor: actor, Request: input.Request})
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `SELECT repository_id FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, repository); err != nil {
			return err
		}
		if _, err = q.LockMythicalStackOrder(ctx, repository); err != nil {
			return err
		}
		row, err := scratchWorkspace(ctx, tx, q, repository, branch)
		if err != nil {
			return err
		}
		w, err := s.scratchWorkspaces(q, tx)
		if err != nil {
			return err
		}
		if _, err = w.loadWorkspaceWithAccess(ctx, row.ID, repository, actor, WorkspaceAccessWrite); err != nil {
			return err
		}
		var id string
		var raw []byte
		err = tx.QueryRow(ctx, `SELECT id,authorization_context FROM product_job_requests WHERE tenant_id=$1 AND principal_id=$2 AND operation='branch.rebase-requested'
 AND authorization_context->'scratch_rebase'->>'phase' IN ('conflict','resolved','prepared','completed')
 AND authorization_context->'scratch_rebase'->>'conflict_change'=$3 AND authorization_context->'scratch_rebase'->>'onto'=$4
 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`, strconv.FormatInt(repository, 10), "branch:"+row.ID, input.ConflictChange, input.OntoRevision).Scan(&id, &raw)
		if errors.Is(err, pgx.ErrNoRows) {
			return &BranchError{409, "stale_conflict", "conflict", "The conflict target changed"}
		}
		if err != nil {
			return err
		}
		var private scratchRebasePrivate
		if err = json.Unmarshal(raw, &private); err != nil {
			return err
		}
		in := private.Rebase
		if in.Phase != "conflict" {
			if in.Done != nil && in.Done.Credential == credential && in.Done.Request == input.Request && in.Done.Input.ConflictChange == input.ConflictChange && in.Done.Input.OntoRevision == input.OntoRevision {
				receipt = TodoControlReceipt{State: "accepted", Branch: row.ID, Onto: in.Onto}
				return nil
			}
			return &BranchError{409, "stale_conflict", "conflict", "The conflict target changed"}
		}
		_, onto, err := s.scratchRebaseTarget(ctx, q, row)
		if err != nil {
			return err
		}
		if onto != in.Onto || row.TargetBookmark != in.Branch || row.BranchArchivedAt.Valid || len(row.MovedOff) != 0 {
			return &BranchError{409, "stale_conflict", "conflict", "The conflict target changed"}
		}
		if row.Status != "running" || in.Native == nil || !in.Native.Inspected || len(in.Native.Paths) == 0 || in.Native.ReceiptID == "" {
			return &BranchError{503, "conflict_validation_unavailable", "infra", "Conflict validation unavailable"}
		}
		if !inspection.Verified {
			inspection = scratchConflictInspection{ID: id, Workspace: row.ID, Change: input.ConflictChange, Onto: input.OntoRevision, Binding: append([]byte{}, raw...)}
			return nil
		}
		if !inspection.matches(id, row.ID, raw) {
			return &BranchError{409, "stale_conflict", "conflict", "The conflict target changed"}
		}
		info := middleware.AuthInfoFromContext(ctx)
		next := in
		next.Done = &scratchRebaseDone{Credential: credential, Request: input.Request, Input: input, Authority: &mythicalRebaseRequest{User: actor, Credential: middleware.CredentialOf(info), RawScopes: info.RawScopes, Via: info.ViaHint, Head: row.HeadCommitID, By: todoActorRef(ctx, person)}}
		next.Done.Input.Request = ""
		next.Phase = "resolved"
		if err = saveScratchIntent(ctx, tx, id, next); err != nil {
			return err
		}
		if _, err = q.RequestMythicalStack(ctx, repository); err != nil {
			return err
		}
		receipt = TodoControlReceipt{State: "accepted", Branch: row.ID, Onto: in.Onto}
		return nil
	}
	err := s.admitScratchAfterInspection(ctx, &inspection, &receipt, admit)
	return receipt, err
}

// Both conflict doors drain outside SQL mutation locks and then repeat their
// fresh ordered admission against the exact private receipt they inspected.
type scratchConflictInspector interface {
	InspectConflict(context.Context, string, string, string) ([]string, error)
}
type scratchConflictInspection struct {
	ID, Workspace, Change, Onto string
	Binding                     []byte
	Verified                    bool
}

func (v scratchConflictInspection) matches(id, workspace string, binding []byte) bool {
	return v.Verified && v.ID == id && v.Workspace == workspace && string(v.Binding) == string(binding)
}
func (s *MythicalService) admitScratchAfterInspection(ctx context.Context, validation *scratchConflictInspection, receipt *TodoControlReceipt, admit func(pgx.Tx) error) error {
	if err := pgx.BeginFunc(ctx, s.store, admit); err != nil {
		return err
	}
	if receipt.State != "" {
		return nil
	}
	inspector, ok := s.branchRebase.(scratchConflictInspector)
	if !ok || validation.Workspace == "" {
		return machined.ErrNotReady
	}
	paths, err := inspector.InspectConflict(ctx, validation.Workspace, validation.Change, validation.Onto)
	if err != nil {
		return err
	}
	if len(paths) != 0 {
		return &BranchError{409, "still_conflicted", "conflict", "Conflict remains"}
	}
	validation.Verified = true
	return pgx.BeginFunc(ctx, s.store, admit)
}
