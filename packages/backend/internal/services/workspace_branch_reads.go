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
	Machine    WorkspaceResponse `json:"machine"`
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

func (s *WorkspaceService) ListBranches(ctx context.Context, repositoryID, userID int64, page, perPage int) ([]BranchMachineResponse, int64, error) {
	if err := s.requireBranchMachineProviders(); err != nil {
		return nil, 0, err
	}
	// List-all authority is a separate catalog decision; a branch-scoped run
	// never gains it by joining its own branch.
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := s.branchMachineProviders.Membership(ctx, tx, repositoryID, userID); err != nil {
		return nil, 0, err
	}
	if err := s.branchMachineProviders.Authorize(ctx, tx, "branches.read", repositoryID, "", userID); err != nil {
		return nil, 0, err
	}
	rows, total, err := s.ListWorkspaces(ctx, repositoryID, userID, page, perPage)
	if err != nil {
		return nil, 0, err
	}
	q := db.New(tx)
	result := make([]BranchMachineResponse, 0, len(rows))
	for _, row := range rows {
		full, err := s.q.GetWorkspace(ctx, row.ID)
		if err != nil {
			return nil, 0, err
		}
		branch, err := s.projectBranch(ctx, q, full, row)
		if err != nil {
			return nil, 0, err
		}
		result = append(result, branch)
	}
	return result, total, nil
}

func (s *WorkspaceService) GetBranch(ctx context.Context, branch string, repositoryID, userID int64) (BranchMachineResponse, error) {
	if err := s.preflightBranchMachine(ctx, repositoryID, userID, branch, ""); err != nil {
		return BranchMachineResponse{}, err
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	row, err := q.GetBranchWorkspace(ctx, db.GetBranchWorkspaceParams{RepositoryID: repositoryID, TargetBookmark: branch})
	if errors.Is(err, pgx.ErrNoRows) {
		return BranchMachineResponse{}, pkgerrors.NotFound("branch not found")
	}
	if err != nil {
		return BranchMachineResponse{}, err
	}
	projected, err := s.GetWorkspace(ctx, row.ID, repositoryID, userID)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	return s.projectBranch(ctx, q, row, projected)
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
