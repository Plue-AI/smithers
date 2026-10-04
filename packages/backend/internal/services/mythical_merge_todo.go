package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// MythicalMergeInput is a person's press of Merge on a TODO in review: Head
// is the pull request head their card displayed, so a head that moved since
// is refused instead of merged unseen.
type MythicalMergeInput struct {
	Head string `json:"reviewed_head_sha"`
}

// mythicalLand is one Review & merge approval (spec §10.6.2c): a browser
// session's press for one generation at one PR head. Refused is the
// definitive refusal that cleared its merge fence; the approval stays as
// that receipt and is never retried until another press replaces it.
type mythicalLand struct {
	By         string                `json:"by"`
	Account    int64                 `json:"account"`
	Generation int64                 `json:"generation,omitempty"`
	Session    string                `json:"session,omitempty"`
	Head       string                `json:"head"`
	Refused    *mythicalMergeRefusal `json:"refused,omitempty"`
}

// mythicalMergeRefusal is the receipt of a refusal that cleared a merge
// fence: the §6.2.3 envelope as refused, GitHub's text verbatim.
type mythicalMergeRefusal struct {
	Code    string    `json:"code"`
	Class   string    `json:"class"`
	Message string    `json:"message"`
	At      time.Time `json:"at"`
}

var mythicalHead = regexp.MustCompile(`^[0-9a-f]{40}$`)

// mythicalMergeabilityReread is how long dispatch waits before reading a PR
// GitHub is still computing mergeability for a second time (§10.6.2b).
const mythicalMergeabilityReread = 2 * time.Second

// mythicalTerminalStates are the items that are merged or dropped: no later
// TODO waits on them (MergeReady row 2).
var mythicalTerminalStates = []string{"landed", "cancelled", "rejected", "declined"}

func mythicalReviewedHead(raw string) (string, error) {
	head := strings.ToLower(raw)
	if !mythicalHead.MatchString(head) {
		return "", &TodoControlError{Status: http.StatusBadRequest, Code: "invalid_reviewed_head_sha", Class: "user", Message: "reviewed_head_sha must be a 40-character hexadecimal commit SHA"}
	}
	return head, nil
}

func mythicalMergeConflict(code, message string) *TodoControlError {
	return &TodoControlError{Status: http.StatusConflict, Code: code, Class: "conflict", Message: message}
}

func mythicalGitHubBlock(message string) *TodoControlError {
	return &TodoControlError{Status: http.StatusConflict, Code: "github", Class: "github", Message: message}
}

// mergeSession reports a person's browser session: a signed-in account that
// is not an agent's, holding a session rather than a token. It is the one
// definition of who may press Merge.
func mergeSession(info *middleware.AuthInfo) bool {
	return info != nil && info.User != nil && !info.IsTokenAuth && info.SessionHash != "" && !info.IsAgent()
}

// MergeCredential refuses every credential but a person's browser session,
// before any read: no credential is unauthenticated, and a token, a run's or
// a machine's credential or an agent account is permission (§5.2.1, §5.3.2).
func MergeCredential(ctx context.Context) error {
	info := middleware.AuthInfoFromContext(ctx)
	switch {
	case info == nil || info.User == nil && !info.IsTokenAuth && info.SessionHash == "":
		return &TodoControlError{Status: http.StatusUnauthorized, Code: "unauthenticated", Class: "permission", Message: "Sign in to merge"}
	case !mergeSession(info):
		return &TodoControlError{Status: http.StatusForbidden, Code: "permission", Class: "permission", Message: "Merge requires an owner or maintainer browser session"}
	}
	return nil
}

// RequireMergeSession rejects non-session authority before readiness reads,
// and a session that is not userID's. The caller still checks current GitHub
// maintainer authority before approval.
func RequireMergeSession(ctx context.Context, userID int64) error {
	if err := MergeCredential(ctx); err != nil {
		return err
	}
	if info := middleware.AuthInfoFromContext(ctx); info.User.ID != userID {
		return &TodoControlError{Status: http.StatusForbidden, Code: "permission", Class: "permission", Message: "Merge requires an owner or maintainer browser session"}
	}
	return nil
}

