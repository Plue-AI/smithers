package services

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/diffview"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// BranchDiff is the item-base subset of the shared DiffCard contract. The
// existing landing response exposes raw patches, not the card's hunk model.
type BranchDiff struct {
	Files []BranchDiffModel `json:"files"`
}
type BranchDiffModel struct {
	Path      string            `json:"path"`
	Branch    string            `json:"branch"`
	Against   BranchDiffAgainst `json:"against"`
	Change    string            `json:"change"`
	RenamedTo string            `json:"renamed_to,omitempty"`
	Binary    *BranchDiffBinary `json:"binary,omitempty"`
	Hunks     []BranchDiffHunk  `json:"hunks"`
}
type BranchDiffAgainst struct {
	Kind string `json:"kind"`
	Rev  string `json:"rev"`
}
type BranchDiffBinary struct {
	BeforeBytes int64 `json:"before_bytes"`
	AfterBytes  int64 `json:"after_bytes"`
}
type BranchDiffHunk struct {
	OldStart int64            `json:"old_start"`
	NewStart int64            `json:"new_start"`
	Lines    []BranchDiffLine `json:"lines"`
}
type BranchDiffLine struct {
	Op   string `json:"op"`
	Text string `json:"text"`
}

// ProjectTODOBranchDiff consumes a diff already read against the immutable
// accepted prefix. It performs no git or machine execution. Binary sizes must
// come from blob metadata: FileDiff omits binary content, so len is not a size.
// Reads refuse rather than comparing against guessed main.
func ProjectTODOBranchDiff(branch, acceptedPrefix string, files []repohost.FileDiff, binarySizes map[string]BranchDiffBinary) (BranchDiff, error) {
	result := BranchDiff{Files: []BranchDiffModel{}}
	if branch == "" || acceptedPrefix == "" {
		return BranchDiff{}, &mythicalPRUnavailable{}
	}
	for _, file := range files {
		if file.Path == "" || file.TooLarge {
			return BranchDiff{}, &mythicalPRUnavailable{}
		}
		model := BranchDiffModel{Path: file.Path, Branch: branch, Against: BranchDiffAgainst{Kind: "item_base", Rev: acceptedPrefix}, Change: file.ChangeType, Hunks: []BranchDiffHunk{}}
		switch file.ChangeType {
		case "added", "modified", "deleted":
		case "renamed":
			if file.OldPath == "" {
				return BranchDiff{}, fmt.Errorf("rename source is unavailable")
			}
			model.Path, model.RenamedTo = file.OldPath, file.Path
		default:
			return BranchDiff{}, fmt.Errorf("unsupported diff change %q", file.ChangeType)
		}
		if file.IsBinary {
			size, ok := binarySizes[file.Path]
			if !ok || size.BeforeBytes < 0 || size.AfterBytes < 0 {
				return BranchDiff{}, &mythicalPRUnavailable{}
			}
			model.Binary = &size
		} else {
			for _, parsed := range parseCommentDiffHunks(file.Patch) {
				hunk := BranchDiffHunk{OldStart: parsed.oldStart, NewStart: parsed.newStart, Lines: []BranchDiffLine{}}
				for _, line := range parsed.body {
					if len(line) > 0 && (line[0] == ' ' || line[0] == '+' || line[0] == '-') {
						hunk.Lines = append(hunk.Lines, BranchDiffLine{Op: line[:1], Text: line[1:]})
					}
				}
				model.Hunks = append(model.Hunks, hunk)
			}
		}
		result.Files = append(result.Files, model)
	}
	return result, nil
}

