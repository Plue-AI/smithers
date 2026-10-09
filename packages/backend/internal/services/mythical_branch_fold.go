package services

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// mythicalFoldedCandidate binds verification owed by a data-only fold to the
// exact new candidate. It is consumed by the existing verification admission.
type mythicalFoldedCandidate struct {
	Base string `json:"base"`
	Head string `json:"head"`
}

// forkFoldChildren validates every adopted descendant before Drop cancels the
// source. The folding transaction repeats this check after capture, since a
// descendant may have started while the source was being retired.
func forkFoldChildren(ctx context.Context, tx pgx.Tx, source db.MythicalItem) ([]db.MythicalItem, error) {
	q := db.New(tx)
	order, err := q.LockMythicalStackOrder(ctx, source.RepositoryID)
	if err != nil {
		return nil, err
	}
	children := []db.MythicalItem{}
	for _, child := range order {
		if child.ID == source.ID || child.WorkspaceID == "" {
			continue
		}
		var forked bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workspaces WHERE id::text=$1 AND forked_from_item=$2)`, child.WorkspaceID, source.ID).Scan(&forked); err != nil {
			return nil, err
		}
		if forked {
			children = append(children, child)
		}
	}
	for _, child := range children {
		// A retained candidate does not exclude member terminal/file writers.
		// Pin workspace state through folding. Awake seed-only children use
		// the existing prepared capture; a candidate bypasses that reader and
		// must remain asleep until live-candidate folding has a daemon contract.
		var status string
		if err := tx.QueryRow(ctx, `SELECT status FROM workspaces WHERE id=$1 AND repository_id=$2 AND deleted_at IS NULL FOR NO KEY UPDATE`, child.WorkspaceID, source.RepositoryID).Scan(&status); err != nil {
			return nil, err
		}
		if status == "running" && child.CandidateHead != "" {
			return nil, todoControlConflict("Forked TODO is still working")
		}
		if status != "stopped" && status != "suspended" && status != "running" {
			return nil, todoControlUnavailable()
		}
		checks := mythicalChecksOf(child)
		// Delivery, verification and review still own the child revision after
		// coding has settled; folding must wait for those launches as well.
		if (checks.RunLaunched && child.RequestOutcome == "") || mythicalRunInFlight(child) {
			return nil, todoControlConflict("Forked TODO is still working")
		}
		if checks.Seed == nil || !mythicalSHA.MatchString(checks.Seed.ForkCommit) || mythicalMergeFenced(child) {
			return nil, todoControlUnavailable()
		}
	}
	return children, nil
}

// FoldIntoForks retains a dropped source's change in every adopted descendant
// before vacating its place. A moved-before-source descendant keeps its tree;
// a later descendant takes source edits made since the fork with a three-way
// merge. Conflict or unavailable capture refuses the whole Drop transaction.
func (s *MythicalService) FoldIntoForks(ctx context.Context, tx pgx.Tx, stack db.MythicalStack, source db.MythicalItem) error {
	q := db.New(tx)
	children, err := forkFoldChildren(ctx, tx, source)
	if err != nil {
		return err
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
		// Folding creates a revision of the adopted TODO's one logical change,
		// never the source machine's captured change identity.
		seedCommit, err := g.readCommit(ctx, checks.Seed.Head)
		if err != nil {
			return err
		}
		commit.ChangeID = seedCommit.ChangeID
		if !mythicalChangeID.MatchString(commit.ChangeID) {
			// Persisted pre-admission seeds may predate explicit item authority.
			commit.ChangeID = checks.MachineItemChanges[child.WorkspaceID]
			if !mythicalChangeID.MatchString(commit.ChangeID) {
				commit.ChangeID = mythicalChangeIDFor("branch-item", child.WorkspaceID)
			}
		}
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
		child.BaseCommit = base
		if child.CandidateHead != "" {
			child.CandidateBase, child.CandidateHead = base, folded
			child.CandidateVerified = false
			child.VerifyOutcome, child.VerifyRunID = "", ""
			// A fold invalidates publication evidence without reviving a failed or
			// stopped TODO. Active completed proposals re-enter their same verifier.
			switch child.State {
			case "integrating", "verifying", "proposing", "waiting", "proposed":
				child.State, child.Reason, child.NextAttemptAt = "integrating", "", pgtype.Timestamptz{}
				checks.Folded = &mythicalFoldedCandidate{Base: base, Head: folded}
			}
			if checks.Land != nil {
				checks.ApprovalCleared, checks.Land = checks.Land.Head, nil
			}
		}
		child.Checks = checks.encode()
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
