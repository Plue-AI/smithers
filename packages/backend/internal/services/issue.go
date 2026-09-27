package services

import (
	"context"
	"encoding/base64"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

// maxIssueTitleLen is the maximum allowed issue title length, in Unicode code
// points. It matches the issues.title VARCHAR(255) column in db/product/migrations/0001_product_baseline.sql so an
// oversized title is rejected with a 4xx instead of surfacing as a DB-driver 500.
const maxIssueTitleLen = 255

type CreateIssueInput struct {
	IdempotencyKey string   `json:"idempotency_key,omitempty"`
	Kind           string   `json:"kind,omitempty"`
	Title          string   `json:"title"`
	Body           string   `json:"body"`
	Assignees      []string `json:"assignees,omitempty"`
	Labels         []string `json:"labels,omitempty"`
	Milestone      *int64   `json:"milestone,omitempty"`
}

type IssueMilestonePatch struct {
	Value *int64 `json:"value,omitempty"`
}

type UpdateIssueInput struct {
	Title     *string              `json:"title,omitempty"`
	Body      *string              `json:"body,omitempty"`
	State     *string              `json:"state,omitempty"`
	Assignees *[]string            `json:"assignees,omitempty"`
	Labels    *[]string            `json:"labels,omitempty"`
	Milestone *IssueMilestonePatch `json:"milestone,omitempty"`
}

type IssuePersona struct {
	Username  string `json:"username"`
	IconEmoji string `json:"iconEmoji,omitempty"`
	IconURL   string `json:"iconUrl,omitempty"`
}

type CreateIssueCommentInput struct {
	externalCommenter string
	Persona           *IssuePersona `json:"persona,omitempty"`
	IdempotencyKey    string        `json:"idempotency_key,omitempty"`
	Body              string        `json:"body"`
}

type UpdateIssueCommentInput struct {
	// externalCommenter: the issue-sync intake writes an external account's
	// edit under the owner's name, so it names no writer.
	externalCommenter bool
	Body              string `json:"body"`
}

type IssueUserSummary struct {
	ID             int64  `json:"id"`
	Login          string `json:"login"`
	AgentSessionID string `json:"agent_session_id,omitempty"`
}

type IssueLinkedChange struct {
	ChangeID    string    `json:"change_id"`
	CommitID    string    `json:"commit_id"`
	Description string    `json:"description"`
	LinkType    string    `json:"link_type"`
	LinkedAt    time.Time `json:"linked_at"`
}

type LabelSummary struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Color       string `json:"color"`
	Description string `json:"description"`
}

type IssueResponse struct {
	IdempotencyKey string                `json:"idempotency_key,omitempty"`
	Kind           string                `json:"kind"`
	Visibility     string                `json:"visibility"`
	ID             int64                 `json:"id"`
	Number         int64                 `json:"number"`
	Title          string                `json:"title"`
	Body           string                `json:"body"`
	State          string                `json:"state"`
	Author         IssueUserSummary      `json:"author"`
	Assignees      []IssueUserSummary    `json:"assignees"`
	Labels         []LabelSummary        `json:"labels"`
	Linear         *LinearIssueReference `json:"linear"`
	MilestoneID    any                   `json:"milestone_id"`
	CommentCount   int64                 `json:"comment_count"`
	ClosedAt       pgtype.Timestamptz    `json:"closed_at"`
	FixedBy        *IssueUserSummary     `json:"fixed_by"`
	FixedAt        pgtype.Timestamptz    `json:"fixed_at"`
	VerifiedBy     *IssueUserSummary     `json:"verified_by"`
	VerifiedAt     pgtype.Timestamptz    `json:"verified_at"`
	LinkedChanges  []IssueLinkedChange   `json:"linked_changes"`
	CreatedAt      time.Time             `json:"created_at"`
	UpdatedAt      time.Time             `json:"updated_at"`
}

type issueLinearMapQuerier interface {
	GetLinearIssueMapBySmithersIssueID(ctx context.Context, jjhubIssueID int64) (db.LinearIssueMap, error)
}

type issueLinkedChangesQuerier interface {
	ListLinkedChangesForIssue(ctx context.Context, issueID int64) ([]db.ListLinkedChangesForIssueRow, error)
}

