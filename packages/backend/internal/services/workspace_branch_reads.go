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
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// BranchMachineResponse is a projection of the existing workspace, with no
// parallel branch or machine state store: the branch's kind, its head, what
// a scratch branch was forked from (spec §8.5.3) and its machine.
type BranchMachineResponse struct {
	Name       string            `json:"name"`
	Kind       string            `json:"kind"`
	State      string            `json:"state"`
	TodoID     string            `json:"todo_id,omitempty"`
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
	if row.BranchArchivedAt.Valid && branchKind(row.TargetBookmark) == "scratch" {
		return "closed"
	}
	switch row.Status {
	case "releasing":
		return "releasing"
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
	// Branch machines belong to the service identity, never to the person
	// reading the roster. List that canonical inventory, including branches
	// the member has not joined yet; reading creates no grant.
	q := db.New(tx)
	owner, err := q.GetBranchMachineOwner(ctx)
	if err != nil {
		return nil, 0, err
	}
	if page < 1 {
		page = 1
	}
	if perPage < 1 || perPage > 100 {
		perPage = 30
	}
	rows, err := q.ListWorkspacesByRepo(ctx, db.ListWorkspacesByRepoParams{
		RepositoryID: repositoryID, UserID: owner,
		PageOffset: ClampInt32((page - 1) * perPage), PageSize: int32(perPage),
	})
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountWorkspacesByRepo(ctx, db.CountWorkspacesByRepoParams{RepositoryID: repositoryID, UserID: owner})
	if err != nil {
		return nil, 0, err
	}
	result := make([]BranchMachineResponse, 0, len(rows))
	for _, row := range rows {
		branch, err := s.projectBranch(ctx, tx, q, row, s.toWorkspaceResponse(row))
		if err != nil {
			return nil, 0, err
		}
		result = append(result, branch)
	}
	return result, total, nil
}

func (s *WorkspaceService) GetBranch(ctx context.Context, branch string, repositoryID, userID int64) (BranchMachineResponse, error) {
	return readInstallWorkspaceMetadata(ctx, s, "branch.read", repositoryID, userID, func(ctx context.Context, scoped *WorkspaceService) (BranchMachineResponse, error) {
		return scoped.getBranch(ctx, branch, repositoryID, userID)
	})
}

func (s *WorkspaceService) getBranch(ctx context.Context, branch string, repositoryID, userID int64) (BranchMachineResponse, error) {
	if err := s.requireBranchMachineProviders(); err != nil {
		return BranchMachineResponse{}, err
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	scoped := *s
	scoped.q, scoped.transactions = q, tx
	if s.installQueries != nil {
		scoped.installQueries = q
	}
	s = &scoped
	var row db.Workspace
	if _, parseErr := uuid.Parse(branch); parseErr == nil {
		row, err = q.GetWorkspaceByRepo(ctx, db.GetWorkspaceByRepoParams{ID: branch, RepositoryID: repositoryID})
	} else {
		row, err = q.GetBranchWorkspace(ctx, db.GetBranchWorkspaceParams{RepositoryID: repositoryID, TargetBookmark: branch})
	}

	if errors.Is(err, pgx.ErrNoRows) {
		return BranchMachineResponse{}, pkgerrors.NotFound("branch not found")
	}
	if err != nil {
		return BranchMachineResponse{}, err
	}
	if err := s.authorizeBranchFileRead(ctx, row, userID); err != nil {
		return BranchMachineResponse{}, err
	}
	// Machine state and queue position are metadata reads. They must
	// remain visible when retained file objects are unavailable.
	if err := s.authorizeWorkspaceReadBinding(ctx, row); err != nil {
		return BranchMachineResponse{}, err
	}
	projected, err := s.getWorkspace(ctx, row.ID, repositoryID, userID)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	return s.projectBranch(ctx, tx, q, row, projected)
}

// projectBranch answers row as a branch: a scratch branch's head is its
// branch ref, which a person's push moves; any other branch's is its
// machine's reported head.
func (s *WorkspaceService) projectBranch(ctx context.Context, tx pgx.Tx, q *db.Queries, row db.Workspace, machine WorkspaceResponse) (BranchMachineResponse, error) {
	branch := BranchMachineResponse{Name: row.TargetBookmark, Kind: branchKind(row.TargetBookmark), State: branchMachineState(row),
		Head: row.HeadCommitID, Machine: machine}
	if branch.Kind == "item" {
		lane, err := q.GetMythicalLane(ctx, row.ID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return BranchMachineResponse{}, err
		}
		if err == nil && (!lane.RetiredAt.Valid || row.BranchArchivedAt.Valid) {
			item, err := q.GetMythicalItem(ctx, lane.ItemID)
			if err != nil {
				return BranchMachineResponse{}, err
			}
			if row.BranchArchivedAt.Valid {
				if state := todoState(item); state == "merged" || state == "dropped" {
					branch.State = "closed"
				}
			}
			if item.WorkspaceID == row.ID {
				branch.TodoID = uuidString(item.ID)
				if branch.Name, err = BranchName(ctx, q, row); err != nil {
					return BranchMachineResponse{}, err
				}
				if seed := mythicalChecksOf(item).Seed; seed != nil && row.HeadCommitID == seed.Captured {
					branch.Head = seed.Head
				}
			}
		}
	}
	forkedFrom, err := branchForkedFrom(ctx, tx, q, row)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	branch.ForkedFrom = forkedFrom
	if branch.Kind == "scratch" && row.Status != "suspended" && row.Status != "stopped" {
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

// branchForkedFrom is where a fork row was forked from: main, a TODO, or the
// scratch branch its branch.forked event recorded. A branch that is no fork,
// or a fork with no recorded source, has none.
func branchForkedFrom(ctx context.Context, tx pgx.Tx, q *db.Queries, row db.Workspace) (*BranchForkedFrom, error) {
	if !row.IsFork || !row.ForkedFromItem.Valid && row.ForkedFromBase == "" {
		return nil, nil
	}
	from := &BranchForkedFrom{Kind: "main", Ref: "main", Commit: row.SourceCommit, Base: row.ForkedFromBase}
	if row.ForkedFromItem.Valid {
		item, err := q.GetMythicalItem(ctx, row.ForkedFromItem)
		if err != nil {
			return nil, err
		}
		from.Kind, from.Item, from.Ref = "item", item.Number.Int64, "T"+strconv.FormatInt(item.Number.Int64, 10)
	}
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT data->'forked_from' FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 AND operation_id=$3 AND event_type='branch.forked'`, strconv.FormatInt(row.RepositoryID, 10), "branch:"+row.ID, row.ID).Scan(&raw)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if err == nil {
		var recorded BranchForkedFrom
		if err := json.Unmarshal(raw, &recorded); err != nil {
			return nil, err
		}
		if strings.HasPrefix(recorded.Ref, scratchBranchPrefix) {
			from.Kind, from.Ref = "branch", recorded.Ref
		}
	}
	return from, nil
}

// BranchCardSource is the kind of branch row is and, for a fork, its source,
// for a live Branch card. The card's refresh has authorized its member through
// PresenceBranch and runs with no request credential, so it reads these stored
// facts here; GetBranch is a request door that admits only a live credential.
func (s *WorkspaceService) BranchCardSource(ctx context.Context, row db.Workspace) (string, *BranchForkedFrom, error) {
	kind := branchKind(row.TargetBookmark)
	if !row.IsFork {
		return kind, nil, nil
	}
	if s.transactions == nil {
		return "", nil, pkgerrors.Internal("workspace store unavailable")
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return "", nil, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	from, err := branchForkedFrom(ctx, tx, db.New(tx), row)
	return kind, from, err
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