// MergeTodo resolves a repository-local TODO number, never a GitHub issue
// number, and requests its merge.
func (s *MythicalService) MergeTodo(ctx context.Context, repositoryID, userID, number int64, input MythicalMergeInput) (MythicalItemView, error) {
	if err := RequireMergeSession(ctx, userID); err != nil {
		return MythicalItemView{}, err
	}
	head, err := mythicalReviewedHead(input.Head)
	if err != nil {
		return MythicalItemView{}, err
	}
	item, err := s.queries().GetMythicalItemByNumber(ctx, repositoryID, number)
	if errors.Is(err, pgx.ErrNoRows) {
		return MythicalItemView{}, &TodoControlError{Status: http.StatusNotFound, Code: "todo_not_found", Class: "user", Message: "TODO not found"}
	}
	if err != nil {
		return MythicalItemView{}, err
	}
	return s.merge(ctx, repositoryID, userID, item.ID, head)
}

// Merge is the same request for the item the repository door names.
func (s *MythicalService) Merge(ctx context.Context, repositoryID, userID int64, itemID string, input MythicalMergeInput) (MythicalItemView, error) {
	if err := RequireMergeSession(ctx, userID); err != nil {
		return MythicalItemView{}, err
	}
	head, err := mythicalReviewedHead(input.Head)
	if err != nil {
		return MythicalItemView{}, err
	}
	id, err := uuid.Parse(itemID)
	if err != nil {
		return MythicalItemView{}, pkgerrors.BadRequest("invalid item id")
	}
	return s.merge(ctx, repositoryID, userID, pgtype.UUID{Bytes: id, Valid: true}, head)
}

// merge records a person's Review & merge (§10.6.2b step 1): their current
// authority (mergeApprover, the rule dispatch applies again), MergeReady's
// PostgreSQL rows, then one transaction that locks the stack and records the
// approval with the merge fence, an intended outbound merge. The claimed
// stack worker rechecks live facts and sends the one squash merge; this
// request never calls GitHub's merge.
func (s *MythicalService) merge(ctx context.Context, repositoryID, userID int64, id pgtype.UUID, head string) (MythicalItemView, error) {
	session := middleware.AuthInfoFromContext(ctx).SessionHash
	item, err := s.queries().GetMythicalItem(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && item.RepositoryID != repositoryID {
		return MythicalItemView{}, &TodoControlError{Status: http.StatusNotFound, Code: "todo_not_found", Class: "user", Message: "TODO not found"}
	}
	if err != nil {
		return MythicalItemView{}, err
	}
	if s.github == nil {
		return MythicalItemView{}, &TodoControlError{Status: http.StatusServiceUnavailable, Code: "github_unavailable", Class: "infra", Message: "GitHub is not configured for this repository"}
	}
	approver, account, err := s.mergeApprover(ctx, repositoryID, session)
	if err != nil {
		return MythicalItemView{}, err
	}
	if approver.ID != userID {
		return MythicalItemView{}, mythicalMergeForbidden()
	}
	if mythicalMergeReplay(item, head, session) {
		return mythicalItemView(item), nil
	}
	before, err := mythicalMergeAfter(ctx, s.store, item)
	if err != nil {
		return MythicalItemView{}, err
	}
	if err := mythicalMergeReady(item, before, head, false); err != nil {
		return MythicalItemView{}, err
	}
	if err := s.mergeDispatchReady(ctx, item); err != nil {
		return MythicalItemView{}, err
	}
	var saved db.MythicalItem
	err = pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		var locked int64
		err := tx.QueryRow(ctx, `SELECT repository_id FROM mythical_stacks WHERE repository_id = $1 FOR UPDATE`, repositoryID).Scan(&locked)
		if errors.Is(err, pgx.ErrNoRows) {
			return &TodoControlError{Status: http.StatusServiceUnavailable, Code: "stack_unavailable", Class: "infra", Message: "Repository stack is not ready"}
		}
		if err != nil {
			return err
		}
		q := db.New(tx)
		current, err := q.GetMythicalItem(ctx, id)
		if err != nil {
			return err
		}
		if mythicalMergeReplay(current, head, session) {
			saved = current
			return nil
		}
		before, err := mythicalMergeAfter(ctx, tx, current)
		if err != nil {
			return err
		}
		if err := mythicalMergeReady(current, before, head, false); err != nil {
			return err
		}
		next := current
		checks := mythicalChecksOf(next)
		checks.Land = &mythicalLand{By: account.Login, Account: account.ID, Generation: current.Generation, Session: session, Head: head}
		next.Checks = checks.encode()
		next.PendingOp, _ = json.Marshal(MythicalOutboundOp{Kind: "merge", Target: strconv.FormatInt(current.PRNumber.Int64, 10), Desired: head, Precondition: "open", State: "intended"})
		next.NextAttemptAt = pgtype.Timestamptz{}
		saved, err = q.SaveMythicalItem(ctx, next)
		if errors.Is(err, pgx.ErrNoRows) {
			return mythicalMergeConflict("rechecking", "The TODO changed; review it again")
		}
		return err
	})
	if err != nil {
		return MythicalItemView{}, err
	}
	if stack, err := s.queries().GetMythicalStack(ctx, repositoryID); err == nil {
		s.itemChanged(ctx, s.queries(), stack, saved.ID)
	}
	return mythicalItemView(saved), nil
}