type IssueCommentResponse struct {
	IdempotencyKey string          `json:"idempotency_key,omitempty"`
	Persona        json.RawMessage `json:"persona,omitempty"`
	ID             int64           `json:"id"`
	IssueID        int64           `json:"issue_id"`
	UserID         int64           `json:"user_id"`
	Commenter      string          `json:"commenter"`
	Body           string          `json:"body"`
	Type           string          `json:"type"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
}

type IssueQuerier interface {
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	GetUserByLowerUsername(ctx context.Context, lowerUsername string) (db.User, error)
	GetMilestoneByID(ctx context.Context, arg db.GetMilestoneByIDParams) (db.Milestone, error)

	CreateIssue(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error)
	GetIssueByNumber(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error)
	ListIssuesByRepoFiltered(ctx context.Context, arg db.ListIssuesByRepoFilteredParams) ([]db.Issue, error)
	CountIssuesByRepoFiltered(ctx context.Context, arg db.CountIssuesByRepoFilteredParams) (int64, error)
	UpdateIssue(ctx context.Context, arg db.UpdateIssueParams) (db.Issue, error)

	ListIssueAssignees(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error)
	ReplaceIssueAssignees(ctx context.Context, arg db.ReplaceIssueAssigneesParams) error
	ListLabelsByNames(ctx context.Context, arg db.ListLabelsByNamesParams) ([]db.Label, error)
	ReplaceIssueLabels(ctx context.Context, arg db.ReplaceIssueLabelsParams) error
	CountLabelsForIssue(ctx context.Context, issueID int64) (int64, error)
	ListLabelsForIssue(ctx context.Context, arg db.ListLabelsForIssueParams) ([]db.Label, error)

	CreateIssueComment(ctx context.Context, arg db.CreateIssueCommentParams) (db.IssueComment, error)
	ListIssueComments(ctx context.Context, arg db.ListIssueCommentsParams) ([]db.IssueComment, error)
	ListIssuesByRepoFilteredKeyset(ctx context.Context, arg db.ListIssuesByRepoFilteredKeysetParams) ([]db.Issue, error)
	ListIssueCommentsByIssueKeyset(ctx context.Context, arg db.ListIssueCommentsByIssueKeysetParams) ([]db.IssueComment, error)
	CountIssueCommentsByIssue(ctx context.Context, issueID int64) (int64, error)
	GetIssueCommentByID(ctx context.Context, id int64) (db.IssueComment, error)
	UpdateIssueComment(ctx context.Context, arg db.UpdateIssueCommentParams) (db.IssueComment, error)
	DeleteIssueComment(ctx context.Context, id int64) error
	GetIssueByCommentID(ctx context.Context, id int64) (db.Issue, error)

	// Timeline events (read back by IssueEventService.ListIssueEvents).
	CreateIssueEvent(ctx context.Context, arg db.CreateIssueEventParams) (db.IssueEvent, error)

	// repositories.num_issues / num_closed_issues and issues.comment_count are
	// maintained by database triggers (trg_issues_repo_counts_*,
	// trg_issue_comments_count_*); services never adjust them directly.

	// Mention queries (used by MentionService wired into CreateIssue/CreateIssueComment).
	CreateMention(ctx context.Context, arg db.CreateMentionParams) (db.Mention, error)
	DeleteMentionsForComment(ctx context.Context, arg db.DeleteMentionsForCommentParams) error
}

type IssueService struct {
	queries        IssueQuerier
	dispatcher     webhooks.Dispatcher
	mentionSvc     *MentionService
	notifSvc       *NotificationService
	workflowRunSvc WorkflowRunService
	ownershipGuard RepoOwnershipGuard
	txManager      issueWriteTxManager
}

// WithIssueOwnershipGuard fences issue creation against concurrent repository
// transfers, so a request authorized against the old owner cannot create
// issues on the new owner's repo.
func WithIssueOwnershipGuard(g RepoOwnershipGuard) IssueServiceOption {
	return func(s *IssueService) {
		s.ownershipGuard = g
	}
}

type IssueServiceOption func(*IssueService)

func WithIssueWebhookDispatcher(dispatcher webhooks.Dispatcher) IssueServiceOption {
	return func(s *IssueService) {
		s.dispatcher = dispatcher
	}
}

// WithIssueMentionService wires a MentionService into IssueService so that
// @mentions in issue bodies and comments automatically create notifications.
func WithIssueMentionService(mentionSvc *MentionService) IssueServiceOption {
	return func(s *IssueService) {
		s.mentionSvc = mentionSvc
	}
}

// WithIssueNotificationService wires a NotificationService into IssueService so
// that watchers receive notifications when a new issue is opened.
func WithIssueNotificationService(notifSvc *NotificationService) IssueServiceOption {
	return func(s *IssueService) {
		s.notifSvc = notifSvc
	}
}

func WithIssueWorkflowRunService(workflowRunSvc WorkflowRunService) IssueServiceOption {
	return func(s *IssueService) {
		s.workflowRunSvc = workflowRunSvc
	}
}

func NewIssueService(q IssueQuerier, opts ...IssueServiceOption) *IssueService {
	s := &IssueService{queries: q, txManager: newIssueWriteTxManager(q)}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

// ListIssues returns a page of issues using stable keyset pagination.
// afterNumber is the exclusive lower bound on issue number (DESC order); 0 means first page.
// limit controls the page size (clamped to [1, maxPerPage]).
// Returns items, next cursor (empty string if no more pages), total count, and error.
func (s *IssueService) ListIssues(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]IssueResponse, string, int64, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, "", 0, err
	}
	if err := s.requireReadAccess(ctx, repository, viewer); err != nil {
		return nil, "", 0, err
	}

	normalizedState, err := normalizeIssueFilterState(state)
	if err != nil {
		return nil, "", 0, err
	}

	if limit <= 0 {
		limit = defaultPerPage
	}
	if limit > maxPerPage {
		limit = maxPerPage
	}

	viewerID := int64(0)
	if viewer != nil {
		viewerID = viewer.ID
	}
	total, err := s.queries.CountIssuesByRepoFiltered(ctx, db.CountIssuesByRepoFilteredParams{ViewerID: viewerID,
		RepositoryID: repository.ID,
		State:        normalizedState,
	})
	if err != nil {
		return nil, "", 0, pkgerrors.Internal("failed to count issues").WithCause(err)
	}

	rows, err := s.queries.ListIssuesByRepoFilteredKeyset(ctx, db.ListIssuesByRepoFilteredKeysetParams{ViewerID: viewerID,
		RepositoryID: repository.ID,
		State:        normalizedState,
		AfterNumber:  afterNumber,
		PageSize:     int32(limit),
	})
	if err != nil {
		return nil, "", 0, pkgerrors.Internal("failed to list issues").WithCause(err)
	}

	items := make([]IssueResponse, 0, len(rows))
	for _, issue := range rows {
		mapped, err := s.mapIssue(ctx, issue)
		if err != nil {
			return nil, "", 0, err
		}
		items = append(items, mapped)
	}

	var nextCursor string
	if len(rows) == limit {
		// Encode the last item's number as the next page cursor.
		lastNumber := rows[len(rows)-1].Number
		nextCursor = encodeIssueNumberCursor(lastNumber)
	}

	return items, nextCursor, total, nil
}

// encodeIssueNumberCursor encodes an issue number as an opaque cursor string.
//
// It MUST use the same base64 scheme as routes.encodeIDCursor/decodeIDCursor,
// because the issue list and issue-comment list route handlers decode the
// cursor with decodeIDCursor (base64-first). A plain decimal cursor like "71"
// is itself valid base64, so decodeIDCursor would decode it to garbage bytes,
// fail to parse, and return 0 (first-page sentinel) — silently pinning the
// client to page 1 forever. Keeping the encoder base64 guarantees the
// round-trip invariant decode(encode(N)) == N for every digit-length of N.
func encodeIssueNumberCursor(number int64) string {
	if number <= 0 {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(number, 10)))
}

// decodeIssueNumberCursor decodes an issue cursor back to the last-seen number.
// Returns 0 for empty/invalid cursors (first page). Mirrors routes.decodeIDCursor:
// base64 first, with a plain-decimal fallback for legacy cursors.
func decodeIssueNumberCursor(cursor string) int64 {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return 0
	}
	if b, err := base64.RawURLEncoding.DecodeString(cursor); err == nil {
		if n, perr := strconv.ParseInt(string(b), 10, 64); perr == nil && n > 0 {
			return n
		}
	}
	n, err := strconv.ParseInt(cursor, 10, 64)
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

func (s *IssueService) CreateIssue(ctx context.Context, actor *db.User, owner, repo string, req CreateIssueInput) (IssueResponse, error) {
	if actor == nil {
		return IssueResponse{}, pkgerrors.Unauthorized("authentication required")
	}

	kind := req.Kind
	if kind == "" {
		kind = "issue"
	}
	if kind != "issue" && kind != "chat" {
		return IssueResponse{}, pkgerrors.BadRequest("invalid issue kind")
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		return IssueResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Issue", Field: "title", Code: "missing_field"})
	}
	if utf8.RuneCountInString(title) > maxIssueTitleLen {
		return IssueResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Issue", Field: "title", Code: "too_long"})
	}
	if verr := validateSafeText("Issue", "title", title); verr != nil {
		return IssueResponse{}, verr
	}
	if verr := validateSafeText("Issue", "body", req.Body); verr != nil {
		return IssueResponse{}, verr
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return IssueResponse{}, err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return IssueResponse{}, err
	}

	milestoneID, err := s.resolveIssueMilestone(ctx, repository.ID, req.Milestone)
	if err != nil {
		return IssueResponse{}, err
	}

	// Resolve assignees and labels BEFORE inserting the issue row so a
	// validation failure (unknown user, unknown label) cannot leave a
	// half-created issue behind.
	assigneeIDs, err := s.resolveAssigneeUserIDs(ctx, req.Assignees)
	if err != nil {
		return IssueResponse{}, err
	}
	labelIDs, err := s.resolveLabelIDs(ctx, repository.ID, req.Labels)
	if err != nil {
		return IssueResponse{}, err
	}

	// The issue row and its associations commit in one transaction inside the
	// ownership fence: an association failure rolls the row (and its issue
	// number) back, so a client retry cannot create a duplicate issue.
	var assigneeSet, labelSet *[]int64
	if len(assigneeIDs) > 0 {
		assigneeSet = &assigneeIDs
	}
	if len(labelIDs) > 0 {
		labelSet = &labelIDs
	}
	if len(req.IdempotencyKey) > 128 {
		return IssueResponse{}, pkgerrors.BadRequest("thread identity is too long")
	}
	replayed := false
	var created db.Issue
	if err := guardedRepoWrite(ctx, s.ownershipGuard, repository, func() error {
		return s.withIssueWriteTx(ctx, func(tx issueWriteTx) error {
			if req.IdempotencyKey != "" {
				if finder, ok := tx.(interface {
					FindIssueRequest(context.Context, int64, int64, string) (db.Issue, error)
				}); ok {
					existing, e := finder.FindIssueRequest(ctx, repository.ID, actor.ID, req.IdempotencyKey)
					if e == nil {
						if existing.Kind != kind {
							return pkgerrors.Conflict("thread identity already has a different kind")
						}
						created = existing
						replayed = true
						return nil
					}
					if !stdErrors.Is(e, pgx.ErrNoRows) {
						return e
					}
				}
			}
			editor, source := nativeIssueTextWriter(ctx, actor.ID)
			if werr := tx.SetIssueTextEditor(ctx, editor, source); werr != nil {
				return werr
			}
			var werr error
			created, werr = tx.CreateIssue(ctx, db.CreateIssueParams{Kind: kind, IdempotencyKey: req.IdempotencyKey,
				RepositoryID: repository.ID,
				Title:        title,
				Body:         req.Body,
				AuthorID:     actor.ID,
				MilestoneID:  milestoneID,
			})
			if werr != nil {
				return pkgerrors.Internal("failed to create issue").WithCause(werr)
			}
			return replaceIssueAssociations(ctx, tx, created.ID, actor.ID, assigneeSet, labelSet)
		})
	}); err != nil {
		return IssueResponse{}, err
	}

	mapped, err := s.mapIssue(ctx, created)
	if err != nil {
		return IssueResponse{}, err
	}
	if replayed {
		return mapped, nil
	}
	s.recordIssueEvent(ctx, created.ID, actor, "opened", nil, map[string]any{"title": mapped.Title})
	if err := s.dispatchIssueEvent(ctx, owner, repository, actor, "opened", mapped); err != nil {
		return IssueResponse{}, err
	}

	// Process @mentions in the issue body. Errors are non-fatal: a mention
	// delivery failure must not block the issue creation response.
	if s.mentionSvc != nil && req.Body != "" && kind != "chat" {
		authorID := pgtype.Int8{Int64: actor.ID, Valid: true}
		issueID := pgtype.Int8{Int64: created.ID, Valid: true}
		subject := fmt.Sprintf("mentioned you in issue #%d", created.Number)
		_ = s.mentionSvc.ProcessMentions(ctx, req.Body, MentionContext{
			RepositoryID: repository.ID,
			IssueID:      issueID,
			CommentType:  "issue_body",
			AuthorUserID: authorID,
		}, subject)
	}

	// Notify repository watchers about the new issue. Errors are non-fatal.
	if s.notifSvc != nil && kind != "chat" {
		subject := fmt.Sprintf("New issue: %s (#%d)", created.Title, created.Number)
		s.notifSvc.NotifyWatchers(ctx, repository.ID, "issue", created.ID, subject, created.Body)
	}

	return mapped, nil
}

func (s *IssueService) GetIssue(ctx context.Context, viewer *db.User, owner, repo string, number int64) (IssueResponse, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return IssueResponse{}, err
	}
	if err := s.requireReadAccess(ctx, repository, viewer); err != nil {
		return IssueResponse{}, err
	}

	issue, err := s.getIssueByNumber(ctx, repository.ID, number)
	if err != nil {
		return IssueResponse{}, err
	}
	if err := requireIssueVisibility(issue, viewer); err != nil {
		return IssueResponse{}, err
	}
	return s.mapIssue(ctx, issue)
}

func (s *IssueService) UpdateIssue(ctx context.Context, actor *db.User, owner, repo string, number int64, req UpdateIssueInput) (IssueResponse, error) {
	if actor == nil {
		return IssueResponse{}, pkgerrors.Unauthorized("authentication required")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return IssueResponse{}, err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return IssueResponse{}, err
	}

	current, err := s.getIssueByNumber(ctx, repository.ID, number)
	if err != nil {
		return IssueResponse{}, err
	}

	if err := requireIssueVisibility(current, actor); err != nil {
		return IssueResponse{}, err
	}
	title := current.Title
	if req.Title != nil {
		title = strings.TrimSpace(*req.Title)
		if title == "" {
			return IssueResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Issue", Field: "title", Code: "missing_field"})
		}
		if utf8.RuneCountInString(title) > maxIssueTitleLen {
			return IssueResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Issue", Field: "title", Code: "too_long"})
		}
		if verr := validateSafeText("Issue", "title", title); verr != nil {
			return IssueResponse{}, verr
		}
	}

	body := current.Body
	if req.Body != nil {
		body = *req.Body
		if verr := validateSafeText("Issue", "body", body); verr != nil {
			return IssueResponse{}, verr
		}
	}

	state := current.State
	if req.State != nil {
		nextState, stateErr := normalizeIssueState(*req.State)
		if stateErr != nil {
			return IssueResponse{}, stateErr
		}
		state = nextState
	}

	closedAt := current.ClosedAt
	if state != "open" {
		if !closedAt.Valid || current.State == "open" {
			closedAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
		}
	} else {
		closedAt = pgtype.Timestamptz{}
	}

	fixedByID := current.FixedByID
	fixedByAgentSessionID := uuidString(current.FixedByAgentSessionID)
	fixedAt := current.FixedAt
	verifiedByID := current.VerifiedByID
	verifiedByAgentSessionID := uuidString(current.VerifiedByAgentSessionID)
	verifiedAt := current.VerifiedAt
	actorAgentSessionID := landingRequestAgentSessionID(ctx)
	now := time.Now().UTC()

	switch state {
	case "open", "closed":
		fixedByID = pgtype.Int8{}
		fixedByAgentSessionID = ""
		fixedAt = pgtype.Timestamptz{}
		verifiedByID = pgtype.Int8{}
		verifiedByAgentSessionID = ""
		verifiedAt = pgtype.Timestamptz{}
	case "fixed":
		if current.State != "fixed" {
			fixedByID = pgtype.Int8{Int64: actor.ID, Valid: true}
			fixedByAgentSessionID = actorAgentSessionID
			fixedAt = pgtype.Timestamptz{Time: now, Valid: true}
		}
		verifiedByID = pgtype.Int8{}
		verifiedByAgentSessionID = ""
		verifiedAt = pgtype.Timestamptz{}
	case "verified":
		if current.State != "verified" {
			if current.State != "fixed" {
				return IssueResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Issue", Field: "state", Code: "invalid_transition"})
			}
			if !issueVerifierDiffersFromFixer(current, actor.ID, actorAgentSessionID) {
				return IssueResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Issue", Field: "state", Code: "self_verification"})
			}
			verifiedByID = pgtype.Int8{Int64: actor.ID, Valid: true}
			verifiedByAgentSessionID = actorAgentSessionID
			verifiedAt = pgtype.Timestamptz{Time: now, Valid: true}
		}
	}

	milestoneID := current.MilestoneID
	if req.Milestone != nil {
		if req.Milestone.Value == nil {
			milestoneID = pgtype.Int8{}
		} else {
			validatedMilestoneID, milestoneErr := s.resolveIssueMilestone(ctx, repository.ID, req.Milestone.Value)
			if milestoneErr != nil {
				return IssueResponse{}, milestoneErr
			}
			milestoneID = validatedMilestoneID
		}
	}

	// Resolve assignees and labels BEFORE writing the issue row or deleting
	// existing associations, so a validation failure (unknown user, unknown
	// label) leaves the issue, counters, and associations untouched.
	var assigneeIDs []int64
	if req.Assignees != nil {
		assigneeIDs, err = s.resolveAssigneeUserIDs(ctx, *req.Assignees)
		if err != nil {
			return IssueResponse{}, err
		}
	}
	var labelIDs []int64
	if req.Labels != nil {
		labelIDs, err = s.resolveLabelIDs(ctx, repository.ID, *req.Labels)
		if err != nil {
			return IssueResponse{}, err
		}
	}

	// repositories.num_closed_issues is maintained by trg_issues_repo_counts_upd,
	// which fires only when the row's state actually transitions — two racing
	// closes of the same issue count once, not twice.
	//
	// The row write and the association replacement commit together, so a
	// failed association write cannot leave a half-applied update behind a 500.
	var assigneeSet, labelSet *[]int64
	if req.Assignees != nil {
		assigneeSet = &assigneeIDs
	}
	if req.Labels != nil {
		labelSet = &labelIDs
	}
	var updated db.Issue
	if err := s.withIssueWriteTx(ctx, func(tx issueWriteTx) error {
		editor, source := nativeIssueTextWriter(ctx, actor.ID)
		if werr := tx.SetIssueTextEditor(ctx, editor, source); werr != nil {
			return werr
		}
		var werr error
		updated, werr = tx.UpdateIssue(ctx, db.UpdateIssueParams{
			ID:                       current.ID,
			Title:                    title,
			Body:                     body,
			State:                    state,
			MilestoneID:              milestoneID,
			ClosedAt:                 closedAt,
			FixedByID:                fixedByID,
			FixedByAgentSessionID:    fixedByAgentSessionID,
			FixedAt:                  fixedAt,
			VerifiedByID:             verifiedByID,
			VerifiedByAgentSessionID: verifiedByAgentSessionID,
			VerifiedAt:               verifiedAt,
		})
		if werr != nil {
			return pkgerrors.Internal("failed to update issue").WithCause(werr)
		}
		return replaceIssueAssociations(ctx, tx, updated.ID, actor.ID, assigneeSet, labelSet)
	}); err != nil {
		return IssueResponse{}, err
	}

	mapped, err := s.mapIssue(ctx, updated)
	if err != nil {
		return IssueResponse{}, err
	}

	action := "edited"
	switch {
	case current.State != mapped.State:
		switch mapped.State {
		case "closed":
			action = "closed"
		case "fixed":
			action = "fixed"
		case "verified":
			action = "verified"
		case "open":
			action = "reopened"
		}
	case req.Assignees != nil:
		action = "assigned"
	case req.Labels != nil:
		action = "labeled"
	}
	eventBefore, eventAfter := issueUpdateEventDetails(action, current, mapped)
	s.recordIssueEvent(ctx, updated.ID, actor, action, eventBefore, eventAfter)
	if err := s.dispatchIssueEvent(ctx, owner, repository, actor, action, mapped); err != nil {
		return IssueResponse{}, err
	}

	return mapped, nil
}

// issueUpdateEventDetails builds the before/after payload halves for an issue
// update timeline event, matching the documented issue_events payload schema
// ({"type", "before"?, "after"?}).
func issueUpdateEventDetails(action string, current db.Issue, mapped IssueResponse) (before, after map[string]any) {
	switch action {
	case "closed", "reopened", "fixed", "verified":
		after := map[string]any{"state": mapped.State}
		if action == "fixed" {
			after["fixed_by"] = mapped.FixedBy
			after["fixed_at"] = mapped.FixedAt.Time
		}
		if action == "verified" {
			after["verified_by"] = mapped.VerifiedBy
			after["verified_at"] = mapped.VerifiedAt.Time
		}
		return map[string]any{"state": current.State}, after
	case "assigned":
		logins := make([]string, 0, len(mapped.Assignees))
		for _, assignee := range mapped.Assignees {
			logins = append(logins, assignee.Login)
		}
		return nil, map[string]any{"assignees": logins}
	case "labeled":
		names := make([]string, 0, len(mapped.Labels))
		for _, label := range mapped.Labels {
			names = append(names, label.Name)
		}
		return nil, map[string]any{"labels": names}
	default:
		return nil, map[string]any{"title": mapped.Title}
	}
}

func issueVerifierDiffersFromFixer(issue db.Issue, verifierUserID int64, verifierAgentSessionID string) bool {
	fixerAgentSessionID := uuidString(issue.FixedByAgentSessionID)
	if fixerAgentSessionID != "" {
		return verifierAgentSessionID == "" || verifierAgentSessionID != fixerAgentSessionID
	}
	return verifierAgentSessionID != "" || !issue.FixedByID.Valid || issue.FixedByID.Int64 != verifierUserID
}

func (s *IssueService) GetIssueComment(ctx context.Context, viewer *db.User, owner, repo string, commentID int64) (IssueCommentResponse, error) {
	if commentID <= 0 {
		return IssueCommentResponse{}, pkgerrors.BadRequest("invalid comment id")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return IssueCommentResponse{}, err
	}
	if err := s.requireReadAccess(ctx, repository, viewer); err != nil {
		return IssueCommentResponse{}, err
	}

	// Scope the comment to the resolved repository: authorization was checked
	// against the URL's repo, so the accessed comment's parent issue must
	// belong to that same repo. Otherwise a globally-unique comment id from
	// another repository could be read (IDOR / cross-tenant). Return the same
	// "comment not found" for the wrong-repo and no-rows cases so cross-repo
	// probing is indistinguishable from a nonexistent comment.
	issue, err := s.queries.GetIssueByCommentID(ctx, commentID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return IssueCommentResponse{}, pkgerrors.NotFound("comment not found")
		}
		return IssueCommentResponse{}, pkgerrors.Internal("failed to get comment").WithCause(err)
	}
	if issue.RepositoryID != repository.ID || requireIssueVisibility(issue, viewer) != nil {
		return IssueCommentResponse{}, pkgerrors.NotFound("comment not found")
	}

	comment, err := s.queries.GetIssueCommentByID(ctx, commentID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return IssueCommentResponse{}, pkgerrors.NotFound("comment not found")
		}
		return IssueCommentResponse{}, pkgerrors.Internal("failed to get comment").WithCause(err)
	}
	return mapIssueComment(comment), nil
}

func (s *IssueService) CreateIssueComment(ctx context.Context, actor *db.User, owner, repo string, number int64, req CreateIssueCommentInput) (IssueCommentResponse, error) {
	if actor == nil {
		return IssueCommentResponse{}, pkgerrors.Unauthorized("authentication required")
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		return IssueCommentResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "IssueComment", Field: "body", Code: "missing_field"})
	}
	if verr := validateSafeText("IssueComment", "body", body); verr != nil {
		return IssueCommentResponse{}, verr
	}

	repository, issue, err := s.resolveWritableIssue(ctx, actor, owner, repo, number)
	if err != nil {
		return IssueCommentResponse{}, err
	}

	if len(req.IdempotencyKey) > 128 {
		return IssueCommentResponse{}, pkgerrors.BadRequest("message identity is too long")
	}
	persona := []byte("{}")
	if req.Persona != nil {
		if issue.Kind != "chat" {
			return IssueCommentResponse{}, pkgerrors.BadRequest("personas require a chat issue")
		}
		if err := validateIssuePersona(*req.Persona); err != nil {
			return IssueCommentResponse{}, err
		}
		persona, _ = json.Marshal(req.Persona)
	}
	// The comment's writer is the person acting; a run credential names no
	// one, and neither does the issue-sync intake, whose text an external
	// account wrote under the owner's name.
	commenter := actor.Username
	editor, _ := nativeIssueTextWriter(ctx, actor.ID)
	if req.externalCommenter != "" {
		commenter, editor = req.externalCommenter, ""
	}
	var comment db.IssueComment
	err = s.withIssueWriteTx(ctx, func(tx issueWriteTx) error {
		if werr := tx.SetIssueTextEditor(ctx, editor, ""); werr != nil {
			return werr
		}
		var werr error
		comment, werr = tx.CreateIssueComment(ctx, db.CreateIssueCommentParams{Persona: persona, IdempotencyKey: req.IdempotencyKey,
			IssueID:   issue.ID,
			UserID:    pgtype.Int8{Int64: actor.ID, Valid: true},
			Body:      body,
			Commenter: commenter,
		})
		if werr != nil {
			if stdErrors.Is(werr, pgx.ErrNoRows) {
				return pkgerrors.Conflict("message identity was deleted or has different content")
			}
			return pkgerrors.Internal("failed to create issue comment").WithCause(werr)
		}
		return nil
	})
	if err != nil {
		return IssueCommentResponse{}, err
	}

	// issues.comment_count is maintained by trg_issue_comments_count_ins.

	mapped := mapIssueComment(comment)
	_ = s.dispatchIssueCommentEvent(ctx, owner, repository, actor, issue, "created", mapped)

	// Process @mentions in the comment body. Errors are non-fatal.
	if s.mentionSvc != nil && issue.Kind != "chat" {
		authorID := pgtype.Int8{Int64: actor.ID, Valid: true}
		issueID := pgtype.Int8{Int64: issue.ID, Valid: true}
		commentID := pgtype.Int8{Int64: comment.ID, Valid: true}
		subject := fmt.Sprintf("mentioned you in a comment on issue #%d", issue.Number)
		_ = s.mentionSvc.ProcessMentions(ctx, body, MentionContext{
			RepositoryID: repository.ID,
			IssueID:      issueID,
			CommentType:  "issue_comment",
			CommentID:    commentID,
			AuthorUserID: authorID,
		}, subject)
	}

	return mapped, nil
}

// ListIssueComments returns a page of comments using stable keyset pagination.
// afterID is the exclusive lower bound on comment ID (ASC order); 0 means first page.
// limit controls the page size (clamped to [1, maxPerPage]).
// Returns items, next cursor (empty string if no more pages), total count, and error.
func (s *IssueService) ListIssueComments(ctx context.Context, viewer *db.User, owner, repo string, number int64, afterID int64, limit int) ([]IssueCommentResponse, string, int64, error) {
	_, issue, err := s.resolveReadableIssue(ctx, viewer, owner, repo, number)
	if err != nil {
		return nil, "", 0, err
	}

	if limit <= 0 {
		limit = defaultPerPage
	}
	if limit > maxPerPage {
		limit = maxPerPage
	}

	total, err := s.queries.CountIssueCommentsByIssue(ctx, issue.ID)
	if err != nil {
		return nil, "", 0, pkgerrors.Internal("failed to count issue comments").WithCause(err)
	}

	rows, err := s.queries.ListIssueCommentsByIssueKeyset(ctx, db.ListIssueCommentsByIssueKeysetParams{
		IssueID:  issue.ID,
		AfterID:  afterID,
		PageSize: int32(limit),
	})
	if err != nil {
		return nil, "", 0, pkgerrors.Internal("failed to list issue comments").WithCause(err)
	}

	items := make([]IssueCommentResponse, 0, len(rows))
	for _, row := range rows {
		items = append(items, mapIssueComment(row))
	}

	var nextCursor string
	if len(rows) == limit {
		// Same opaque base64 scheme as encodeIssueNumberCursor — the comment
		// list route also decodes via decodeIDCursor, so a plain decimal ID
		// would decode to 0 and pin the client to page 1.
		nextCursor = encodeIssueNumberCursor(rows[len(rows)-1].ID)
	}

	return items, nextCursor, total, nil
}

func (s *IssueService) UpdateIssueComment(ctx context.Context, actor *db.User, owner, repo string, commentID int64, req UpdateIssueCommentInput) (IssueCommentResponse, error) {
	if actor == nil {
		return IssueCommentResponse{}, pkgerrors.Unauthorized("authentication required")
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		return IssueCommentResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "IssueComment", Field: "body", Code: "missing_field"})
	}
	if verr := validateSafeText("IssueComment", "body", body); verr != nil {
		return IssueCommentResponse{}, verr
	}

	if commentID <= 0 {
		return IssueCommentResponse{}, pkgerrors.BadRequest("invalid comment id")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return IssueCommentResponse{}, err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return IssueCommentResponse{}, err
	}

	issue, err := s.queries.GetIssueByCommentID(ctx, commentID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return IssueCommentResponse{}, pkgerrors.NotFound("issue comment not found")
		}
		return IssueCommentResponse{}, pkgerrors.Internal("failed to load issue comment").WithCause(err)
	}
	if issue.RepositoryID != repository.ID || requireIssueVisibility(issue, actor) != nil {
		return IssueCommentResponse{}, pkgerrors.NotFound("issue comment not found")
	}

	editor, _ := nativeIssueTextWriter(ctx, actor.ID)
	if req.externalCommenter {
		editor = ""
	}
	var updated db.IssueComment
	err = s.withIssueWriteTx(ctx, func(tx issueWriteTx) error {
		if werr := tx.SetIssueTextEditor(ctx, editor, ""); werr != nil {
			return werr
		}
		var werr error
		updated, werr = tx.UpdateIssueComment(ctx, db.UpdateIssueCommentParams{ID: commentID, Body: body})
		if werr != nil {
			if stdErrors.Is(werr, pgx.ErrNoRows) {
				return pkgerrors.NotFound("issue comment not found")
			}
			return pkgerrors.Internal("failed to update issue comment").WithCause(werr)
		}
		return nil
	})
	if err != nil {
		return IssueCommentResponse{}, err
	}

	mapped := mapIssueComment(updated)
	_ = s.dispatchIssueCommentEvent(ctx, owner, repository, actor, issue, "edited", mapped)
	return mapped, nil
}

func (s *IssueService) DeleteIssueComment(ctx context.Context, actor *db.User, owner, repo string, commentID int64) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	if commentID <= 0 {
		return pkgerrors.BadRequest("invalid comment id")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return err
	}

	issue, err := s.queries.GetIssueByCommentID(ctx, commentID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("issue comment not found")
		}
		return pkgerrors.Internal("failed to load issue comment").WithCause(err)
	}
	if issue.RepositoryID != repository.ID || requireIssueVisibility(issue, actor) != nil {
		return pkgerrors.NotFound("issue comment not found")
	}

	comment, fetchErr := s.queries.GetIssueCommentByID(ctx, commentID)
	if fetchErr != nil && !stdErrors.Is(fetchErr, pgx.ErrNoRows) {
		return pkgerrors.Internal("failed to load issue comment for webhook dispatch").WithCause(fetchErr)
	}

	// issues.comment_count is maintained by trg_issue_comments_count_del,
	// which fires only when a row is actually removed — two racing deletes of
	// the same comment decrement once, not twice. Reactions on the comment are
	// removed by trg_issue_comments_delete_reactions.
	if err := s.queries.DeleteIssueComment(ctx, commentID); err != nil {
		return pkgerrors.Internal("failed to delete issue comment").WithCause(err)
	}

	// Dispatch issue_comment webhook with action "deleted" (non-fatal).
	if fetchErr == nil {
		mapped := mapIssueComment(comment)
		_ = s.dispatchIssueCommentEvent(ctx, owner, repository, actor, issue, "deleted", mapped)
	}
	return nil
}

func (s *IssueService) resolveReadableIssue(ctx context.Context, viewer *db.User, owner, repo string, number int64) (db.Repository, db.Issue, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return db.Repository{}, db.Issue{}, err
	}
	if err := s.requireReadAccess(ctx, repository, viewer); err != nil {
		return db.Repository{}, db.Issue{}, err
	}
	issue, err := s.getIssueByNumber(ctx, repository.ID, number)
	if err != nil {
		return db.Repository{}, db.Issue{}, err
	}
	if err := requireIssueVisibility(issue, viewer); err != nil {
		return db.Repository{}, db.Issue{}, err
	}
	return repository, issue, nil
}

func (s *IssueService) resolveWritableIssue(ctx context.Context, actor *db.User, owner, repo string, number int64) (db.Repository, db.Issue, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return db.Repository{}, db.Issue{}, err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return db.Repository{}, db.Issue{}, err
	}
	issue, err := s.getIssueByNumber(ctx, repository.ID, number)
	if err != nil {
		return db.Repository{}, db.Issue{}, err
	}
	if err := requireIssueVisibility(issue, actor); err != nil {
		return db.Repository{}, db.Issue{}, err
	}
	return repository, issue, nil
}

func (s *IssueService) getIssueByNumber(ctx context.Context, repositoryID, number int64) (db.Issue, error) {
	if number <= 0 {
		return db.Issue{}, pkgerrors.BadRequest("invalid issue number")
	}
	issue, err := s.queries.GetIssueByNumber(ctx, db.GetIssueByNumberParams{RepositoryID: repositoryID, Number: number})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Issue{}, pkgerrors.NotFound("issue not found")
		}
		return db.Issue{}, pkgerrors.Internal("failed to load issue").WithCause(err)
	}
	return issue, nil
}

func (s *IssueService) mapIssue(ctx context.Context, issue db.Issue) (IssueResponse, error) {
	author, err := s.queries.GetUserByID(ctx, issue.AuthorID)
	if err != nil {
		return IssueResponse{}, pkgerrors.Internal("failed to load issue author").WithCause(err)
	}

	assigneeRows, err := s.queries.ListIssueAssignees(ctx, issue.ID)
	if err != nil {
		return IssueResponse{}, pkgerrors.Internal("failed to load issue assignees").WithCause(err)
	}
	assignees := make([]IssueUserSummary, 0, len(assigneeRows))
	for _, assignee := range assigneeRows {
		assignees = append(assignees, IssueUserSummary{ID: assignee.ID, Login: assignee.Username})
	}

	labels, err := s.listAllLabelsForIssue(ctx, issue.ID)
	if err != nil {
		return IssueResponse{}, err
	}

	var milestoneID any
	if issue.MilestoneID.Valid {
		milestoneID = issue.MilestoneID.Int64
	}

	var linear *LinearIssueReference
	if q, ok := s.queries.(issueLinearMapQuerier); ok {
		issueMap, mapErr := q.GetLinearIssueMapBySmithersIssueID(ctx, issue.ID)
		switch {
		case mapErr == nil:
			ref := linearIssueReference(issueMap.LinearIdentifier)
			linear = &ref
		case stdErrors.Is(mapErr, pgx.ErrNoRows):
			// An issue without a mapping is represented explicitly as JSON null.
		default:
			return IssueResponse{}, pkgerrors.Internal("failed to load Linear issue link")
		}
	}

	var fixedBy *IssueUserSummary
	if issue.FixedByID.Valid {
		user, userErr := s.queries.GetUserByID(ctx, issue.FixedByID.Int64)
		if userErr != nil {
			return IssueResponse{}, pkgerrors.Internal("failed to load issue fixer").WithCause(userErr)
		}
		fixedBy = &IssueUserSummary{ID: user.ID, Login: user.Username, AgentSessionID: uuidString(issue.FixedByAgentSessionID)}
	}
	var verifiedBy *IssueUserSummary
	if issue.VerifiedByID.Valid {
		user, userErr := s.queries.GetUserByID(ctx, issue.VerifiedByID.Int64)
		if userErr != nil {
			return IssueResponse{}, pkgerrors.Internal("failed to load issue verifier").WithCause(userErr)
		}
		verifiedBy = &IssueUserSummary{ID: user.ID, Login: user.Username, AgentSessionID: uuidString(issue.VerifiedByAgentSessionID)}
	}
	linkedChanges := []IssueLinkedChange{}
	if q, ok := s.queries.(issueLinkedChangesQuerier); ok {
		rows, linkErr := q.ListLinkedChangesForIssue(ctx, issue.ID)
		if linkErr != nil {
			return IssueResponse{}, pkgerrors.Internal("failed to load linked changes").WithCause(linkErr)
		}
		for _, row := range rows {
			linkedChanges = append(linkedChanges, IssueLinkedChange{
				ChangeID: row.ChangeID, CommitID: row.CommitID, Description: row.Description,
				LinkType: row.LinkType, LinkedAt: row.CreatedAt,
			})
		}
	}

	return IssueResponse{
		IdempotencyKey: issue.IdempotencyKey,
		Kind:           issue.Kind,
		Visibility:     issueVisibility(issue),
		ID:             issue.ID,
		Number:         issue.Number,
		Title:          issue.Title,
		Body:           issue.Body,
		State:          issue.State,
		Author:         IssueUserSummary{ID: author.ID, Login: author.Username},
		Assignees:      assignees,
		Labels:         labels,
		Linear:         linear,
		MilestoneID:    milestoneID,
		CommentCount:   issue.CommentCount,
		ClosedAt:       issue.ClosedAt,
		FixedBy:        fixedBy,
		FixedAt:        issue.FixedAt,
		VerifiedBy:     verifiedBy,
		VerifiedAt:     issue.VerifiedAt,
		LinkedChanges:  linkedChanges,
		CreatedAt:      issue.CreatedAt,
		UpdatedAt:      issue.UpdatedAt,
	}, nil
}

func mapIssueComment(comment db.IssueComment) IssueCommentResponse {
	return IssueCommentResponse{
		IdempotencyKey: comment.IdempotencyKey,
		Persona:        comment.Persona,
		ID:             comment.ID,
		IssueID:        comment.IssueID,
		UserID:         comment.UserID.Int64,
		Commenter:      comment.Commenter,
		Body:           comment.Body,
		Type:           comment.Type,
		CreatedAt:      comment.CreatedAt,
		UpdatedAt:      comment.UpdatedAt,
	}
}

func (s *IssueService) dispatchIssueEvent(ctx context.Context, owner string, repository db.Repository, actor *db.User, action string, issue IssueResponse) error {
	if issue.Kind == "chat" {
		return nil
	}
	sender := issueSenderPayload(actor)
	repositoryPayload := issueRepositoryPayload(owner, repository)

	payload := webhooks.IssueEventPayload{
		Action:     action,
		Issue:      issuePayloadFromResponse(issue),
		Repository: repositoryPayload,
		Sender:     sender,
	}

	if s.dispatcher != nil {
		if err := s.dispatcher.DispatchEvent(ctx, repository.ID, webhooks.EventTypeIssues, payload); err != nil {
			return pkgerrors.Internal("failed to enqueue webhook delivery").WithCause(err)
		}
	}

	if s.workflowRunSvc != nil {
		input := newWorkflowEventDispatchInput(repository, actor, "issues", action, issueWorkflowInputs(owner, repository, payload.Issue, payload.Sender, action))
		if _, err := s.workflowRunSvc.DispatchForEvent(ctx, input); err != nil {
			slog.Error("workflow dispatch for issues failed", "repo_id", repository.ID, "action", action, "error", err)
		}
	}
	return nil
}

func issueWorkflowInputs(owner string, repository db.Repository, issue webhooks.IssuePayload, sender webhooks.UserPayload, action string) map[string]any {
	repositoryPayload := issueRepositoryPayload(owner, repository)
	inputs := map[string]any{
		"action":      action,
		"issue":       issue,
		"repository":  repositoryPayload,
		"sender":      sender,
		"issueId":     issue.ID,
		"issueNumber": issue.Number,
		"issueTitle":  issue.Title,
		"issueBody":   issue.Body,
		"issueState":  issue.State,
		"issueAuthor": issue.Author.Login,
		"issueLabels": issueLabelNamesFromPayload(issue.Labels),
		"labels":      issueLabelsToWorkflowInputsFromPayload(issue.Labels),
		"repoName":    repository.Name,
	}
	if owner != "" {
		inputs["repoOwner"] = owner
		inputs["repoFullName"] = repositoryPayload.FullName
	}
	return inputs
}

func issueLabelNamesFromPayload(labels []webhooks.IssueLabelPayload) []string {
	if len(labels) == 0 {
		return nil
	}
	names := make([]string, 0, len(labels))
	for _, label := range labels {
		names = append(names, label.Name)
	}
	return names
}

func issueLabelsToWorkflowInputsFromPayload(labels []webhooks.IssueLabelPayload) []map[string]any {
	if len(labels) == 0 {
		return nil
	}
	items := make([]map[string]any, 0, len(labels))
	for _, label := range labels {
		items = append(items, map[string]any{
			"name":        label.Name,
			"color":       label.Color,
			"description": label.Description,
		})
	}
	return items
}

func (s *IssueService) dispatchIssueCommentEvent(ctx context.Context, owner string, repository db.Repository, actor *db.User, issue db.Issue, action string, comment IssueCommentResponse) error {
	if issue.Kind == "chat" {
		return nil
	}
	sender := issueSenderPayload(actor)
	repositoryPayload := issueRepositoryPayload(owner, repository)
	issuePayload := s.issuePayloadForDispatch(ctx, issue)

	payload := webhooks.IssueCommentEventPayload{
		Action: action,
		Issue:  issuePayload,
		Comment: webhooks.IssueCommentPayload{
			ID:        comment.ID,
			IssueID:   issue.ID,
			Body:      comment.Body,
			Commenter: comment.Commenter,
			User:      sender,
			CreatedAt: comment.CreatedAt,
			UpdatedAt: comment.UpdatedAt,
		},
		Repository: repositoryPayload,
		Sender:     sender,
	}

	if s.dispatcher != nil {
		if err := s.dispatcher.DispatchEvent(ctx, repository.ID, webhooks.EventTypeIssueComment, payload); err != nil {
			return pkgerrors.Internal("failed to enqueue issue comment webhook delivery").WithCause(err)
		}
	}

	if s.workflowRunSvc != nil {
		inputs := issueWorkflowInputs(owner, repository, payload.Issue, payload.Sender, action)
		inputs["comment"] = payload.Comment
		input := newWorkflowEventDispatchInput(repository, actor, "issue_comment", action, inputs)
		if _, err := s.workflowRunSvc.DispatchForEvent(ctx, input); err != nil {
			slog.Error("workflow dispatch for issue_comment failed", "repo_id", repository.ID, "action", action, "error", err)
		}
	}
	return nil
}

func (s *IssueService) issuePayloadForDispatch(ctx context.Context, issue db.Issue) webhooks.IssuePayload {
	mapped, err := s.mapIssue(ctx, issue)
	if err != nil {
		slog.Error("load issue details for dispatch failed", "issue_id", issue.ID, "error", err)
		return issuePayloadFromRecord(issue, nil, nil, nil)
	}
	return issuePayloadFromResponse(mapped)
}

func issueSenderPayload(actor *db.User) webhooks.UserPayload {
	if actor == nil {
		return webhooks.UserPayload{}
	}
	return webhooks.UserPayload{
		ID:    actor.ID,
		Login: actor.Username,
	}
}

func issueRepositoryPayload(owner string, repository db.Repository) webhooks.RepositoryPayload {
	payload := webhooks.RepositoryPayload{
		ID:   repository.ID,
		Name: repository.Name,
	}
	if owner != "" {
		payload.FullName = owner + "/" + repository.Name
	}
	return payload
}

func issuePayloadFromResponse(issue IssueResponse) webhooks.IssuePayload {
	payload := webhooks.IssuePayload{
		ID:        issue.ID,
		Number:    issue.Number,
		Title:     issue.Title,
		Body:      issue.Body,
		State:     issue.State,
		Author:    webhooks.UserPayload{ID: issue.Author.ID, Login: issue.Author.Login},
		Assignees: issueAssigneePayloads(issue.Assignees),
		Labels:    issueLabelPayloads(issue.Labels),
		CreatedAt: issue.CreatedAt,
		UpdatedAt: issue.UpdatedAt,
	}
	if issue.FixedBy != nil {
		payload.FixedBy = &webhooks.UserPayload{ID: issue.FixedBy.ID, Login: issue.FixedBy.Login}
		payload.FixedByAgentSessionID = issue.FixedBy.AgentSessionID
	}
	if issue.FixedAt.Valid {
		fixedAt := issue.FixedAt.Time
		payload.FixedAt = &fixedAt
	}
	if issue.VerifiedBy != nil {
		payload.VerifiedBy = &webhooks.UserPayload{ID: issue.VerifiedBy.ID, Login: issue.VerifiedBy.Login}
		payload.VerifiedByAgentSessionID = issue.VerifiedBy.AgentSessionID
	}
	if issue.VerifiedAt.Valid {
		verifiedAt := issue.VerifiedAt.Time
		payload.VerifiedAt = &verifiedAt
	}
	return payload
}

func issuePayloadFromRecord(issue db.Issue, author *db.User, assignees []db.ListIssueAssigneesRow, labels []db.Label) webhooks.IssuePayload {
	payload := webhooks.IssuePayload{
		ID:        issue.ID,
		Number:    issue.Number,
		Title:     issue.Title,
		Body:      issue.Body,
		State:     issue.State,
		Assignees: issueAssigneePayloadsFromDBRows(assignees),
		Labels:    issueLabelPayloadsFromDB(labels),
		CreatedAt: issue.CreatedAt,
		UpdatedAt: issue.UpdatedAt,
	}
	if author != nil {
		payload.Author = webhooks.UserPayload{ID: author.ID, Login: author.Username}
	}
	if issue.FixedByID.Valid {
		payload.FixedBy = &webhooks.UserPayload{ID: issue.FixedByID.Int64}
		payload.FixedByAgentSessionID = uuidString(issue.FixedByAgentSessionID)
	}
	if issue.FixedAt.Valid {
		fixedAt := issue.FixedAt.Time
		payload.FixedAt = &fixedAt
	}
	if issue.VerifiedByID.Valid {
		payload.VerifiedBy = &webhooks.UserPayload{ID: issue.VerifiedByID.Int64}
		payload.VerifiedByAgentSessionID = uuidString(issue.VerifiedByAgentSessionID)
	}
	if issue.VerifiedAt.Valid {
		verifiedAt := issue.VerifiedAt.Time
		payload.VerifiedAt = &verifiedAt
	}
	return payload
}

func issueAssigneePayloads(assignees []IssueUserSummary) []webhooks.UserPayload {
	if len(assignees) == 0 {
		return nil
	}
	payloads := make([]webhooks.UserPayload, 0, len(assignees))
	for _, assignee := range assignees {
		payloads = append(payloads, webhooks.UserPayload{
			ID:    assignee.ID,
			Login: assignee.Login,
		})
	}
	return payloads
}

func issueAssigneePayloadsFromDBRows(assignees []db.ListIssueAssigneesRow) []webhooks.UserPayload {
	if len(assignees) == 0 {
		return nil
	}
	payloads := make([]webhooks.UserPayload, 0, len(assignees))
	for _, assignee := range assignees {
		payloads = append(payloads, webhooks.UserPayload{
			ID:    assignee.ID,
			Login: assignee.Username,
		})
	}
	return payloads
}

func issueLabelPayloads(labels []LabelSummary) []webhooks.IssueLabelPayload {
	if len(labels) == 0 {
		return nil
	}
	payloads := make([]webhooks.IssueLabelPayload, 0, len(labels))
	for _, label := range labels {
		payloads = append(payloads, webhooks.IssueLabelPayload{
			ID:          label.ID,
			Name:        label.Name,
			Color:       label.Color,
			Description: label.Description,
		})
	}
	return payloads
}

func issueLabelPayloadsFromDB(labels []db.Label) []webhooks.IssueLabelPayload {
	if len(labels) == 0 {
		return nil
	}
	payloads := make([]webhooks.IssueLabelPayload, 0, len(labels))
	for _, label := range labels {
		payloads = append(payloads, webhooks.IssueLabelPayload{
			ID:          label.ID,
			Name:        label.Name,
			Color:       label.Color,
			Description: label.Description,
		})
	}
	return payloads
}

func newWorkflowEventDispatchInput(repository db.Repository, actor *db.User, eventType, action string, inputs map[string]any) DispatchForEventInput {
	input := DispatchForEventInput{
		RepositoryID: repository.ID,
		Event: TriggerEvent{
			Type:   eventType,
			Action: action,
			Inputs: inputs,
		},
	}
	if actor != nil {
		input.UserID = actor.ID
	}
	return input
}

// resolveAssigneeUserIDs validates assignee usernames and resolves them to user
// IDs WITHOUT mutating anything. It must run before the issue row is written so
// an invalid assignee cannot leave a partially-applied mutation behind.
func (s *IssueService) resolveAssigneeUserIDs(ctx context.Context, usernames []string) ([]int64, error) {
	normalized, err := normalizeAssigneeUsernames(usernames)
	if err != nil {
		return nil, err
	}

	userIDs := make([]int64, 0, len(normalized))
	for _, username := range normalized {
		user, err := s.queries.GetUserByLowerUsername(ctx, username)
		if err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Issue", Field: "assignees", Code: "invalid"})
			}
			return nil, pkgerrors.Internal("failed to load assignee").WithCause(err)
		}
		userIDs = append(userIDs, user.ID)
	}
	return userIDs, nil
}

// resolveLabelIDs validates label names against the repository and resolves them
// to label IDs WITHOUT mutating anything. An empty/nil names slice resolves to
// nil (meaning "clear all labels" when applied).
func (s *IssueService) resolveLabelIDs(ctx context.Context, repositoryID int64, names []string) ([]int64, error) {
	if len(names) == 0 {
		return nil, nil
	}

	normalized, err := normalizeLabelNames(names)
	if err != nil {
		return nil, err
	}

	labels, err := s.queries.ListLabelsByNames(ctx, db.ListLabelsByNamesParams{
		RepositoryID: repositoryID,
		Names:        normalized,
	})
	if err != nil {
		return nil, pkgerrors.Internal("failed to load labels").WithCause(err)
	}
	if len(labels) != len(normalized) {
		return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Issue", Field: "labels", Code: "invalid"})
	}

	labelIDs := make([]int64, 0, len(labels))
	for _, label := range labels {
		labelIDs = append(labelIDs, label.ID)
	}
	return labelIDs, nil
}

// recordIssueEvent persists a timeline row (read back via GET /issues/{n}/events)
// for a successful issue mutation. Payload follows the documented issue_events
// schema: {"type": string, "before"?: any, "after"?: any}. Failures are logged
// rather than surfaced: the mutation already committed, so a timeline write
// error must not turn the response into a 500.
func (s *IssueService) recordIssueEvent(ctx context.Context, issueID int64, actor *db.User, eventType string, before, after map[string]any) {
	payload := map[string]any{"type": eventType}
	if before != nil {
		payload["before"] = before
	}
	if after != nil {
		payload["after"] = after
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		slog.Error("issue timeline event payload not encodable", "issue_id", issueID, "event_type", eventType, "error", err)
		raw = []byte(`{}`)
	}

	actorID := pgtype.Int8{}
	if actor != nil {
		actorID = pgtype.Int8{Int64: actor.ID, Valid: true}
	}
	if _, err := s.queries.CreateIssueEvent(ctx, db.CreateIssueEventParams{
		IssueID:   issueID,
		ActorID:   actorID,
		EventType: eventType,
		Payload:   raw,
	}); err != nil {
		slog.Error("issue timeline event not recorded", "issue_id", issueID, "event_type", eventType, "error", err)
	}
}

func (s *IssueService) listAllLabelsForIssue(ctx context.Context, issueID int64) ([]LabelSummary, error) {
	total, err := s.queries.CountLabelsForIssue(ctx, issueID)
	if err != nil {
		return nil, pkgerrors.Internal("failed to count issue labels").WithCause(err)
	}
	if total == 0 {
		return []LabelSummary{}, nil
	}

	labels := make([]LabelSummary, 0, int(total))
	offset := int32(0)
	for int64(len(labels)) < total {
		pageSize := int32(maxPerPage)
		remaining := total - int64(len(labels))
		if remaining < int64(pageSize) {
			pageSize = int32(remaining)
		}

		rows, err := s.queries.ListLabelsForIssue(ctx, db.ListLabelsForIssueParams{
			IssueID:    issueID,
			PageOffset: offset,
			PageSize:   pageSize,
		})
		if err != nil {
			return nil, pkgerrors.Internal("failed to load issue labels").WithCause(err)
		}
		if len(rows) == 0 {
			break
		}

		for _, row := range rows {
			labels = append(labels, LabelSummary{
				ID:          row.ID,
				Name:        row.Name,
				Color:       row.Color,
				Description: row.Description,
			})
		}
		offset += int32(len(rows))
	}
	return labels, nil
}

func (s *IssueService) resolveIssueMilestone(ctx context.Context, repositoryID int64, milestone *int64) (pgtype.Int8, error) {
	if milestone == nil {
		return pgtype.Int8{}, nil
	}
	if *milestone <= 0 {
		return pgtype.Int8{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Issue", Field: "milestone", Code: "invalid"})
	}

	_, err := s.queries.GetMilestoneByID(ctx, db.GetMilestoneByIDParams{
		RepositoryID: repositoryID,
		ID:           *milestone,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pgtype.Int8{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Issue", Field: "milestone", Code: "invalid"})
		}
		return pgtype.Int8{}, pkgerrors.Internal("failed to load milestone").WithCause(err)
	}
	return pgtype.Int8{Int64: *milestone, Valid: true}, nil
}

func normalizeAssigneeUsernames(usernames []string) ([]string, error) {
	seen := make(map[string]struct{}, len(usernames))
	result := make([]string, 0, len(usernames))
	for _, raw := range usernames {
		username := strings.ToLower(strings.TrimSpace(raw))
		if username == "" {
			return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Issue", Field: "assignees", Code: "invalid"})
		}
		if _, ok := seen[username]; ok {
			continue
		}
		seen[username] = struct{}{}
		result = append(result, username)
	}
	return result, nil
}

func normalizeIssueFilterState(raw string) (string, error) {
	state := strings.ToLower(strings.TrimSpace(raw))
	// GitHub's API treats state=all (and an empty value) as "no state filter".
	if state == "" || state == "all" {
		return "", nil
	}
	if state != "open" && state != "closed" && state != "fixed" && state != "verified" {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Issue", Field: "state", Code: "invalid"})
	}
	return state, nil
}

func normalizeIssueState(raw string) (string, error) {
	state := strings.ToLower(strings.TrimSpace(raw))
	if state != "open" && state != "closed" && state != "fixed" && state != "verified" {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Issue", Field: "state", Code: "invalid"})
	}
	return state, nil
}

func (s *IssueService) resolveRepoByOwnerAndName(ctx context.Context, owner, repo string) (db.Repository, error) {
	lowerOwner := strings.ToLower(strings.TrimSpace(owner))
	lowerRepo := strings.ToLower(strings.TrimSpace(repo))
	if lowerOwner == "" {
		return db.Repository{}, pkgerrors.BadRequest("owner is required")
	}
	if lowerRepo == "" {
		return db.Repository{}, pkgerrors.BadRequest("repository name is required")
	}

	repository, err := s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
		Owner:     lowerOwner,
		LowerName: lowerRepo,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Repository{}, pkgerrors.NotFound("repository not found")
		}
		return db.Repository{}, pkgerrors.Internal("failed to load repository").WithCause(err)
	}
	return repository, nil
}

func (s *IssueService) requireReadAccess(ctx context.Context, repository db.Repository, viewer *db.User) error {
	if repository.IsPublic {
		return nil
	}
	if viewer == nil {
		return pkgerrors.Forbidden("permission denied")
	}
	allowed, err := s.canReadRepo(ctx, repository, viewer.ID)
	if err != nil {
		return err
	}
	if !allowed {
		return pkgerrors.Forbidden("permission denied")
	}
	return nil
}

func (s *IssueService) requireWriteAccess(ctx context.Context, repository db.Repository, actor *db.User) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	allowed, err := s.canWriteRepo(ctx, repository, actor.ID)
	if err != nil {
		return err
	}
	if !allowed {
		return pkgerrors.Forbidden("permission denied")
	}
	return nil
}

func (s *IssueService) canReadRepo(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canReadRepo(ctx, s.queries, repository, userID)
}

func (s *IssueService) canWriteRepo(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canWriteRepo(ctx, s.queries, repository, userID)
}

// Chat privacy is independent of repository visibility and collaborator grants.
func requireIssueVisibility(issue db.Issue, viewer *db.User) error {
	if issue.Kind == "chat" && (viewer == nil || viewer.ID != issue.AuthorID) {
		return pkgerrors.NotFound("issue not found")
	}
	return nil
}
func issueVisibility(issue db.Issue) string {
	if issue.Kind == "chat" {
		return "private"
	}
	return "repository"
}

var issuePersonaEmoji = regexp.MustCompile(`^:[a-z0-9_+'\-]{1,100}:$`)
var issuePersonaURL = regexp.MustCompile(`^https://\S+$`)

func validateIssuePersona(p IssuePersona) error {
	if strings.TrimSpace(p.Username) == "" || utf8.RuneCountInString(p.Username) > 80 || (p.IconEmoji != "" && p.IconURL != "") || (p.IconURL != "" && (len(p.IconURL) > 2008 || !issuePersonaURL.MatchString(p.IconURL))) || (p.IconEmoji != "" && !issuePersonaEmoji.MatchString(p.IconEmoji)) {
		return pkgerrors.BadRequest("invalid persona")
	}
	return nil
}
