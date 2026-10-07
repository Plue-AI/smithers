package services

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// BranchForkInput is POST /api/branches fork{from, name?} (spec §6.3):
// from is main or a TODO (T2); name defaults to fork-<from>.
type BranchForkInput struct {
	From    string `json:"from"`
	Name    string `json:"name,omitempty"`
	Request string `json:"-"`
}

// forkWorkspaceRevision keeps the hosted workspace door on the same revision
// operation as /api/branches. A workspace id selects a server-owned item
// binding, never a caller-supplied commit or a machine snapshot.
func (s *MythicalService) forkWorkspaceRevision(ctx context.Context, source db.Workspace, input ForkWorkspaceInput) (WorkspaceResponse, error) {
	if s == nil || s.store == nil {
		return WorkspaceResponse{}, branchForkUnavailable("fork unavailable")
	}
	from := "main"
	if strings.HasPrefix(source.TargetBookmark, scratchBranchPrefix) {
		from = source.TargetBookmark
	} else {
		var number int64
		err := s.store.QueryRow(ctx, `SELECT i.number FROM mythical_items i
            LEFT JOIN mythical_lanes l ON l.item_id=i.id
            WHERE i.repository_id=$1 AND (i.workspace_id=$2 OR l.workspace_id=$2)
            ORDER BY l.created_at DESC NULLS LAST LIMIT 1`, source.RepositoryID, source.ID).Scan(&number)
		if err == nil {
			from = "T" + strconv.FormatInt(number, 10)
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return WorkspaceResponse{}, err
		} else if source.TargetBookmark != "main" {
			return WorkspaceResponse{}, &BranchError{409, "no_verified_head", "conflict", "Workspace has no verified revision to fork"}
		}
	}
	branch, err := s.ForkBranch(ctx, input.RepositoryID, input.UserID, BranchForkInput{From: from, Name: input.Name, Request: input.Request})
	return branch.Machine, err
}

// BranchError is a branch command's refusal on the §6.2.3 envelope.
type BranchError struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Class   string `json:"class"`
	Message string `json:"message"`
}

func (e *BranchError) Error() string { return e.Message }

// mythicalScratchForks is the lanes' workspace side of a fork
// (workspaceMythicalLanes.ForkScratch): it answers the new branch with its
// machine.
type mythicalScratchForks interface {
	CheckScratchFork(context.Context, int64, int64, string) error
	ForkScratch(ctx context.Context, fork ScratchFork) (BranchMachineResponse, error)
}