// mythicalMergeReplay reports a repeat of the press the fence already
// carries: the same session at the same head and generation. It answers
// that request again instead of a second fence.
func mythicalMergeReplay(item db.MythicalItem, head, session string) bool {
	land := mythicalChecksOf(item).Land
	op, _ := decodeMythicalOutbound(item.PendingOp)
	return mythicalMergeFenced(item) && op.Desired == head && land != nil && land.Refused == nil &&
		land.Session == session && land.Head == head && land.Generation == item.Generation
}

// mergeDispatchReady refuses a request no worker could act on: dispatch
// needs every outbound guard, the merge decision and the merge kind of
// lookup, send and settlement (EnableTodoPublication composes them).
func (s *MythicalService) mergeDispatchReady(ctx context.Context, item db.MythicalItem) error {
	if err := s.outboundReady(ctx, item, "merge"); err != nil {
		return mythicalMergeConflict("rechecking", err.Error())
	}
	if s.outbound.MergeDecision == nil || s.outbound.Lookup == nil || s.outbound.Send == nil || s.outbound.Settle == nil {
		return mythicalMergeConflict("rechecking", "Waiting for merge dispatch and reconciliation integration")
	}
	return nil
}

func mythicalMergeForbidden() *TodoControlError {
	return &TodoControlError{Status: http.StatusForbidden, Code: "permission", Class: "permission", Message: "Merge requires an owner or maintainer browser session"}
}

// mythicalAuthorityRefusal types maintainerPerson's refusals in the §6.2.3
// envelope; an outage stays an error, never a refusal.
func mythicalAuthorityRefusal(err error) error {
	var api *pkgerrors.APIError
	if errors.As(err, &api) && api.Status == http.StatusForbidden {
		return &TodoControlError{Status: http.StatusForbidden, Code: "permission", Class: "permission", Message: api.Message}
	}
	return err
}

func mythicalIsTodo(item db.MythicalItem) bool {
	checks := mythicalChecksOf(item)
	return checks.Todo || checks.AutoTodo != ""
}

// mythicalMergeAfter is the first unmerged TODO ahead of item in stack
// order (MergeReady row 2), or 0 when item is first.
func mythicalMergeAfter(ctx context.Context, conn db.DBTX, item db.MythicalItem) (int64, error) {
	if !item.StackPosition.Valid {
		return 0, nil
	}
	var number int64
	err := conn.QueryRow(ctx, `SELECT number FROM mythical_items
		WHERE repository_id = $1 AND stack_position < $2 AND state <> ALL($3) AND id <> $4
		  AND (checks->>'todo' = 'true' OR COALESCE(checks->>'autoTodo', '') <> '')
		ORDER BY stack_position LIMIT 1`, item.RepositoryID, item.StackPosition.Int64, mythicalTerminalStates, item.ID).Scan(&number)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return number, err
}

