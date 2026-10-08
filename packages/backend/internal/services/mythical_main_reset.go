package services

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

var _ GitHubMainStackContracts = (*MythicalService)(nil)

// Ready uses the same providers as the ordinary stack's rebase and flow-load
// consumers. Neither consumer has a host execution fallback.
func (s *MythicalService) Ready(context.Context) error {
	if s == nil || s.store == nil || s.host == nil || s.branchRebase == nil || !s.flowLoad || s.launcher == nil || s.lanes == nil {
		return githubSyncUnavailable()
	}
	return nil
}

type mainForcePushAttention struct {
	ID        string           `json:"id"`
	Kind      string           `json:"kind"`
	Old       string           `json:"old"`
	New       string           `json:"new"`
	Text      string           `json:"text"`
	Actions   []map[string]any `json:"actions"`
	SettledBy int64            `json:"settled_by,omitempty"`
	SettledAt *time.Time       `json:"settled_at,omitempty"`
	// The attention ID is the durable delivery key. Its stack generation and
	// target commit feed the existing claimed worker and coalescing flow loader.
	MainMovedGeneration int64 `json:"main_moved_generation,omitempty"`
}

func forcePushAttention(row OrderAttention) (mainForcePushAttention, error) {
	var value mainForcePushAttention
	err := json.Unmarshal(row.retained, &value)
	return value, err
}
func retainForcePush(row mainForcePushAttention) (OrderAttention, error) {
	raw, err := json.Marshal(row)
	return OrderAttention{ID: row.ID, Kind: row.Kind, SettledAt: row.SettledAt, retained: raw}, err
}

func (s *MythicalService) OpenForcePush(ctx context.Context, tx pgx.Tx, repository int64, push GitHubMainForcePush) error {
	if push.Old == push.New || !repositorySourceSHA.MatchString(push.Old) || !repositorySourceSHA.MatchString(push.New) {
		return staleMainReset()
	}
	// Let an already-started stack/merge operation recover before freezing
	// dispatch; otherwise the attention would strand its own reset fence.
	if err := noMainMergeFence(ctx, tx, repository); err != nil {
		return err
	}
	rows, err := readStackAttention(ctx, tx, repository)
	if err != nil {
		return err
	}
	index := -1
	id := uuid.NewString()
	for i, row := range rows {
		if row.Kind == "force_push" && row.SettledAt == nil {
			prior, err := forcePushAttention(row)
			if err != nil {
				return err
			}
			if prior.Old == push.Old && prior.New == push.New {
				return nil
			}
			index, id = i, row.ID
			break
		}
	}
	value := mainForcePushAttention{ID: id, Kind: "force_push", Old: push.Old, New: push.New, Text: "main rewritten on GitHub", Actions: []map[string]any{{"tag": "main.reset-to-github", "label": "Reset to GitHub main", "args": map[string]string{"id": id, "old": push.Old, "new": push.New}}}}
	row, err := retainForcePush(value)
	if err != nil {
		return err
	}
	if index < 0 {
		rows = append(rows, row)
	} else {
		rows[index] = row
	}
	if err := writeStackAttention(ctx, tx, repository, rows); err != nil {
		return err
	}
	s.notify(ctx, db.New(tx), repository, 0, "attention", "")
	return nil
}

// The repository session lock orders merge dispatch, pulls and reset. Persistent
// merge fences also cover requests sent before a process died.
func noMainMergeFence(ctx context.Context, tx pgx.Tx, repository int64) error {
	items, err := db.New(tx).ListMythicalPendingOperations(ctx, repository)
	if err != nil {
		return err
	}
	for _, item := range items {
		if _, err := decodeMythicalOutbound(item.PendingOp); err != nil {
			return mythicalMergeConflict("rechecking", "The stack operation is unreadable")
		}
		if mythicalMergeFenced(item) {
			return mythicalMergeConflict("merging", "A merge is in flight")
		}
	}
	var pending bool
	if err := tx.QueryRow(ctx, `SELECT pending_op IS NOT NULL OR running FROM mythical_stacks WHERE repository_id=$1`, repository).Scan(&pending); err != nil {
		return err
	}
	if pending {
		return mythicalMergeConflict("rechecking", "The stack is updating")
	}
	return nil
}

