package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
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
		// Containment notes follow the pre-fold stack order, not UUID order.
		positionOf := func(item db.MythicalItem) int64 {
			if item.StackPosition.Valid {
				return item.StackPosition.Int64
			}
			return mythicalChecksOf(item).GitHubClosedPosition
		}
		sort.SliceStable(items, func(i, j int) bool {
			left, right := positionOf(items[i]), positionOf(items[j])
			if left == right {
				return mythicalItemNumber(items[i]) < mythicalItemNumber(items[j])
			}
			return left < right
		})
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
				fact.Manifest = checks.retainedManifest(pull.HeadSHA)
				for _, earlier := range items {
					position := earlier.StackPosition.Int64
					if !earlier.StackPosition.Valid {
						position = mythicalChecksOf(earlier).GitHubClosedPosition
					}
					identity := mythicalCandidateIdentity(earlier)
					containedDrop := false
					if (earlier.State == "cancelled" || earlier.State == "rejected" || earlier.State == "dropped") && fact.Manifest != nil {
						for _, included := range fact.Manifest.Included {
							if identity.ID == included.ID && identity.Head != "" && identity.Head == included.Head && identity.Change == included.Change {
								containedDrop = true
							}
						}
					}
					if earlier.ID != item.ID && (containedDrop || position > 0 && item.StackPosition.Valid && position < item.StackPosition.Int64) && earlier.State != "landed" && earlier.State != "merged" && earlier.State != "declined" {
						fact.Earlier = append(fact.Earlier, mythicalCandidateIdentity(earlier))
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
			if decision.Attention == "order" {
				if err := appendOrderAttention(ctx, tx, repository, OrderAttentionEntry{Pull: pull.Number, Commit: pull.MergeCommit, Text: decision.AttentionText}); err != nil {
					return nil, err
				}
				for i, contained := range decision.Contained {
					for _, earlier := range items {
						if uuidString(earlier.ID) != contained.ID {
							continue
						}
						if err := s.cancelAttempt(ctx, tx, stack, earlier); err != nil {
							return nil, err
						}
						folded := mythicalLanded(earlier, pull.MergeCommit, s.now())
						// The earlier PR did not merge; its keyed close obligation remains.
						folded.PRState = earlier.PRState
						folded.Reason = decision.Notes[i]
						foldChecks := mythicalChecksOf(folded)
						foldChecks.MergedVia = &mythicalMergedVia{Number: fact.Number, Pull: pull.Number, URL: pull.URL, Commit: pull.MergeCommit, Note: decision.Notes[i], At: s.now()}
						folded.Checks = foldChecks.encode()
						folded = mythicalDropObligation(folded)
						saved, err := q.SaveMythicalItem(ctx, folded)
						if err != nil {
							return nil, err
						}
						data, _ := json.Marshal(map[string]any{"item": contained.ID, "n": contained.Number, "pr": earlier.PRNumber.Int64, "reason": folded.Reason, "merged_via": foldChecks.MergedVia, "source": "github", "version": fetched.Version})
						if _, err := s.recordTodoFact(ctx, tx, saved, uuid.NewString(), "todo.github_merged", todoState(saved), data); err != nil {
							return nil, err
						}
						changed++
					}
				}
			}

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
				// Restoration keeps the accepted generation and pin, never a live
				// destination for input to the ended attempt. Retain its evidence
				// before clearing the binding; restart admission owns the next run.
				next.Checks = checks.encode()
				next = retainTodoAttemptEvidence(next)
				checks = mythicalChecksOf(next)
				next.RequestRunID, next.VibeRunID, next.VerifyRunID = "", "", ""
				checks.RunLaunched, checks.RunAttached = false, false
				next.State, next.PRState, next.Reason = "proposed", "open", ""
				checks.GitHubReopenedAttempt = item.Attempt
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
			if decision.Event == "dropped" {
				next = settleTodoAttemptEvidence(next, "dropped")
			}
			if decision.Event == "" && string(next.Checks) == string(item.Checks) {
				continue
			}
			if decision.Event == "in_review" {
				// Historical drops can retain a now-occupied slot. Move the
				// terminal row before reactivating the unique live position.
				placed, err := q.PlaceMythicalItem(ctx, next.ID, next.StackPosition.Int64)
				if err != nil {
					return nil, err
				}
				next.Version = placed.Version
			}
			saved, err := q.SaveMythicalItem(ctx, next)
			if err != nil {
				return nil, err
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
