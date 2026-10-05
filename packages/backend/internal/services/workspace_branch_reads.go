package services

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// BranchMachineResponse is a projection of the existing workspace, with no
// parallel branch or machine state store: the branch's kind, its head, what
// a scratch branch was forked from (spec §8.5.3) and its machine.
type BranchMachineResponse struct {
	Name       string            `json:"name"`
	Kind       string            `json:"kind"`
	State      string            `json:"state"`
	Head       string            `json:"head,omitempty"`
	ForkedFrom *BranchForkedFrom `json:"forked_from,omitempty"`
	Item       *BranchItem       `json:"item,omitempty"`
	Machine    WorkspaceResponse `json:"machine"`
}

// BranchItem is the TODO a TODO's branch belongs to, in its card's words:
// its number, title, state and place in the stack (0 once it has left it).
type BranchItem struct {
	N     int64  `json:"n"`
	Title string `json:"title"`
	State string `json:"state"`
	Place int64  `json:"place"`
}

// BranchForkedFrom is forked_from {kind, ref, commit, base, item?} (spec
// §8.5.3): main's tip, or item Tn's last verified head and the revision Tn's
// change is measured from in it. commit is the workspace's source_commit.
type BranchForkedFrom struct {
	Kind   string `json:"kind"`
	Ref    string `json:"ref"`
	Commit string `json:"commit"`
	Base   string `json:"base"`
	Item   int64  `json:"item,omitempty"`
}

// BranchHeadReader reads the repository's ref advertisement, where a scratch
// branch's head is its branch ref (repohost.Client.InfoRefsUploadPack).
type BranchHeadReader interface {
	InfoRefsUploadPack(ctx context.Context, owner, repo string) ([]byte, error)
}

// WithBranchHeads lets branch reads answer a scratch branch's head.
func WithBranchHeads(heads BranchHeadReader) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.branchHeads = heads }
}

func branchMachineState(row db.Workspace) string {
	switch row.Status {
	case "running":
		return "awake"
	case "suspended", "stopped":
		return "asleep"
	case "pending", "starting":
		if row.VmID != "" {
			return "waking"
		}
		return "provisioning"
	case "failed":
		return "failed"
	default:
		return "closed"
	}
}

// branchKind is scratch for scratch/<member>/<name>, item for a TODO's lane
// (the stack's bookmark or smithers/<slug>) and main otherwise.
func branchKind(bookmark string) string {
	switch {
	case strings.HasPrefix(bookmark, scratchBranchPrefix):
		return "scratch"
	case bookmark == MythicalBookmark || strings.HasPrefix(bookmark, "smithers/"):
		return "item"
	}
	return "main"
}

// branchListLimit bounds the branch machines one list reads: an install's
// repository has a handful of open TODOs and scratch branches.
const branchListLimit = 500