var (
	branchForkTodo = regexp.MustCompile(`^[Tt]?([1-9][0-9]{0,17})$`)
	// A scratch name is one lower-case path segment Git accepts.
	branchForkName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)*$`)
)

// branchForkSource is the revision a fork starts from (spec §8.5.0, S1):
// main's tip, or an item's last verified head, which the stack pinned when
// it integrated it (mythicalItemStep.integrate). pin is the ref that holds
// commit in the repository.
type branchForkSource struct {
	ref, commit, base, pin, parent string
	item                           pgtype.UUID
	number                         int64
}

// ForkBranch is the stack service's Fork (spec §8.5, M-32): it creates the
// scratch branch scratch/<member>/<name> from main's tip or from an item's
// last verified head, never from a machine, so the source machine and its run
// are not touched (§8.5.2). Smithers writes the branch, for the person who
// asked: the revision is pinned under the new workspace's source ref, the
// workspace records forked_from, then the branch is published in the
// install's repository and nowhere else: a scratch branch never reaches
// GitHub (M-22). Awake and scratch sources consume the daemon capture.
func (s *MythicalService) forkBranch(ctx context.Context, repositoryID, actorID int64, input BranchForkInput, selected *branchForkSource, remember func(branchForkSource) error) (BranchMachineResponse, error) {
	if s == nil || s.store == nil || s.host == nil {
		return BranchMachineResponse{}, branchForkUnavailable("fork unavailable")
	}
	forks, ok := s.lanes.(mythicalScratchForks)
	if !ok {
		return BranchMachineResponse{}, branchForkUnavailable("fork unavailable")
	}
	if _, err := Authorize(ctx, s.queries(), "branch.fork", InstallBranchForkSubject(ctx, repositoryID, input)); err != nil {
		return BranchMachineResponse{}, err
	}
	from := strings.TrimSpace(input.From)
	if from == "" {
		return BranchMachineResponse{}, &BranchError{http.StatusBadRequest, "bad_request", "user", "Choose what to fork: main or a TODO"}
	}
	q := s.queries()
	person, err := q.GetUserByID(ctx, actorID)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = "fork-" + strings.ToLower(from[strings.LastIndex(from, "/")+1:])
	}
	if len(name) > 48 || !branchForkName.MatchString(name) || strings.HasSuffix(name, ".lock") {
		return BranchMachineResponse{}, &BranchError{http.StatusBadRequest, "bad_request", "user", "Use lower-case letters, digits, '-', '_' or '.' for the name"}
	}
	branch := scratchBranchPrefix + strings.ToLower(person.Username) + "/" + name
	// Qualify machine admission before retaining a revision or persisting intent.
	if err := forks.CheckScratchFork(ctx, repositoryID, actorID, branch); err != nil {
		return BranchMachineResponse{}, err
	}
	repository, owner, err := s.repository(ctx, repositoryID)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	// The stack's own bridge: fetches are free, and each write is armed for
	// exactly its ref update.
	bridge, err := startMythicalBridge(ctx, s.host, owner, repository.Name, RepositoryStillAt(q, repositoryID, owner, repository.Name))
	if err != nil {
		return BranchMachineResponse{}, err
	}
	defer bridge.Close()
	g, cleanup, err := s.forkGit(ctx, repositoryID)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	defer cleanup()
	refs, err := g.lsRemote(ctx, bridge.URL())
	if err != nil {
		return BranchMachineResponse{}, branchForkUnavailable("the repository could not be read")
	}
	var source branchForkSource
	if selected != nil {
		source = *selected
	} else {
		source, err = s.forkSource(withBranchCaptureContext(ctx), q, repository, from, refs)
		if err != nil {
			return BranchMachineResponse{}, err
		}
	}
	if !g.has(ctx, source.commit) {
		if _, err := g.git(ctx, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", "--depth=1",
			bridge.URL(), "+"+source.pin+":refs/fork/source"); err != nil || !g.has(ctx, source.commit) {
			return BranchMachineResponse{}, branchForkUnavailable("the fork's revision could not be read")
		}
	}
	r := &mythicalRun{row: db.MythicalStack{RepositoryID: repositoryID}, g: g, bridge: bridge, owner: owner, repo: repository.Name}
	if remember != nil && selected == nil {
		// Retain before committing intent: recovery must not depend on a moving ref.
		if err := s.pin(ctx, r, source.commit); err != nil {
			return BranchMachineResponse{}, err
		}
		source.pin = repohost.MythicalReservedRefNS + "keep/" + source.commit
		if err := remember(source); err != nil {
			return BranchMachineResponse{}, err
		}
	}
	branchRow, err := forks.ForkScratch(ctx, ScratchFork{
		RepositoryID: repositoryID, Owner: owner, Repo: repository.Name, ActorID: actorID, Branch: branch,
		Commit: source.commit, Base: source.base, Recover: selected != nil, Item: source.item, Parent: source.parent,
		Retain: func(ctx context.Context, workspaceID string) error {
			_, err := s.retainFor(ctx, r, workspaceID, source.commit)
			return err
		},
		Publish: func(ctx context.Context) error { return s.publishScratch(ctx, r, branch, source.commit) },
	})
	if err != nil {
		return BranchMachineResponse{}, err
	}
	if err := s.recordFork(ctx, repositoryID, branchRow, person, source); err != nil {
		return BranchMachineResponse{}, err
	}
	branchRow.ForkedFrom = &BranchForkedFrom{Kind: "main", Ref: source.ref, Commit: source.commit, Base: source.base}
	if source.item.Valid {
		branchRow.ForkedFrom.Kind, branchRow.ForkedFrom.Item = "item", source.number
	}
	if strings.HasPrefix(source.ref, scratchBranchPrefix) {
		branchRow.ForkedFrom.Kind = "branch"
	}
	if branchRow.Head == "" {
		branchRow.Head = source.commit
	}
	return branchRow, nil
}

// ForkBranch serializes a session's request through the existing operation
// store. A completed retry returns the original branch even after main moves;
// a different payload cannot reuse its key. Authorization still runs on every
// HTTP request before this receipt is read.
func (s *MythicalService) ForkBranch(ctx context.Context, repositoryID, actorID int64, input BranchForkInput) (BranchMachineResponse, error) {
	if s == nil || s.store == nil {
		return BranchMachineResponse{}, branchForkUnavailable("fork unavailable")
	}
	decision, err := Authorize(ctx, s.queries(), "branch.fork", InstallBranchForkSubject(ctx, repositoryID, input))
	if err != nil {
		return BranchMachineResponse{}, err
	}
	ctx = WithInstallAuthorization(ctx, "branch.fork", decision, InstallBranchForkSubject(ctx, repositoryID, input))
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || info.User == nil || info.User.ID != actorID {
		return BranchMachineResponse{}, &BranchError{403, "permission", "permission", "Access denied"}
	}
	ctx = withBranchCaptureContext(ctx)
	if input.Request == "" {
		if err := s.prepareForkCapture(ctx, repositoryID, actorID, input); err != nil {
			return BranchMachineResponse{}, err
		}

		if s == nil || s.store == nil {
			return BranchMachineResponse{}, branchForkUnavailable("fork unavailable")
		}
		var branch BranchMachineResponse
		err := pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
			if err := guardInstallForkWrite(ctx, tx, repositoryID, actorID, input); err != nil {
				return err
			}
			var err error
			branch, err = s.forkBranch(ctx, repositoryID, actorID, input, nil, nil)
			return err
		})
		return branch, err
	}
	if len(input.Request) > 256 {
		return BranchMachineResponse{}, &BranchError{400, "bad_request", "user", "Invalid Idempotency-Key"}
	}
	if s == nil || s.store == nil {
		return BranchMachineResponse{}, branchForkUnavailable("fork unavailable")
	}
	credential, err := branchForkRequestCredential(ctx, actorID)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	scope := jobs.Scope{TenantID: strconv.FormatInt(repositoryID, 10), PrincipalID: "branch-request:" + credential}
	id := uuid.NewSHA1(confirmationNamespace, []byte(scope.TenantID+"\x00"+scope.PrincipalID+"\x00branch.fork\x00"+input.Request)).String()
	canonical, _ := json.Marshal(input)
	intentID := uuid.NewSHA1(confirmationNamespace, []byte(id+"\x00intended")).String()
	var retained bool
	if err := s.store.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 AND operation_id IN ($3,$4) AND event_type IN ('branch.fork.completed','branch.fork.intended'))`, scope.TenantID, scope.PrincipalID, id, intentID).Scan(&retained); err != nil {
		return BranchMachineResponse{}, err
	}
	if !retained {
		if err := s.prepareForkCapture(ctx, repositoryID, actorID, input); err != nil {
			return BranchMachineResponse{}, err
		}
	}
	var branch BranchMachineResponse
	err = pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		if err := guardInstallForkWrite(ctx, tx, repositoryID, actorID, input); err != nil {
			return err
		}
		digest := sha256.Sum256([]byte(id))
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, int64(binary.BigEndian.Uint64(digest[:8]))); err != nil {
			return err
		}
		var raw []byte
		err := tx.QueryRow(ctx, `SELECT data FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 AND operation_id=$3 AND event_type='branch.fork.completed'`, scope.TenantID, scope.PrincipalID, id).Scan(&raw)
		if err == nil {
			var receipt struct {
				Input  json.RawMessage       `json:"input"`
				Branch BranchMachineResponse `json:"branch"`
			}
			if err := json.Unmarshal(raw, &receipt); err != nil {
				return err
			}
			if !jsonEqual(receipt.Input, canonical) {
				return &BranchError{409, "idempotency_mismatch", "conflict", "Idempotency-Key was already used for a different request"}
			}
			branch = receipt.Branch
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		var selected *branchForkSource
		err = tx.QueryRow(ctx, `SELECT data FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 AND operation_id=$3 AND event_type='branch.fork.intended'`, scope.TenantID, scope.PrincipalID, intentID).Scan(&raw)
		if err == nil {
			var intent branchForkIntent
			if err := json.Unmarshal(raw, &intent); err != nil {
				return err
			}
			if !jsonEqual(intent.Input, canonical) {
				return &BranchError{409, "idempotency_mismatch", "conflict", "Idempotency-Key was already used for a different request"}
			}
			source := intent.source()
			selected = &source
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		remember := func(source branchForkSource) error {
			intent := branchForkIntent{Input: canonical, Ref: source.ref, Commit: source.commit, Base: source.base, Pin: source.pin, Parent: source.parent, Item: source.item, Number: source.number}
			data, err := json.Marshal(intent)
			if err != nil {
				return err
			}
			// This intent survives rollback of the completion transaction. The
			// request lock above serializes writers; machine work begins only
			// after the immutable revision and this intent are durable.
			return pgx.BeginFunc(ctx, s.store, func(intentTx pgx.Tx) error {
				_, err := jobs.RecordFactInTx(ctx, intentTx, scope, intentID, "branch.fork.intended", "intended", data)
				return err
			})
		}
		branch, err = s.forkBranch(ctx, repositoryID, actorID, input, selected, remember)
		if err != nil {
			return err
		}
		fact, _ := json.Marshal(map[string]any{"input": json.RawMessage(canonical), "branch": branch})
		_, err = jobs.RecordFactInTx(ctx, tx, scope, id, "branch.fork.completed", "completed", fact)
		return err
	})
	return branch, err
}

