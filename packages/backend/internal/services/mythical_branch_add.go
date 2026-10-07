package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// BranchAddInput uses the same placement as a new TODO. Omitted placement
// inserts after the source item; a main fork appends.
type BranchAddInput struct {
	Text       string   `json:"text"`
	Title      string   `json:"title,omitempty"`
	Acceptance []string `json:"acceptance,omitempty"`
	After      *int64   `json:"after,omitempty"`
	Before     *int64   `json:"before,omitempty"`
	Request    string   `json:"-"`
}

type branchSeed struct {
	Base       string `json:"base"`
	ForkCommit string `json:"fork_commit"`
	Head       string `json:"head"`
	Captured   string `json:"captured"`
	Diff       string `json:"diff"`
}

func (s *MythicalService) AddBranchToStack(ctx context.Context, repository, actor int64, branch string, input BranchAddInput) (MythicalItemView, error) {
	if s == nil || s.store == nil || s.host == nil {
		return MythicalItemView{}, branchForkUnavailable("Add to stack unavailable")
	}
	decision, err := Authorize(ctx, s.queries(), "branch.add-to-stack")
	if err != nil {
		return MythicalItemView{}, err
	}
	if decision.UserID != actor {
		return MythicalItemView{}, &BranchError{403, "permission", "permission", "Access denied"}
	}
	if strings.TrimSpace(branch) == "" || input.Request == "" || len(input.Request) > 256 || input.After != nil && input.Before != nil || input.After != nil && *input.After < 1 || input.Before != nil && *input.Before < 1 {
		return MythicalItemView{}, &BranchError{400, "bad_request", "user", "Invalid Add to stack request"}
	}
	reader, ok := s.lanes.(interface {
		CapturedHead(context.Context, string, int64, int64) (string, error)
		AdmitScratch(context.Context, pgx.Tx, int64, int64, db.Workspace) error
	})
	if !ok {
		return MythicalItemView{}, branchForkUnavailable("Capture unavailable")
	}
	canonical, _ := json.Marshal(struct {
		Branch string         `json:"branch"`
		Input  BranchAddInput `json:"input"`
	}{branch, input})
	info := middleware.AuthInfoFromContext(ctx)
	var result MythicalItemView
	err = pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		q := db.New(tx)
		if err := guardInstallTodoWrite(ctx, tx, repository, actor); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, repository); err != nil {
			return err
		}
		prior, err := q.GetMythicalRequest(ctx, repository, info.SessionHash, input.Request)
		if err == nil {
			if mythicalChecksOf(prior).CreationPayload != string(canonical) {
				return &BranchError{409, "idempotency_mismatch", "conflict", "Idempotency-Key was already used"}
			}
			result = mythicalItemView(prior)
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		// Capture publication locks stack, items, then workspace. Adoption must
		// take the same order before binding or consuming the scratch snapshot.
		if _, err := tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, repository); err != nil {
			return err
		}
		order, err := q.LockMythicalStackOrder(ctx, repository)
		if err != nil {
			return err
		}
		workspace, err := branchAddWorkspace(ctx, q, repository, branch)
		if err != nil {
			return &BranchError{404, "branch_not_found", "user", "Branch not found"}
		}
		if _, err := tx.Exec(ctx, `SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE`, workspace.ID); err != nil {
			return err
		}
		workspace, err = q.GetWorkspace(ctx, workspace.ID)
		if err != nil {
			return err
		}
		if !strings.HasPrefix(workspace.TargetBookmark, scratchBranchPrefix) {
			return &BranchError{409, "branch_changed", "conflict", "Branch changed"}
		}
		if !workspace.IsFork || workspace.ForkedFromBase == "" {
			return &BranchError{409, "fork_provenance_missing", "conflict", "Branch has no fork revision"}
		}
		if err := reader.AdmitScratch(ctx, tx, repository, actor, workspace); err != nil {
			return err
		}
		head, err := reader.CapturedHead(ctx, workspace.ID, repository, actor)
		if err != nil {
			return err
		}
		if !mythicalSHA.MatchString(head) {
			return branchForkUnavailable("Capture unavailable")
		}
		repo, owner, err := s.repository(ctx, repository)
		if err != nil {
			return err
		}
		bridge, err := startMythicalBridge(ctx, s.host, owner, repo.Name, RepositoryStillAt(q, repository, owner, repo.Name))
		if err != nil {
			return err
		}
		defer bridge.Close()
		g, cleanup, err := s.forkGit(ctx, repository)
		if err != nil {
			return err
		}
		defer cleanup()
		if _, err = g.git(ctx, "fetch", "--quiet", "--no-tags", "--no-auto-maintenance", bridge.URL(), "+refs/*:refs/*"); err != nil {
			return err
		}
		commit, err := g.readCommit(ctx, head)
		if err != nil {
			return err
		}
		commit.Parents = []string{workspace.ForkedFromBase}
		commit.ChangeID = ""
		commit.Message = "Add to stack\n"
		seedHead, err := g.writeCommit(ctx, commit)
		if err != nil {
			return err
		}
		diffBytes, err := g.command(ctx, nil, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--binary", workspace.ForkedFromBase, head)
		diff := string(diffBytes)
		if err != nil {
			return err
		}
		seed := &branchSeed{Base: workspace.ForkedFromBase, ForkCommit: workspace.SourceCommit, Head: seedHead, Captured: head, Diff: diff}
		place := MythicalTodoPlace{Mode: "append"}
		after := input.After
		if after == nil && input.Before == nil && workspace.ForkedFromItem.Valid {
			source, err := q.GetMythicalItem(ctx, workspace.ForkedFromItem)
			if err != nil {
				return err
			}
			if !mythicalOffStack(source.State) {
				n := source.Number.Int64
				after = &n
			}
		}
		if input.Before != nil {
			place = MythicalTodoPlace{Mode: "before", N: input.Before}
		}
		if after != nil {
			found := false
			for i, item := range order {
				if item.Number.Int64 == *after {
					found = true
					if i+1 < len(order) {
						n := order[i+1].Number.Int64
						place = MythicalTodoPlace{Mode: "before", N: &n}
					}
					break
				}
			}
			if !found {
				return invalidTodoPlace("TODO is not on the stack")
			}
		}
		consumer := *s
		consumer.store = tx
		if strings.TrimSpace(input.Text) == "" {
			input.Text = workspace.TargetBookmark[strings.LastIndex(workspace.TargetBookmark, "/")+1:]
		}
		title, _, _ := strings.Cut(strings.TrimSpace(input.Text), "\n")
		if input.Title != "" {
			title = input.Title
		}
		view, err := consumer.FileTodo(ctx, repository, actor, MythicalTodoInput{Prompt: input.Text, Title: todoClip(title, 256), Place: place, Acceptance: input.Acceptance, Request: input.Request, seed: seed})
		if err != nil {
			return err
		}
		item, err := q.GetMythicalItemByNumber(ctx, repository, view.Number)
		if err != nil {
			return err
		}
		name := "smithers/" + workspace.TargetBookmark[strings.LastIndex(workspace.TargetBookmark, "/")+1:] + "-" + workspace.ID
		run := &mythicalRun{row: db.MythicalStack{RepositoryID: repository}, g: g, bridge: bridge, owner: owner, repo: repo.Name}
		if err = s.pin(ctx, run, seedHead); err != nil {
			return err
		}
		if _, err = s.retainFor(ctx, run, workspace.ID, seedHead); err != nil {
			return err
		}
		if err = s.renameScratch(ctx, run, workspace.TargetBookmark, name, seedHead); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE workspaces SET target_bookmark=$1 WHERE id=$2`, name, workspace.ID); err != nil {
			return err
		}
		item.WorkspaceID, item.BaseCommit = workspace.ID, seed.Base
		checks := mythicalChecksOf(item)
		checks.Seed = seed
		checks.Branch = name
		checks.CreationPayload = string(canonical)
		item.Checks = checks.encode()
		item, err = q.SaveMythicalItem(ctx, item)
		if err != nil {
			return err
		}
		if _, _, err = q.BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: workspace.ID, RepositoryID: repository, ItemID: item.ID, Name: name}); err != nil {
			return err
		}
		person, err := q.GetUserByID(ctx, actor)
		if err != nil {
			return err
		}
		fact, _ := json.Marshal(map[string]any{"actor": map[string]any{"kind": "system", "login": "smithers"}, "for": map[string]any{"kind": "person", "id": actor, "login": person.Username}, "branch": name, "workspace": workspace.ID, "n": view.Number})
		_, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(repository), PrincipalID: "branch:" + workspace.ID}, uuid.NewString(), "branch.added-to-stack", "item", fact)
		result = mythicalItemView(item)
		return err
	})
	return result, err
}

// The name is workspace-derived so an interrupted SQL commit cannot collide
// with a later TODO number. Ref writes are compare-and-swap, and retry accepts
// only the same seed, never an unrelated existing branch.
func (s *MythicalService) renameScratch(ctx context.Context, r *mythicalRun, source, target, head string) error {
	refs, err := r.g.lsRemote(ctx, r.bridge.URL())
	if err != nil {
		return err
	}
	from, to := "refs/heads/"+source, "refs/heads/"+target
	if refs[to] != "" && refs[to] != head {
		return &BranchError{409, "branch_changed", "conflict", "Branch changed"}
	}
	updates := []mythicalRefUpdate{}
	args := []string{"push", "--atomic", "--porcelain", "--no-verify"}
	if refs[to] == "" {
		updates = append(updates, mythicalRefUpdate{Ref: to, Old: strings.Repeat("0", 40), New: head})
		args = append(args, "--force-with-lease="+to+":")
	}
	if refs[from] != "" {
		updates = append(updates, mythicalRefUpdate{Ref: from, Old: refs[from], New: strings.Repeat("0", 40)})
		args = append(args, "--force-with-lease="+from+":"+refs[from])
	}
	if len(updates) == 0 {
		return nil
	}
	r.bridge.permit(updates, repohost.ReceivePackMetadata{RepositoryID: r.row.RepositoryID, PusherLogin: "smithers"})
	args = append(args, r.bridge.URL())
	if refs[to] == "" {
		args = append(args, head+":"+to)
	}
	if refs[from] != "" {
		args = append(args, ":"+from)
	}
	_, err = r.g.git(ctx, args...)
	return err
}

func branchAddWorkspace(ctx context.Context, q *db.Queries, repository int64, subject string) (db.Workspace, error) {
	if _, err := uuid.Parse(subject); err == nil {
		row, err := q.GetWorkspace(ctx, subject)
		if err == nil && row.RepositoryID != repository {
			return db.Workspace{}, pgx.ErrNoRows
		}
		return row, err
	}
	return q.GetBranchWorkspace(ctx, db.GetBranchWorkspaceParams{RepositoryID: repository, TargetBookmark: subject})
}

// Only a validated private confirmation preview can read its exact subject
// using the requesting full delegated credential. It grants no mutation.
type branchConfirmationSnapshotKey struct{}