// mythicalMergeReady is MergeReady's PostgreSQL rows (§10.6.2a) for the
// reviewed head, against the last synced PR head: the first failing row's
// refusal, nil when each holds. before is mythicalMergeAfter; fenced admits
// the item's own merge fence, under which dispatch rechecks.
func mythicalMergeReady(item db.MythicalItem, before int64, head string, fenced bool) error {
	switch {
	case !mythicalIsTodo(item):
		return mythicalMergeConflict("state", "only a TODO can merge")
	case item.PRState == "closed":
		return mythicalMergeConflict("state", "PR is closed on GitHub")
	case item.State != "proposed" || !item.PRNumber.Valid || item.PRState != "open" && item.PRState != "" || todoState(item) != "in_review" || mythicalChecksOf(item).ForeignHead != "":
		return mythicalMergeConflict("state", "only a TODO in review can merge")
	case before > 0:
		return mythicalMergeConflict("order", fmt.Sprintf("Merges after T%d", before))
	case mythicalMergeFenced(item) && !fenced:
		return mythicalMergeConflict("merging", "A merge is in flight")
	case len(item.PendingOp) > 0 && !mythicalMergeFenced(item):
		return mythicalMergeConflict("rechecking", "Waiting for the TODO's pull request push to settle")
	case !item.CandidateVerified || item.PRHead == "":
		return mythicalMergeConflict("rechecking", "Waiting for the TODO's accepted pull request head")
	case head != item.PRHead:
		return &MythicalStaleHeadError{TodoControlError: *mythicalMergeConflict("stale_head", "the pull request changed since you saw it"), CurrentHead: item.PRHead}
	}
	return nil
}

// MythicalStaleHeadError supplies the current persisted head without replacing
// the head the person reviewed. A retry requires another review.
type MythicalStaleHeadError struct {
	TodoControlError
	CurrentHead string `json:"current_head_sha"`
}

func (e *MythicalStaleHeadError) Unwrap() error { return &e.TodoControlError }

// todoMerge is the card's merge block (§10.6.2a merge_block) from the same
// rows as the route, on synced facts: done once merged, merging under the
// fence, a retained refusal of the current approval, then the first failing
// row. A refusal of the approving person blocks no one else's press: the
// block stays ready and its detail says why that press did not merge. Live
// required checks, reviews and mergeability are read at dispatch only;
// until T-GH-03 syncs them, ready rests on the PostgreSQL rows.
func (s *MythicalService) todoMerge(ctx context.Context, item db.MythicalItem) (map[string]any, error) {
	block := map[string]any{"on_github": item.PRNumber.Valid}
	land := mythicalChecksOf(item).Land
	switch {
	case item.State == "landed":
		block["state"] = "done"
		return block, nil
	case item.State == "proposed" && mythicalMergeFenced(item):
		block["state"], block["reason"] = "merging", "merging"
		return block, nil
	case land != nil && land.Refused != nil && land.Head == item.PRHead && land.Generation == item.Generation && mythicalMergeReason(land.Refused.Code) != "":
		block["state"], block["reason"], block["detail"] = "blocked", mythicalMergeReason(land.Refused.Code), land.Refused.Message
		return block, nil
	}
	before, err := mythicalMergeAfter(ctx, s.store, item)
	if err != nil {
		return nil, err
	}
	var refusal *TodoControlError
	if err := mythicalMergeReady(item, before, item.PRHead, false); !errors.As(err, &refusal) {
		block["state"] = "ready"
		if land != nil && land.Refused != nil && land.Head == item.PRHead && land.Generation == item.Generation {
			block["detail"] = land.Refused.Message
		}
		return block, nil
	}
	block["state"], block["reason"] = "waiting", refusal.Code
	if refusal.Code == "order" {
		block["detail"] = strings.TrimPrefix(refusal.Message, "Merges after ")
	}
	return block, nil
}

func mythicalMergeFenced(item db.MythicalItem) bool {
	op, err := decodeMythicalOutbound(item.PendingOp)
	return len(item.PendingOp) > 0 && err == nil && op.Kind == "merge"
}