// forkSource resolves from to its revision (spec §8.5.0, §8.5.3): main is
// the mirror's tip, its own base; item Tn is its last verified head, and its
// base is the revision Tn's change is measured from in that head. An item
// with no verified head has nothing to fork yet.
func (s *MythicalService) forkSource(ctx context.Context, q *db.Queries, repository db.Repository, from string, refs map[string]string) (branchForkSource, error) {
	if strings.EqualFold(from, "main") {
		mainRef := "refs/heads/" + mythicalDefaultBranch(repository)
		tip := refs[mainRef]
		if !isLowerHexRevision(tip) {
			return branchForkSource{}, branchForkUnavailable("main has no tip yet")
		}
		return branchForkSource{ref: "main", commit: tip, base: tip, pin: mainRef}, nil
	}
	if strings.HasPrefix(from, scratchBranchPrefix) {
		capture, ok := s.lanes.(interface {
			PrepareCapturedHead(context.Context, string, int64, int64) error
			CapturedHead(context.Context, string, int64, int64) (string, error)
		})
		if !ok {
			return branchForkSource{}, branchForkUnavailable("Capture unavailable")
		}
		row, err := q.GetBranchWorkspace(ctx, db.GetBranchWorkspaceParams{RepositoryID: repository.ID, TargetBookmark: from})
		if err != nil {
			return branchForkSource{}, err
		}
		actor := middleware.AuthInfoFromContext(ctx).User.ID
		if err := capture.PrepareCapturedHead(ctx, row.ID, repository.ID, actor); err != nil {
			return branchForkSource{}, err
		}
		head, err := capture.CapturedHead(ctx, row.ID, repository.ID, actor)
		if err != nil {
			return branchForkSource{}, err
		}
		if !isLowerHexRevision(row.ForkedFromBase) {
			return branchForkSource{}, branchForkUnavailable("Fork revision unavailable")
		}
		source := branchForkSource{ref: from, commit: head, base: row.ForkedFromBase, pin: repohost.BranchHeadRef(row.ID), parent: row.ID, item: row.ForkedFromItem}
		if source.item.Valid {
			item, err := q.GetMythicalItem(ctx, source.item)
			if err != nil {
				return branchForkSource{}, err
			}
			source.number = item.Number.Int64
		}
		return source, nil
	}
	match := branchForkTodo.FindStringSubmatch(from)
	if match == nil {
		return branchForkSource{}, &BranchError{http.StatusBadRequest, "bad_request", "user", "Fork main or a TODO such as T2"}
	}
	number, _ := strconv.ParseInt(match[1], 10, 64)
	ref := "T" + match[1]
	item, err := q.GetMythicalItemByNumber(ctx, repository.ID, number)
	if errors.Is(err, pgx.ErrNoRows) {
		return branchForkSource{}, &BranchError{http.StatusNotFound, "todo_not_found", "user", "TODO not found"}
	}
	if err != nil {
		return branchForkSource{}, err
	}
	if mythicalSettledStates[item.State] {
		return branchForkSource{}, &BranchError{http.StatusConflict, "todo_settled", "conflict", ref + " is " + todoState(item) + "; fork main"}
	}
	if item.WorkspaceID != "" {
		row, err := q.GetWorkspace(ctx, item.WorkspaceID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return branchForkSource{}, err
		}
		if err == nil && row.Status == "running" {
			capture, ok := s.lanes.(interface {
				PrepareCapturedHead(context.Context, string, int64, int64) error
				CapturedHead(context.Context, string, int64, int64) (string, error)
			})
			if !ok {
				return branchForkSource{}, branchForkUnavailable("Capture unavailable")
			}
			actor := middleware.AuthInfoFromContext(ctx).User.ID
			if err := capture.PrepareCapturedHead(ctx, row.ID, repository.ID, actor); err != nil {
				return branchForkSource{}, err
			}
			head, err := capture.CapturedHead(ctx, row.ID, repository.ID, actor)
			if err != nil {
				return branchForkSource{}, err
			}
			if !isLowerHexRevision(item.CandidateBase) {
				return branchForkSource{}, branchForkUnavailable("Fork base unavailable")
			}
			return branchForkSource{ref: ref, commit: head, base: item.CandidateBase, pin: repohost.BranchHeadRef(row.ID), parent: row.ID, item: item.ID, number: number}, nil
		}
	}
	pin := repohost.MythicalReservedRefNS + "keep/" + item.CandidateHead
	if !item.CandidateVerified || !isLowerHexRevision(item.CandidateHead) || !isLowerHexRevision(item.CandidateBase) || refs[pin] != item.CandidateHead {
		return branchForkSource{}, &BranchError{http.StatusConflict, "no_verified_head", "conflict", ref + " has no verified head to fork yet"}
	}
	// The item's workspace: its lane, or the last one the stack bound once
	// the item released it at review.
	parent := item.WorkspaceID
	if !mythicalWorkspaceID.MatchString(parent) {
		parent = ""
		if err := s.store.QueryRow(ctx, `SELECT l.workspace_id FROM mythical_lanes l JOIN workspaces w ON w.id::text = l.workspace_id
            WHERE l.item_id = $1 AND w.deleted_at IS NULL ORDER BY l.created_at DESC LIMIT 1`, item.ID).Scan(&parent); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return branchForkSource{}, err
		}
	}
	return branchForkSource{ref: ref, commit: item.CandidateHead, base: item.CandidateBase, pin: pin, parent: parent, item: item.ID, number: number}, nil
}

