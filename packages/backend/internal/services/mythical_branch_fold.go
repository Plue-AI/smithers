package services

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// FoldIntoForks retains a dropped source's change in every adopted descendant
// before vacating its place. A moved-before-source descendant keeps its tree;
// a later descendant takes source edits made since the fork with a three-way
// merge. Conflict or unavailable capture refuses the whole Drop transaction.
func (s *MythicalService) FoldIntoForks(ctx context.Context, tx pgx.Tx, stack db.MythicalStack, source db.MythicalItem) error {
	q := db.New(tx)
	order, err := q.LockMythicalStackOrder(ctx, source.RepositoryID)
	if err != nil {
		return err
	}
	children := []db.MythicalItem{}
	for _, child := range order {
		if child.ID == source.ID || child.WorkspaceID == "" {
			continue
		}
		workspace, err := q.GetWorkspace(ctx, child.WorkspaceID)
		if err != nil {
			return err
		}
		if workspace.ForkedFromItem == source.ID {
			children = append(children, child)
		}
	}
	if len(children) == 0 {
		return nil
	}
	// A steer starts a new attempt and clears its current candidate. The
	// accepted generation remains in history; live Drop's writer-excluded
	// final capture is the source to fold while that attempt is still working.
	if mythicalChecksOf(source).DropRequested != nil {
		workspace, err := q.GetWorkspace(ctx, source.WorkspaceID)
		if err != nil {
			return err
		}
		if workspace.RepositoryID != source.RepositoryID || workspace.Status != "suspended" && workspace.Status != "stopped" {
			return todoControlUnavailable()
		}
		source.CandidateHead = workspace.HeadCommitID
		if source.CandidateBase == "" {
			source.CandidateBase = source.BaseCommit
		}
	}
	if s == nil || s.host == nil || !mythicalSHA.MatchString(source.CandidateBase) || !mythicalSHA.MatchString(source.CandidateHead) {
		return todoControlUnavailable()
	}
	reader, ok := s.lanes.(interface {
		CapturedHead(context.Context, string, int64, int64) (string, error)
	})
	if !ok {
		return todoControlUnavailable()
	}
	repo, owner, err := s.repository(ctx, source.RepositoryID)
	if err != nil {
		return err
	}
	bridge, err := startMythicalBridge(ctx, s.host, owner, repo.Name, RepositoryStillAt(q, source.RepositoryID, owner, repo.Name))
	if err != nil {
		return err
	}
	defer bridge.Close()
	g, cleanup, err := s.forkGit(ctx, source.RepositoryID)
	if err != nil {
		return err
	}
	defer cleanup()
	if _, err = g.git(ctx, "fetch", "--quiet", "--no-tags", "--no-auto-maintenance", bridge.URL(), "+refs/*:refs/*"); err != nil {
		return err
	}
	run := &mythicalRun{row: stack, g: g, bridge: bridge, owner: owner, repo: repo.Name}
	for _, child := range children {
		checks := mythicalChecksOf(child)
		if checks.Seed == nil || !mythicalSHA.MatchString(checks.Seed.ForkCommit) || mythicalMergeFenced(child) || checks.RunLaunched && child.RequestOutcome == "" {
			return todoControlUnavailable()
		}
		head := child.CandidateHead
		if head == "" {
			head, err = reader.CapturedHead(ctx, child.WorkspaceID, source.RepositoryID, stack.ActorUserID.Int64)
			if err != nil {
				return err
			}
		}
		commit, err := g.readCommit(ctx, head)
		if err != nil {
			return err
		}
		base := checks.Seed.Base
		if child.StackPosition.Int64 > source.StackPosition.Int64 {
			tree, err := g.merge3(ctx, checks.Seed.ForkCommit, source.CandidateHead, head)
			if err != nil {
				return todoControlConflict("Fork conflicts with the source; resolve it before Drop")
			}
			commit.Tree = tree
			base = source.CandidateBase
		}
		commit.Parents = []string{base}
		commit.ChangeID = ""
		commit.Message = "Fold into fork\n"
		folded, err := g.writeCommit(ctx, commit)
		if err != nil {
			return err
		}
		if err = s.pin(ctx, run, folded); err != nil {
			return err
		}
		if _, err = s.retainFor(ctx, run, child.WorkspaceID, folded); err != nil {
			return err
		}
		diffBytes, err := g.command(ctx, nil, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--binary", base, folded)
		diff := string(diffBytes)
		if err != nil {
			return err
		}
		seed := *checks.Seed
		seed.Base, seed.Head, seed.Diff = base, folded, diff
		checks.Seed = &seed
		child.Checks = checks.encode()
		child.BaseCommit = base
		if child.CandidateHead != "" {
			child.CandidateBase, child.CandidateHead = base, folded
		}
		if _, err = q.SaveMythicalItem(ctx, child); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE workspaces SET forked_from_item=NULL,forked_from_base=$1 WHERE id=$2`, base, child.WorkspaceID); err != nil {
			return err
		}
		s.itemChanged(ctx, q, stack, child.ID)
	}
	return nil
}