// TODOBranchDiff compares the verified sleeping snapshot or accepted candidate
// with its recorded item base. It never enters or starts a branch machine.
func (s *MythicalService) TODOBranchDiff(ctx context.Context, branch string) (BranchDiff, error) {
	if s == nil || s.store == nil || s.host == nil {
		return BranchDiff{}, &mythicalPRUnavailable{}
	}
	authorization, err := Authorize(ctx, s.queries(), "branch.read")
	if err != nil {
		return BranchDiff{}, err
	}
	repository, err := InstallRepositoryID(ctx, s.queries())
	if err != nil {
		return BranchDiff{}, err
	}
	branch, err = url.PathUnescape(branch)
	if err != nil {
		return BranchDiff{}, &BranchError{http.StatusBadRequest, "invalid_branch", "user", "Invalid branch"}
	}
	subject := branch
	// Branch cards dispatch the durable workspace id; slash commands may
	// name its bookmark. Resolve only within this install repository before
	// selecting the scratch reader, so both doors compare the same revision.
	if mythicalWorkspaceID.MatchString(branch) {
		workspace, readErr := s.queries().GetWorkspace(ctx, branch)
		if readErr == nil && workspace.RepositoryID == repository && !workspace.DeletedAt.Valid {
			if strings.HasPrefix(workspace.TargetBookmark, scratchBranchPrefix) {
				branch = workspace.TargetBookmark
			}
		} else if readErr != nil && !errors.Is(readErr, pgx.ErrNoRows) {
			return BranchDiff{}, readErr
		} else {
			return BranchDiff{}, &BranchError{http.StatusNotFound, "branch_not_found", "user", "Branch not found"}
		}
	}
	if strings.HasPrefix(branch, scratchBranchPrefix) {
		diff, err := s.scratchBranchDiff(ctx, repository, branch)
		for i := range diff.Files {
			diff.Files[i].Branch = subject
		}
		return diff, err
	}
	var id string
	err = s.store.QueryRow(ctx, `SELECT id::text FROM mythical_items WHERE repository_id=$1 AND (workspace_id=$2 OR checks->>'branch'=$2) ORDER BY created_at DESC LIMIT 1`, repository, branch).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return BranchDiff{}, &BranchError{http.StatusNotFound, "branch_not_found", "user", "Branch not found"}
	}
	if err != nil {
		return BranchDiff{}, err
	}
	item, err := s.queries().GetMythicalItem(ctx, stringToUUID(id))
	if err != nil {
		return BranchDiff{}, err
	}
	if err := todoBranchForbids(ctx, item); err != nil {
		return BranchDiff{}, err
	}
	if delegation, delegated := middleware.AuthInfoFromContext(ctx).Delegation(); delegated && (delegation.Branch == "" || delegation.Branch != item.WorkspaceID) {
		return BranchDiff{}, &BranchError{http.StatusForbidden, "permission", "permission", "Credential is bound to another branch"}
	}
	base, head := item.CandidateBase, item.CandidateHead
	lane, exists, err := s.todoBranchWorkspace(ctx, item)
	if err != nil {
		return BranchDiff{}, err
	}
	if exists && item.WorkspaceID == lane.ID && (lane.Status == "suspended" || lane.Status == "stopped") {
		reader, ok := s.lanes.(interface {
			CapturedHead(context.Context, string, int64, int64) (string, error)
		})
		if !ok {
			return BranchDiff{}, &mythicalPRUnavailable{}
		}
		head, err = reader.CapturedHead(ctx, lane.ID, repository, authorization.UserID)
		if err != nil {
			return BranchDiff{}, err
		}
		base = item.BaseCommit
	} else if !item.CandidateVerified {
		return BranchDiff{}, &mythicalPRUnavailable{}
	}
	if !mythicalSHA.MatchString(base) || !mythicalSHA.MatchString(head) {
		return BranchDiff{}, &mythicalPRUnavailable{}
	}
	store, ok := s.host.(branchDiffStore)
	if !ok {
		return BranchDiff{}, &mythicalPRUnavailable{}
	}
	repo, owner, err := s.repository(ctx, repository)
	if err != nil {
		return BranchDiff{}, err
	}
	for _, revision := range []string{base, head} {
		commit, err := store.GetChange(ctx, owner, repo.Name, revision)
		if err != nil || commit.CommitID != revision {
			return BranchDiff{}, &mythicalPRUnavailable{}
		}
	}
	bridge, err := startMythicalBridge(ctx, s.host, owner, repo.Name, RepositoryStillAt(s.queries(), repository, owner, repo.Name))
	if err != nil {
		return BranchDiff{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch snapshot diff unavailable").WithCause(err)
	}
	defer bridge.Close()
	g, cleanup, err := s.forkGit(ctx, repository)
	if err != nil {
		return BranchDiff{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch snapshot diff unavailable").WithCause(err)
	}
	defer cleanup()
	for _, rev := range []string{base, head} {
		if !g.has(ctx, rev) {
			if err := g.fetch(ctx, bridge.URL(), 0, 0, rev); err != nil {
				return BranchDiff{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch snapshot diff unavailable").WithCause(err)
			}
		}
	}
	reader := acceptedTreeDiffReader{store: store, g: g, base: base, head: head}
	diff, err := diffview.BuildChangeDiff(ctx, reader, owner, repo.Name, head, diffview.BuildOptions{})
	if err != nil {
		return BranchDiff{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch snapshot diff unavailable").WithCause(err)
	}
	sizes := map[string]BranchDiffBinary{}
	for _, file := range diff.FileDiffs {
		if !file.IsBinary {
			continue
		}
		size := BranchDiffBinary{}
		for _, before := range []bool{true, false} {
			if before && file.ChangeType == "added" || !before && file.ChangeType == "deleted" {
				continue
			}
			rev, path := head, file.Path
			if before {
				rev = base
				if file.OldPath != "" {
					path = file.OldPath
				}
			}
			content, err := reader.GetFileAtChange(ctx, owner, repo.Name, rev, path)
			if err != nil {
				return BranchDiff{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch snapshot diff unavailable").WithCause(err)
			}
			if content.TooLarge {
				return BranchDiff{}, &mythicalPRUnavailable{}
			}
			bytes := []byte(content.Content)
			if content.Encoding == "base64" {
				bytes, err = base64.StdEncoding.DecodeString(content.Content)
				if err != nil {
					return BranchDiff{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch snapshot diff unavailable").WithCause(err)
				}
			} else if content.Encoding != "" && content.Encoding != "utf8" {
				return BranchDiff{}, &mythicalPRUnavailable{}
			}
			if before {
				size.BeforeBytes = int64(len(bytes))
			} else {
				size.AfterBytes = int64(len(bytes))
			}
		}
		sizes[file.Path] = size
	}
	return ProjectTODOBranchDiff(branch, base, diff.FileDiffs, sizes)
}

// acceptedTreeDiffReader pins the shared bounded diff builder to immutable
// host-store objects. Branch configuration and executables never run on the host.
type branchDiffStore interface {
	GetChange(context.Context, string, string, string) (repohost.Change, error)
	GetRevisionDiff(context.Context, string, string, string, string, string, string) (repohost.ChangeDiff, error)
	GetFileAtCommit(context.Context, string, string, string, string) (repohost.FileContent, error)
}
type acceptedTreeDiffReader struct {
	store      branchDiffStore
	g          mythicalGit
	base, head string
}

func (r acceptedTreeDiffReader) GetChange(context.Context, string, string, string) (repohost.Change, error) {
	return repohost.Change{ParentCommitID: r.base}, nil
}
func (r acceptedTreeDiffReader) GetChangeDiff(ctx context.Context, owner, repo, _ string) (repohost.ChangeDiff, error) {
	diff, err := r.store.GetRevisionDiff(ctx, owner, repo, r.head, r.base, r.head, "")
	if err != nil {
		return repohost.ChangeDiff{}, err
	}
	// The native interdiff reports moves as add/delete. Retain the existing
	// controlled Git rename classification without executing textconv or hooks.
	raw, err := r.g.command(ctx, nil, "diff", "--name-status", "-z", "--find-renames", "--diff-filter=R", "--no-ext-diff", "--no-textconv", r.base, r.head, "--")
	if err != nil {
		return repohost.ChangeDiff{}, err
	}
	parts := strings.Split(string(raw), "\x00")
	for i := 0; i < len(parts)-1; i += 3 {
		if i+2 >= len(parts)-1 || !strings.HasPrefix(parts[i], "R") {
			return repohost.ChangeDiff{}, fmt.Errorf("invalid rename classification")
		}
		oldPath, newPath := parts[i+1], parts[i+2]
		files := make([]repohost.FileDiff, 0, len(diff.FileDiffs))
		for _, file := range diff.FileDiffs {
			if file.ChangeType == "deleted" && file.Path == oldPath || file.ChangeType == "added" && file.Path == newPath {
				continue
			}
			files = append(files, file)
		}
		diff.FileDiffs = append(files, repohost.FileDiff{Path: newPath, OldPath: oldPath, ChangeType: "renamed"})
	}
	sort.Slice(diff.FileDiffs, func(i, j int) bool { return diff.FileDiffs[i].Path < diff.FileDiffs[j].Path })
	return diff, nil
}
func (r acceptedTreeDiffReader) GetFileAtChange(ctx context.Context, owner, repo, rev, path string) (repohost.FileContent, error) {
	file, err := r.store.GetFileAtCommit(ctx, owner, repo, rev, path)
	if err == nil && (file.Encoding == "" || file.Encoding == "utf8") && strings.ContainsRune(file.Content, 0) {
		file.Content = base64.StdEncoding.EncodeToString([]byte(file.Content))
		file.Encoding = "base64"
	}
	return file, err
}

// scratchBranchDiff compares retained fork and advertised head revisions without a machine operation.
func (s *MythicalService) scratchBranchDiff(ctx context.Context, repositoryID int64, branch string) (BranchDiff, error) {
	row, err := s.queries().GetBranchWorkspace(ctx, db.GetBranchWorkspaceParams{RepositoryID: repositoryID, TargetBookmark: branch})
	if errors.Is(err, pgx.ErrNoRows) {
		return BranchDiff{}, pkgerrors.NotFound("branch not found")
	}
	if err != nil {
		return BranchDiff{}, err
	}
	if delegation, delegated := middleware.AuthInfoFromContext(ctx).Delegation(); delegated && (delegation.Branch == "" || delegation.Branch != row.ID) {
		return BranchDiff{}, &BranchError{http.StatusForbidden, "permission", "permission", "Credential is bound to another branch"}
	}
	if !row.IsFork || !mythicalSHA.MatchString(row.SourceCommit) {
		return BranchDiff{}, &TODOPrUnavailable{}
	}
	reader, ok := s.host.(interface {
		GetRevisionDiff(context.Context, string, string, string, string, string, string) (repohost.ChangeDiff, error)
	})
	if !ok {
		return BranchDiff{}, &TODOPrUnavailable{}
	}
	repository, owner, err := s.repository(ctx, repositoryID)
	if err != nil {
		return BranchDiff{}, err
	}
	head, err := s.refCommit(ctx, owner, repository.Name, "refs/heads/"+branch)
	if err != nil || !mythicalSHA.MatchString(head) {
		return BranchDiff{}, &TODOPrUnavailable{}
	}
	diff, err := reader.GetRevisionDiff(ctx, owner, repository.Name, head, row.SourceCommit, head, "")
	if err != nil {
		return BranchDiff{}, &TODOPrUnavailable{}
	}
	sizes := map[string]BranchDiffBinary{}
	for _, file := range diff.FileDiffs {
		if !file.IsBinary {
			continue
		}
		blobs, ok := s.host.(interface {
			GetFileAtChange(context.Context, string, string, string, string) (repohost.FileContent, error)
		})
		if !ok {
			return BranchDiff{}, &TODOPrUnavailable{}
		}
		size := func(rev, path string) (int64, error) {
			blob, err := blobs.GetFileAtChange(ctx, owner, repository.Name, rev, path)
			if err != nil || blob.TooLarge {
				return 0, &TODOPrUnavailable{}
			}
			switch blob.Encoding {
			case "base64":
				bytes, err := base64.StdEncoding.DecodeString(blob.Content)
				if err != nil {
					return 0, &TODOPrUnavailable{}
				}
				return int64(len(bytes)), nil
			case "", "utf-8", "utf8":
				return int64(len(blob.Content)), nil
			default:
				return 0, &TODOPrUnavailable{}
			}
		}
		beforePath := file.Path
		if file.OldPath != "" {
			beforePath = file.OldPath
		}
		var metadata BranchDiffBinary
		if file.ChangeType != "added" {
			metadata.BeforeBytes, err = size(row.SourceCommit, beforePath)
			if err != nil {
				return BranchDiff{}, err
			}
		}
		if file.ChangeType != "deleted" {
			metadata.AfterBytes, err = size(head, file.Path)
			if err != nil {
				return BranchDiff{}, err
			}
		}
		sizes[file.Path] = metadata
	}
	projected, err := ProjectTODOBranchDiff(branch, row.SourceCommit, diff.FileDiffs, sizes)
	if err != nil {
		return BranchDiff{}, err
	}
	for i := range projected.Files {
		projected.Files[i].Against.Kind = "fork"
	}
	return projected, nil
}
