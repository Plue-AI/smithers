package services

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// MythicalMergeInput is a maintainer's press of Merge on a proposed TODO:
// Head is the pull request head they saw, so a head that moved since is
// refused instead of landed unseen.
type MythicalMergeInput struct {
	Head string `json:"reviewed_head_sha"`
}

// mythicalLand is a maintainer person's request, made through Smithers, that
// the stack merge a TODO's pull request at one head: the automerge label the
// App applies for them is theirs while this names the head the stack merges.
type mythicalLand struct {
	By         string `json:"by"`
	Account    int64  `json:"account"`
	Generation int64  `json:"generation,omitempty"`
	Session    string `json:"session,omitempty"`
	Head       string `json:"head"`
}

var mythicalHead = regexp.MustCompile(`^[0-9a-f]{40}$`)

// Merge records a browser-session maintainer's request at the displayed PR
// head under the existing item CAS and wakes the stack worker. The route never
// sends a merge PUT; dispatch remains subject to the worker's outbound gate.
func (s *MythicalService) Merge(ctx context.Context, repositoryID, userID int64, itemID string, input MythicalMergeInput) (MythicalItemView, error) {
	if err := RequireMergeSession(ctx, userID); err != nil {
		return MythicalItemView{}, err
	}
	info := middleware.AuthInfoFromContext(ctx)
	input.Head = strings.ToLower(input.Head)
	id, err := uuid.Parse(itemID)
	if err != nil {
		return MythicalItemView{}, pkgerrors.BadRequest("invalid item id")
	}
	if !mythicalHead.MatchString(input.Head) {
		return MythicalItemView{}, &TodoControlError{Status: http.StatusBadRequest, Code: "invalid_reviewed_head_sha", Class: "user", Message: "reviewed_head_sha must be a 40-character hexadecimal commit SHA"}
	}
	if s.github == nil {
		return MythicalItemView{}, pkgerrors.Internal("GitHub is not configured for the mythical stack")
	}
	gh, account, err := s.maintainerPerson(ctx, repositoryID, userID, "merge a TODO")
	if err != nil {
		return MythicalItemView{}, err
	}
	q := s.queries()
	item, err := q.GetMythicalItem(ctx, pgtype.UUID{Bytes: id, Valid: true})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && item.RepositoryID != repositoryID) {
		return MythicalItemView{}, pkgerrors.NotFound("item not found")
	}
	if err != nil {
		return MythicalItemView{}, err
	}
	if err := mythicalMergeable(item, input.Head); err != nil {
		return MythicalItemView{}, err
	}
	// The label first: its event, whenever it arrives, finds the item as
	// it was, and the record below keeps automerge on while it stays.
	if err := s.github.AddLabel(ctx, gh, item.IssueNumber.Int64, automergeLabel); err != nil {
		return MythicalItemView{}, err
	}
	for range 3 {
		item, err := q.GetMythicalItem(ctx, pgtype.UUID{Bytes: id, Valid: true})
		if err != nil {
			return MythicalItemView{}, err
		}
		if err := mythicalMergeable(item, input.Head); err != nil {
			return MythicalItemView{}, err
		}
		next := item
		checks := mythicalChecksOf(next)
		checks.Automerge = true
		checks.Land = &mythicalLand{By: account.Login, Account: account.ID, Head: input.Head, Generation: item.Generation, Session: info.SessionHash}
		next.Checks = checks.encode()
		// The gate runs on the next pass, not the next poll.
		next.NextAttemptAt = pgtype.Timestamptz{}
		saved, err := q.SaveMythicalItem(ctx, next)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return MythicalItemView{}, err
		}
		if stack, err := q.GetMythicalStack(ctx, repositoryID); err == nil {
			s.itemChanged(ctx, q, stack, saved.ID)
		}
		return mythicalItemView(saved), nil
	}
	return MythicalItemView{}, pkgerrors.Conflict("the item kept changing; try again")
}

// mythicalMergeable refuses what Merge cannot ask for: anything but a TODO
// whose pull request is open at the head the person saw.
func mythicalMergeable(item db.MythicalItem, head string) error {
	checks := mythicalChecksOf(item)
	switch {
	case item.Source != "issue" || !item.IssueNumber.Valid || !checks.Todo && checks.AutoTodo == "":
		return pkgerrors.Conflict("only a TODO can merge")
	case item.State != "proposed" || !item.PRNumber.Valid || item.PRState != "open" && item.PRState != "":
		return pkgerrors.Conflict("only a TODO with an open pull request can merge")
	case checks.ForeignHead != "":
		return pkgerrors.Conflict("someone else pushed to this pull request; a person decides on GitHub")
	case len(item.PendingOp) > 0:
		return &TodoControlError{Status: http.StatusConflict, Code: "merging", Class: "conflict", Message: "A GitHub operation is in flight"}
	case item.PRHead != head:
		return &MythicalStaleHeadError{TodoControlError: TodoControlError{Status: http.StatusConflict, Code: "stale_head", Class: "conflict", Message: "the pull request changed since you saw it"}, CurrentHead: item.PRHead}
	}
	return nil
}

