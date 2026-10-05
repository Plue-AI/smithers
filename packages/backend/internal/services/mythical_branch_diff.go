package services

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// branchDiffFileLimit and branchDiffPatchBytes bound one diff read: a change
// past them is too large to show as a card and reads as unavailable.
const (
	branchDiffFileLimit   = 300
	branchDiffPatchBytes  = 1 << 20
	branchDiffCommitLimit = 100
)

// BranchDiff reads a branch's change for GET /api/branches/{b}/diff (spec
// §6.3): a TODO's verified candidate against the revision its change is
// measured from (its accepted prefix; main's tip for the first TODO, as the
// review reads it in proposalDiff), and a scratch branch's head against the
// revision it was forked from, with the commits between, oldest first. A
// TODO with no candidate yet, and main, have no change to show. The objects
// are read through the stack's own bridge into a scratch repository of the
// read's own that borrows the stack's objects, as Fork does; nothing is
// written to the repository.
func (s *MythicalService) BranchDiff(ctx context.Context, repositoryID int64, branch BranchMachineResponse) (BranchDiff, error) {
	empty := BranchDiff{Files: []BranchDiffModel{}, Commits: []BranchCommit{}}
	if s == nil || s.store == nil || s.host == nil {
		return BranchDiff{}, branchForkUnavailable("diff unavailable")
	}
	q := s.queries()
	var base, head, against string
	fetch := []string{"refs/heads/main"}
	switch {
	case branch.Kind == "item" && branch.Item != nil:
		item, err := q.GetMythicalItemByNumber(ctx, repositoryID, branch.Item.N)
		if errors.Is(err, pgx.ErrNoRows) {
			return BranchDiff{}, &BranchError{404, "todo_not_found", "user", "TODO not found"}
		}
		if err != nil {
			return BranchDiff{}, err
		}
		// The verified candidate is the change; the pull request's head is a
		// commit with the same tree that GitHub may have rebuilt on main.
		base, head, against = item.CandidateBase, item.CandidateHead, "item_base"
		if head == "" {
			head = item.PRHead
		}
	case branch.Kind == "scratch" && branch.ForkedFrom != nil:
		base, head, against = branch.ForkedFrom.Commit, branch.Head, "fork"
		fetch = append(fetch, "refs/heads/"+branch.Name)
	default:
		return empty, nil
	}
	if !isLowerHexRevision(base) || !isLowerHexRevision(head) {
		return empty, nil
	}
	fetch = append(fetch, repohost.MythicalReservedRefNS+"keep/"+head, repohost.MythicalReservedRefNS+"keep/"+base)
	g, cleanup, err := s.forkGit(ctx, repositoryID)
	if err != nil {
		return BranchDiff{}, err
	}
	defer cleanup()
	if !g.has(ctx, base) || !g.has(ctx, head) {
		if err := s.fetchBranchRevisions(ctx, g, repositoryID, fetch); err != nil {
			return BranchDiff{}, err
		}
		if !g.has(ctx, base) || !g.has(ctx, head) {
			return BranchDiff{}, branchForkUnavailable("the branch's revisions could not be read")
		}
	}
	files, sizes, err := branchDiffFiles(ctx, g, base, head)
	if err != nil {
		return BranchDiff{}, err
	}
	diff, err := ProjectTODOBranchDiff(branch.Name, base, files, sizes)
	if err != nil {
		return BranchDiff{}, err
	}
	for i := range diff.Files {
		diff.Files[i].Against.Kind = against
	}
	if diff.Commits, err = branchDiffCommits(ctx, g, base, head); err != nil {
		return BranchDiff{}, err
	}
	return diff, nil
}

// fetchBranchRevisions fetches the refs of refs the repository has into g.
func (s *MythicalService) fetchBranchRevisions(ctx context.Context, g mythicalGit, repositoryID int64, refs []string) error {
	repository, owner, err := s.repository(ctx, repositoryID)
	if err != nil {
		return err
	}
	bridge, err := startMythicalBridge(ctx, s.host, owner, repository.Name, RepositoryStillAt(s.queries(), repositoryID, owner, repository.Name))
	if err != nil {
		return err
	}
	defer bridge.Close()
	advertised, err := g.lsRemote(ctx, bridge.URL())
	if err != nil {
		return branchForkUnavailable("the repository could not be read")
	}
	present := []string{}
	for _, ref := range refs {
		if advertised[ref] != "" {
			present = append(present, ref)
		}
	}
	if len(present) == 0 {
		return nil
	}
	if err := g.fetch(ctx, bridge.URL(), 0, 0, present...); err != nil {
		return branchForkUnavailable("the branch's revisions could not be read")
	}
	return nil
}

