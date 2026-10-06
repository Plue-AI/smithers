package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// consumeGitHubPullTodos runs inside fetched delivery's transaction: the PR
// projection, lifecycle event and branch-restoration intent share its receipt.
func (s *MythicalService) consumeGitHubPullTodos(ctx context.Context, tx pgx.Tx, fetched gitHubFetchedObject) (json.RawMessage, error) {
	source, err := lockFetchedRepo(ctx, tx, fetched.Repo)
	if err != nil {
		return nil, err
	}
	if fetched.Resource != GitHubRepoMetadataPulls || source.GithubRepositoryID.Int64 != fetched.GitHubRepository || source.InstallationID.Int64 != fetched.Installation {
		return nil, gitHubFetchUnavailable()
	}
	if err := s.installGitHubSync.authorizeFetched(ctx, source); err != nil {
		return nil, err
	}
	var payload struct {
		mythicalGitHubPull
		ClosedAt *time.Time `json:"closed_at"`
		ClosedBy *struct {
			Login string `json:"login"`
		} `json:"closed_by"`
	}
	if json.Unmarshal(fetched.Object, &payload) != nil || payload.Number != fetched.Number || payload.Head.SHA == "" {
		return nil, errors.New("invalid fetched pull fact")
	}
	pull := payload.pull()
	q := db.New(tx)
	repositories, err := q.ListRepositoryIDsForGitHubSource(ctx, source.OwnerLogin, source.RepoName)
	if err != nil {
		return nil, err
	}
	changed := 0
	for _, repository := range repositories {
		owner, repo, err := resolveGitHubDestination(ctx, q, nil, 0, repository, "", "")
		if err != nil {
			return nil, err
		}
		if !strings.EqualFold(owner, source.OwnerLogin) || !strings.EqualFold(repo, source.RepoName) {
			continue
		}
		if _, err := tx.Exec(ctx, `SELECT repository_id FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, repository); err != nil {
			return nil, err
		}
		stack, err := q.GetMythicalStack(ctx, repository)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		items, err := q.ListMythicalGitHubBranchItems(ctx, repository)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			if !item.PRNumber.Valid || item.PRNumber.Int64 != pull.Number {
				continue
			}
			checks := mythicalChecksOf(item)
			if checks.Branch != pull.HeadRef {
				return nil, gitHubFetchUnavailable()
			}
			fact := mythicalGitHubFact{Head: pull.HeadSHA, MergeCommit: pull.MergeCommit, Number: mythicalItemNumber(item)}
			switch {
			case pull.Merged:
				fact.Kind = "merged"
				if item.State == "landed" || item.State == "merged" {
					break
				}
				if s.host == nil {
					return nil, &mythicalPRUnavailable{}
				}
				// The mirror must already contain the reported commit. GitHub's own
				// merge receipt alone cannot expose Merged ahead of its main row.
				localRepo, localOwner, err := s.repository(ctx, repository)
				if err != nil {
					return nil, err
				}
				main, err := s.host.GetBookmark(ctx, localOwner, localRepo.Name, "main")
				if err != nil {
					return nil, err
				}
				ancestry, ok := s.host.(interface {
					IsAncestor(context.Context, string, string, string, string) (bool, error)
				})
				fact.OnMain = main.TargetCommitID == pull.MergeCommit && pull.MergeCommit != ""
				if !fact.OnMain && ok && pull.MergeCommit != "" {
					fact.OnMain, err = ancestry.IsAncestor(ctx, localOwner, localRepo.Name, pull.MergeCommit, main.TargetCommitID)
					if err != nil {
						return nil, err
					}
				}
				if !fact.OnMain {
					return nil, fmt.Errorf("waiting for mirrored main to contain %s", pull.MergeCommit)
				}
				// Missing retained containment provider cannot silently absorb earlier
				// items. Keep this fetched delivery for its order-attention consumer.
				for _, earlier := range items {
					if earlier.ID != item.ID && earlier.StackPosition.Valid && item.StackPosition.Valid && earlier.StackPosition.Int64 < item.StackPosition.Int64 && !mythicalSettledStates[earlier.State] {
						return nil, &mythicalPRUnavailable{}
					}
				}
			case pull.State == "closed":
				fact.Kind = "closed"
			case mythicalDroppedPull(item) && pull.State == "open":
				fact.Kind = "reopened"
			default:
				fact.Kind = "push"
			}
			decision := decideGitHubFact(fact, mythicalGitHubFactItem{State: item.State, Head: item.PRHead, ClosedAt: mythicalGitHubClosedAt(item)}, s.now())
			next := item
			checks.PRDraft = pull.Draft
			switch decision.Event {
			case "dropped":
				if err := s.cancelAttempt(ctx, tx, stack, item); err != nil {
					return nil, err
				}
				at := s.now()
				if payload.ClosedAt != nil {
					at = *payload.ClosedAt
				}
				checks.GitHubClosedAt = &at
				checks.GitHubClosedPosition = item.StackPosition.Int64
				for i := range checks.Waits {
					if checks.Waits[i].SettledAt == nil {
						checks.Waits[i].SettledAt = &at
					}
				}
				next.State, next.PRState, next.Reason = "rejected", "closed", "closed on GitHub"
				if payload.ClosedBy != nil && payload.ClosedBy.Login != "" {
					next.Reason += " by @" + payload.ClosedBy.Login
				}
				next.PausedAt = pgtype.Timestamptz{}
			case "in_review":
				if item.State == "cancelled" {
					if !checks.GitHubDropRead.matches(source) {
						return nil, gitHubFetchUnavailable()
					}
					if fetched.PullObservation < checks.GitHubDropRead.Observation {
						continue
					}
				}
				// Close reconciliation owns the pending slot, including an unknown
				// response. Retain this delivery until it settles; never discard the
				// close or let its later dispatch undo the person's reopen.
				if len(item.PendingOp) != 0 {
					return nil, &mythicalPRUnavailable{}
				}
				if !item.CandidateVerified || item.PRHead == "" || !mythicalTodoBranchValid(checks.Branch) {
					return nil, &mythicalPRUnavailable{}
				}
				order, err := q.LockMythicalStackOrder(ctx, repository)
				if err != nil {
					return nil, err
				}
				position := checks.GitHubClosedPosition
				if position == 0 && item.State == "cancelled" {
					position = item.StackPosition.Int64 // retained pre-upgrade drop
				}
				max := int64(0)
				free := position > 0
				for _, other := range order {
					if other.StackPosition.Int64 == position {
						free = false
					}
					if other.StackPosition.Int64 > max {
						max = other.StackPosition.Int64
					}
				}
				if !free {
					position = max + 1
				}
				next.StackPosition = pgtype.Int8{Int64: position, Valid: true}
				next.State, next.PRState, next.Reason = "proposed", "open", ""
				checks.GitHubClosedAt = nil
				// Missing branches are restored from the last verified proposal; a
				// foreign branch is retained by the outbound push lease, never overwritten.
				if len(next.PendingOp) == 0 {
					next.PendingOp, _ = json.Marshal(MythicalOutboundOp{Kind: "push", Target: checks.Branch, Desired: item.PRHead, Precondition: "", State: "intended"})
				}
			case "merged":
				if err := s.cancelAttempt(ctx, tx, stack, item); err != nil {
					return nil, err
				}
				next = mythicalLanded(next, pull.MergeCommit, s.now())
				checks = mythicalChecksOf(next)
			}
			next.Checks = checks.encode()
			if decision.Event == "" && string(next.Checks) == string(item.Checks) {
				continue
			}
			saved, err := q.SaveMythicalItem(ctx, next)
			if err != nil {
				return nil, err
			}
			if decision.Event == "in_review" {
				saved, err = q.PlaceMythicalItem(ctx, saved.ID, next.StackPosition.Int64)
				if err != nil {
					return nil, err
				}
			}
			if decision.Event != "" {
				data, _ := json.Marshal(map[string]any{"item": uuidString(item.ID), "n": mythicalItemNumber(item), "pr": pull.Number, "reason": next.Reason, "source": "github", "version": fetched.Version, "observation": fetched.PullObservation})
				if _, err := jobs.RecordFactInTx(ctx, tx, todoOperationScope(saved), uuid.NewString(), "todo.github_"+decision.Event, todoState(saved), data); err != nil {
					return nil, err
				}
			}
			if _, err := q.RequestMythicalStack(ctx, repository); err != nil {
				return nil, err
			}
			changed++
		}
	}
	return json.Marshal(map[string]int{"todos": changed})
}