// maintainerPerson is the person userID as GitHub knows them now, when the
// repository's policy names them (or names no one) and GitHub counts them a
// maintainer; anything else is refused before GitHub is written.
func (s *MythicalService) maintainerPerson(ctx context.Context, repositoryID, userID int64, act string) (mythicalGitHubRepo, gitHubActor, error) {
	accountID, err := s.personGitHubID(ctx, userID, act)
	if err != nil {
		return mythicalGitHubRepo{}, gitHubActor{}, err
	}
	gh, err := s.stackGitHub(ctx, repositoryID)
	if err != nil {
		return mythicalGitHubRepo{}, gitHubActor{}, err
	}
	policy, err := s.stackPolicy(ctx, repositoryID)
	if err != nil {
		return mythicalGitHubRepo{}, gitHubActor{}, err
	}
	account, err := s.github.Account(ctx, gh, accountID)
	if err != nil {
		return mythicalGitHubRepo{}, gitHubActor{}, err
	}
	if account.ID != accountID || !policy.maintains(account.Login) {
		return mythicalGitHubRepo{}, gitHubActor{}, pkgerrors.Forbidden("only a maintainer the factory's policy names may " + act)
	}
	if maintainer, err := s.github.Maintainer(ctx, gh, account); err != nil {
		return mythicalGitHubRepo{}, gitHubActor{}, err
	} else if !maintainer {
		return mythicalGitHubRepo{}, gitHubActor{}, pkgerrors.Forbidden("only a maintainer of " + gh.Owner + "/" + gh.Name + " on GitHub may " + act)
	}
	return gh, account, nil
}

// landedByMaintainer reports whether an automerge label the App applied is a
// maintainer's merge approval for the head the stack is about to merge: recorded for
// exactly that head, by a person the policy still names and, with no list,
// GitHub still counts a maintainer.
func (st *mythicalItemStep) landedByMaintainer(ctx context.Context, item db.MythicalItem, applier *mythicalLabelApplier, policy factoryGitHubPolicy) (bool, error) {
	land := mythicalChecksOf(item).Land
	if land == nil || land.Head != item.PRHead || land.Generation != 0 && land.Generation != item.Generation || !applier.present() || !applier.ViaApp || !policy.maintains(land.By) {
		return false, nil
	}

	account, err := st.s.github.Account(ctx, *st.gh, land.Account)
	if err != nil {
		return false, err
	}
	if account.ID != land.Account || account.Login != land.By {
		return false, nil
	}
	return st.s.github.Maintainer(ctx, *st.gh, account)
}

// RequireMergeSession rejects non-session authority before readiness reads.
// The caller still checks current GitHub maintainer authority before approval.
func RequireMergeSession(ctx context.Context, userID int64) error {
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || info.User == nil || info.User.ID != userID || info.IsTokenAuth || info.SessionHash == "" || info.IsAgent() {
		return &TodoControlError{Status: http.StatusForbidden, Code: "permission", Class: "permission", Message: "Merge requires an owner or maintainer browser session"}
	}
	return nil
}

// MergeTodo resolves a repository-local TODO number, never a GitHub issue
// number. Missing production dispatch dependencies refuse before approval.
func (s *MythicalService) MergeTodo(ctx context.Context, repositoryID, userID, number int64, input MythicalMergeInput) (MythicalItemView, error) {
	if err := RequireMergeSession(ctx, userID); err != nil {
		return MythicalItemView{}, err
	}
	input.Head = strings.ToLower(input.Head)
	if !mythicalHead.MatchString(input.Head) {
		return MythicalItemView{}, &TodoControlError{Status: 400, Code: "invalid_reviewed_head_sha", Class: "user", Message: "reviewed_head_sha must be a 40-character hexadecimal commit SHA"}
	}
	item, err := s.queries().GetMythicalItemByNumber(ctx, repositoryID, number)
	if errors.Is(err, pgx.ErrNoRows) {
		return MythicalItemView{}, &TodoControlError{Status: 404, Code: "todo_not_found", Class: "user", Message: "TODO not found"}
	}
	if err != nil {
		return MythicalItemView{}, err
	}
	if err := mythicalMergeable(item, input.Head); err != nil {
		return MythicalItemView{}, err
	}
	if err := s.outboundReady(ctx, item, "merge"); err != nil {
		return MythicalItemView{}, &TodoControlError{Status: 409, Code: "rechecking", Class: "conflict", Message: err.Error()}
	}
	if s.outbound.MergeDecision == nil || s.outbound.Lookup == nil || s.outbound.Send == nil || s.outbound.Settle == nil {
		return MythicalItemView{}, &TodoControlError{Status: 409, Code: "rechecking", Class: "conflict", Message: "Waiting for merge dispatch and reconciliation integration"}
	}
	return s.Merge(ctx, repositoryID, userID, uuid.UUID(item.ID.Bytes).String(), input)
}

// MythicalStaleHeadError supplies the current persisted head without replacing
// the head the person reviewed. A retry requires another review.
type MythicalStaleHeadError struct {
	TodoControlError
	CurrentHead string `json:"current_head_sha"`
}

func (e *MythicalStaleHeadError) Unwrap() error { return &e.TodoControlError }