// mythicalMergeReason is the merge_block reason a retained refusal shows:
// GitHub's own refusal is the github row. A refusal of the approving person
// blocks nothing: another person's press is decided afresh.
func mythicalMergeReason(code string) string {
	switch code {
	case "state", "order", "attention", "merging", "rechecking", "pending_work", "stale_head", "checks", "review_required", "github":
		return code
	case "github_refused":
		return "github"
	}
	return ""
}

// mythicalMergeNumber is the pull request a merge operation names, refused
// unless it is the item's own.
func mythicalMergeNumber(item db.MythicalItem, op MythicalOutboundOp) (int64, error) {
	number, err := strconv.ParseInt(op.Target, 10, 64)
	if err != nil || number <= 0 || !item.PRNumber.Valid || number != item.PRNumber.Int64 {
		return 0, errors.New("merge operation names another pull request")
	}
	return number, nil
}

// mergeGitHub resolves the stack's GitHub destination for item.
func (s *MythicalService) mergeGitHub(ctx context.Context, item db.MythicalItem, op MythicalOutboundOp) (mythicalGitHubRepo, int64, error) {
	if s.github == nil {
		return mythicalGitHubRepo{}, 0, errors.New("GitHub is not configured for the mythical stack")
	}
	number, err := mythicalMergeNumber(item, op)
	if err != nil {
		return mythicalGitHubRepo{}, 0, err
	}
	gh, err := s.stackGitHub(ctx, item.RepositoryID)
	return gh, number, err
}

// MergeDecision is DecideMerge at dispatch and recovery (§10.6.2b step 2),
// installed as the outbound MergeDecision provider: the approval the fence
// carries, its person's current authority, MergeReady's PostgreSQL rows under
// the item's own fence, then GitHub's live head, checks and mergeability. A
// *TodoControlError is definitive: the worker clears the fence and keeps it
// on the approval. Any other error keeps the fence for the next pass.
func (s *MythicalService) MergeDecision(ctx context.Context, item db.MythicalItem, op MythicalOutboundOp) error {
	land := mythicalChecksOf(item).Land
	if op.Kind != "merge" || land == nil || land.Session == "" || land.Refused != nil || land.Head != op.Desired || land.Generation != item.Generation {
		return mythicalMergeConflict("rechecking", "The merge approval no longer matches this TODO; review it again")
	}
	if err := s.mergeAuthority(ctx, item, *land); err != nil {
		return err
	}
	before, err := mythicalMergeAfter(ctx, s.store, item)
	if err != nil {
		return err
	}
	if err := mythicalMergeReady(item, before, op.Desired, true); err != nil {
		return err
	}
	gh, number, err := s.mergeGitHub(ctx, item, op)
	if err != nil {
		return err
	}
	return s.mergeLive(ctx, gh, number, op.Desired)
}

// mergeAuthority rechecks the approving person now (§10.6.2b) with the rule
// the press applied, and that their GitHub account is still the one that
// approved. A stored approval is never current authorization by itself.
func (s *MythicalService) mergeAuthority(ctx context.Context, item db.MythicalItem, land mythicalLand) error {
	_, account, err := s.mergeApprover(ctx, item.RepositoryID, land.Session)
	if err != nil {
		return err
	}
	if account.ID != land.Account {
		return &TodoControlError{Status: http.StatusForbidden, Code: "permission", Class: "permission", Message: "The GitHub account that approved this merge is no longer this person's"}
	}
	return nil
}

