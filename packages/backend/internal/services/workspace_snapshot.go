package services

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// Snapshot reads use only install-shipped repository-store operations. No guest
// entry, captured executable, hook or branch-selected tool participates.
type workspaceSnapshotStore interface {
	BranchHeadReader
	GetChange(context.Context, string, string, string) (repohost.Change, error)
	ListDirectory(context.Context, string, string, string, string, string, int) ([]repohost.TreeEntry, error)
	GetFileAtCommit(context.Context, string, string, string, string) (repohost.FileContent, error)
}

// Metadata and snapshot reads share the credential's branch restriction.
// Snapshot verification belongs only to reads that consume retained objects.
func (s *WorkspaceService) authorizeWorkspaceReadBinding(ctx context.Context, row db.Workspace) error {
	if delegation, delegated := middleware.AuthInfoFromContext(ctx).Delegation(); delegated {
		if subject, ok := ctx.Value(branchConfirmationSnapshotKey{}).(string); ok && subject == row.ID && delegation.Branch == "" && delegation.Profile == "" {
			return nil
		}
		if s.installQueries != nil && delegation.Profile == "" && delegation.Branch == "" {
			// A full-scope delegated reader is a catalog actor, not a
			// branch-restricted terminal. Reuse its actual command decision.
			_, err := Authorize(ctx, s.installQueries, "branch.read")
			return err
		}
		if delegation.Branch == "" || !strings.EqualFold(delegation.Branch, row.ID) {
			if s.installQueries != nil {
				return confirmationPermission()
			}
			return pkgerrors.Forbidden("credential is bound to another branch")
		}
	}
	return nil
}

func (s *WorkspaceService) workspaceSnapshotTarget(ctx context.Context, id string, repositoryID, userID int64) (db.Workspace, string, string, string, bool, error) {
	row, err := s.loadWorkspaceWithAccess(ctx, id, repositoryID, userID, WorkspaceAccessRead)
	if err != nil {
		return row, "", "", "", false, err
	}
	if err := s.authorizeWorkspaceReadBinding(ctx, row); err != nil {
		return row, "", "", "", false, err
	}
	if row.Status != "suspended" && row.Status != "stopped" && (row.HeadCommitID == "" || capturedForOperation(ctx, row.ID) != row.HeadCommitID) {
		return row, "", "", "", false, nil
	}
	unavailable := func() (db.Workspace, string, string, string, bool, error) {
		return row, "", "", "", true, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "verified branch snapshot unavailable")
	}
	store, ok := s.branchHeads.(workspaceSnapshotStore)
	if !ok || s.transactions == nil || s.branchMachineProviders.LaneBinding == nil || row.HeadCommitID == "" || strings.TrimSpace(row.VmID) == "" {
		return unavailable()
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return row, "", "", "", true, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := s.branchMachineProviders.LaneBinding(ctx, tx, repositoryID, row.TargetBookmark, row.ID); err != nil {
		return row, "", "", "", true, err
	}
	slug, err := s.workspaceRepoSlug(ctx, repositoryID)
	if err != nil {
		return row, "", "", "", true, err
	}
	owner, repo, _ := strings.Cut(slug, "/")
	advertisement, err := store.InfoRefsUploadPack(ctx, owner, repo)
	if err != nil {
		return unavailable()
	}
	refs, err := parseUploadPackAdvertisement(advertisement)
	if err != nil {
		return unavailable()
	}
	head, retainedRef := row.HeadCommitID, repohost.BranchHeadRef(row.ID)
	// Before the adopted machine publishes a newer capture, a source Drop
	// can fold a newer tree into its retained seed without running the guest.
	// Read that stack-owned immutable source; never execute its contents.
	lane, laneErr := db.New(tx).GetMythicalLane(ctx, row.ID)
	if laneErr != nil && !errors.Is(laneErr, pgx.ErrNoRows) {
		return row, "", "", "", true, laneErr
	}
	if laneErr == nil && !lane.RetiredAt.Valid {
		item, err := db.New(tx).GetMythicalItem(ctx, lane.ItemID)
		if err != nil {
			return row, "", "", "", true, err
		}
		if seed := mythicalChecksOf(item).Seed; seed != nil && item.WorkspaceID == row.ID && head == seed.Captured {
			head, retainedRef = seed.Head, repohost.WorkspaceSourceRef(row.ID, seed.Head)
		}
	}
	for _, ref := range refs {
		if ref.name == retainedRef && ref.oid == head {
			commit, err := store.GetChange(ctx, owner, repo, head)
			if err != nil || commit.CommitID != head {
				return unavailable()
			}
			return row, owner, repo, head, true, nil
		}
	}
	return unavailable()
}

