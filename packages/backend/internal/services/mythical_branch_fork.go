package services

import (
	"context"
	"encoding/json"
	"errors"
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
	From string `json:"from"`
	Name string `json:"name,omitempty"`
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
// GitHub (M-22). Forking a scratch branch waits for stage 2's capture.
func (s *MythicalService) ForkBranch(ctx context.Context, repositoryID, actorID int64, input BranchForkInput) (BranchMachineResponse, error) {
	if s == nil || s.store == nil || s.host == nil {
		return BranchMachineResponse{}, branchForkUnavailable("fork unavailable")
	}
	forks, ok := s.lanes.(mythicalScratchForks)
	if !ok {
		return BranchMachineResponse{}, branchForkUnavailable("fork unavailable")
	}
	if err := middleware.RequirePerson(ctx, "fork a branch"); err != nil {
		return BranchMachineResponse{}, &BranchError{http.StatusForbidden, "permission", "permission", "Only a person forks a branch"}
	}
	from := strings.TrimSpace(input.From)
	if from == "" {
		return BranchMachineResponse{}, &BranchError{http.StatusBadRequest, "bad_request", "user", "Choose what to fork: main or a TODO"}
	}
	if strings.HasPrefix(from, scratchBranchPrefix) {
		return BranchMachineResponse{}, &BranchError{http.StatusBadRequest, "scratch_fork_unavailable", "user", "A scratch branch cannot be forked yet"}
	}
	q := s.queries()
	person, err := q.GetUserByID(ctx, actorID)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = "fork-" + strings.ToLower(from)
	}
	if len(name) > 48 || !branchForkName.MatchString(name) || strings.HasSuffix(name, ".lock") {
		return BranchMachineResponse{}, &BranchError{http.StatusBadRequest, "bad_request", "user", "Use lower-case letters, digits, '-', '_' or '.' for the name"}
	}
	branch := scratchBranchPrefix + strings.ToLower(person.Username) + "/" + name
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
	source, err := s.forkSource(ctx, q, repository, from, refs)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	if !g.has(ctx, source.commit) {
		if _, err := g.git(ctx, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", "--depth=1",
			bridge.URL(), "+"+source.pin+":refs/fork/source"); err != nil || !g.has(ctx, source.commit) {
			return BranchMachineResponse{}, branchForkUnavailable("the fork's revision could not be read")
		}
	}
	r := &mythicalRun{row: db.MythicalStack{RepositoryID: repositoryID}, g: g, bridge: bridge, owner: owner, repo: repository.Name}
	branchRow, err := forks.ForkScratch(ctx, ScratchFork{
		RepositoryID: repositoryID, Owner: owner, Repo: repository.Name, ActorID: actorID, Branch: branch,
		Commit: source.commit, Base: source.base, Item: source.item, Parent: source.parent,
		Retain: func(ctx context.Context, workspaceID string) error {
			_, err := s.retainFor(ctx, r, workspaceID, source.commit)
			return err
		},
		Publish: func(ctx context.Context) error { return s.publishScratch(ctx, r, branch, source.commit) },
	})
	if err != nil {
		return BranchMachineResponse{}, err
	}
	s.recordFork(ctx, repositoryID, branchRow, person, source)
	branchRow.ForkedFrom = &BranchForkedFrom{Kind: "main", Ref: source.ref, Commit: source.commit, Base: source.base}
	if source.item.Valid {
		branchRow.ForkedFrom.Kind, branchRow.ForkedFrom.Item = "item", source.number
	}
	if branchRow.Head == "" {
		branchRow.Head = source.commit
	}
	return branchRow, nil
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
// person (M-32). The branch exists either way; a lost entry is logged.
func (s *MythicalService) recordFork(ctx context.Context, repositoryID int64, branch BranchMachineResponse, person db.User, source branchForkSource) {
	fact, _ := json.Marshal(map[string]any{
		"actor":  map[string]any{"kind": "system", "login": "smithers"},
		"for":    map[string]any{"kind": "person", "id": person.ID, "login": person.Username},
		"branch": branch.Name, "workspace": branch.Machine.ID,
		"forked_from": map[string]any{"ref": source.ref, "commit": source.commit, "base": source.base, "item": source.number}})
	scope := jobs.Scope{TenantID: strconv.FormatInt(repositoryID, 10), PrincipalID: "branch:" + branch.Machine.ID}
	err := pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		_, err := jobs.RecordFactInTx(ctx, tx, scope, branch.Machine.ID, "branch.forked", "scratch", fact)
		return err
	})
	if err != nil {
		s.logger.Warn("branch.fork_activity_failed", "workspace", branch.Machine.ID, "error", err)
	}
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
