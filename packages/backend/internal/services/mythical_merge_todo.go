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
// is refused instead of merged unseen. Request is the press's
// Idempotency-Key (§6.2.1): the same request again answers its receipt.
type MythicalMergeInput struct {
	Head    string `json:"reviewed_head_sha"`
	Request string `json:"-"`
}

// mythicalLand is one Review & merge approval (spec §10.6.2c): a browser
// session's press for one generation at one PR head, at At. Refused is the
// refusal that cleared its merge fence; the approval stays as that receipt
// and is never retried until another press replaces it.
type mythicalLand struct {
	By         string    `json:"by"`
	Account    int64     `json:"account"`
	Generation int64     `json:"generation,omitempty"`
	Session    string    `json:"session,omitempty"`
	Head       string    `json:"head"`
	At         time.Time `json:"at"`
	// Request is the Idempotency-Key of the press that recorded it.
	Request string                `json:"request,omitempty"`
	Refused *mythicalMergeRefusal `json:"refused,omitempty"`
}

// mythicalMergeRequest is one accepted press's identity (§6.2.1), kept on
// the TODO it approved: the session's Idempotency-Key, the generation and
// the reviewed head. A retry of it answers its receipt and never records
// another approval; a renewed approval needs a new key.
type mythicalMergeRequest struct {
	Session    string `json:"session"`
	Request    string `json:"request"`
	Generation int64  `json:"generation"`
	Head       string `json:"head"`
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

// mythicalMergeExpiry bounds a merge that neither completes nor is refused:
// once this long has passed since its approval, a merge GitHub has not
// received is not sent; its fence clears with a receipt asking for another
// press.
const mythicalMergeExpiry = 10 * time.Minute

// mythicalMergeFactsBound bounds GitHub's facts at the claim. They cannot
// be locked, so a claim whose locks are all held more than this long after
// the decision's last read of GitHub sends nothing; the next pass reads
// GitHub again (§10.6.2b).
const mythicalMergeFactsBound = 5 * time.Second

// errMythicalMergedOnGitHub is GitHub reporting the pull request merged
// while a merge is decided: lookup settles it, never a second merge.
var errMythicalMergedOnGitHub = errors.New("GitHub reports the pull request merged; settling it")

// errMythicalMergeFactsAged is a claim past mythicalMergeFactsBound, and
// errMythicalMergeBindingMoved one whose repository changed its GitHub
// destination or App since the merge was prepared. Neither refuses: the
// fence stays and the next pass decides again.
var (
	errMythicalMergeFactsAged    = errors.New("GitHub's merge facts are older than the claim allows; deciding the merge again")
	errMythicalMergeBindingMoved = errors.New("the repository's GitHub destination or App changed; deciding the merge again")
)

// mythicalMergeDecided is what a merge decision read on GitHub that its
// claim checks again: the approver's account as GitHub names it (the
// policy names logins), and when GitHub was last read.
type mythicalMergeDecided struct {
	account gitHubActor
	read    time.Time
}

// mythicalMergeBinding is where a merge goes and through what: the stack's
// account, the repository and its owner, its GitHub destination, the App
// installation serving it and the App. The merge's token is minted for it
// before the claim, which resolves it again under its locks.
type mythicalMergeBinding struct {
	actor, repoUser, repoOrg int64
	owner, name              string
	githubOwner, githubRepo  string
	installation, app        int64
}

// mythicalMergeDispatch is a merge made ready before its claim: the binding
// it was prepared for, and send, its request alone.
type mythicalMergeDispatch struct {
	binding mythicalMergeBinding
	send    func(context.Context, db.MythicalItem) error
}

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

// MergeCredential refuses every credential but a person's own browser
// session, before any read (§5.2.1, §5.3.2): no credential is
// unauthenticated; a request an in-app agent makes with the person's
// session (via, the Smithers-Via header) is never, only a person merges;
// a token, a run's or a machine's credential or an agent account is
// permission.
func MergeCredential(ctx context.Context, via string) error {
	info := middleware.AuthInfoFromContext(ctx)
	switch {
	case info == nil || info.User == nil && !info.IsTokenAuth && info.SessionHash == "":
		return &TodoControlError{Status: http.StatusUnauthorized, Code: "unauthenticated", Class: "permission", Message: "Sign in to merge"}
	case strings.TrimSpace(via) != "":
		return &TodoControlError{Status: http.StatusForbidden, Code: "never", Class: "never", Message: "Only a person can do this"}
	case !mergeSession(info):
		return &TodoControlError{Status: http.StatusForbidden, Code: "permission", Class: "permission", Message: "Merge requires an owner or maintainer browser session"}
	}
	return nil
}

// RequireMergeSession rejects non-session authority before readiness reads,
// and a session that is not userID's. The caller still checks current GitHub
// maintainer authority before approval.
func RequireMergeSession(ctx context.Context, userID int64) error {
	if err := MergeCredential(ctx, ""); err != nil {
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
	return s.requestMerge(ctx, repositoryID, userID, input, func(q *db.Queries) (db.MythicalItem, error) {
		return q.GetMythicalItemByNumber(ctx, repositoryID, number)
	})
}

// Merge is the same request for the item the repository door names.
func (s *MythicalService) Merge(ctx context.Context, repositoryID, userID int64, itemID string, input MythicalMergeInput) (MythicalItemView, error) {
	return s.requestMerge(ctx, repositoryID, userID, input, func(q *db.Queries) (db.MythicalItem, error) {
		id, err := uuid.Parse(itemID)
		if err != nil {
			return db.MythicalItem{}, &TodoControlError{Status: http.StatusBadRequest, Code: "invalid_todo", Class: "user", Message: "Invalid TODO id"}
		}
		item, err := q.GetMythicalItem(ctx, pgtype.UUID{Bytes: id, Valid: true})
		if err == nil && item.RepositoryID != repositoryID {
			return db.MythicalItem{}, pgx.ErrNoRows
		}
		return item, err
	})
}

// requestMerge records a person's Review & merge (§10.6.2b step 1) behind
// both doors, in one order: the browser-session credential; the person's
// standing (a live session, the install owner) before the request's fields
// or the TODO are read; the reviewed head and Idempotency-Key; the TODO; a
// repeat of an accepted request, answered with its receipt; the person's
// whole authority (mergeApprover, the rule dispatch applies again);
// MergeReady's PostgreSQL rows; GitHub's live pull request (row 8); then one
// transaction that locks the stack, decides the repeat and the rows again,
// requires every dispatch provider, and records the approval, its request
// identity and the merge fence. The claimed stack worker rechecks live facts
// and sends the one squash merge; this request never calls GitHub's merge.
func (s *MythicalService) requestMerge(ctx context.Context, repositoryID, userID int64, input MythicalMergeInput, find func(*db.Queries) (db.MythicalItem, error)) (MythicalItemView, error) {
	if err := RequireMergeSession(ctx, userID); err != nil {
		return MythicalItemView{}, err
	}
	session := middleware.AuthInfoFromContext(ctx).SessionHash
	if person, err := s.mergePerson(ctx, session); err != nil {
		return MythicalItemView{}, err
	} else if person != userID {
		return MythicalItemView{}, mythicalMergeForbidden()
	}
	head, err := mythicalReviewedHead(input.Head)
	if err != nil {
		return MythicalItemView{}, err
	}
	if input.Request == "" || len(input.Request) > 256 {
		return MythicalItemView{}, &TodoControlError{Status: http.StatusBadRequest, Code: "idempotency_key_required", Class: "user", Message: "Idempotency-Key is required"}
	}
	item, err := find(s.queries())
	if errors.Is(err, pgx.ErrNoRows) {
		return MythicalItemView{}, &TodoControlError{Status: http.StatusNotFound, Code: "todo_not_found", Class: "user", Message: "TODO not found"}
	}
	if err != nil {
		return MythicalItemView{}, err
	}
	if s.github == nil {
		return MythicalItemView{}, &TodoControlError{Status: http.StatusServiceUnavailable, Code: "github_unavailable", Class: "infra", Message: "GitHub is not configured for this repository"}
	}
	approver, account, gh, err := s.mergeApprover(ctx, repositoryID, session)
	if err != nil {
		return MythicalItemView{}, err
	}
	if approver != userID {
		return MythicalItemView{}, mythicalMergeForbidden()
	}
	if prior, err := s.queries().GetMythicalRequest(ctx, repositoryID, session, input.Request); err == nil {
		if err := mythicalMergeRepeat(prior, item.ID, session, input.Request, head); err != nil {
			return MythicalItemView{}, err
		}
		return mythicalItemView(prior), nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return MythicalItemView{}, err
	}
	before, err := mythicalMergeAfter(ctx, s.store, item)
	if err != nil {
		return MythicalItemView{}, err
	}
	if err := mythicalMergeReady(item, before, head, false); err != nil {
		return MythicalItemView{}, err
	}
	pull, err := s.github.Pull(ctx, gh, item.PRNumber.Int64)
	if err != nil {
		return MythicalItemView{}, mythicalMergeConflict("rechecking", "Waiting for fresh GitHub merge facts")
	}
	if err := mythicalMergeOnGitHub(pull, head); errors.Is(err, errMythicalMergedOnGitHub) {
		return MythicalItemView{}, mythicalMergeConflict("rechecking", "GitHub reports the pull request merged; waiting for main to contain it")
	} else if err != nil {
		return MythicalItemView{}, err
	}
	var saved db.MythicalItem
	err = pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		// The repository's request lock (FileTodo's) orders presses that
		// share an Idempotency-Key; the stack row lock orders stack changes.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, repositoryID); err != nil {
			return err
		}
		var locked int64
		err := tx.QueryRow(ctx, `SELECT repository_id FROM mythical_stacks WHERE repository_id = $1 FOR UPDATE`, repositoryID).Scan(&locked)
		if errors.Is(err, pgx.ErrNoRows) {
			return &TodoControlError{Status: http.StatusServiceUnavailable, Code: "stack_unavailable", Class: "infra", Message: "Repository stack is not ready"}
		}
		if err != nil {
			return err
		}
		q := db.New(tx)
		if prior, err := q.GetMythicalRequest(ctx, repositoryID, session, input.Request); err == nil {
			saved = prior
			return mythicalMergeRepeat(prior, item.ID, session, input.Request, head)
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		current, err := q.GetMythicalItem(ctx, item.ID)
		if err != nil {
			return err
		}
		before, err := mythicalMergeAfter(ctx, tx, current)
		if err != nil {
			return err
		}
		if err := mythicalMergeReady(current, before, head, false); err != nil {
			return err
		}
		if err := s.mergeDispatchReady(ctx, current); err != nil {
			return err
		}
		next := current
		checks := mythicalChecksOf(next)
		checks.Land = &mythicalLand{By: account.Login, Account: account.ID, Generation: current.Generation, Session: session, Head: head,
			At: s.now().UTC(), Request: input.Request}
		checks.MergeRequests = append(checks.MergeRequests, mythicalMergeRequest{Session: session, Request: input.Request, Generation: current.Generation, Head: head})
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

// mythicalMergeRepeat decides a press whose Idempotency-Key this session
// already used (prior is the TODO carrying that request): the same TODO at
// the same reviewed head is the same request, answered with its outcome, its
// receipt or, when its approval was refused or expired, that refusal (409,
// the retained code, class and words); anything else is a different
// request.
func mythicalMergeRepeat(prior db.MythicalItem, id pgtype.UUID, session, request, head string) error {
	checks := mythicalChecksOf(prior)
	for _, accepted := range checks.MergeRequests {
		if accepted.Session == session && accepted.Request == request && prior.ID == id && accepted.Head == head {
			if land := checks.Land; land != nil && land.Request == request && land.Session == session && land.Refused != nil {
				return &TodoControlError{Status: http.StatusConflict, Code: land.Refused.Code, Class: land.Refused.Class, Message: land.Refused.Message}
			}
			return nil
		}
	}
	return &TodoControlError{Status: http.StatusConflict, Code: "idempotency_mismatch", Class: "conflict", Message: "Idempotency-Key was already used for a different request"}
}

// mergeDispatchReady refuses a request no worker could act on: dispatch
// needs every outbound guard, the merge decision and the merge kind of
// lookup, send and settlement (EnableTodoPublication composes them).
func (s *MythicalService) mergeDispatchReady(ctx context.Context, item db.MythicalItem) error {
	if err := s.outboundReady(ctx, item, "merge"); err != nil {
		return mythicalMergeConflict("rechecking", err.Error())
	}
	if s.outbound.MergeDecision == nil || s.outbound.Lookup == nil || s.outbound.PrepareMerge == nil || s.outbound.Settle == nil {
		return mythicalMergeConflict("rechecking", "Waiting for merge dispatch and reconciliation integration")
	}
	return nil
}

func mythicalMergeForbidden() *TodoControlError {
	return &TodoControlError{Status: http.StatusForbidden, Code: "permission", Class: "permission", Message: "Merge requires an owner or maintainer browser session"}
}

// mythicalMergeAccountMoved refuses an approval whose GitHub account is no
// longer the one the person has linked.
func mythicalMergeAccountMoved() *TodoControlError {
	return &TodoControlError{Status: http.StatusForbidden, Code: "permission", Class: "permission", Message: "The GitHub account that approved this merge is no longer this person's"}
}

// mythicalPolicyRefusal refuses an account the factory's policy does not
// name.
func mythicalPolicyRefusal(act string) error {
	return pkgerrors.Forbidden("only a maintainer the factory's policy names may " + act)
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
// carries, MergeReady's PostgreSQL rows under the item's own fence, GitHub's
// live head, base, checks, reviews and mergeability, then, after those
// reads, its person's current authority with GitHub's permission read now,
// then the pull request's base and head once more. It answers what the
// claim (claimMerge) checks again: the account GitHub named and when GitHub
// was last read. A *TodoControlError is definitive: the worker clears the
// fence and keeps it on the approval. Any other error keeps the fence for
// the next pass.
func (s *MythicalService) MergeDecision(ctx context.Context, item db.MythicalItem, op MythicalOutboundOp) (mythicalMergeDecided, error) {
	land := mythicalChecksOf(item).Land
	if op.Kind != "merge" || land == nil || land.Session == "" || land.Refused != nil || land.Head != op.Desired || land.Generation != item.Generation {
		return mythicalMergeDecided{}, mythicalMergeConflict("rechecking", "The merge approval no longer matches this TODO; review it again")
	}
	before, err := mythicalMergeAfter(ctx, s.store, item)
	if err != nil {
		return mythicalMergeDecided{}, err
	}
	if err := mythicalMergeReady(item, before, op.Desired, true); err != nil {
		return mythicalMergeDecided{}, err
	}
	gh, number, err := s.mergeGitHub(ctx, item, op)
	if err != nil {
		return mythicalMergeDecided{}, err
	}
	if err := s.mergeLive(ctx, gh, number, op.Desired); err != nil {
		return mythicalMergeDecided{}, err
	}
	account, err := s.mergeAuthority(ctx, item, *land)
	if err != nil {
		return mythicalMergeDecided{}, err
	}
	// GitHub's merge takes no base: read the pull request once more, the
	// last read before the claim (§10.6.2b, the retarget ruling).
	pull, err := s.github.Pull(ctx, gh, number)
	if err != nil {
		return mythicalMergeDecided{}, err
	}
	read := s.now()
	if err := mythicalMergeOnGitHub(pull, op.Desired); err != nil {
		return mythicalMergeDecided{}, err
	}
	return mythicalMergeDecided{account: account, read: read}, nil
}

// mergeAuthority rechecks the approving person now (§10.6.2b) with the rule
// the press applied, and that their GitHub account is still the one that
// approved, and answers that account as GitHub names it. A stored approval
// is never current authorization by itself.
func (s *MythicalService) mergeAuthority(ctx context.Context, item db.MythicalItem, land mythicalLand) (gitHubActor, error) {
	_, account, _, err := s.mergeApprover(ctx, item.RepositoryID, land.Session)
	if err != nil {
		return gitHubActor{}, err
	}
	if account.ID != land.Account {
		return gitHubActor{}, mythicalMergeAccountMoved()
	}
	return account, nil
}

// mergeBinding is the repository's merge binding as the install holds it
// now.
func (s *MythicalService) mergeBinding(ctx context.Context, repositoryID int64) (mythicalMergeBinding, error) {
	target, err := s.publicationTarget(ctx, repositoryID)
	if err != nil {
		return mythicalMergeBinding{}, err
	}
	credentials, err := loadGitHubAppCredentials(ctx, s.publication.app)
	if err != nil {
		return mythicalMergeBinding{}, fmt.Errorf("the install's GitHub App is unavailable: %w", err)
	}
	return mythicalMergeBinding{actor: target.actor, repoUser: target.repository.UserID.Int64, repoOrg: target.repository.OrgID.Int64,
		owner: target.owner, name: target.repository.Name, githubOwner: target.githubOwner, githubRepo: target.githubRepo,
		installation: target.installation, app: credentials.ID}, nil
}

// mergeApprover is the one authority rule for a merge, applied at the press
// and again at dispatch, so a press is never accepted that dispatch must
// refuse: the person's standing (mergePerson), then GitHub and the
// factory's policy counting their account a maintainer, read now and never
// remembered, then their standing again, so a sign-out, suspension or
// ownership change committed while GitHub answered is seen. It answers the
// stack's GitHub destination with them.
func (s *MythicalService) mergeApprover(ctx context.Context, repositoryID int64, sessionKey string) (int64, gitHubActor, mythicalGitHubRepo, error) {
	user, err := s.mergePerson(ctx, sessionKey)
	if err != nil {
		return 0, gitHubActor{}, mythicalGitHubRepo{}, err
	}
	gh, account, err := s.maintainerPerson(ctx, repositoryID, user, "merge a TODO")
	if err != nil {
		return 0, gitHubActor{}, mythicalGitHubRepo{}, mythicalAuthorityRefusal(err)
	}
	if _, err := s.mergePerson(ctx, sessionKey); err != nil {
		return 0, gitHubActor{}, mythicalGitHubRepo{}, err
	}
	return user, account, gh, nil
}

// mergePerson is the person whose browser session is stored under
// sessionKey, while the session is live, the person may sign in and is the
// install's owner or one of its maintainers (M-05, M-17).
// A session filed before keys were hashed at rest is not found under its
// digest, at the press as at dispatch: it signs in again.
func (s *MythicalService) mergePerson(ctx context.Context, sessionKey string) (int64, error) {
	standing, err := readMergeStanding(ctx, s.store, sessionKey)
	if err != nil {
		return 0, err
	}
	return standing.person(s.now())
}

// mergeStanding is the approver's rows as one read found them: the session
// stored under its key, its person, the install's owner and whether the
// person is a maintainer on the roster.
type mergeStanding struct {
	session, user bool
	userID, owner int64
	expires       time.Time
	enabled       bool
	maintainer    bool
}

// readMergeStanding reads the approver's rows through conn, the claim's
// transaction once it holds their locks (claimMerge). It decides nothing:
// person does, at a time.
func readMergeStanding(ctx context.Context, conn db.DBTX, sessionKey string) (mergeStanding, error) {
	var standing mergeStanding
	if sessionKey == "" {
		return standing, nil
	}
	err := conn.QueryRow(ctx, `SELECT user_id, expires_at FROM auth_sessions WHERE session_key = $1`, sessionKey).Scan(&standing.userID, &standing.expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return standing, nil
	}
	if err != nil {
		return standing, err
	}
	standing.session = true
	var active, prohibited bool
	var deleted pgtype.Timestamptz
	err = conn.QueryRow(ctx, `SELECT is_active, prohibit_login, deleted_at FROM users WHERE id = $1`, standing.userID).Scan(&active, &prohibited, &deleted)
	if errors.Is(err, pgx.ErrNoRows) {
		return standing, nil
	}
	if err != nil {
		return standing, err
	}
	standing.user, standing.enabled = true, active && !prohibited && !deleted.Valid
	err = conn.QueryRow(ctx, `SELECT user_id FROM self_host_owners WHERE singleton`).Scan(&standing.owner)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return standing, err
	}
	if standing.owner != standing.userID {
		role, err := InstallRoleOf(ctx, db.New(conn), standing.userID)
		if err != nil {
			return standing, err
		}
		standing.maintainer = role == InstallMaintainer
	}
	return standing, nil
}

// person is the approver while, at now, the session is live, its person may
// sign in and is the install's owner or a maintainer on its roster (M-05);
// otherwise the refusal.
func (m mergeStanding) person(now time.Time) (int64, error) {
	if !m.session || !m.user || !m.expires.After(now) || !m.enabled {
		return 0, &TodoControlError{Status: http.StatusUnauthorized, Code: "unauthenticated", Class: "permission", Message: "The approving browser session has ended; sign in again to merge"}
	}
	if m.owner != m.userID && !m.maintainer {
		return 0, mythicalMergeForbidden()
	}
	return m.userID, nil
}

// mythicalMergeOnGitHub is row 8 on GitHub's own pull request: open, based
// on main and at the reviewed head. GitHub merges into whatever base the
// pull request has, so one retargeted away from main is refused. A pull
// request GitHub reports merged is settled by lookup, never merged again.
func mythicalMergeOnGitHub(pull mythicalPull, head string) error {
	switch {
	case pull.Merged:
		return errMythicalMergedOnGitHub
	case pull.State != "open":
		return mythicalMergeConflict("state", "PR is closed on GitHub")
	case pull.BaseRef != "main":
		return mythicalMergeConflict("state", "PR no longer targets main on GitHub")
	case pull.HeadSHA != head:
		return &MythicalStaleHeadError{TodoControlError: *mythicalMergeConflict("stale_head", "the pull request changed since you saw it"), CurrentHead: pull.HeadSHA}
	}
	return nil
}

// mergeLive is MergeReady rows 8-9 on GitHub's live facts: the PR is open,
// based on main, at the reviewed head, its required checks pass there,
// main's required reviews are satisfied, it is not draft and GitHub
// affirmatively reports it mergeable. GitHub still computing mergeability is
// read once more after two seconds, and rows 8-9 are evaluated again against
// that read.
func (s *MythicalService) mergeLive(ctx context.Context, gh mythicalGitHubRepo, number int64, head string) error {
	pull, err := s.github.Pull(ctx, gh, number)
	if err != nil {
		return err
	}
	for reread := false; ; reread = true {
		if err := mythicalMergeOnGitHub(pull, head); err != nil {
			return err
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

// mergeLookup is appLookup's merge kind, what GitHub shows of the pull
// request: op.Desired once merged into main, whoever merged it; "merged
// into <base>" once merged into another branch; "closed" when closed
// unmerged; "head <sha>" at another head; op.Precondition while open at
// the reviewed head (recoverMerge decides on each).
func (s *MythicalService) mergeLookup(ctx context.Context, gh mythicalGitHubRepo, item db.MythicalItem, op MythicalOutboundOp) (string, bool, error) {
	number, err := mythicalMergeNumber(item, op)
	if err != nil {
		return "", false, err
	}
	pull, err := s.github.Pull(ctx, gh, number)
	if err != nil {
		return "", false, err
	}
	switch {
	case pull.Merged && pull.BaseRef != "main":
		return mythicalMergedInto + pull.BaseRef, false, nil
	case pull.Merged:
		return op.Desired, false, nil
	case pull.State != "open":
		return mythicalMergeClosed, false, nil
	case pull.HeadSHA != op.Desired:
		return mythicalMergeMoved + pull.HeadSHA, false, nil
	}
	return op.Precondition, false, nil
}

// mergeLookup's observations besides the merge and the reviewed head.
const (
	mythicalMergedInto  = "merged into "
	mythicalMergeClosed = "closed"
	mythicalMergeMoved  = "head "
)

// mergeSend is the merge's request, after its claim (prepareMerge): GitHub's
// squash merge with sha = the reviewed head, sent with the App token minted
// for it, its commit title and message rendered by mythicalMergeCommit. A
// refusal GitHub states (401, 403, 404, 405, 409, 422) is definitive with
// GitHub's text verbatim, unless the PR turns out to be merged already; any
// other failure is unknown, and lookup decides on the next pass.
func (s *MythicalService) mergeSend(ctx context.Context, gh mythicalGitHubRepo, token string, item db.MythicalItem, op MythicalOutboundOp) error {
	number, err := mythicalMergeNumber(item, op)
	if err != nil {
		return err
	}
	_, err = s.github.Merge(ctx, gh, token, number, op.Desired, mythicalMergeCommit(item, number, op.Desired))
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
	// GitHub's main moved: the next pass confirms the merge and settles it,
	// and the GitHub sync brings the install's main to it.
	s.MainMoved(ctx, item.RepositoryID)
	if s.followMain != nil {
		s.followMain(ctx, item.RepositoryID)
	}
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

// mythicalMergeCommit is the squash commit's title and message, rendered
// from what Smithers holds for the reviewed TODO: its title, its number and
// its pull request's. Never the live pull request's title or body, which
// anyone who can write on GitHub may edit after the review; a closing
// keyword in the title is made a plain reference.
func mythicalMergeCommit(item db.MythicalItem, number int64, head string) mythicalMergeCommitText {
	title := strings.Join(strings.Fields(mythicalNoCIDirectives(mythicalNoClosingKeywords(mythicalTodoTitle(item)))), " ")
	return mythicalMergeCommitText{Title: fmt.Sprintf("%s (#%d)", title, number),
		Message: fmt.Sprintf("TODO T%d, reviewed at %s.", mythicalItemNumber(item), head)}
}

// mythicalCIDirective matches the commit-message directives that skip
// GitHub's CI ([skip ci], [ci skip], [no ci], [skip actions], [actions
// skip]) and the skip-checks trailer.
var mythicalCIDirective = regexp.MustCompile(`(?i)\[\s*(skip\s+ci|ci\s+skip|no\s+ci|skip\s+actions|actions\s+skip)\s*\]|\bskip-checks\s*:\s*true\b`)

// mythicalNoCIDirectives makes each CI-skip directive in text plain, as
// mythicalNoClosingKeywords does closing references: a TODO's title becomes
// the squash commit's title and must not switch off main's checks.
func mythicalNoCIDirectives(text string) string {
	return mythicalCIDirective.ReplaceAllStringFunc(text, func(directive string) string {
		if strings.HasPrefix(directive, "[") {
			return "(" + strings.Join(strings.Fields(strings.Trim(directive, "[]")), " ") + ")"
		}
		return "skip-checks true"
	})
}

// mythicalMergeExpired reports a merge approval older than
// mythicalMergeExpiry at now's time, or one recorded before approvals
// carried their time. A fence with no approval is MergeDecision's to refuse.
func mythicalMergeExpired(item db.MythicalItem, now func() time.Time) bool {
	land := mythicalChecksOf(item).Land
	return land != nil && (land.At.IsZero() || now().Sub(land.At) >= mythicalMergeExpiry)
}

// mythicalMergeUnfinished is the receipt of a merge mythicalMergeExpiry
// ended without GitHub merging it.
func mythicalMergeUnfinished() *TodoControlError {
	return mythicalGitHubBlock("The merge did not complete within 10 minutes; press Merge again")
}

// recoverMerge is recoverOutbound for a merge (§10.6.2b, §12.4.1b), after
// its lookup. A merge whose request was sent (the slot is unknown, recorded
// by claimMerge before the request left) is never sent again, never ended
// by mythicalMergeExpiry or by a refusal of its approver: only what GitHub
// shows settles it (merged; closed; another head, which the sha-bound
// request can no longer merge). A merge never sent is decided afresh,
// bounded by mythicalMergeExpiry against the time now, prepared up to its
// request, and claimed atomically with every fact it rests on.
func (st *mythicalItemStep) recoverMerge(ctx context.Context, item db.MythicalItem, op MythicalOutboundOp, observed string, lookup error) (*db.MythicalItem, error) {
	p := st.s.outbound
	sent := op.State == "unknown"
	if lookup != nil {
		if !sent && mythicalMergeExpired(item, st.s.now) {
			// Never sent: GitHub cannot have it, so the bound ends the fence.
			return st.refuseMerge(ctx, item, op, mythicalMergeUnfinished(), true)
		}
		return nil, lookup
	}
	switch {
	case observed == op.Desired:
		op.State = "done"
		return st.settleOutbound(ctx, item, op)
	case strings.HasPrefix(observed, mythicalMergedInto):
		return st.mergedOffMain(ctx, item, op, strings.TrimPrefix(observed, mythicalMergedInto))
	case sent && observed == mythicalMergeClosed:
		return st.refuseMerge(ctx, item, op, mythicalMergeConflict("state", "PR is closed on GitHub"), false)
	case sent && strings.HasPrefix(observed, mythicalMergeMoved):
		return st.refuseMerge(ctx, item, op, mythicalMergeConflict("stale_head", "the pull request changed since you saw it"), false)
	case sent:
		// Still open at the reviewed head: the request may yet complete.
		return &item, nil
	}
	op.State = "intended"
	if mythicalMergeExpired(item, st.s.now) {
		return st.refuseMerge(ctx, item, op, mythicalMergeUnfinished(), true)
	}
	if err := st.s.outboundReady(ctx, item, op.Kind); err != nil {
		return st.refuseMerge(ctx, item, op, err, true)
	}
	if p.MergeDecision == nil {
		return nil, errors.New("Waiting for merge readiness integration")
	}
	decided, err := p.MergeDecision(ctx, item, op)
	if err != nil {
		return st.refuseMerge(ctx, item, op, err, true)
	}
	if p.PrepareMerge == nil {
		return nil, errors.New("Waiting for GitHub dispatch integration")
	}
	if p.Settle == nil {
		return nil, errors.New("Waiting for GitHub settlement integration")
	}
	// Everything but the request happens before the claim records the
	// send, so a failed lookup or mint leaves it never sent.
	dispatch, err := p.PrepareMerge(st, ctx, item, op)
	if err != nil {
		return st.refuseMerge(ctx, item, op, err, true)
	}
	claimed, err := st.claimMerge(ctx, item, op, decided, dispatch.binding)
	if err != nil {
		return st.refuseMerge(ctx, item, op, err, true)
	}
	op.State = "unknown"
	if err := dispatch.send(ctx, claimed); err != nil {
		// Sent: only GitHub's definitive refusal ends the fence now;
		// anything else is settled by lookup.
		return st.refuseMerge(ctx, claimed, op, err, false)
	}
	// Looked up once right away; never sent twice in one pass.
	if observed, _, err := p.Lookup(st, ctx, claimed, op); err == nil {
		return st.recoverMerge(ctx, claimed, op, observed, nil)
	}
	return &claimed, nil
}

// claimMerge records, in one transaction, that the merge is being sent (the
// slot becomes unknown) only while every fact its decision rested on still
// holds (§10.6.2b). It first takes every lock it needs, in the install's
// one lock order (lockMergeFacts), then reads each local fact again: the
// TODO's row by the save's version check, the approver's session, person
// and linked GitHub account, the install's owner, and the repository's
// GitHub binding, against the binding the merge was prepared for. The
// policy lives on the repository host, outside PostgreSQL, and is read
// again after the locks. Only then does it read the time, for the
// approval's age, the session's expiry and the age of GitHub's facts,
// which cannot be locked and are refused past mythicalMergeFactsBound. A
// change committed before the claim sends nothing; a writer of a locked
// row after it waits for the claim, and a row inserted after it orders
// after it: neither recalls the request.
func (st *mythicalItemStep) claimMerge(ctx context.Context, item db.MythicalItem, op MythicalOutboundOp, decided mythicalMergeDecided, binding mythicalMergeBinding) (db.MythicalItem, error) {
	land := mythicalChecksOf(item).Land
	if land == nil {
		return db.MythicalItem{}, mythicalMergeConflict("rechecking", "The merge approval no longer matches this TODO; review it again")
	}
	var claimed db.MythicalItem
	err := pgx.BeginFunc(ctx, st.s.store, func(tx pgx.Tx) error {
		if err := lockMergeFacts(ctx, tx, item, land.Session, binding); err != nil {
			return err
		}
		q := db.New(tx)
		standing, err := readMergeStanding(ctx, tx, land.Session)
		if err != nil {
			return err
		}
		accounts, err := q.ListUserOAuthAccounts(ctx, standing.userID)
		if err != nil {
			return err
		}
		linked, _ := mythicalLinkedGitHub(accounts)
		// The rows the binding is read from are locked, so this read
		// through the pool sees what the claim holds.
		current, bindingErr := st.s.mergeBinding(ctx, item.RepositoryID)
		policyCtx, cancel := context.WithTimeout(ctx, mythicalMergeFactsBound)
		policy, policyErr := st.s.stackPolicy(policyCtx, item.RepositoryID)
		cancel()
		now := st.s.now()
		if mythicalMergeExpired(item, func() time.Time { return now }) {
			return mythicalMergeUnfinished()
		}
		if _, err := standing.person(now); err != nil {
			return err
		}
		switch {
		case linked != land.Account:
			return mythicalMergeAccountMoved()
		case policyErr != nil:
			return policyErr
		case !policy.maintains(decided.account.Login):
			return mythicalAuthorityRefusal(mythicalPolicyRefusal("merge a TODO"))
		case bindingErr != nil:
			return bindingErr
		case current != binding:
			return errMythicalMergeBindingMoved
		case now.Sub(decided.read) > mythicalMergeFactsBound:
			return errMythicalMergeFactsAged
		}
		op.State = "unknown"
		next := item
		next.PendingOp, _ = json.Marshal(op)
		claimed, err = q.SaveMythicalItemUnderLease(ctx, next, st.r.row.Claim)
		return err
	})
	return claimed, err
}

// lockMergeFacts takes the claim's locks in the install's one lock order
// (§10.6.2b): the repository's row; the stack's, then the TODO's (every
// stack writer takes the stack's row before a TODO's); the users rows, the
// approver's and the repository owner's; then every other row the claim
// reads, by table name, the order account erasure deletes in, which ends
// with the install's owner. A repository's deletion takes its row before
// the rows it cascades to; erasure takes the users row first; every other
// writer of these rows takes one of them. PostgreSQL ends any cycle a
// writer outside this order makes by aborting one transaction: an aborted
// claim records nothing and sends nothing, and the next pass decides
// again.
func lockMergeFacts(ctx context.Context, tx pgx.Tx, item db.MythicalItem, session string, b mythicalMergeBinding) error {
	destinations := []any{strings.ToLower(b.githubOwner), strings.ToLower(b.githubRepo), strings.ToLower(b.owner), strings.ToLower(b.name)}
	for _, lock := range []struct {
		sql  string
		args []any
	}{
		{`SELECT 1 FROM repositories WHERE id = $1 FOR SHARE`, []any{item.RepositoryID}},
		{`SELECT 1 FROM mythical_stacks WHERE repository_id = $1 FOR UPDATE`, []any{item.RepositoryID}},
		{`SELECT 1 FROM mythical_items WHERE id = $1 FOR UPDATE`, []any{item.ID}},
		{`SELECT 1 FROM users WHERE id IN ((SELECT user_id FROM auth_sessions WHERE session_key = $1), $2) ORDER BY id FOR SHARE`, []any{session, b.repoUser}},
		{`SELECT 1 FROM auth_sessions WHERE session_key = $1 FOR SHARE`, []any{session}},
		{`SELECT 1 FROM github_app WHERE singleton FOR SHARE`, nil},
		{`SELECT 1 FROM github_app_installation_repositories WHERE (owner_login_lower, repo_name_lower) IN (($1, $2), ($3, $4)) FOR SHARE`, destinations},
		{`SELECT 1 FROM github_synced_repos WHERE LOWER(mirror_owner) = $1 AND LOWER(mirror_repo) = $2 FOR SHARE`, destinations[2:]},
		{`SELECT 1 FROM import_jobs WHERE repository_id = $1 AND status = 'ready' FOR SHARE`, []any{item.RepositoryID}},
		{`SELECT 1 FROM oauth_accounts WHERE user_id = (SELECT user_id FROM auth_sessions WHERE session_key = $1) FOR SHARE`, []any{session}},
		{`SELECT 1 FROM org_members WHERE organization_id = $1 FOR SHARE`, []any{b.repoOrg}},
		{`SELECT 1 FROM organizations WHERE id = $1 FOR SHARE`, []any{b.repoOrg}},
		{`SELECT 1 FROM repo_connections WHERE (repo_owner_lower, repo_name_lower) IN (($1, $2), ($3, $4)) FOR SHARE`, destinations},
		{`SELECT 1 FROM self_host_owners WHERE singleton FOR SHARE`, nil},
	} {
		if _, err := tx.Exec(ctx, lock.sql, lock.args...); err != nil {
			return err
		}
	}
	return nil
}

// mergedOffMain settles a merge GitHub made into base, not main: possible
// only when the pull request was retargeted between the last read and the
// request, since GitHub's merge takes no base (the retarget ruling,
// §10.6.2b). The TODO is never Merged: the fence clears with a receipt
// naming the branch, the TODO closes as a pull request closed on GitHub
// does, so later TODOs are not held behind it, and the owner's log records
// it.
func (st *mythicalItemStep) mergedOffMain(ctx context.Context, item db.MythicalItem, op MythicalOutboundOp, base string) (*db.MythicalItem, error) {
	refusal := mythicalGitHubBlock("GitHub merged the pull request into " + base + ", not main")
	next := item
	next.PRState, next.State, next.Reason = "closed", "rejected", "merged into "+base+" on GitHub, not main"
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
	st.s.logger.Warn("mythical.merge_off_main", "repository_id", item.RepositoryID, "item", uuidString(item.ID),
		"todo", mythicalItemNumber(item), "pull_request", op.Target, "base", base, "reviewed_head", op.Desired)
	st.s.notify(ctx, st.q, st.r.row.RepositoryID, st.r.row.Generation, "item", uuidString(saved.ID))
	return &saved, nil
}

// refuseMerge settles a refused merge (§10.6.2b-c): the fence clears, the
// approval stays with the refusal as its receipt and the card shows it
// until another press. Before any send (unsent: lookup proved GitHub has not
// merged it), a failure that settles nothing is a refusal when the
// approver's standing is gone: a revoked session, a suspended or removed
// person ends the fence at once. Any other failure leaves the fence for the
// next pass, which looks a sent merge up and which mythicalMergeExpiry
// bounds.
func (st *mythicalItemStep) refuseMerge(ctx context.Context, item db.MythicalItem, op MythicalOutboundOp, err error, unsent bool) (*db.MythicalItem, error) {
	var refusal *TodoControlError
	if !errors.As(err, &refusal) {
		land := mythicalChecksOf(item).Land
		if !unsent || land == nil || errors.Is(err, errMythicalMergedOnGitHub) {
			return nil, err
		}
		if _, standing := st.s.mergePerson(ctx, land.Session); !errors.As(standing, &refusal) {
			return nil, err
		}
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
// maintainer, read from GitHub now; anything else is refused before GitHub is
// written.
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
		return mythicalGitHubRepo{}, gitHubActor{}, mythicalPolicyRefusal(act)
	}
	if maintainer, err := s.github.MaintainerNow(ctx, gh, account); err != nil {
		return mythicalGitHubRepo{}, gitHubActor{}, err
	} else if !maintainer {
		return mythicalGitHubRepo{}, gitHubActor{}, pkgerrors.Forbidden("only a maintainer of " + gh.Owner + "/" + gh.Name + " on GitHub may " + act)
	}
	return gh, account, nil
}