func (s *MythicalService) ValidateReset(ctx context.Context, tx pgx.Tx, repository int64, id, old, new string) (string, error) {
	if _, err := Authorize(ctx, db.New(tx), "main.reset-to-github"); err != nil {
		return "", err
	}
	// Recheck the current person after waiting for the operation lock;
	// the route's cached catalog decision does not replace this read.
	if _, err := authorizePersonOnly(ctx, db.New(tx), middleware.AuthInfoFromContext(ctx), InstallOwner); err != nil {
		return "", err
	}
	if err := noMainMergeFence(ctx, tx, repository); err != nil {
		return "", err
	}
	rows, err := readStackAttention(ctx, tx, repository)
	if err != nil {
		return "", err
	}
	for _, row := range rows {
		if row.Kind != "force_push" || row.SettledAt != nil {
			continue
		}
		value, err := forcePushAttention(row)
		if err != nil {
			return "", err
		}
		if (id == "" || id == value.ID) && old == value.Old && new == value.New {
			return value.ID, nil
		}
	}
	return "", staleMainReset()
}
func (s *MythicalService) VerifyPull(ctx context.Context, tx pgx.Tx, repository int64, old, new string) error {
	// A normal sync must be able to observe a sent merge on GitHub and settle
	// its fence. Only reset is forbidden by a sent merge.
	rows, err := readStackAttention(ctx, tx, repository)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if row.Kind == "force_push" && row.SettledAt == nil {
			return staleMainReset()
		}
	}
	return nil
}
func (s *MythicalService) SettleReset(ctx context.Context, tx pgx.Tx, intent GitHubMainResetIntent) error {
	if intent.ActorID <= 0 {
		return staleMainReset()
	}
	rows, err := readStackAttention(ctx, tx, intent.RepositoryID)
	if err != nil {
		return err
	}
	index := -1
	var attention mainForcePushAttention
	for i, row := range rows {
		if row.Kind == "force_push" && row.ID == intent.ID {
			attention, err = forcePushAttention(row)
			if err != nil {
				return err
			}
			if attention.Old != intent.Old || attention.New != intent.New || attention.SettledAt != nil {
				return staleMainReset()
			}
			index = i
			break
		}
	}
	if index < 0 {
		return staleMainReset()
	}
	q := db.New(tx)
	stack, err := q.GetMythicalStack(ctx, intent.RepositoryID)
	if err != nil {
		return err
	}
	// Merged TODOs remain merged even when GitHub removed their commit.
	landed, err := q.ListMythicalItemsInStates(ctx, intent.RepositoryID, []string{"landed"})
	if err != nil {
		return err
	}
	if len(landed) > 0 {
		ancestry, ok := s.host.(interface {
			IsAncestor(context.Context, string, string, string, string) (bool, error)
		})
		if !ok {
			return githubSyncUnavailable()
		}
		repository, owner, err := s.repository(ctx, intent.RepositoryID)
		if err != nil {
			return err
		}
		for _, item := range landed {
			if item.PRMergeCommit == "" {
				continue
			}
			present, err := ancestry.IsAncestor(ctx, owner, repository.Name, item.PRMergeCommit, intent.New)
			if err != nil {
				return err
			}
			if !present {
				item.Reason = "commit no longer on main after a force push"
				if _, err := q.SaveMythicalItem(ctx, item); err != nil {
					return err
				}
			}
		}
	}
	items, err := q.LockMythicalStackOrder(ctx, intent.RepositoryID)
	if err != nil {
		return err
	}
	step := mythicalItemStep{s: s, q: q, now: s.now(), r: &mythicalRun{row: stack, mainTip: intent.New}, items: items}
	for _, item := range items {
		if mythicalSettledStates[item.State] || !item.StackPosition.Valid {
			continue
		}
		next := step.awaitRebase(item, intent.New, "main")
		if next == nil {
			next = &item
		}
		next.CandidateVerified = false
		checks := mythicalChecksOf(*next)
		if checks.Land != nil {
			checks.ApprovalCleared, checks.Land = checks.Land.Head, nil
		}
		next.Checks = checks.encode()
		if _, err := q.SaveMythicalItem(ctx, *next); err != nil {
			return err
		}
	}
	// Reuse the stack's durable rebuild intent. The worker alone replaces
	// mythical and loads the new main's flows, after this transaction commits.
	rebuilt, err := q.RequestMythicalBootstrap(ctx, intent.RepositoryID, intent.ActorID, stack.BootstrapDepth, true)
	if err != nil {
		return err
	}
	now := s.now()
	attention.SettledAt, attention.SettledBy, attention.Actions = &now, intent.ActorID, []map[string]any{}
	attention.MainMovedGeneration = rebuilt.RequestedGeneration
	rows[index], err = retainForcePush(attention)
	if err != nil {
		return err
	}
	if err := writeStackAttention(ctx, tx, intent.RepositoryID, rows); err != nil {
		return err
	}
	s.notify(ctx, q, intent.RepositoryID, rebuilt.Generation, "attention", "")
	return nil
}
func (s *MythicalService) LeaveOpen(context.Context, pgx.Tx, GitHubMainResetIntent) error { return nil }
