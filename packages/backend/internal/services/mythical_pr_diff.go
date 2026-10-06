package services

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/diffview"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

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

// TODOBranchDiff reads only the recorded accepted candidate and its base. Live
// workspace contents and today's stack order cannot change this comparison.
func (s *MythicalService) TODOBranchDiff(ctx context.Context, branch string) (BranchDiff, error) {
	if s == nil || s.store == nil || s.host == nil {
		return BranchDiff{}, &mythicalPRUnavailable{}
	}
	if _, err := Authorize(ctx, s.queries(), "branches.read"); err != nil {
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
	if strings.HasPrefix(branch, scratchBranchPrefix) {
		return s.scratchBranchDiff(ctx, repository, branch)
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
	if !item.CandidateVerified || item.CandidateBase == "" || item.CandidateHead == "" {
		return BranchDiff{}, &mythicalPRUnavailable{}
	}
	repo, owner, err := s.repository(ctx, repository)
	if err != nil {
		return BranchDiff{}, err
	}
	bridge, err := startMythicalBridge(ctx, s.host, owner, repo.Name, RepositoryStillAt(s.queries(), repository, owner, repo.Name))
	if err != nil {
		return BranchDiff{}, err
	}
	defer bridge.Close()
	g, cleanup, err := s.forkGit(ctx, repository)
	if err != nil {
		return BranchDiff{}, err
	}
	defer cleanup()
	for _, rev := range []string{item.CandidateBase, item.CandidateHead} {
		if !mythicalSHA.MatchString(rev) {
			return BranchDiff{}, &mythicalPRUnavailable{}
		}
		if !g.has(ctx, rev) {
			if err := g.fetch(ctx, bridge.URL(), 0, 0, rev); err != nil {
				return BranchDiff{}, err
			}
		}
	}
	reader := acceptedTreeDiffReader{g: g, base: item.CandidateBase, head: item.CandidateHead}
	diff, err := diffview.BuildChangeDiff(ctx, reader, owner, repo.Name, item.CandidateHead, diffview.BuildOptions{})
	if err != nil {
		return BranchDiff{}, err
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
			rev, path := item.CandidateHead, file.Path
			if before {
				rev = item.CandidateBase
				if file.OldPath != "" {
					path = file.OldPath
				}
			}
			content, err := reader.GetFileAtChange(ctx, owner, repo.Name, rev, path)
			if err != nil {
				return BranchDiff{}, err
			}
			if content.TooLarge {
				return BranchDiff{}, &mythicalPRUnavailable{}
			}
			bytes := []byte(content.Content)
			if content.Encoding == "base64" {
				bytes, err = base64.StdEncoding.DecodeString(content.Content)
				if err != nil {
					return BranchDiff{}, err
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
	return ProjectTODOBranchDiff(branch, item.CandidateBase, diff.FileDiffs, sizes)
}

// acceptedTreeDiffReader adapts controlled object reads to the existing bounded
// diff builder. Git's NUL-delimited classification keeps unusual paths intact;
// all patch construction, binary detection and caps remain in diffview.
type acceptedTreeDiffReader struct {
	g          mythicalGit
	base, head string
}

func (r acceptedTreeDiffReader) GetChange(context.Context, string, string, string) (repohost.Change, error) {
	return repohost.Change{ParentCommitID: r.base}, nil
}
func (r acceptedTreeDiffReader) GetChangeDiff(ctx context.Context, _, _, _ string) (repohost.ChangeDiff, error) {
	raw, err := r.g.command(ctx, nil, "diff", "--name-status", "-z", "--find-renames", "--no-ext-diff", "--no-textconv", r.base, r.head, "--")
	if err != nil {
		return repohost.ChangeDiff{}, err
	}
	parts := strings.Split(string(raw), "\x00")
	result := repohost.ChangeDiff{ChangeID: r.head, FileDiffs: []repohost.FileDiff{}}
	for i := 0; i < len(parts)-1; {
		status := parts[i]
		i++
		if status == "" || i >= len(parts)-1 {
			return repohost.ChangeDiff{}, fmt.Errorf("invalid file classification")
		}
		file := repohost.FileDiff{Path: parts[i]}
		i++
		switch status[0] {
		case 'A':
			file.ChangeType = "added"
		case 'D':
			file.ChangeType = "deleted"
		case 'M', 'T':
			file.ChangeType = "modified"
		case 'R':
			if i >= len(parts)-1 {
				return repohost.ChangeDiff{}, fmt.Errorf("invalid rename classification")
			}
			file.ChangeType = "renamed"
			file.OldPath = file.Path
			file.Path = parts[i]
			i++
		default:
			return repohost.ChangeDiff{}, fmt.Errorf("unsupported file classification")
		}
		result.FileDiffs = append(result.FileDiffs, file)
	}
	return result, nil
}
func (r acceptedTreeDiffReader) GetFileAtChange(ctx context.Context, _, _, rev, path string) (repohost.FileContent, error) {
	object := rev + ":" + path
	size, err := r.g.git(ctx, "cat-file", "-s", object)
	if err != nil {
		return repohost.FileContent{}, err
	}
	n, err := strconv.ParseInt(size, 10, 64)
	if err != nil {
		return repohost.FileContent{}, err
	}
	if n > 1<<20 {
		return repohost.FileContent{Path: path, TooLarge: true}, nil
	}
	content, err := r.g.command(ctx, nil, "cat-file", "blob", object)
	if err != nil {
		return repohost.FileContent{}, err
	}
	result := repohost.FileContent{Path: path, Content: string(content), Encoding: "utf8"}
	if !utf8.Valid(content) || strings.ContainsRune(result.Content, 0) {
		result.Encoding = "base64"
		result.Content = base64.StdEncoding.EncodeToString(content)
	}
	return result, nil
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