// forkGit is a scratch repository of the fork's own that borrows the stack's
// objects (read only), so the revision is usually present without a fetch;
// the stack's passes keep their repository to themselves.
func (s *MythicalService) forkGit(ctx context.Context, repositoryID int64) (mythicalGit, func(), error) {
	if err := os.MkdirAll(s.scratchRoot, 0o700); err != nil {
		return mythicalGit{}, nil, err
	}
	dir, err := os.MkdirTemp(s.scratchRoot, "fork-")
	if err != nil {
		return mythicalGit{}, nil, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	g := mythicalGit{dir: filepath.Join(dir, "repo.git")}
	if err := g.init(ctx); err != nil {
		cleanup()
		return mythicalGit{}, nil, err
	}
	stack := filepath.Join(s.scratchRoot, "repo-"+strconv.FormatInt(repositoryID, 10)+".git", "objects")
	if info, err := os.Stat(stack); err == nil && info.IsDir() {
		if err := os.WriteFile(filepath.Join(g.dir, "objects", "info", "alternates"), []byte(stack+"\n"), 0o600); err != nil {
			cleanup()
			return mythicalGit{}, nil, err
		}
	}
	return g, cleanup, nil
}

// publishScratch creates the scratch branch at commit in the install's
// repository, as Smithers. A branch that exists already is kept where it is:
// a person may have pushed to it since.
func (s *MythicalService) publishScratch(ctx context.Context, r *mythicalRun, branch, commit string) error {
	ref := "refs/heads/" + branch
	refs, err := r.g.lsRemote(ctx, r.bridge.URL())
	if err != nil {
		return branchForkUnavailable("the repository could not be read")
	}
	if refs[ref] != "" {
		return nil
	}
	r.bridge.permit([]mythicalRefUpdate{{Ref: ref, Old: strings.Repeat("0", 40), New: commit}},
		repohost.ReceivePackMetadata{RepositoryID: r.row.RepositoryID, PusherLogin: "smithers"})
	if _, err := r.g.git(ctx, "push", "--porcelain", "--no-verify", r.bridge.URL(), commit+":"+ref); err != nil {
		if refs, lsErr := r.g.lsRemote(ctx, r.bridge.URL()); lsErr == nil && refs[ref] != "" {
			return nil
		}
		return branchForkUnavailable("the scratch branch could not be written: " + sanitizeMirrorError(err, r.bridge.URL()))
	}
	return nil
}

// recordFork appends the fork to the new branch's activity: Smithers, for the
// person (M-32). Completion requires this durable attribution; a retry
// recovers the same workspace and records the missing entry before completing.
func (s *MythicalService) recordFork(ctx context.Context, repositoryID int64, branch BranchMachineResponse, person db.User, source branchForkSource) error {
	fact, _ := json.Marshal(map[string]any{
		"actor":  map[string]any{"kind": "system", "login": "smithers"},
		"for":    map[string]any{"kind": "person", "id": person.ID, "login": person.Username},
		"branch": branch.Name, "workspace": branch.Machine.ID,
		"forked_from": map[string]any{"ref": source.ref, "commit": source.commit, "base": source.base, "item": source.number}})
	scope := jobs.Scope{TenantID: strconv.FormatInt(repositoryID, 10), PrincipalID: "branch:" + branch.Machine.ID}
	return pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		_, err := jobs.RecordFactInTx(ctx, tx, scope, branch.Machine.ID, "branch.forked", "scratch", fact)
		return err
	})
}