// RetainedBranchHead verifies the objects behind an asleep branch's file
// reads. A metadata projection is not a snapshot verification receipt.
func (s *WorkspaceService) RetainedBranchHead(ctx context.Context, id string, repositoryID, userID int64) (string, error) {
	_, _, _, head, asleep, err := s.workspaceSnapshotTarget(ctx, id, repositoryID, userID)
	if err != nil {
		return "", err
	}
	if !asleep {
		return "", pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch snapshot changed")
	}
	return head, nil
}

func (s *WorkspaceService) readWorkspaceSnapshot(ctx context.Context, owner, repo, head, relative string) (WorkspaceFileContent, error) {
	file, err := s.branchHeads.(workspaceSnapshotStore).GetFileAtCommit(ctx, owner, repo, head, relative)
	if repohost.IsFileNotFound(err) {
		return WorkspaceFileContent{}, pkgerrors.NotFound("file not found")
	}
	if err != nil {
		return WorkspaceFileContent{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch snapshot file unavailable").WithCause(err)
	}
	if file.TooLarge {
		return WorkspaceFileContent{}, pkgerrors.RequestEntityTooLarge("workspace file exceeds 1 MiB limit")
	}
	content := []byte(file.Content)
	switch file.Encoding {
	case "", "utf8":
	case "base64":
		content, err = base64.StdEncoding.DecodeString(file.Content)
		if err != nil {
			return WorkspaceFileContent{}, pkgerrors.Internal("invalid snapshot file encoding").WithCause(err)
		}
	default:
		return WorkspaceFileContent{}, pkgerrors.Internal("invalid snapshot file encoding")
	}
	if len(content) > MaxWorkspaceFileBytes {
		return WorkspaceFileContent{}, pkgerrors.RequestEntityTooLarge("workspace file exceeds 1 MiB limit")
	}
	return workspaceFileContent(relative, content), nil
}

func (s *WorkspaceService) listWorkspaceSnapshot(ctx context.Context, row db.Workspace, owner, repo, head, relative string) ([]WorkspaceFileEntry, error) {
	store := s.branchHeads.(workspaceSnapshotStore)
	entries := []WorkspaceFileEntry{}
	after := ""
	for {
		page, err := store.ListDirectory(ctx, owner, repo, head, relative, after, 1000)
		if err != nil {
			return nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch snapshot directory unavailable").WithCause(err)
		}
		for _, entry := range page {
			if path.Dir(entry.Path) != relative && !(relative == "" && path.Dir(entry.Path) == ".") {
				return nil, pkgerrors.Internal("invalid snapshot directory entry")
			}
			kind := entry.Kind
			if kind == "directory" {
				kind = "dir"
			}
			value := WorkspaceFileEntry{Name: path.Base(entry.Path), Path: entry.Path, Type: kind}
			if kind == "file" {
				file, err := store.GetFileAtCommit(ctx, owner, repo, head, entry.Path)
				if err != nil {
					// The tree can include symlinks and submodules. The bounded file
					// API refuses those; retain their entry without invented byte metadata.
					status, ok := repohost.IsStatusError(err)
					if !ok || status.StatusCode != http.StatusNotFound || repohost.IsFileNotFound(err) {
						return nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch snapshot metadata unavailable").WithCause(err)
					}
				} else if !file.TooLarge {
					switch file.Encoding {
					case "", "utf8":
						value.Size = int64(len(file.Content))
					case "base64":
						raw, err := base64.StdEncoding.DecodeString(file.Content)
						if err != nil {
							return nil, pkgerrors.Internal("invalid snapshot file encoding").WithCause(err)
						}
						value.Size = int64(len(raw))
					default:
						return nil, pkgerrors.Internal("invalid snapshot file encoding")
					}
				}
			}

			entries = append(entries, value)
		}
		if len(page) < 1000 {
			break
		}
		next := page[len(page)-1].Path
		if next <= after {
			return nil, pkgerrors.Internal("invalid snapshot directory cursor")
		}
		after = next
	}
	sort.Slice(entries, func(i, j int) bool {
		if (entries[i].Type == "dir") != (entries[j].Type == "dir") {
			return entries[i].Type == "dir"
		}
		return entries[i].Name < entries[j].Name
	})
	s.touchWorkspaceEntryRecency(ctx, row.ID, "files")
	return entries, nil
}

// CapturedHead gives the existing stack diff reader the same verified head as
// File and Branch cards, through the production lane adapter.
func (l *workspaceMythicalLanes) CapturedHead(ctx context.Context, id string, repositoryID, userID int64) (string, error) {
	if l == nil || l.workspaces == nil {
		return "", pkgerrors.New(pkgerrors.CodeServiceUnavailable, "verified branch snapshot unavailable")
	}
	row, _, _, head, asleep, err := l.workspaces.workspaceSnapshotTarget(ctx, id, repositoryID, userID)
	if err != nil {
		return "", err
	}
	// Snapshot verification can select an adopted seed with the captured
	// tree and a stack-owned parent. Fence the machine publication identity,
	// not that derived seed commit.
	if selected := capturedForOperation(ctx, id); selected != "" && selected != row.HeadCommitID {
		return "", branchForkUnavailable("Capture changed")
	}
	if !asleep {
		return "", pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch state changed")
	}
	return head, nil
}

// AdmitScratch holds the existing branch admission in the adoption transaction.
// Adoption changes no machine identity and never bypasses the runtime gates.
func (l *workspaceMythicalLanes) AdmitScratch(ctx context.Context, tx pgx.Tx, repository, actor int64, row db.Workspace) error {
	if l == nil || l.workspaces == nil {
		return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch unavailable")
	}
	return l.workspaces.authorizeBranchMachine(ctx, tx, repository, actor, row.TargetBookmark, row.ID)
}

type branchCaptureContextKey struct{}
type branchCaptureContext map[string]string

func withBranchCaptureContext(ctx context.Context) context.Context {
	if _, ok := ctx.Value(branchCaptureContextKey{}).(branchCaptureContext); ok {
		return ctx
	}
	return context.WithValue(ctx, branchCaptureContextKey{}, branchCaptureContext{})
}
func capturedForOperation(ctx context.Context, id string) string {
	heads, _ := ctx.Value(branchCaptureContextKey{}).(branchCaptureContext)
	return heads[id]
}

// PrepareCapturedHead runs before stack/workspace locks. The daemon waits for
// publication ACK, whose transaction takes those locks in the event consumer.
// Subsequent reads in this operation verify this exact retained head again.
func (l *workspaceMythicalLanes) PrepareCapturedHead(ctx context.Context, id string, repository, actor int64) error {
	if l == nil || l.workspaces == nil {
		return branchForkUnavailable("Capture unavailable")
	}
	s := l.workspaces
	row, err := s.loadWorkspaceWithAccess(ctx, id, repository, actor, WorkspaceAccessRead)
	if err != nil {
		return err
	}
	if err := s.authorizeWorkspaceReadBinding(ctx, row); err != nil {
		return err
	}
	return l.prepareCapturedBranchHead(ctx, row, repository, actor)
}

// Caller authority is established before this common capture path.
func (l *workspaceMythicalLanes) prepareCapturedBranchHead(ctx context.Context, row db.Workspace, repository, actor int64) error {
	s := l.workspaces
	id := row.ID
	if row.Status == "stopped" || row.Status == "suspended" {
		return nil
	}
	if capturedForOperation(ctx, id) != "" {
		return nil
	}
	heads, ok := ctx.Value(branchCaptureContextKey{}).(branchCaptureContext)
	if !ok || s.branchCapture == nil || row.Status != "running" {
		return branchForkUnavailable("Capture unavailable")
	}
	if err := s.requireBranchMachineProviders(); err != nil {
		return err
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	err = s.authorizeBranchMachine(ctx, tx, repository, actor, row.TargetBookmark, id)
	_ = tx.Rollback(context.WithoutCancel(ctx))
	if err != nil {
		return err
	}
	capture, err := captureAwakeBranch(ctx, s.branchCapture, id)
	head := capture.Head
	if err != nil {
		slog.Warn("awake branch capture refused", "workspace_id", id, "error", err)
		return branchForkUnavailable("Capture unavailable")
	}
	current, err := s.q.GetWorkspace(ctx, id)
	if err != nil {
		return err
	}
	if len(current.CapturePending) != 0 {
		var pending MachineCapturePending
		if json.Unmarshal(current.CapturePending, &pending) != nil || pending.Stale || pending.Conflict || pending.Head != head || pending.Onto != head {
			return branchForkUnavailable("Capture changed")
		}
	}
	if !mythicalSHA.MatchString(head) || current.HeadCommitID != head || current.VmID != row.VmID || current.TargetBookmark != row.TargetBookmark {
		return branchForkUnavailable("Capture changed")
	}
	heads[id] = head
	return nil
}

// A member write can leave native delivery draining. ErrNotReady explicitly
// retains the awake machine and requests another capture. Bound that retry;
// an authorization or incarnation refusal is terminal.
func captureAwakeBranch(ctx context.Context, provider BranchCapture, id string) (machined.CaptureResult, error) {
	captureCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		if err := captureCtx.Err(); err != nil {
			return machined.CaptureResult{}, err
		}
		capture, err := provider.Capture(captureCtx, id)
		if !errors.Is(err, machined.ErrNotReady) {
			return capture, err
		}
		select {
		case <-captureCtx.Done():
			return machined.CaptureResult{}, captureCtx.Err()
		case <-tick.C:
		}
	}
}