// mergeApprover is the one authority rule for a merge, applied at the press
// and again at dispatch, so a press is never accepted that dispatch must
// refuse: the browser session stored under sessionKey is live, its person is
// the install's owner (the only member a self-hosted install has before
// M-17), and GitHub and the factory's policy count their account a
// maintainer now. A session filed before keys were hashed at rest is not
// found under its digest, at the press as at dispatch: it signs in again.
func (s *MythicalService) mergeApprover(ctx context.Context, repositoryID int64, sessionKey string) (db.User, gitHubActor, error) {
	q := s.queries()
	ended := &TodoControlError{Status: http.StatusUnauthorized, Code: "unauthenticated", Class: "permission", Message: "The approving browser session has ended; sign in again to merge"}
	if sessionKey == "" {
		return db.User{}, gitHubActor{}, ended
	}
	session, err := q.GetAuthSessionBySessionKey(ctx, sessionKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.User{}, gitHubActor{}, ended
	}
	if err != nil {
		return db.User{}, gitHubActor{}, err
	}
	user, err := q.GetUserByID(ctx, session.UserID)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (!session.ExpiresAt.After(s.now()) || !user.IsActive || user.ProhibitLogin || user.DeletedAt.Valid) {
		return db.User{}, gitHubActor{}, ended
	}
	if err != nil {
		return db.User{}, gitHubActor{}, err
	}
	owner, err := q.GetSelfHostOwner(ctx)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && owner.ID != user.ID {
		return db.User{}, gitHubActor{}, mythicalMergeForbidden()
	}
	if err != nil {
		return db.User{}, gitHubActor{}, err
	}
	_, account, err := s.maintainerPerson(ctx, repositoryID, user.ID, "merge a TODO")
	if err != nil {
		return db.User{}, gitHubActor{}, mythicalAuthorityRefusal(err)
	}
	return user, account, nil
}

// mergeLive is MergeReady rows 8-9 on GitHub's live facts: the PR is open at
// the reviewed head, its required checks pass there, main's required reviews
// are satisfied, it is not draft and GitHub affirmatively reports it
// mergeable. GitHub still computing mergeability is read once more after two
// seconds, and rows 8-9 are evaluated again against that read.
func (s *MythicalService) mergeLive(ctx context.Context, gh mythicalGitHubRepo, number int64, head string) error {
	pull, err := s.github.Pull(ctx, gh, number)
	if err != nil {
		return err
	}
	for reread := false; ; reread = true {
		switch {
		case pull.Merged:
			// Lookup settles a PR GitHub reports merged; never a second PUT.
			return errors.New("GitHub reports the pull request merged; settling it")
		case pull.State != "open":
			return mythicalMergeConflict("state", "PR is closed on GitHub")
		case pull.HeadSHA != head:
			return &MythicalStaleHeadError{TodoControlError: *mythicalMergeConflict("stale_head", "the pull request changed since you saw it"), CurrentHead: pull.HeadSHA}
		}
		if err := s.mergeChecks(ctx, gh, head); err != nil {
			return err
		}
		if err := s.mergeReviews(ctx, gh, number); err != nil {
			return err
		}
		if pull.Draft {
			return mythicalGitHubBlock("PR is still draft on GitHub")
		}
		switch pull.MergeableState {
		case "clean", "unstable", "has_hooks":
			return nil
		case "", "unknown":
			if reread {
				return mythicalGitHubBlock("GitHub is still computing mergeability")
			}
		default:
			return mythicalGitHubBlock("GitHub reports this PR is not mergeable")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(mythicalMergeabilityReread):
		}
		if pull, err = s.github.Pull(ctx, gh, number); err != nil {
			return err
		}
	}
}

// mergeChecks refuses at the first required check, by name, that is not
// green on head; a failing optional check does not block.
func (s *MythicalService) mergeChecks(ctx context.Context, gh mythicalGitHubRepo, head string) error {
	facts, err := s.github.HeadCheckFacts(ctx, gh, head)
	if err != nil {
		return err
	}
	sort.SliceStable(facts, func(i, j int) bool { return facts[i].Name < facts[j].Name })
	for _, fact := range facts {
		if fact.Required && fact.State != mythicalCIGreen {
			return mythicalMergeConflict("checks", fact.Name)
		}
	}
	return nil
}

// mergeReviews refuses while GitHub's own review decision for the PR is not
// approved under main's required reviews (code owners and rulesets
// included); GitHub answers no decision when main requires no review.
func (s *MythicalService) mergeReviews(ctx context.Context, gh mythicalGitHubRepo, number int64) error {
	decision, err := s.github.ReviewDecision(ctx, gh, number)
	if err != nil {
		return err
	}
	if decision != "" && decision != "APPROVED" {
		return mythicalMergeConflict("review_required", "Required reviews are not satisfied on GitHub")
	}
	return nil
}