func mythicalDefaultBranch(repository db.Repository) string {
	if branch := strings.TrimSpace(repository.DefaultBookmark); branch != "" {
		return branch
	}
	return "main"
}

func branchForkUnavailable(message string) *BranchError {
	return &BranchError{http.StatusServiceUnavailable, "branch_unavailable", "infra", message}
}

// branchForkIntent binds interrupted work to the revision originally resolved.
// It shares the request stream with completion; no branch or history store is added.
type branchForkIntent struct {
	Input  json.RawMessage `json:"input"`
	Ref    string          `json:"ref"`
	Commit string          `json:"commit"`
	Base   string          `json:"base"`
	Pin    string          `json:"pin"`
	Parent string          `json:"parent"`
	Item   pgtype.UUID     `json:"item"`
	Number int64           `json:"number"`
}

func (i branchForkIntent) source() branchForkSource {
	return branchForkSource{ref: i.Ref, commit: i.Commit, base: i.Base, pin: i.Pin, parent: i.Parent, item: i.Item, number: i.Number}
}

func (s *MythicalService) prepareForkCapture(ctx context.Context, repository, actor int64, input BranchForkInput) error {
	if s == nil || s.store == nil || s.host == nil {
		return branchForkUnavailable("Fork unavailable")
	}
	from := strings.TrimSpace(input.From)
	if strings.EqualFold(from, "main") {
		return nil
	}
	var row db.Workspace
	var err error
	if strings.HasPrefix(from, scratchBranchPrefix) {
		row, err = branchAddWorkspace(ctx, s.queries(), repository, from)
	} else if match := branchForkTodo.FindStringSubmatch(from); match != nil {
		n, _ := strconv.ParseInt(match[1], 10, 64)
		item, e := s.queries().GetMythicalItemByNumber(ctx, repository, n)
		if e != nil {
			return e
		}
		if item.WorkspaceID == "" {
			return nil
		}
		row, err = s.queries().GetWorkspace(ctx, item.WorkspaceID)
	} else {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if row.Status != "running" {
		return nil
	}
	forks, ok := s.lanes.(mythicalScratchForks)
	if !ok {
		return branchForkUnavailable("Fork unavailable")
	}
	person, err := s.queries().GetUserByID(ctx, actor)
	if err != nil {
		return err
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = "fork-" + strings.ToLower(from[strings.LastIndex(from, "/")+1:])
	}
	if len(name) > 48 || !branchForkName.MatchString(name) || strings.HasSuffix(name, ".lock") {
		return &BranchError{400, "bad_request", "user", "Invalid fork name"}
	}
	if err := forks.CheckScratchFork(ctx, repository, actor, scratchBranchPrefix+strings.ToLower(person.Username)+"/"+name); err != nil {
		return err
	}
	capture, ok := s.lanes.(interface {
		PrepareCapturedHead(context.Context, string, int64, int64) error
	})
	if !ok {
		return branchForkUnavailable("Capture unavailable")
	}
	return capture.PrepareCapturedHead(ctx, row.ID, repository, actor)
}