// beginBranchRead admits a person's read of the repository's branches
// (branches.read). Every member reads every branch: a branch belongs to the
// repository and its machine to the machine service, never to the person
// who started it. List-all authority is a separate catalog decision; a
// branch-scoped run never gains it by joining its own branch.
func (s *WorkspaceService) beginBranchRead(ctx context.Context, repositoryID, userID int64) (pgx.Tx, error) {
	if err := s.requireBranchMachineProviders(); err != nil {
		return nil, err
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.branchMachineProviders.Membership(ctx, tx, repositoryID, userID); err != nil {
		_ = tx.Rollback(context.WithoutCancel(ctx))
		return nil, err
	}
	if err := s.branchMachineProviders.Authorize(ctx, tx, "branches.read", repositoryID, "", userID); err != nil {
		_ = tx.Rollback(context.WithoutCancel(ctx))
		return nil, err
	}
	return tx, nil
}

// ListBranches is every open branch of the repository, whoever started it:
// each open TODO's branch as its card names it, then every other branch
// machine (scratch branches, main), newest first.
func (s *WorkspaceService) ListBranches(ctx context.Context, repositoryID, userID int64, page, perPage int) ([]BranchMachineResponse, int64, error) {
	tx, err := s.beginBranchRead(ctx, repositoryID, userID)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	todos, err := todoBranches(ctx, tx, q, repositoryID, false)
	if err != nil {
		return nil, 0, err
	}
	all := make([]BranchMachineResponse, 0, len(todos))
	for _, todo := range todos {
		all = append(all, s.projectTodoBranch(todo))
	}
	machines, err := q.GetBranchMachineOwner(ctx)
	if err != nil {
		return nil, 0, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch machine owner unavailable").WithCause(err)
	}
	rows, err := q.ListWorkspacesByRepo(ctx, db.ListWorkspacesByRepoParams{RepositoryID: repositoryID, UserID: machines, PageSize: branchListLimit})
	if err != nil {
		return nil, 0, pkgerrors.Internal("list branches: " + err.Error())
	}
	seen := map[string]bool{}
	for _, row := range rows {
		// A TODO's lanes are its one branch (above), never branches of their own.
		if row.TargetBookmark == MythicalBookmark || seen[row.TargetBookmark] {
			continue
		}
		seen[row.TargetBookmark] = true
		branch, err := s.projectBranch(ctx, q, row, s.toWorkspaceResponse(row))
		if err != nil {
			return nil, 0, err
		}
		all = append(all, branch)
	}
	return branchPage(all, page, perPage), int64(len(all)), nil
}

// branchPage is page (from 1) of perPage branches (1 to 100, else 30); a
// page past the end is empty.
func branchPage(all []BranchMachineResponse, page, perPage int) []BranchMachineResponse {
	if page < 1 {
		page = 1
	}
	if perPage < 1 || perPage > 100 {
		perPage = 30
	}
	start := len(all)
	if page-1 < len(all)/perPage+1 {
		start = min((page-1)*perPage, len(all))
	}
	return all[start:min(start+perPage, len(all))]
}

// GetBranch reads one branch by name: a branch machine's bookmark (a scratch
// branch, main), else the name a TODO's card gives its branch, merged or not.
func (s *WorkspaceService) GetBranch(ctx context.Context, branch string, repositoryID, userID int64) (BranchMachineResponse, error) {
	tx, err := s.beginBranchRead(ctx, repositoryID, userID)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	if branch != MythicalBookmark {
		row, err := q.GetBranchWorkspace(ctx, db.GetBranchWorkspaceParams{RepositoryID: repositoryID, TargetBookmark: branch})
		if err == nil {
			return s.projectBranch(ctx, q, row, s.toWorkspaceResponse(row))
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return BranchMachineResponse{}, err
		}
	}
	todos, err := todoBranches(ctx, tx, q, repositoryID, true)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	for _, todo := range todos {
		if todo.name == branch {
			return s.projectTodoBranch(todo), nil
		}
	}
	return BranchMachineResponse{}, pkgerrors.NotFound("branch not found")
}

// todoBranch is one TODO's branch: the TODO, the lane machine its card
// names and the name it goes by (todoBranchWorkspace, todoBranchName).
type todoBranch struct {
	item      db.MythicalItem
	workspace db.Workspace
	name      string
}

// todoBranches are the repository's TODOs' branches; settled includes the
// merged and dropped TODOs', whose cards still name them.
func todoBranches(ctx context.Context, store db.DBTX, q *db.Queries, repositoryID int64, settled bool) ([]todoBranch, error) {
	items, err := q.ListMythicalItems(ctx, repositoryID, branchListLimit)
	if err != nil {
		return nil, err
	}
	branches := []todoBranch{}
	for _, item := range items {
		if !item.Number.Valid {
			continue
		}
		if state := todoState(item); !settled && (state == "merged" || state == "dropped") {
			continue
		}
		workspace, ok, err := todoBranchWorkspace(ctx, store, q, item)
		if err != nil {
			return nil, err
		}
		if ok {
			branches = append(branches, todoBranch{item: item, workspace: workspace, name: todoBranchName(item, workspace)})
		}
	}
	return branches, nil
}

// projectTodoBranch answers a TODO's branch: kind item, the TODO it holds and
// its head, the pull request's once published, else its verified candidate,
// else its lane machine's.
func (s *WorkspaceService) projectTodoBranch(todo todoBranch) BranchMachineResponse {
	item := todo.item
	head := item.PRHead
	for _, next := range []string{item.CandidateHead, todo.workspace.HeadCommitID, todo.workspace.SourceCommit} {
		if head == "" {
			head = next
		}
	}
	state := todoState(item)
	var place int64
	if item.StackPosition.Valid && state != "merged" && state != "dropped" {
		place = item.StackPosition.Int64
	}
	return BranchMachineResponse{Name: todo.name, Kind: "item", State: branchMachineState(todo.workspace), Head: head,
		Item:    &BranchItem{N: item.Number.Int64, Title: item.Title.String, State: state, Place: place},
		Machine: s.toWorkspaceResponse(todo.workspace)}
}

// projectBranch answers row as a branch: a scratch branch's head is its
// branch ref, which a person's push moves; any other branch's is its
// machine's reported head.
func (s *WorkspaceService) projectBranch(ctx context.Context, q *db.Queries, row db.Workspace, machine WorkspaceResponse) (BranchMachineResponse, error) {
	branch := BranchMachineResponse{Name: row.TargetBookmark, Kind: branchKind(row.TargetBookmark), State: branchMachineState(row),
		Head: row.HeadCommitID, Machine: machine}
	if row.IsFork && (row.ForkedFromItem.Valid || row.ForkedFromBase != "") {
		from := &BranchForkedFrom{Kind: "main", Ref: "main", Commit: row.SourceCommit, Base: row.ForkedFromBase}
		if row.ForkedFromItem.Valid {
			item, err := q.GetMythicalItem(ctx, row.ForkedFromItem)
			if err != nil {
				return BranchMachineResponse{}, err
			}
			from.Kind, from.Item, from.Ref = "item", item.Number.Int64, "T"+strconv.FormatInt(item.Number.Int64, 10)
		}
		branch.ForkedFrom = from
	}
	if branch.Kind == "scratch" {
		head, err := s.branchRefHead(ctx, row)
		if err != nil {
			return BranchMachineResponse{}, err
		}
		if head != "" {
			branch.Head = head
		}
	}
	if branch.Head == "" {
		branch.Head = row.SourceCommit
	}
	return branch, nil
}

// branchRefHead is the commit refs/heads/<branch> names, or "" while the
// branch has no ref.
func (s *WorkspaceService) branchRefHead(ctx context.Context, row db.Workspace) (string, error) {
	if s.branchHeads == nil {
		return "", nil
	}
	slug, err := s.workspaceRepoSlug(ctx, row.RepositoryID)
	if err != nil {
		return "", err
	}
	owner, repo, _ := strings.Cut(slug, "/")
	advertisement, err := s.branchHeads.InfoRefsUploadPack(ctx, owner, repo)
	if err != nil {
		return "", pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch head unavailable").WithCause(err)
	}
	refs, err := parseUploadPackAdvertisement(advertisement)
	if err != nil {
		return "", pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch head unavailable").WithCause(err)
	}
	for _, ref := range refs {
		if ref.name == "refs/heads/"+row.TargetBookmark {
			return ref.oid, nil
		}
	}
	return "", nil
}