// mergeLookup is appLookup's merge kind: GitHub reporting the PR merged is
// the desired effect, whoever merged it; anything else leaves the
// precondition, so the next send waits for a fresh MergeDecision.
func (s *MythicalService) mergeLookup(ctx context.Context, gh mythicalGitHubRepo, item db.MythicalItem, op MythicalOutboundOp) (string, bool, error) {
	number, err := mythicalMergeNumber(item, op)
	if err != nil {
		return "", false, err
	}
	pull, err := s.github.Pull(ctx, gh, number)
	if err != nil {
		return "", false, err
	}
	if pull.Merged {
		return op.Desired, false, nil
	}
	return op.Precondition, false, nil
}

// mergeSend is appSend's merge kind: GitHub's squash merge with sha = the
// reviewed head through the install's App. A refusal GitHub states (405,
// 409, 422) is definitive with GitHub's text verbatim, unless the PR turns
// out to be merged already; any other failure is unknown, and lookup decides
// on the next pass.
func (s *MythicalService) mergeSend(ctx context.Context, gh mythicalGitHubRepo, item db.MythicalItem, op MythicalOutboundOp) error {
	number, err := mythicalMergeNumber(item, op)
	if err != nil {
		return err
	}
	_, err = s.github.Merge(ctx, gh, number, op.Desired)
	var refusal *GitHubRefusal
	if errors.As(err, &refusal) {
		pull, lookup := s.github.Pull(ctx, gh, number)
		if lookup != nil {
			return lookup
		}
		if !pull.Merged {
			return &TodoControlError{Status: refusal.Status, Code: "github_refused", Class: "github", Message: refusal.Message}
		}
	} else if err != nil {
		return err
	}
	// GitHub's main moved: the next pass confirms the merge and settles it.
	s.MainMoved(ctx, item.RepositoryID)
	return nil
}

// mergeSettle is appSettle's merge kind: the TODO is Merged only once GitHub
// reports the merge and its main contains the merge commit, the same
// containment decision polling makes. Until then the fence stays.
func (s *MythicalService) mergeSettle(ctx context.Context, gh mythicalGitHubRepo, item db.MythicalItem, op MythicalOutboundOp) (db.MythicalItem, error) {
	if item.State == "landed" {
		return item, nil
	}
	number, err := mythicalMergeNumber(item, op)
	if err != nil {
		return item, err
	}
	pull, err := s.github.Pull(ctx, gh, number)
	if err != nil {
		return item, err
	}
	fact := mythicalGitHubFact{Kind: "merged", Head: pull.HeadSHA, MergeCommit: pull.MergeCommit}
	if pull.Merged && pull.MergeCommit != "" {
		if fact.OnMain, err = s.github.OnMain(ctx, gh, "main", pull.MergeCommit); err != nil {
			return item, err
		}
	}
	if decision := decideGitHubFact(fact, mythicalGitHubFactItem{State: item.State, Head: item.PRHead}, s.now()); !pull.Merged || decision.Event != "merged" {
		return item, fmt.Errorf("waiting for main to contain the merge of pull request %d", number)
	}
	return mythicalLanded(item, pull.MergeCommit, s.now()), nil
}

// refuseMerge settles a definitive refusal (§10.6.2b-c): the fence clears,
// the approval stays with the refusal as its receipt and the card shows it
// until another press. Any other error leaves the fence for lookup.
func (st *mythicalItemStep) refuseMerge(ctx context.Context, item db.MythicalItem, op MythicalOutboundOp, err error) (*db.MythicalItem, error) {
	var refusal *TodoControlError
	if !errors.As(err, &refusal) {
		return nil, err
	}
	next := item
	checks := mythicalChecksOf(next)
	if checks.Land != nil && checks.Land.Head == op.Desired {
		checks.Land.Refused = &mythicalMergeRefusal{Code: refusal.Code, Class: refusal.Class, Message: refusal.Message, At: st.now}
	}
	next.Checks = checks.encode()
	next.PendingOp = nil
	saved, err := st.q.SaveMythicalItemUnderLease(ctx, next, st.r.row.Claim)
	if err != nil {
		return nil, err
	}
	st.s.notify(ctx, st.q, st.r.row.RepositoryID, st.r.row.Generation, "item", uuidString(saved.ID))
	return &saved, nil
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