// branchDiffFiles is head's change from base, one patch per file, renames
// found; a binary file's sizes come from its blobs.
func branchDiffFiles(ctx context.Context, g mythicalGit, base, head string) ([]repohost.FileDiff, map[string]BranchDiffBinary, error) {
	raw, err := g.command(ctx, nil, "diff-tree", "-r", "-z", "-M", "--raw", base, head)
	if err != nil {
		return nil, nil, err
	}
	fields := strings.Split(strings.TrimSuffix(string(raw), "\x00"), "\x00")
	files := []repohost.FileDiff{}
	sizes := map[string]BranchDiffBinary{}
	for i := 0; i+1 < len(fields); {
		// ":<old mode> <new mode> <old blob> <new blob> <status>", then the
		// path, then the new path for a rename.
		meta := strings.Fields(strings.TrimPrefix(fields[i], ":"))
		if len(meta) != 5 {
			return nil, nil, errors.New("unreadable diff-tree entry")
		}
		file := repohost.FileDiff{Path: fields[i+1]}
		paths := []string{file.Path}
		i += 2
		switch meta[4][0] {
		case 'A':
			file.ChangeType = "added"
		case 'D':
			file.ChangeType = "deleted"
		case 'R':
			if i >= len(fields) {
				return nil, nil, errors.New("unreadable diff-tree rename")
			}
			file.ChangeType, file.OldPath, file.Path = "renamed", file.Path, fields[i]
			paths = append(paths, file.Path)
			i++
		default:
			file.ChangeType = "modified"
		}
		if len(files) == branchDiffFileLimit {
			file.TooLarge = true
			files = append(files, file)
			break
		}
		// A path is a path, never a pattern: "*" names only the file "*".
		patch, err := g.command(ctx, nil, append([]string{"--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", base, head, "--"}, paths...)...)
		if err != nil {
			return nil, nil, err
		}
		file.Patch = string(patch)
		file.TooLarge = len(patch) > branchDiffPatchBytes
		if strings.Contains(file.Patch, "\nBinary files ") || strings.HasPrefix(file.Patch, "Binary files ") {
			file.IsBinary, file.Patch = true, ""
			before, err := branchBlobSize(ctx, g, meta[2])
			if err != nil {
				return nil, nil, err
			}
			after, err := branchBlobSize(ctx, g, meta[3])
			if err != nil {
				return nil, nil, err
			}
			sizes[file.Path] = BranchDiffBinary{BeforeBytes: before, AfterBytes: after}
		}
		files = append(files, file)
	}
	return files, sizes, nil
}

// branchBlobSize is a blob's size, 0 for the side a file does not exist on.
func branchBlobSize(ctx context.Context, g mythicalGit, blob string) (int64, error) {
	if strings.Trim(blob, "0") == "" {
		return 0, nil
	}
	out, err := g.git(ctx, "cat-file", "-s", blob)
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(out, 10, 64)
}

// branchDiffCommits are the commits from base to head, oldest first.
func branchDiffCommits(ctx context.Context, g mythicalGit, base, head string) ([]BranchCommit, error) {
	out, err := g.command(ctx, nil, "log", "-z", "--reverse", "--max-count="+strconv.Itoa(branchDiffCommitLimit),
		"--format=%H%x1f%an%x1f%aI%x1f%s", base+".."+head)
	if err != nil {
		return nil, err
	}
	commits := []BranchCommit{}
	for _, entry := range strings.Split(string(out), "\x00") {
		parts := strings.SplitN(strings.TrimSpace(entry), "\x1f", 4)
		if len(parts) == 4 {
			commits = append(commits, BranchCommit{SHA: parts[0], Author: parts[1], At: parts[2], Subject: parts[3]})
		}
	}
	return commits, nil
}
