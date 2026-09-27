package services

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"log/slog"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/diffview"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/ownership"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

// maxLandingStackChanges caps the number of change IDs in a single landing
// request. Landing creation inserts one row per change ID and the landing
// worker later loads the full stack, so an unbounded list lets a repo writer
// exhaust database and worker memory with one request.
const maxLandingStackChanges = 1024

const (
	landingStateOpen    = "open"
	landingStateClosed  = "closed"
	landingStateMerged  = "merged"
	landingStateDraft   = "draft"
	landingStateQueued  = "queued"
	landingStateLanding = "landing"
	landingStateFailed  = "failed"
)

type CreateLandingRequestInput struct {
	RequestID      string   `json:"-"`
	Title          string   `json:"title"`
	Body           string   `json:"body"`
	TargetBookmark string   `json:"target_bookmark"`
	SourceBookmark string   `json:"source_bookmark"`
	ChangeIDs      []string `json:"change_ids"`
}

type UpdateLandingRequestInput struct {
	Title          *string `json:"title,omitempty"`
	Body           *string `json:"body,omitempty"`
	State          *string `json:"state,omitempty"`
	TargetBookmark *string `json:"target_bookmark,omitempty"`
	SourceBookmark *string `json:"source_bookmark,omitempty"`
	ConflictStatus *string `json:"conflict_status,omitempty"`
}

type SetAutoLandInput struct {
	Enabled bool `json:"enabled"`
}

type CreateLandingReviewInput struct {
	Type             string `json:"type"`
	Body             string `json:"body"`
	Verdict          string `json:"verdict"`
	ConfidenceBucket string `json:"confidence_bucket"`
	Summary          string `json:"summary"`
	CommitID         string `json:"commit_id"`
}

type CreateLandingReviewRequestInput struct {
	Reviewer string `json:"reviewer"`
	Agent    string `json:"agent"`
}

type CreateLandingCommentInput struct {
	Path     string `json:"path"`
	Line     int64  `json:"line"`
	Side     string `json:"side"`
	Body     string `json:"body"`
	CommitID string `json:"commit_id"`
}

type LandLandingRequestInput struct {
	CommitID         string               `json:"commit_id"`
	ExpectedCommitID *string              `json:"-"`
	Append           *repohost.LandAppend `json:"-"`
}

// LandingReviewResponse represents a review on a landing request.
type LandingReviewResponse struct {
	ID        int64                `json:"id"`
	Body      string               `json:"body"`
	State     string               `json:"state"`
	Author    LandingRequestAuthor `json:"user"`
	CreatedAt time.Time            `json:"created_at"`
	UpdatedAt time.Time            `json:"updated_at"`
}

// LandingCommentResponse adds the live anchor location to the immutable
// revision-pinned comment row. State is the review-thread lifecycle (open,
// done, or resolved), while AnchorState reports whether the revision-pinned
// anchor is current, moved, or stale. Line remains the original revision's
// line; CurrentLine is populated when that same hunk now appears at a new line.
type LandingCommentResponse struct {
	db.LandingRequestComment
	AnchorState string `json:"anchor_state"`
	CurrentLine int64  `json:"current_line,omitempty"`
	UserLogin   string `json:"user_login"`
}

type LandingRequestAuthor struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
}

type LandingChangeResponse struct {
	db.LandingRequestChange
	CommitID    string `json:"commit_id"`
	Description string `json:"description"`
	AuthorName  string `json:"author_name"`
	Timestamp   string `json:"timestamp"`
}

// LandingReviewRequestResponse identifies the human or named agent asked to
// review a landing request and preserves the requester for review history.
type LandingReviewRequestResponse struct {
	ID          int64                 `json:"id"`
	RequestedBy LandingRequestAuthor  `json:"requested_by"`
	Reviewer    *LandingRequestAuthor `json:"reviewer"`
	Agent       string                `json:"agent,omitempty"`
	State       string                `json:"state"`
	CreatedAt   time.Time             `json:"created_at"`
}

// LandingRequestTurn identifies the event that most recently handed work to
// the author or reviewer side. ActorID is text because user IDs are numeric
// while agent-session IDs are UUIDs. ActorLogin is the user's login or the
// agent session's display title.
type LandingRequestTurn struct {
	Party      string    `json:"party"`
	ActorID    string    `json:"actor_id"`
	ActorLogin string    `json:"actor_login"`
	Since      time.Time `json:"since"`
	Reason     string    `json:"reason"`
}

// LandingBlock is one unsatisfied requirement reported by the existing
// landing gate. Optional fields let each gate identify its subject without
// forcing clients to parse error messages.
type LandingBlock struct {
	Kind       string   `json:"kind"`
	Name       string   `json:"name,omitempty"`
	Repo       string   `json:"repo,omitempty"`
	Missing    string   `json:"missing,omitempty"`
	Count      int64    `json:"count,omitempty"`
	Path       string   `json:"path,omitempty"`
	Candidates []string `json:"candidates,omitempty"`
}

type LandingAutoLand struct {
	Enabled   bool                  `json:"enabled"`
	SetBy     *LandingRequestAuthor `json:"set_by"`
	SetAt     *time.Time            `json:"set_at"`
	WaitingOn []LandingBlock        `json:"waiting_on"`
}

type LandingRequestResponse struct {
	RequestID      string                         `json:"request_id,omitempty"`
	Number         int64                          `json:"number"`
	Title          string                         `json:"title"`
	Body           string                         `json:"body"`
	State          string                         `json:"state"`
	Author         LandingRequestAuthor           `json:"author"`
	ChangeIDs      []string                       `json:"change_ids"`
	TargetBookmark string                         `json:"target_bookmark"`
	ConflictStatus string                         `json:"conflict_status"`
	StackSize      int64                          `json:"stack_size"`
	AgentAuthored  bool                           `json:"agent_authored"`
	Turn           LandingRequestTurn             `json:"turn"`
	ReviewRequests []LandingReviewRequestResponse `json:"review_requests"`
	AutoLand       LandingAutoLand                `json:"auto_land"`
	LandablePrefix int64                          `json:"landable_prefix"`
	BlockedBy      map[string][]LandingBlock      `json:"blocked_by"`
	CreatedAt      time.Time                      `json:"created_at"`
	UpdatedAt      time.Time                      `json:"updated_at"`
	// GitHubMerge is the receipt of a landing merged by its GitHub pull request.
	GitHubMerge *LandingGitHubMergeReceipt `json:"github_merge,omitempty"`
}

type LandingGitHubMergeReceipt struct {
	Repository  string `json:"repository"`
	PullNumber  int64  `json:"pull_number"`
	HeadSHA     string `json:"head_sha"`
	MergeCommit string `json:"merge_commit"`
}

type LandingConflict struct {
	FilePath     string `json:"file_path"`
	ConflictType string `json:"conflict_type"`
}

type LandingConflictsResponse struct {
	ConflictStatus    string                       `json:"conflict_status"`
	HasConflicts      bool                         `json:"has_conflicts"`
	ConflictsByChange map[string][]LandingConflict `json:"conflicts_by_change,omitempty"`
}

// LandLandingRequestAccepted is the response returned when a landing request
// is enqueued for async processing. The HTTP handler returns 202 Accepted.
type LandLandingRequestAccepted struct {
	LandingRequestResponse
	QueuePosition int64 `json:"queue_position"`
	TaskID        int64 `json:"task_id"`
}

type LandingQuerier interface {
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)

	CreateLandingRequest(ctx context.Context, arg db.CreateLandingRequestParams) (db.LandingRequest, error)
	AddLandingRequestChange(ctx context.Context, arg db.AddLandingRequestChangeParams) (db.LandingRequestChange, error)
	DeleteLandingRequestChanges(ctx context.Context, landingRequestID int64) error
	UpdateLandingRequest(ctx context.Context, arg db.UpdateLandingRequestParams) (db.LandingRequest, error)
	MergeLandingRequest(ctx context.Context, id int64) (db.LandingRequest, error)
	EnqueueLandingRequest(ctx context.Context, arg db.EnqueueLandingRequestParams) (db.LandingRequest, error)
	RevertLandingRequestToOpen(ctx context.Context, id int64) (db.LandingRequest, error)
	CreateLandingTask(ctx context.Context, arg db.CreateLandingTaskParams) (db.LandingTask, error)
	GetLandingTaskByLandingRequestID(ctx context.Context, landingRequestID int64) (db.LandingTask, error)
	GetLandingQueuePositionByTaskID(ctx context.Context, id int64) (int64, error)
	GetLatestCommitStatusesByChangeIDsAndContexts(ctx context.Context, arg db.GetLatestCommitStatusesByChangeIDsAndContextsParams) ([]db.GetLatestCommitStatusesByChangeIDsAndContextsRow, error)
	ListLatestCommitStatusesByChangeIDsAndContexts(ctx context.Context, arg db.ListLatestCommitStatusesByChangeIDsAndContextsParams) ([]db.ListLatestCommitStatusesByChangeIDsAndContextsRow, error)

	GetLandingRequestWithChangeIDsByNumber(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error)
	ListLandingRequestsWithChangeIDsByRepoFiltered(ctx context.Context, arg db.ListLandingRequestsWithChangeIDsByRepoFilteredParams) ([]db.ListLandingRequestsWithChangeIDsByRepoFilteredRow, error)
	ListLandingRequestsByRepoFilteredKeyset(ctx context.Context, arg db.ListLandingRequestsByRepoFilteredKeysetParams) ([]db.ListLandingRequestsByRepoFilteredKeysetRow, error)
	CountLandingRequestsByRepoFiltered(ctx context.Context, arg db.CountLandingRequestsByRepoFilteredParams) (int64, error)

	ListLandingRequestReviews(ctx context.Context, arg db.ListLandingRequestReviewsParams) ([]db.LandingRequestReview, error)
	CountLandingRequestReviews(ctx context.Context, landingRequestID int64) (int64, error)
	CreateLandingRequestReview(ctx context.Context, arg db.CreateLandingRequestReviewParams) (db.LandingRequestReview, error)
	GetLandingRequestChangeRevisionByCommitID(ctx context.Context, arg db.GetLandingRequestChangeRevisionByCommitIDParams) (db.ChangeRevision, error)
	UpdateLandingRequestReviewState(ctx context.Context, arg db.UpdateLandingRequestReviewStateParams) (db.LandingRequestReview, error)
	GetLandingRequestReviewByID(ctx context.Context, id int64) (db.LandingRequestReview, error)

	ListLandingRequestComments(ctx context.Context, arg db.ListLandingRequestCommentsParams) ([]db.LandingRequestComment, error)
	CountLandingRequestComments(ctx context.Context, landingRequestID int64) (int64, error)
	CountUnresolvedLandingRequestThreads(ctx context.Context, landingRequestID int64) (int64, error)
	CreateLandingRequestComment(ctx context.Context, arg db.CreateLandingRequestCommentParams) (db.LandingRequestComment, error)
	GetLandingRequestCommentByID(ctx context.Context, arg db.GetLandingRequestCommentByIDParams) (db.LandingRequestComment, error)
	MarkLandingRequestThreadDone(ctx context.Context, arg db.MarkLandingRequestThreadDoneParams) (db.LandingRequestComment, error)
	AckLandingRequestThread(ctx context.Context, arg db.AckLandingRequestThreadParams) (db.LandingRequestComment, error)
	ReopenLandingRequestThread(ctx context.Context, arg db.ReopenLandingRequestThreadParams) (db.LandingRequestComment, error)

	ListLandingRequestChanges(ctx context.Context, arg db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error)
	CountLandingRequestChanges(ctx context.Context, landingRequestID int64) (int64, error)
	GetChangeByChangeID(ctx context.Context, arg db.GetChangeByChangeIDParams) (db.Change, error)
	ListAllProtectedBookmarksByRepo(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error)
	CountApprovedLandingRequestReviews(ctx context.Context, landingRequestID int64) (int64, error)

	// Mention queries (used by MentionService wired into CreateLandingRequest/CreateLandingComment).
	GetUserByLowerUsername(ctx context.Context, lowerUsername string) (db.User, error)
	CreateMention(ctx context.Context, arg db.CreateMentionParams) (db.Mention, error)
	DeleteMentionsForComment(ctx context.Context, arg db.DeleteMentionsForCommentParams) error
}

type LandingAgentTurnDispatchInput struct {
	SessionID    string
	RepositoryID int64
	UserID       int64
	RepoOwner    string
	RepoName     string
	Number       int64
	Feedback     string
}

type landingTurnQuerier interface {
	UpdateLandingRequestTurn(ctx context.Context, arg db.UpdateLandingRequestTurnParams) (db.LandingRequest, error)
}

type landingReviewRequestQuerier interface {
	CreateLandingReviewRequest(ctx context.Context, arg db.CreateLandingReviewRequestParams) (db.LandingReviewRequest, error)
	ListLandingReviewRequests(ctx context.Context, landingRequestID int64) ([]db.LandingReviewRequest, error)
	DismissLandingReviewRequest(ctx context.Context, arg db.DismissLandingReviewRequestParams) (db.LandingReviewRequest, error)
	FulfillLandingReviewRequestsForUser(ctx context.Context, arg db.FulfillLandingReviewRequestsForUserParams) error
	FulfillLandingReviewRequestsForAgent(ctx context.Context, arg db.FulfillLandingReviewRequestsForAgentParams) error
}

// LandingAgentTurnDispatcher resumes an agent-authored landing request when a
// reviewer hands the turn back to its author.
type LandingAgentTurnDispatcher interface {
	DispatchLandingAuthorTurn(ctx context.Context, input LandingAgentTurnDispatchInput) error
}

type landingAutoLandQuerier interface {
	SetLandingRequestAutoLand(ctx context.Context, arg db.SetLandingRequestAutoLandParams) (db.LandingRequest, error)
	ClearLandingRequestAutoLand(ctx context.Context, id int64) (db.LandingRequest, error)
	ClaimAutoLandCandidate(ctx context.Context) (db.LandingRequest, error)
	EnqueueAutoLandRequest(ctx context.Context, arg db.EnqueueAutoLandRequestParams) (db.LandingRequest, error)
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetOrgByID(ctx context.Context, id int64) (db.Organization, error)
}

type LandingRepoHostClient interface {
	LandChanges(ctx context.Context, owner, repo string, req repohost.LandRequest) (repohost.LandResult, error)
	GetChangeConflicts(ctx context.Context, owner, repo, changeID string) ([]repohost.Conflict, error)
	GetChange(ctx context.Context, owner, repo, changeID string) (repohost.Change, error)
	GetChangeDiff(ctx context.Context, owner, repo, changeID string) (repohost.ChangeDiff, error)
	GetChangeFiles(ctx context.Context, owner, repo, changeID string) ([]repohost.ChangeFile, error)
	GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error)
}

type landingOwnershipQuerier interface {
	ownershipQueries
	UpsertChange(ctx context.Context, arg db.UpsertChangeParams) (db.Change, error)
	CountCurrentApprovedLandingRequestReviews(ctx context.Context, arg db.CountCurrentApprovedLandingRequestReviewsParams) (int64, error)
}

type landingRevisionQuerier interface {
	ListChangeRevisions(ctx context.Context, arg db.ListChangeRevisionsParams) ([]db.ChangeRevision, error)
}

type landingRevisionDiffRepoHost interface {
	GetRevisionDiff(ctx context.Context, owner, repo, changeID, fromCommitID, toCommitID, path string) (repohost.ChangeDiff, error)
}

type landingAgentReviewQuerier interface {
	CountCurrentAgentLandingReviewCommits(ctx context.Context, arg db.CountCurrentAgentLandingReviewCommitsParams) (int64, error)
}

type landingBookmarkRepoHost interface {
	ListBookmarks(ctx context.Context, owner, repo string, cursor string, limit int) ([]repohost.Bookmark, string, error)
}

// landingCreateTx is a transaction handle for the coupled CreateLandingRequest +
// AddLandingRequestChange writes. It exposes only the query methods needed inside
// the transaction plus Commit/Rollback.
type landingCreateTx interface {
	CreateLandingRequest(ctx context.Context, arg db.CreateLandingRequestParams) (db.LandingRequest, error)
	AddLandingRequestChange(ctx context.Context, arg db.AddLandingRequestChangeParams) (db.LandingRequestChange, error)
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

// landingCreateTxManager begins a new transaction for the create-landing-request
// write path. Abstracting this behind an interface keeps the service unit-testable
// without a real pgxpool.Pool.
type landingCreateTxManager interface {
	BeginCreateTx(ctx context.Context) (landingCreateTx, error)
}

// landingLandTx is a transaction handle for the coupled EnqueueLandingRequest +
// landing task write. Wrapping both in one transaction guarantees a landing
// request is never left 'queued' without a claimable task.
type landingLandTx interface {
	EnqueueLandingRequest(ctx context.Context, arg db.EnqueueLandingRequestParams) (db.LandingRequest, error)
	EnqueueAutoLandRequest(ctx context.Context, arg db.EnqueueAutoLandRequestParams) (db.LandingRequest, error)
	ResetOrCreateLandingTask(ctx context.Context, arg db.CreateLandingTaskParams) (db.LandingTask, error)
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

// landingLandTxManager begins a new transaction for the land (enqueue) write path.
type landingLandTxManager interface {
	BeginLandTx(ctx context.Context) (landingLandTx, error)
}

// pgxLandingCreateTxManager is the production implementation backed by pgxpool.
type pgxLandingCreateTxManager struct {
	pool *pgxpool.Pool
}

func (m *pgxLandingCreateTxManager) BeginCreateTx(ctx context.Context) (landingCreateTx, error) {
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &pgxLandingCreateTx{
		tx: tx,
		q:  db.New(tx),
	}, nil
}

type pgxLandingCreateTx struct {
	tx pgx.Tx
	q  *db.Queries
}

func (t *pgxLandingCreateTx) CreateLandingRequest(ctx context.Context, arg db.CreateLandingRequestParams) (db.LandingRequest, error) {
	return t.q.CreateLandingRequest(ctx, arg)
}

func (t *pgxLandingCreateTx) AddLandingRequestChange(ctx context.Context, arg db.AddLandingRequestChangeParams) (db.LandingRequestChange, error) {
	return t.q.AddLandingRequestChange(ctx, arg)
}

func (t *pgxLandingCreateTx) Commit(ctx context.Context) error {
	return t.tx.Commit(ctx)
}

func (t *pgxLandingCreateTx) Rollback(ctx context.Context) error {
	return t.tx.Rollback(ctx)
}

func (m *pgxLandingCreateTxManager) BeginLandTx(ctx context.Context) (landingLandTx, error) {
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &pgxLandingLandTx{
		tx: tx,
		q:  db.New(tx),
	}, nil
}

type pgxLandingLandTx struct {
	tx pgx.Tx
	q  *db.Queries
}

func (t *pgxLandingLandTx) EnqueueLandingRequest(ctx context.Context, arg db.EnqueueLandingRequestParams) (db.LandingRequest, error) {
	return t.q.EnqueueLandingRequest(ctx, arg)
}

func (t *pgxLandingLandTx) EnqueueAutoLandRequest(ctx context.Context, arg db.EnqueueAutoLandRequestParams) (db.LandingRequest, error) {
	return t.q.EnqueueAutoLandRequest(ctx, arg)
}

// ResetOrCreateLandingTask creates the landing task for a landing request, or
// resets an existing finished (failed/done) task back to pending so a landing
// request can be re-landed. landing_tasks has UNIQUE(landing_request_id), so a
// plain INSERT would fail with a unique violation on every re-land of a failed
// request. Returns pgx.ErrNoRows when the existing task is still pending or
// running (an active task must never be reset out from under the worker).
func (t *pgxLandingLandTx) ResetOrCreateLandingTask(ctx context.Context, arg db.CreateLandingTaskParams) (db.LandingTask, error) {
	return t.q.ResetOrCreateLandingTask(ctx, db.ResetOrCreateLandingTaskParams(arg))
}

func (t *pgxLandingLandTx) Commit(ctx context.Context) error {
	return t.tx.Commit(ctx)
}

func (t *pgxLandingLandTx) Rollback(ctx context.Context) error {
	return t.tx.Rollback(ctx)
}

type LandingService struct {
	metrics         LandingMetricsObserver
	queries         LandingQuerier
	repoHost        LandingRepoHostClient
	createTxManager landingCreateTxManager
	landTxManager   landingLandTxManager
	dispatcher      webhooks.Dispatcher
	mentionSvc      *MentionService
	notifSvc        *NotificationService
	workflowRunSvc  WorkflowRunService
	agentTurn       LandingAgentTurnDispatcher
}

type LandingMetricsObserver interface{ ObserveLandingOperation(operation string) }

type LandingServiceOption func(*LandingService)

func WithLandingMetrics(metrics LandingMetricsObserver) LandingServiceOption {
	return func(s *LandingService) { s.metrics = metrics }
}

func (s *LandingService) observeLanding(operation string) {
	if s.metrics != nil {
		s.metrics.ObserveLandingOperation(operation)
	}
}

func WithLandingWebhookDispatcher(dispatcher webhooks.Dispatcher) LandingServiceOption {
	return func(s *LandingService) {
		s.dispatcher = dispatcher
	}
}

// WithLandingMentionService wires a MentionService into LandingService so that
// @mentions in landing request bodies and comments automatically create notifications.
func WithLandingMentionService(mentionSvc *MentionService) LandingServiceOption {
	return func(s *LandingService) {
		s.mentionSvc = mentionSvc
	}
}

// WithLandingNotificationService wires a NotificationService into LandingService so
// that watchers receive notifications when a new landing request is opened.
func WithLandingNotificationService(notifSvc *NotificationService) LandingServiceOption {
	return func(s *LandingService) {
		s.notifSvc = notifSvc
	}
}

// WithLandingWorkflowRunService wires a WorkflowRunService into LandingService
// so that landing request events trigger matching workflow runs.
func WithLandingWorkflowRunService(svc WorkflowRunService) LandingServiceOption {
	return func(s *LandingService) {
		s.workflowRunSvc = svc
	}
}

func WithLandingAgentTurnDispatcher(dispatcher LandingAgentTurnDispatcher) LandingServiceOption {
	return func(s *LandingService) {
		s.agentTurn = dispatcher
	}
}

// SetAgentTurnDispatcher completes production wiring after AgentService is
// constructed. LandingService is created earlier because pair sessions use it.
func (s *LandingService) SetAgentTurnDispatcher(dispatcher LandingAgentTurnDispatcher) {
	s.agentTurn = dispatcher
}

func NewLandingService(q LandingQuerier, rh LandingRepoHostClient, opts ...LandingServiceOption) *LandingService {
	s := &LandingService{
		queries:  q,
		repoHost: rh,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

// NewLandingServiceWithPool returns a LandingService that wraps
// CreateLandingRequest + AddLandingRequestChange in a database transaction.
func NewLandingServiceWithPool(q LandingQuerier, rh LandingRepoHostClient, pool *pgxpool.Pool, opts ...LandingServiceOption) *LandingService {
	if pool == nil {
		return NewLandingService(q, rh, opts...)
	}
	txManager := &pgxLandingCreateTxManager{pool: pool}
	s := &LandingService{
		queries:         q,
		repoHost:        rh,
		createTxManager: txManager,
		landTxManager:   txManager,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

// ListLandingRequests returns a page of landing requests using stable keyset pagination.
// afterNumber is the exclusive lower bound on landing number (DESC order); 0 means first page.
// limit controls the page size (clamped to [1, maxPerPage]).
// Returns items, next cursor (empty string if no more pages), total count, and error.
func (s *LandingService) ListLandingRequests(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]LandingRequestResponse, string, int64, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, "", 0, err
	}
	if err := s.requireReadAccess(ctx, repository, viewer); err != nil {
		return nil, "", 0, err
	}

	normalizedState, err := normalizeLandingFilterState(state)
	if err != nil {
		return nil, "", 0, err
	}

	if limit <= 0 {
		limit = defaultPerPage
	}
	if limit > maxPerPage {
		limit = maxPerPage
	}

	total, err := s.queries.CountLandingRequestsByRepoFiltered(ctx, db.CountLandingRequestsByRepoFilteredParams{
		RepositoryID: repository.ID,
		State:        normalizedState,
	})
	if err != nil {
		return nil, "", 0, pkgerrors.Internal("failed to count landing requests").WithCause(err)
	}

	rows, err := s.queries.ListLandingRequestsByRepoFilteredKeyset(ctx, db.ListLandingRequestsByRepoFilteredKeysetParams{
		RepositoryID: repository.ID,
		State:        normalizedState,
		AfterNumber:  afterNumber,
		PageSize:     int32(limit),
	})
	if err != nil {
		return nil, "", 0, pkgerrors.Internal("failed to list landing requests").WithCause(err)
	}

	authors := make(map[int64]LandingRequestAuthor, len(rows))
	turnLogins := make(map[string]string, len(rows))
	items := make([]LandingRequestResponse, 0, len(rows))
	for _, row := range rows {
		record := landingRecordFromKeysetRow(row)
		author, err := s.resolveLandingAuthor(ctx, authors, record.AuthorID)
		if err != nil {
			return nil, "", 0, err
		}
		turnLogins[strconv.FormatInt(author.ID, 10)] = author.Login
		response := LandingRequestResponse{
			Number:         record.Number,
			Title:          record.Title,
			Body:           record.Body,
			State:          record.State,
			Author:         author,
			ChangeIDs:      row.ChangeIds,
			TargetBookmark: record.TargetBookmark,
			ConflictStatus: record.ConflictStatus,
			StackSize:      record.StackSize,
			AgentAuthored:  record.AgentAuthored,
			Turn:           resolveLandingTurnWithCache(ctx, s.queries, record.TurnParty, record.TurnActorID, record.TurnSince, record.TurnReason, turnLogins),
			ReviewRequests: []LandingReviewRequestResponse{},
			AutoLand:       LandingAutoLand{Enabled: record.AutoLandEnabled, WaitingOn: []LandingBlock{}},
			CreatedAt:      record.CreatedAt,
			UpdatedAt:      record.UpdatedAt,
		}
		response, err = s.populateAutoLandMetadata(ctx, record, response)
		if err != nil {
			return nil, "", 0, err
		}
		response, err = s.populateAutoLandWaiting(ctx, repository, owner, repo, landingRecordWithChangeIDs(record, row.ChangeIds), response)
		if err != nil {
			return nil, "", 0, err
		}
		if err := s.populateLandingReadiness(ctx, repository, owner, record.ID, record.TargetBookmark, record.ConflictStatus, row.ChangeIds, &response); err != nil {
			return nil, "", 0, err
		}
		if err := s.populateLandingReviewRequests(ctx, record.ID, &response); err != nil {
			return nil, "", 0, err
		}
		items = append(items, response)
	}

	var nextCursor string
	if len(rows) == limit {
		lastNumber := rows[len(rows)-1].Number
		// Encode with the canonical base64 cursor scheme routes.decodeIDCursor
		// consumes (base64-first). A plain-decimal cursor is itself valid base64url,
		// so it decodes to garbage -> 0 and pins the client to page 1.
		nextCursor = encodeIssueNumberCursor(lastNumber)
	}

	return items, nextCursor, total, nil
}

func (s *LandingService) CreateLandingRequest(ctx context.Context, actor *db.User, owner, repo string, req CreateLandingRequestInput) (LandingRequestResponse, error) {
	if actor == nil {
		return LandingRequestResponse{}, pkgerrors.Unauthorized("authentication required")
	}

	title := strings.TrimSpace(req.Title)
	if title == "" {
		return LandingRequestResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingRequest", Field: "title", Code: "missing_field"})
	}
	targetBookmark := strings.TrimSpace(req.TargetBookmark)
	if targetBookmark == "" {
		return LandingRequestResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingRequest", Field: "target_bookmark", Code: "missing_field"})
	}
	if isMythicalBookmark(targetBookmark) {
		return LandingRequestResponse{}, errMythicalBookmarkOwned
	}
	sourceBookmark := strings.TrimSpace(req.SourceBookmark)
	changeIDs, err := normalizeChangeIDs(req.ChangeIDs)
	if err != nil {
		return LandingRequestResponse{}, err
	}

	for _, f := range []struct{ field, value string }{
		{"title", title},
		{"body", req.Body},
		{"source_bookmark", sourceBookmark},
		{"target_bookmark", targetBookmark},
	} {
		if verr := validateSafeText("LandingRequest", f.field, f.value); verr != nil {
			return LandingRequestResponse{}, verr
		}
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return LandingRequestResponse{}, err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return LandingRequestResponse{}, err
	}

	authorAgentSessionID := landingRequestAgentSessionID(ctx)
	createParams := db.CreateLandingRequestParams{
		RepositoryID:         repository.ID,
		Title:                title,
		Body:                 req.Body,
		AuthorID:             actor.ID,
		TargetBookmark:       targetBookmark,
		SourceBookmark:       sourceBookmark,
		StackSize:            int64(len(changeIDs)),
		AgentAuthored:        authorAgentSessionID != "" || landingRequestIsAgentAuthored(ctx),
		AuthorAgentSessionID: authorAgentSessionID,
	}

	if req.RequestID != "" {
		return s.createLandingIdempotent(ctx, repository, owner, actor, createParams, changeIDs, req.RequestID)
	}

	// When a transaction manager is available, wrap parent + child inserts atomically.
	if s.createTxManager != nil {
		created, err := s.createLandingInTx(ctx, createParams, changeIDs)
		if err != nil {
			return LandingRequestResponse{}, err
		}
		return s.afterCreate(ctx, repository, owner, actor, created, changeIDs, req.Body)
	}

	// Fallback: non-transactional path (backwards compatibility when no pool is injected).
	created, err := s.queries.CreateLandingRequest(ctx, createParams)
	if err != nil {
		return LandingRequestResponse{}, normalizeLandingCreateError(err, "failed to create landing request")
	}

	for idx, changeID := range changeIDs {
		_, err := s.queries.AddLandingRequestChange(ctx, db.AddLandingRequestChangeParams{
			LandingRequestID: created.ID,
			ChangeID:         changeID,
			PositionInStack:  int64(idx + 1),
		})
		if err != nil {
			return LandingRequestResponse{}, normalizeLandingCreateError(err, "failed to store landing request changes")
		}
	}

	return s.afterCreate(ctx, repository, owner, actor, created, changeIDs, req.Body)
}

// afterCreate handles the shared post-create logic for both the transactional
// and non-transactional paths: builds the API response, dispatches the
// "opened" webhook event, and processes @mentions in the body.
func (s *LandingService) afterCreate(ctx context.Context, repository db.Repository, owner string, actor *db.User, created db.LandingRequest, changeIDs []string, body string) (LandingRequestResponse, error) {
	if err := s.recordLandingSource(ctx, created.ID); err != nil {
		return LandingRequestResponse{}, err
	}
	s.observeLanding("create")
	mapped, err := s.buildCreateResponse(ctx, repository, owner, created, changeIDs)
	if err != nil {
		return LandingRequestResponse{}, err
	}
	if err := s.dispatchLandingRequestEvent(ctx, repository, actor, "opened", mapped); err != nil {
		return LandingRequestResponse{}, err
	}
	// Process @mentions in the landing request body. Errors are non-fatal.
	if s.mentionSvc != nil && body != "" {
		authorID := pgtype.Int8{Int64: actor.ID, Valid: true}
		lrID := pgtype.Int8{Int64: created.ID, Valid: true}
		subject := fmt.Sprintf("mentioned you in landing request #%d", created.Number)
		_ = s.mentionSvc.ProcessMentions(ctx, body, MentionContext{
			RepositoryID:     repository.ID,
			LandingRequestID: lrID,
			CommentType:      "landing_body",
			AuthorUserID:     authorID,
		}, subject)
	}

	// Notify repository watchers about the new landing request. Errors are non-fatal.
	if s.notifSvc != nil {
		subject := fmt.Sprintf("New landing request: %s (#%d)", created.Title, created.Number)
		s.notifSvc.NotifyWatchers(ctx, repository.ID, "landing", created.ID, subject, body)
	}

	return mapped, nil
}

// createLandingInTx performs the parent insert and all child change inserts
// inside a single database transaction. On any failure the transaction is
// rolled back so no orphan landing_requests row is left behind.
func (s *LandingService) createLandingInTx(ctx context.Context, params db.CreateLandingRequestParams, changeIDs []string) (db.LandingRequest, error) {
	tx, err := s.createTxManager.BeginCreateTx(ctx)
	if err != nil {
		return db.LandingRequest{}, normalizeLandingCreateError(err, "failed to begin landing request transaction")
	}

	created, err := tx.CreateLandingRequest(ctx, params)
	if err != nil {
		rollbackLandingTx(ctx, tx)
		return db.LandingRequest{}, normalizeLandingCreateError(err, "failed to create landing request")
	}

	for idx, changeID := range changeIDs {
		_, err := tx.AddLandingRequestChange(ctx, db.AddLandingRequestChangeParams{
			LandingRequestID: created.ID,
			ChangeID:         changeID,
			PositionInStack:  int64(idx + 1),
		})
		if err != nil {
			rollbackLandingTx(ctx, tx)
			return db.LandingRequest{}, normalizeLandingCreateError(err, "failed to store landing request changes")
		}
	}

	if err := tx.Commit(ctx); err != nil {
		rollbackLandingTx(ctx, tx)
		return db.LandingRequest{}, normalizeLandingCreateError(err, "failed to commit landing request transaction")
	}

	return created, nil
}

func rollbackLandingTx(ctx context.Context, tx landingCreateTx) {
	_ = tx.Rollback(ctx)
}

// buildCreateResponse constructs the API response for a newly created landing request.
func (s *LandingService) buildCreateResponse(ctx context.Context, repository db.Repository, owner string, created db.LandingRequest, changeIDs []string) (LandingRequestResponse, error) {
	author, err := s.queries.GetUserByID(ctx, created.AuthorID)
	if err != nil {
		return LandingRequestResponse{}, pkgerrors.Internal("failed to load landing request author").WithCause(err)
	}

	response := LandingRequestResponse{
		Number:         created.Number,
		RequestID:      uuidString(created.RequestID),
		Title:          created.Title,
		Body:           created.Body,
		State:          created.State,
		Author:         LandingRequestAuthor{ID: author.ID, Login: author.Username},
		ChangeIDs:      changeIDs,
		TargetBookmark: created.TargetBookmark,
		ConflictStatus: created.ConflictStatus,
		StackSize:      created.StackSize,
		AgentAuthored:  created.AgentAuthored,
		Turn: resolveLandingTurnWithCache(ctx, s.queries, created.TurnParty, created.TurnActorID, created.TurnSince, created.TurnReason, map[string]string{
			strconv.FormatInt(author.ID, 10): author.Username,
		}),
		ReviewRequests: []LandingReviewRequestResponse{},
		AutoLand:       LandingAutoLand{WaitingOn: []LandingBlock{}},
		CreatedAt:      created.CreatedAt,
		UpdatedAt:      created.UpdatedAt,
	}
	if err := s.populateLandingReadiness(ctx, repository, owner, created.ID, created.TargetBookmark, created.ConflictStatus, changeIDs, &response); err != nil {
		return LandingRequestResponse{}, err
	}
	return response, nil
}

func (s *LandingService) GetLandingRequest(ctx context.Context, viewer *db.User, owner, repo string, number int64) (LandingRequestResponse, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return LandingRequestResponse{}, err
	}
	if err := s.requireReadAccess(ctx, repository, viewer); err != nil {
		return LandingRequestResponse{}, err
	}

	row, err := s.getLandingByNumber(ctx, repository.ID, number)
	if err != nil {
		return LandingRequestResponse{}, err
	}
	response, err := s.mapLandingRow(ctx, repository, owner, row)
	if err != nil {
		return LandingRequestResponse{}, err
	}
	return s.populateAutoLandWaiting(ctx, repository, owner, repo, row, response)
}

// SetLandingRequestAutoLand records an authorized intent to enqueue this
// landing request once the ordinary landing gate has no blockers.
func (s *LandingService) SetLandingRequestAutoLand(ctx context.Context, actor *db.User, owner, repo string, number int64, req SetAutoLandInput) (LandingRequestResponse, error) {
	if actor == nil {
		return LandingRequestResponse{}, pkgerrors.Unauthorized("authentication required")
	}
	if !req.Enabled {
		return LandingRequestResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingRequestAutoLand", Field: "enabled", Code: "invalid"})
	}
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return LandingRequestResponse{}, err
	}
	if err := s.requireLandAccess(ctx, repository, actor); err != nil {
		return LandingRequestResponse{}, err
	}
	current, err := s.getLandingByNumber(ctx, repository.ID, number)
	if err != nil {
		return LandingRequestResponse{}, err
	}
	if current.State != landingStateOpen {
		return LandingRequestResponse{}, pkgerrors.Conflict("auto-land can only be enabled for an open landing request")
	}
	blocks, err := s.landingBlockers(ctx, repository, owner, repo, current)
	if err != nil {
		return LandingRequestResponse{}, err
	}
	q, ok := s.queries.(landingAutoLandQuerier)
	if !ok {
		return LandingRequestResponse{}, pkgerrors.Internal("auto-land store unavailable")
	}
	updated, err := q.SetLandingRequestAutoLand(ctx, db.SetLandingRequestAutoLandParams{SetBy: pgtype.Int8{Int64: actor.ID, Valid: true}, ID: current.ID})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return LandingRequestResponse{}, pkgerrors.Conflict("landing request changed; retry enabling auto-land")
		}
		return LandingRequestResponse{}, pkgerrors.Internal("failed to enable auto-land").WithCause(err)
	}
	row := landingRecordWithChangeIDs(updated, current.ChangeIds)
	response, err := s.mapLandingRow(ctx, repository, owner, row)
	if err != nil {
		return LandingRequestResponse{}, err
	}
	response.AutoLand.WaitingOn = blocks
	return response, nil
}

// ClearLandingRequestAutoLand clears a landing request's auto-land intent.
// The update is idempotent while the landing request exists.
func (s *LandingService) ClearLandingRequestAutoLand(ctx context.Context, actor *db.User, owner, repo string, number int64) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return err
	}
	if err := s.requireLandAccess(ctx, repository, actor); err != nil {
		return err
	}
	current, err := s.getLandingByNumber(ctx, repository.ID, number)
	if err != nil {
		return err
	}
	q, ok := s.queries.(landingAutoLandQuerier)
	if !ok {
		return pkgerrors.Internal("auto-land store unavailable")
	}
	if _, err := q.ClearLandingRequestAutoLand(ctx, current.ID); err != nil {
		return pkgerrors.Internal("failed to clear auto-land").WithCause(err)
	}
	return nil
}

func (s *LandingService) UpdateLandingRequest(ctx context.Context, actor *db.User, owner, repo string, number int64, req UpdateLandingRequestInput) (LandingRequestResponse, error) {
	if actor == nil {
		return LandingRequestResponse{}, pkgerrors.Unauthorized("authentication required")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return LandingRequestResponse{}, err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return LandingRequestResponse{}, err
	}

	current, err := s.getLandingByNumber(ctx, repository.ID, number)
	if err != nil {
		return LandingRequestResponse{}, err
	}

	// Freeze the merge target once a landing request has been enqueued. The
	// required-approval gate in LandLandingRequest is evaluated against
	// target_bookmark at enqueue time; letting a writer change target_bookmark or
	// source_bookmark while the request is queued/landing (or already merged)
	// would redirect an approved land onto a protected bookmark that never
	// received the required approvals — a check-time/use-time (TOCTOU) authz
	// bypass. Only block actual changes so idempotent re-sends still succeed.
	if req.TargetBookmark != nil && isMythicalBookmark(*req.TargetBookmark) {
		return LandingRequestResponse{}, errMythicalBookmarkOwned
	}
	switch current.State {
	case landingStateQueued, landingStateLanding, landingStateMerged:
		if req.TargetBookmark != nil && strings.TrimSpace(*req.TargetBookmark) != current.TargetBookmark {
			return LandingRequestResponse{}, pkgerrors.Conflict("target_bookmark cannot be changed after a landing request is enqueued")
		}
		if req.SourceBookmark != nil && strings.TrimSpace(*req.SourceBookmark) != current.SourceBookmark {
			return LandingRequestResponse{}, pkgerrors.Conflict("source_bookmark cannot be changed after a landing request is enqueued")
		}
	}

	title, err := applyOptionalTitle(current.Title, req.Title)
	if err != nil {
		return LandingRequestResponse{}, err
	}

	body := current.Body
	if req.Body != nil {
		body = *req.Body
	}

	state, err := applyOptionalState(current.State, req.State)
	if err != nil {
		return LandingRequestResponse{}, err
	}

	targetBookmark, err := applyOptionalBookmark(current.TargetBookmark, req.TargetBookmark, "target_bookmark")
	if err != nil {
		return LandingRequestResponse{}, err
	}

	sourceBookmark := current.SourceBookmark
	if req.SourceBookmark != nil {
		sourceBookmark = strings.TrimSpace(*req.SourceBookmark)
	}

	conflictStatus, err := applyOptionalConflictStatus(current.ConflictStatus, req.ConflictStatus)
	if err != nil {
		return LandingRequestResponse{}, err
	}

	shouldPersist := req.Title != nil || req.Body != nil || req.State != nil || req.TargetBookmark != nil || req.SourceBookmark != nil || req.ConflictStatus != nil
	persisted := db.LandingRequest{
		ID:             current.ID,
		RepositoryID:   current.RepositoryID,
		Number:         current.Number,
		Title:          current.Title,
		Body:           current.Body,
		State:          current.State,
		AuthorID:       current.AuthorID,
		TargetBookmark: current.TargetBookmark,
		SourceBookmark: current.SourceBookmark,
		ConflictStatus: current.ConflictStatus,
		StackSize:      current.StackSize,
		ClosedAt:       current.ClosedAt,
		MergedAt:       current.MergedAt,
		CreatedAt:      current.CreatedAt,
		UpdatedAt:      current.UpdatedAt,
	}

	if shouldPersist {
		closedAt := current.ClosedAt
		mergedAt := current.MergedAt
		if state == landingStateClosed {
			if !closedAt.Valid || current.State != landingStateClosed {
				closedAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
			}
		} else {
			closedAt = pgtype.Timestamptz{}
		}

		updatedRow, err := s.queries.UpdateLandingRequest(ctx, db.UpdateLandingRequestParams{
			Title:          title,
			Body:           body,
			State:          state,
			TargetBookmark: targetBookmark,
			SourceBookmark: sourceBookmark,
			ConflictStatus: conflictStatus,
			StackSize:      current.StackSize,
			ClosedAt:       closedAt,
			MergedAt:       mergedAt,
			ID:             current.ID,
			ExpectedState:  current.State,
		})
		if err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return LandingRequestResponse{}, pkgerrors.Conflict("landing request changed; retry the update")
			}
			return LandingRequestResponse{}, pkgerrors.Internal("failed to update landing request").WithCause(err)
		}
		persisted = updatedRow
	}

	mapped, err := s.mapLandingRecord(ctx, repository, owner, persisted, current.ChangeIds)
	if err != nil {
		return LandingRequestResponse{}, err
	}
	mapped, err = s.populateAutoLandWaiting(ctx, repository, owner, repo, landingRecordWithChangeIDs(persisted, current.ChangeIds), mapped)
	if err != nil {
		return LandingRequestResponse{}, err
	}
	action := "edited"
	if current.State != mapped.State {
		switch mapped.State {
		case landingStateClosed:
			action = "closed"
		case landingStateOpen:
			action = "reopened"
		}
	}
	if err := s.dispatchLandingRequestEvent(ctx, repository, actor, action, mapped); err != nil {
		return LandingRequestResponse{}, err
	}
	if req.ConflictStatus != nil && current.ConflictStatus != mapped.ConflictStatus {
		if err := s.dispatchLandingConflictEvent(ctx, repository, actor, current.ConflictStatus, mapped); err != nil {
			return LandingRequestResponse{}, err
		}
	}
	return mapped, nil
}

func (s *LandingService) LandLandingRequest(ctx context.Context, actor *db.User, owner, repo string, number int64, req LandLandingRequestInput) (LandLandingRequestAccepted, error) {
	if actor == nil {
		return LandLandingRequestAccepted{}, pkgerrors.Unauthorized("authentication required")
	}
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return LandLandingRequestAccepted{}, err
	}
	if err := s.requireLandAccess(ctx, repository, actor); err != nil {
		return LandLandingRequestAccepted{}, err
	}

	landingRow, err := s.getLandingByNumber(ctx, repository.ID, number)
	if err != nil {
		return LandLandingRequestAccepted{}, err
	}
	if landingRow.State != landingStateOpen && landingRow.State != landingStateFailed {
		return LandLandingRequestAccepted{}, pkgerrors.Conflict("landing request is not open or failed")
	}
	if len(landingRow.ChangeIds) == 0 {
		return LandLandingRequestAccepted{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingRequest", Field: "change_ids", Code: "invalid"})
	}
	appendRequest, appendRecovered, err := s.recoverLandingAppend(ctx, repository, owner, repo, landingRow, req)
	if err != nil {
		return LandLandingRequestAccepted{}, err
	}
	if !appendRecovered {
		unresolvedThreads, err := s.queries.CountUnresolvedLandingRequestThreads(ctx, landingRow.ID)
		if err != nil {
			return LandLandingRequestAccepted{}, pkgerrors.Internal("failed to count unresolved review comments").WithCause(err)
		}
		if unresolvedThreads > 0 {
			return LandLandingRequestAccepted{}, landingBlocked(
				[]LandingOwnerBlock{{Kind: "thread", Count: unresolvedThreads}},
				"landing request has unresolved review comments",
			)
		}

		revision, err := s.resolveLandingRevision(ctx, repository.ID, owner, repo, landingRow.ID, req.CommitID, "LandingRequest")
		if err != nil {
			return LandLandingRequestAccepted{}, err
		}
		selector := revision.ChangeID
		if req.Append != nil {
			selector = revision.CommitID
		}
		current, err := s.repoHost.GetChange(ctx, owner, repo, selector)
		if err != nil {
			return LandLandingRequestAccepted{}, mapLandingRepoHostError(err, "failed to load landing change")
		}
		if current.CommitID != revision.CommitID {
			return LandLandingRequestAccepted{}, pkgerrors.Conflict("landing revision no longer matches the change head")
		}

		// Guard against double-queueing: if an active (pending or running) task
		// already exists for this landing request, reject the request. This can
		// happen if the LR was reverted to open by a worker failure but a task is
		// still in flight (e.g. due to a slow claim query).
		if existingTask, err := s.queries.GetLandingTaskByLandingRequestID(ctx, landingRow.ID); err == nil {
			if existingTask.Status == "pending" || existingTask.Status == "append_pending" || existingTask.Status == "running" {
				return LandLandingRequestAccepted{}, pkgerrors.Conflict("landing request already has an active task")
			}
		} else if !stdErrors.Is(err, pgx.ErrNoRows) {
			return LandLandingRequestAccepted{}, pkgerrors.Internal("failed to check for existing landing task")
		}

		// Append pins its exact immutable request here; the existing worker
		// performs complete ownership, review and status inspection before any
		// mutation. Full mythical imports can exceed the public 30s deadline
		// during file inspection. A 202 means queued, never already validated.
		if req.Append == nil {
			blocks, err := s.landingBlockers(ctx, repository, owner, repo, landingRow)
			if err != nil {
				return LandLandingRequestAccepted{}, err
			}
			if len(blocks) > 0 {
				return LandLandingRequestAccepted{}, landingBlocked(blocks, "landing requirements are not satisfied")
			}
		}

		appendRequest, err = s.prepareLandingAppend(ctx, repository, owner, repo, landingRow, req)
		if err != nil {
			return LandLandingRequestAccepted{}, err
		}
	}
	enqueuedRow, task, err := s.enqueueLanding(ctx, actor, repository, landingRow, false, appendRequest)
	if err != nil {
		return LandLandingRequestAccepted{}, err
	}

	position, err := s.queries.GetLandingQueuePositionByTaskID(ctx, task.ID)
	if err != nil {
		return LandLandingRequestAccepted{}, pkgerrors.Internal("failed to determine queue position").WithCause(err)
	}

	resp, err := s.mapLandingRecord(ctx, repository, owner, enqueuedRow, landingRow.ChangeIds)
	if err != nil {
		return LandLandingRequestAccepted{}, err
	}
	if err := s.dispatchLandingRequestEvent(ctx, repository, actor, "queued", resp); err != nil {
		return LandLandingRequestAccepted{}, err
	}

	return LandLandingRequestAccepted{
		LandingRequestResponse: resp,
		QueuePosition:          position,
		TaskID:                 task.ID,
	}, nil
}

// landingBlockers evaluates the same gates used by both explicit and automatic
// landing. Keeping this as the sole pre-enqueue evaluator prevents auto-land
// from developing weaker or stronger policy semantics than the Land action.
func (s *LandingService) landingBlockers(ctx context.Context, repository db.Repository, owner, repo string, landingRow db.GetLandingRequestWithChangeIDsByNumberRow) ([]LandingBlock, error) {
	rules, err := s.queries.ListAllProtectedBookmarksByRepo(ctx, repository.ID)
	if err != nil {
		return nil, pkgerrors.Internal("failed to list protected bookmarks").WithCause(err)
	}
	requiredHumanApprovals, requireAgentLGTM, protectedContexts, err := landingProtectionRequirements(rules, landingRow.TargetBookmark)
	if err != nil {
		return nil, pkgerrors.Internal("invalid protected bookmark pattern").WithCause(err)
	}
	touched, revisions, err := s.syncLandingChangeRevisions(ctx, repository.ID, owner, repo, landingRow.ChangeIds)
	if err != nil {
		return nil, err
	}
	dismissStale, err := landingDismissStaleReviews(rules, landingRow.TargetBookmark)
	if err != nil {
		return nil, pkgerrors.Internal("invalid protected bookmark pattern").WithCause(err)
	}

	blocks := make([]LandingBlock, 0)
	if requiredHumanApprovals > 0 {
		var approvedCount int64
		if dismissStale {
			if q, ok := s.queries.(landingOwnershipQuerier); ok {
				approvedCount, err = q.CountCurrentApprovedLandingRequestReviews(ctx, db.CountCurrentApprovedLandingRequestReviewsParams{LandingRequestID: landingRow.ID, RepositoryID: repository.ID})
			} else {
				approvedCount, err = s.queries.CountApprovedLandingRequestReviews(ctx, landingRow.ID)
			}
		} else {
			approvedCount, err = s.queries.CountApprovedLandingRequestReviews(ctx, landingRow.ID)
		}
		if err != nil {
			return nil, pkgerrors.Internal("failed to count approved landing reviews").WithCause(err)
		}
		if approvedCount < requiredHumanApprovals {
			blocks = append(blocks, LandingBlock{Kind: "review", Missing: "human_approval", Count: requiredHumanApprovals - approvedCount})
		}
	}
	if requireAgentLGTM {
		commitIDs, err := landingRevisionCommitIDs(revisions)
		if err != nil {
			return nil, pkgerrors.Internal("failed to decode landing revision snapshot").WithCause(err)
		}
		q, ok := s.queries.(landingAgentReviewQuerier)
		if !ok {
			return nil, pkgerrors.Internal("agent review policy evaluator unavailable")
		}
		approvedCommits, err := q.CountCurrentAgentLandingReviewCommits(ctx, db.CountCurrentAgentLandingReviewCommitsParams{
			LandingRequestID: landingRow.ID,
			CommitIds:        commitIDs,
		})
		if err != nil {
			return nil, pkgerrors.Internal("failed to count current agent reviews").WithCause(err)
		}
		if len(commitIDs) == 0 || approvedCommits < int64(len(commitIDs)) {
			blocks = append(blocks, LandingBlock{Kind: "review", Missing: "agent_lgtm"})
		}
	}

	ownerBlocks, err := s.ownershipLandingBlockers(ctx, repository, owner, repo, landingRow, touched, dismissStale)
	if err != nil {
		return nil, err
	}
	blocks = append(blocks, ownerBlocks...)

	requiredContexts := unionLandingStatusContexts(protectedContexts, repository.LandingQueueRequiredChecks)
	if len(requiredContexts) > 0 {
		pins, err := landingRevisionPins(revisions)
		if err != nil {
			return nil, pkgerrors.Internal("invalid landing revision snapshot").WithCause(err)
		}
		failing, err := failingLandingStatusContexts(ctx, s.queries, repository.ID, landingRow.ChangeIds, requiredContexts, pins)
		if err != nil {
			return nil, pkgerrors.Internal("failed to load commit statuses for required checks").WithCause(err)
		}
		for _, contextName := range failing {
			blocks = append(blocks, LandingBlock{Kind: "check", Name: contextName, Repo: repository.Name})
		}
	}
	return blocks, nil
}

// ProcessNextAutoLand gives one enabled intent a fair turn, and enqueues it
// only when the shared landing gate is clear. It is called by the existing
// landing worker before that worker claims a queued task.
func (s *LandingService) ProcessNextAutoLand(ctx context.Context) error {
	q, ok := s.queries.(landingAutoLandQuerier)
	if !ok {
		return pkgerrors.Internal("auto-land store unavailable")
	}
	candidate, err := q.ClaimAutoLandCandidate(ctx)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return fmt.Errorf("claim auto-land intent: %w", err)
	}
	repository, err := q.GetRepoByID(ctx, candidate.RepositoryID)
	if err != nil {
		return fmt.Errorf("load auto-land repository: %w", err)
	}
	owner, err := s.autoLandRepositoryOwner(ctx, q, repository)
	if err != nil {
		return err
	}
	changes, err := s.queries.ListLandingRequestChanges(ctx, db.ListLandingRequestChangesParams{
		LandingRequestID: candidate.ID,
		PageOffset:       0,
		PageSize:         maxLandingStackChanges + 1,
	})
	if err != nil {
		return fmt.Errorf("load auto-land changes: %w", err)
	}
	if len(changes) == 0 || len(changes) > maxLandingStackChanges {
		return fmt.Errorf("auto-land request has invalid stack size: %d", len(changes))
	}
	changeIDs := make([]string, len(changes))
	for i, change := range changes {
		changeIDs[i] = change.ChangeID
	}
	row := landingRecordWithChangeIDs(candidate, changeIDs)
	blocks, err := s.landingBlockers(ctx, repository, owner, repository.Name, row)
	if err != nil {
		return err
	}
	if len(blocks) > 0 {
		return nil
	}
	if !candidate.AutoLandSetBy.Valid {
		return fmt.Errorf("auto-land request %d has no set_by actor", candidate.ID)
	}
	actor, err := s.queries.GetUserByID(ctx, candidate.AutoLandSetBy.Int64)
	if err != nil {
		return fmt.Errorf("load auto-land actor: %w", err)
	}
	enqueued, _, err := s.enqueueLanding(ctx, &actor, repository, row, true, nil)
	if err != nil {
		// Clearing the intent or changing the request while its gate was being
		// evaluated is a benign race; the conditional enqueue protects it.
		if apiErr, ok := err.(*pkgerrors.APIError); ok && apiErr.Status == 409 {
			return nil
		}
		return err
	}
	response, err := s.mapLandingRecord(ctx, repository, owner, enqueued, changeIDs)
	if err != nil {
		return err
	}
	return s.dispatchLandingRequestEvent(ctx, repository, &actor, "queued", response)
}

func (s *LandingService) autoLandRepositoryOwner(ctx context.Context, q landingAutoLandQuerier, repository db.Repository) (string, error) {
	if repository.UserID.Valid {
		user, err := s.queries.GetUserByID(ctx, repository.UserID.Int64)
		if err != nil {
			return "", fmt.Errorf("load auto-land repository owner: %w", err)
		}
		return user.Username, nil
	}
	if repository.OrgID.Valid {
		org, err := q.GetOrgByID(ctx, repository.OrgID.Int64)
		if err != nil {
			return "", fmt.Errorf("load auto-land organization owner: %w", err)
		}
		return org.Name, nil
	}
	return "", fmt.Errorf("auto-land repository %d has no owner", repository.ID)
}

type LandingOwnerBlock = LandingBlock

type LandingBlockedDetails struct {
	BlockedBy []LandingBlock `json:"blocked_by"`
}

func landingBlocked(blocks []LandingBlock, message string) error {
	return &pkgerrors.APIError{Status: 422, Code: pkgerrors.CodeLandingBlocked, Message: message, Details: LandingBlockedDetails{BlockedBy: blocks}}
}

func landingRequestIsAgentAuthored(ctx context.Context) bool {
	info := middleware.AuthInfoFromContext(ctx)
	return info != nil && info.IsTokenAuth && len(middleware.ParseTokenPathRestrictions(info.RawScopes)) > 0
}

func landingRequestAgentSessionID(ctx context.Context) string {
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || !info.IsTokenAuth {
		return ""
	}
	candidate := middleware.ParseTokenAgentSessionRestriction(info.RawScopes)
	parsed, err := uuid.Parse(candidate)
	if err != nil {
		return ""
	}
	return parsed.String()
}

func landingActionIsFromAuthor(ctx context.Context, landing db.GetLandingRequestWithChangeIDsByNumberRow, actor *db.User) bool {
	if landing.AgentAuthored {
		authorSessionID := uuidString(landing.AuthorAgentSessionID)
		if authorSessionID != "" {
			return landingRequestAgentSessionID(ctx) == authorSessionID
		}
		// Compatibility for agent-authored rows made before session-bound API
		// tokens existed.
		return landingRequestIsAgentAuthored(ctx)
	}
	return actor != nil && actor.ID == landing.AuthorID
}

func (s *LandingService) updateLandingTurn(
	ctx context.Context,
	repository db.Repository,
	owner string,
	landing db.GetLandingRequestWithChangeIDsByNumberRow,
	actor *db.User,
	party, reason, feedback string,
) error {
	actorID := ""
	if sessionID := landingRequestAgentSessionID(ctx); sessionID != "" {
		actorID = sessionID
	} else if actor != nil {
		actorID = strconv.FormatInt(actor.ID, 10)
	}
	turnQueries, ok := s.queries.(landingTurnQuerier)
	if !ok {
		return pkgerrors.Internal("landing turn store unavailable")
	}
	updated, err := turnQueries.UpdateLandingRequestTurn(ctx, db.UpdateLandingRequestTurnParams{
		ID:          landing.ID,
		TurnParty:   party,
		TurnActorID: actorID,
		TurnReason:  reason,
	})
	if err != nil {
		return pkgerrors.Internal("failed to update landing request turn").WithCause(err)
	}
	if party != "author" || !updated.AgentAuthored || s.agentTurn == nil {
		return nil
	}
	sessionID := uuidString(updated.AuthorAgentSessionID)
	if sessionID == "" {
		slog.Warn("agent-authored landing request has no author session for turn dispatch", "landing_request_id", updated.ID)
		return nil
	}
	if err := s.agentTurn.DispatchLandingAuthorTurn(ctx, LandingAgentTurnDispatchInput{
		SessionID:    sessionID,
		RepositoryID: repository.ID,
		UserID:       updated.AuthorID,
		RepoOwner:    owner,
		RepoName:     repository.Name,
		Number:       updated.Number,
		Feedback:     feedback,
	}); err != nil {
		return pkgerrors.Internal("failed to dispatch agent author turn").WithCause(err)
	}
	return nil
}

func (s *LandingService) syncLandingChangeRevisions(ctx context.Context, repositoryID int64, owner, repo string, changeIDs []string) ([]OwnershipTouchedFile, json.RawMessage, error) {
	q, ok := s.queries.(landingOwnershipQuerier)
	touched := make([]OwnershipTouchedFile, 0)
	revisions := make(map[string]approvalRevision, len(changeIDs))
	for _, changeID := range changeIDs {
		change, err := s.repoHost.GetChange(ctx, owner, repo, changeID)
		if err != nil {
			return nil, nil, mapLandingRepoHostError(err, "failed to load landing change")
		}
		parents, err := json.Marshal(change.ParentChangeIDs)
		if err != nil {
			return nil, nil, pkgerrors.Internal("failed to encode landing change parents").WithCause(err)
		}
		stored := db.Change{RevisionSeq: 1}
		if ok {
			stored, err = q.UpsertChange(ctx, db.UpsertChangeParams{
				RepositoryID: repositoryID, ChangeID: change.ChangeID, CommitID: change.CommitID,
				Description: change.Description, AuthorName: change.AuthorName, AuthorEmail: change.AuthorEmail,
				HasConflict: change.HasConflict, IsEmpty: change.IsEmpty, ParentChangeIds: parents,
			})
			if err != nil {
				return nil, nil, pkgerrors.Internal("failed to record landing change revision").WithCause(err)
			}
		}
		revisions[changeID] = approvalRevision{CommitID: change.CommitID, Seq: stored.RevisionSeq}
		files, err := s.repoHost.GetChangeFiles(ctx, owner, repo, change.CommitID)
		if err != nil {
			return nil, nil, mapLandingRepoHostError(err, "failed to load landing change files")
		}
		for _, file := range files {
			touched = append(touched, OwnershipTouchedFile{Path: file.Path, ChangeID: changeID, CommitID: change.CommitID, RevisionSeq: stored.RevisionSeq})
		}
	}
	encoded, err := json.Marshal(revisions)
	if err != nil {
		return nil, nil, pkgerrors.Internal("failed to encode landing revision snapshot").WithCause(err)
	}
	return touched, encoded, nil
}

func landingRevisionCommitIDs(encoded json.RawMessage) ([]string, error) {
	var revisions map[string]approvalRevision
	if err := json.Unmarshal(encoded, &revisions); err != nil {
		return nil, err
	}
	commitIDs := make([]string, 0, len(revisions))
	seen := make(map[string]struct{}, len(revisions))
	for _, revision := range revisions {
		if revision.CommitID == "" {
			continue
		}
		if _, ok := seen[revision.CommitID]; ok {
			continue
		}
		seen[revision.CommitID] = struct{}{}
		commitIDs = append(commitIDs, revision.CommitID)
	}
	slices.Sort(commitIDs)
	return commitIDs, nil
}

func landingReviewRevisionForCommit(encoded json.RawMessage, commitID string) (json.RawMessage, bool, error) {
	var revisions map[string]approvalRevision
	if err := json.Unmarshal(encoded, &revisions); err != nil {
		return nil, false, err
	}
	for changeID, revision := range revisions {
		if revision.CommitID != commitID {
			continue
		}
		selected, err := json.Marshal(map[string]approvalRevision{changeID: revision})
		return selected, true, err
	}
	return nil, false, nil
}

func (s *LandingService) enforceOwnershipGate(ctx context.Context, repository db.Repository, owner, repo string, landing db.GetLandingRequestWithChangeIDsByNumberRow, touched []OwnershipTouchedFile, dismissStale bool) error {
	blocks, err := s.ownershipLandingBlockers(ctx, repository, owner, repo, landing, touched, dismissStale)
	if err != nil {
		return err
	}
	if len(blocks) > 0 {
		return landingBlocked(blocks, "landing is blocked by ownership policy")
	}
	return nil
}

func (s *LandingService) ownershipLandingBlockers(ctx context.Context, repository db.Repository, owner, repo string, landing db.GetLandingRequestWithChangeIDsByNumberRow, touched []OwnershipTouchedFile, dismissStale bool) ([]LandingBlock, error) {
	q, ok := s.queries.(landingOwnershipQuerier)
	if !ok {
		return nil, nil
	}
	targetRevision, err := s.targetBookmarkRevision(ctx, owner, repo, landing.TargetBookmark)
	if err != nil {
		return nil, err
	}
	resolved, err := resolveChangeOwnership(ctx, q, s.repoHost, repository.ID, owner, repo, targetRevision, touched, landing.ID)
	if err != nil {
		return nil, pkgerrors.UnprocessableEntity("invalid ownership configuration: " + err.Error())
	}
	var blocks []LandingBlock
	approvals, err := loadOwnershipApprovals(ctx, q, repository.ID, landing.ID)
	if err != nil {
		return nil, pkgerrors.Internal("failed to load ownership approvals").WithCause(err)
	}
	for _, item := range resolved.TouchedPaths {
		candidates := approvingCandidates(item.Owners)
		if landing.AgentAuthored && item.AgentPolicy == ownership.PolicyDeny {
			blocks = append(blocks, LandingBlock{Kind: "agent_policy", Path: item.Path, Candidates: candidates})
			continue
		}
		if len(candidates) == 0 || item.SatisfiedBy != nil {
			continue
		}
		if !dismissStale && anyPrincipalApproval(approvals, item.Owners) {
			continue
		}
		if landing.AgentAuthored && item.AgentPolicy == ownership.PolicyAutoLand {
			ok, err := s.hasCurrentAgentApproval(ctx, repository.ID, landing.ID, touched)
			if err != nil {
				return nil, pkgerrors.Internal("failed to evaluate agent approval").WithCause(err)
			}
			if ok {
				continue
			}
		}
		blocks = append(blocks, LandingBlock{Kind: "owner", Path: item.Path, Candidates: candidates})
	}
	return blocks, nil
}

func anyPrincipalApproval(approvals []ownershipApproval, owners []ownership.Principal) bool {
	for _, approval := range approvals {
		if principalApproves(approval, owners) {
			return true
		}
	}
	return false
}

func (s *LandingService) hasCurrentAgentApproval(ctx context.Context, _, landingID int64, touched []OwnershipTouchedFile) (bool, error) {
	q, ok := s.queries.(landingAgentReviewQuerier)
	if !ok {
		return false, pkgerrors.Internal("agent review store unavailable")
	}
	commitIDs := landingTouchedCommitIDs(touched)
	if len(commitIDs) == 0 {
		return false, nil
	}
	count, err := q.CountCurrentAgentLandingReviewCommits(ctx, db.CountCurrentAgentLandingReviewCommitsParams{
		LandingRequestID: landingID,
		CommitIds:        commitIDs,
	})
	if err != nil {
		return false, err
	}
	return count == int64(len(commitIDs)), nil
}

func landingTouchedCommitIDs(touched []OwnershipTouchedFile) []string {
	seen := make(map[string]struct{}, len(touched))
	commitIDs := make([]string, 0, len(touched))
	for _, file := range touched {
		if file.CommitID == "" {
			continue
		}
		if _, ok := seen[file.CommitID]; ok {
			continue
		}
		seen[file.CommitID] = struct{}{}
		commitIDs = append(commitIDs, file.CommitID)
	}
	slices.Sort(commitIDs)
	return commitIDs
}

func (s *LandingService) targetBookmarkRevision(ctx context.Context, owner, repo, target string) (string, error) {
	rh, ok := s.repoHost.(landingBookmarkRepoHost)
	if !ok {
		return "", pkgerrors.Internal("target bookmark resolver unavailable")
	}
	cursor := ""
	for {
		bookmarks, next, err := rh.ListBookmarks(ctx, owner, repo, cursor, 100)
		if err != nil {
			return "", mapLandingRepoHostError(err, "failed to resolve target bookmark")
		}
		for _, bookmark := range bookmarks {
			if bookmark.Name == target && strings.TrimSpace(bookmark.TargetChangeID) != "" {
				return bookmark.TargetChangeID, nil
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	return "", pkgerrors.UnprocessableEntity("target bookmark does not exist")
}

func landingDismissStaleReviews(rules []db.ProtectedBookmark, targetBookmark string) (bool, error) {
	for _, rule := range rules {
		matches, err := bookmarkMatchesPattern(rule.Pattern, targetBookmark)
		if err != nil {
			return false, err
		}
		if matches && rule.DismissStaleReviews {
			return true, nil
		}
	}
	return false, nil
}

// enqueueLanding transitions the landing request to 'queued' and creates (or
// resets) its landing task. When a transaction manager is available both writes
// happen atomically; the fallback path compensates by reverting the landing
// request to 'open' if the task write fails, so a request is never stranded in
// 'queued' with no claimable task.
func (s *LandingService) enqueueLanding(
	ctx context.Context,
	actor *db.User,
	repository db.Repository,
	landingRow db.GetLandingRequestWithChangeIDsByNumberRow,
	requireAutoLand bool,
	appendRequest json.RawMessage,
) (db.LandingRequest, db.LandingTask, error) {
	if len(appendRequest) == 0 {
		previous, err := s.queries.GetLandingTaskByLandingRequestID(ctx, landingRow.ID)
		if err != nil && !stdErrors.Is(err, pgx.ErrNoRows) {
			return db.LandingRequest{}, db.LandingTask{}, pkgerrors.Internal("failed to read existing landing task").WithCause(err)
		}
		if err == nil && len(previous.AppendRequest) != 0 {
			return db.LandingRequest{}, db.LandingTask{}, pkgerrors.Conflict("an append landing cannot be converted to ordinary landing")
		}
	}
	enqueueParams := db.EnqueueLandingRequestParams{
		QueuedBy:       pgtype.Int8{Int64: actor.ID, Valid: true},
		ID:             landingRow.ID,
		TargetBookmark: landingRow.TargetBookmark,
		SourceBookmark: landingRow.SourceBookmark,
	}
	taskParams := db.CreateLandingTaskParams{
		LandingRequestID: landingRow.ID,
		RepositoryID:     repository.ID,
		Priority:         1,
		AppendRequest:    appendRequest,
	}

	if s.landTxManager != nil {
		tx, err := s.landTxManager.BeginLandTx(ctx)
		if err != nil {
			return db.LandingRequest{}, db.LandingTask{}, pkgerrors.Internal("failed to begin landing transaction").WithCause(err)
		}
		var enqueuedRow db.LandingRequest
		if requireAutoLand {
			enqueuedRow, err = tx.EnqueueAutoLandRequest(ctx, db.EnqueueAutoLandRequestParams(enqueueParams))
		} else {
			enqueuedRow, err = tx.EnqueueLandingRequest(ctx, enqueueParams)
		}
		if err != nil {
			_ = tx.Rollback(ctx)
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return db.LandingRequest{}, db.LandingTask{}, pkgerrors.Conflict("landing request changed; retry landing")
			}
			return db.LandingRequest{}, db.LandingTask{}, pkgerrors.Internal("failed to enqueue landing request").WithCause(err)
		}
		task, err := tx.ResetOrCreateLandingTask(ctx, taskParams)
		if err != nil {
			_ = tx.Rollback(ctx)
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return db.LandingRequest{}, db.LandingTask{}, pkgerrors.Conflict("landing request already has an active task")
			}
			return db.LandingRequest{}, db.LandingTask{}, pkgerrors.Internal("failed to create landing task").WithCause(err)
		}
		if err := tx.Commit(ctx); err != nil {
			_ = tx.Rollback(ctx)
			return db.LandingRequest{}, db.LandingTask{}, pkgerrors.Internal("failed to commit landing transaction").WithCause(err)
		}
		s.observeLanding("queue")
		return enqueuedRow, task, nil
	}

	var enqueuedRow db.LandingRequest
	var err error
	if requireAutoLand {
		q, ok := s.queries.(landingAutoLandQuerier)
		if !ok {
			return db.LandingRequest{}, db.LandingTask{}, pkgerrors.Internal("auto-land store unavailable")
		}
		enqueuedRow, err = q.EnqueueAutoLandRequest(ctx, db.EnqueueAutoLandRequestParams(enqueueParams))
	} else {
		enqueuedRow, err = s.queries.EnqueueLandingRequest(ctx, enqueueParams)
	}
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.LandingRequest{}, db.LandingTask{}, pkgerrors.Conflict("landing request changed; retry landing")
		}
		return db.LandingRequest{}, db.LandingTask{}, pkgerrors.Internal("failed to enqueue landing request").WithCause(err)
	}
	task, err := s.queries.CreateLandingTask(ctx, taskParams)
	if err != nil {
		if _, revertErr := s.queries.RevertLandingRequestToOpen(ctx, landingRow.ID); revertErr != nil {
			slog.Error("failed to revert landing request after task creation failure",
				"landing_request_id", landingRow.ID, "error", revertErr)
		}
		return db.LandingRequest{}, db.LandingTask{}, pkgerrors.Internal("failed to create landing task").WithCause(err)
	}
	s.observeLanding("queue")
	return enqueuedRow, task, nil
}

// landingProtectionRequirements aggregates the independent human-approval,
// agent-LGTM, and status-check requirements from every matching rule.
// The returned contexts are the union of each matching rule's legacy
// required_checks list and, when require_status_checks is set, its
// required_status_contexts.
func landingProtectionRequirements(rules []db.ProtectedBookmark, targetBookmark string) (int64, bool, []string, error) {
	var requiredHumanApprovals int64
	var requireAgentLGTM bool
	var contexts []string
	for _, rule := range rules {
		matches, err := bookmarkMatchesPattern(rule.Pattern, targetBookmark)
		if err != nil {
			return 0, false, nil, err
		}
		if !matches {
			continue
		}
		if rule.RequireReview && rule.RequireHumanApprovals > requiredHumanApprovals {
			requiredHumanApprovals = rule.RequireHumanApprovals
		}
		if rule.RequireAgentLgtm {
			requireAgentLGTM = true
		}
		contexts = unionLandingStatusContexts(contexts, rule.RequiredChecks)
		if rule.RequireStatusChecks {
			contexts = unionLandingStatusContexts(contexts, rule.RequiredStatusContexts)
		}
	}
	return requiredHumanApprovals, requireAgentLGTM, contexts, nil
}

// unionLandingStatusContexts merges extra into contexts, trimming whitespace
// and dropping blanks and duplicates while preserving order.
func unionLandingStatusContexts(contexts []string, extra []string) []string {
	seen := make(map[string]struct{}, len(contexts))
	for _, c := range contexts {
		seen[c] = struct{}{}
	}
	for _, c := range extra {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		if _, ok := seen[c]; ok {
			continue
		}
		seen[c] = struct{}{}
		contexts = append(contexts, c)
	}
	return contexts
}

// landingStatusQuerier is the subset of LandingQuerier needed to evaluate
// required status checks; it is shared with the landing worker's pre-land
// re-check.
func (s *LandingService) populateLandingReadiness(
	ctx context.Context,
	repository db.Repository,
	owner string,
	landingRequestID int64,
	targetBookmark string,
	conflictStatus string,
	changeIDs []string,
	response *LandingRequestResponse,
) error {
	response.BlockedBy = make(map[string][]LandingBlock, len(changeIDs))
	for _, changeID := range changeIDs {
		response.BlockedBy[changeID] = []LandingBlock{}
	}
	if len(changeIDs) == 0 {
		return nil
	}

	rules, err := s.queries.ListAllProtectedBookmarksByRepo(ctx, repository.ID)
	if err != nil {
		return pkgerrors.Internal("failed to list protected bookmarks for landing readiness").WithCause(err)
	}
	// Readiness is a read-only view: resolve the live commits below, but leave
	// revision persistence to the push and landing paths.
	requiredApprovals, requireAgentLGTM, protectedContexts, err := landingProtectionRequirements(rules, targetBookmark)
	if err != nil {
		return pkgerrors.Internal("invalid protected bookmark pattern").WithCause(err)
	}
	requiredContexts := unionLandingStatusContexts(protectedContexts, repository.LandingQueueRequiredChecks)

	statusByChange := make(map[string]map[string]string, len(changeIDs))
	if len(requiredContexts) > 0 {
		statuses, err := s.queries.ListLatestCommitStatusesByChangeIDsAndContexts(ctx, db.ListLatestCommitStatusesByChangeIDsAndContextsParams{
			RepositoryID: repository.ID,
			ChangeIds:    changeIDs,
			Contexts:     requiredContexts,
		})
		if err != nil {
			return pkgerrors.Internal("failed to load commit statuses for landing readiness").WithCause(err)
		}
		for _, status := range statuses {
			byContext := statusByChange[status.ChangeID]
			if byContext == nil {
				byContext = make(map[string]string, len(requiredContexts))
				statusByChange[status.ChangeID] = byContext
			}
			byContext[status.Context] = status.Status
		}
	}

	reviewBlocked := false
	if requiredApprovals > 0 {
		dismissStale, err := landingDismissStaleReviews(rules, targetBookmark)
		if err != nil {
			return pkgerrors.Internal("invalid protected bookmark pattern").WithCause(err)
		}
		var approvedCount int64
		if dismissStale {
			if q, ok := s.queries.(landingOwnershipQuerier); ok {
				approvedCount, err = q.CountCurrentApprovedLandingRequestReviews(ctx, db.CountCurrentApprovedLandingRequestReviewsParams{
					LandingRequestID: landingRequestID,
					RepositoryID:     repository.ID,
				})
			} else {
				approvedCount, err = s.queries.CountApprovedLandingRequestReviews(ctx, landingRequestID)
			}
		} else {
			approvedCount, err = s.queries.CountApprovedLandingRequestReviews(ctx, landingRequestID)
		}
		if err != nil {
			return pkgerrors.Internal("failed to count approved landing reviews for landing readiness").WithCause(err)
		}
		reviewBlocked = approvedCount < requiredApprovals
	}

	agentReviewBlocked := make(map[string]bool, len(changeIDs))
	if requireAgentLGTM {
		q, ok := s.queries.(landingAgentReviewQuerier)
		if !ok {
			return pkgerrors.Internal("agent review policy evaluator unavailable")
		}
		for _, changeID := range changeIDs {
			change, err := s.repoHost.GetChange(ctx, strings.TrimSpace(owner), repository.Name, changeID)
			if err != nil {
				return mapLandingRepoHostError(err, "failed to load landing change for landing readiness")
			}
			commitID := strings.TrimSpace(change.CommitID)
			if commitID == "" {
				agentReviewBlocked[changeID] = true
				continue
			}
			approvedCommits, err := q.CountCurrentAgentLandingReviewCommits(ctx, db.CountCurrentAgentLandingReviewCommitsParams{
				LandingRequestID: landingRequestID,
				CommitIds:        []string{commitID},
			})
			if err != nil {
				return pkgerrors.Internal("failed to count current agent reviews for landing readiness").WithCause(err)
			}
			agentReviewBlocked[changeID] = approvedCommits < 1
		}
	}

	for _, changeID := range changeIDs {
		for _, contextName := range requiredContexts {
			if statusByChange[changeID][contextName] != "success" {
				response.BlockedBy[changeID] = append(response.BlockedBy[changeID], LandingBlock{
					Kind: "check",
					Name: contextName,
					Repo: repository.Name,
				})
			}
		}
		if reviewBlocked {
			response.BlockedBy[changeID] = append(response.BlockedBy[changeID], LandingBlock{
				Kind: "review",
				Name: "approval",
				Repo: repository.Name,
			})
		}
		if agentReviewBlocked[changeID] {
			response.BlockedBy[changeID] = append(response.BlockedBy[changeID], LandingBlock{
				Kind:    "review",
				Missing: "agent_lgtm",
			})
		}
		if conflictStatus == "conflicted" {
			conflicts, err := s.repoHost.GetChangeConflicts(ctx, strings.TrimSpace(owner), repository.Name, changeID)
			if err != nil {
				return mapLandingRepoHostError(err, "failed to load landing conflicts for landing readiness")
			}
			for _, conflict := range conflicts {
				name := strings.TrimSpace(conflict.FilePath)
				if name == "" {
					name = "conflict"
				}
				response.BlockedBy[changeID] = append(response.BlockedBy[changeID], LandingBlock{
					Kind: "conflict",
					Name: name,
					Repo: repository.Name,
				})
			}
		}
	}

	for _, changeID := range changeIDs {
		if len(response.BlockedBy[changeID]) > 0 {
			break
		}
		response.LandablePrefix++
	}
	return nil
}

// CreateLandingReviewRequest records an explicit request for either a human
// login or a named agent. The target principal is resolved before the write so
// invalid human logins cannot leave partial request state behind.
func (s *LandingService) CreateLandingReviewRequest(ctx context.Context, actor *db.User, owner, repo string, number int64, req CreateLandingReviewRequestInput) (LandingReviewRequestResponse, error) {
	if actor == nil {
		return LandingReviewRequestResponse{}, pkgerrors.Unauthorized("authentication required")
	}

	reviewerLogin := strings.TrimSpace(req.Reviewer)
	agentName := strings.TrimSpace(req.Agent)
	if (reviewerLogin == "") == (agentName == "") {
		return LandingReviewRequestResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingReviewRequest", Field: "reviewer", Code: "invalid"})
	}
	if reviewerLogin != "" {
		if len(reviewerLogin) > 255 {
			return LandingReviewRequestResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingReviewRequest", Field: "reviewer", Code: "invalid"})
		}
		if err := validateSafeText("LandingReviewRequest", "reviewer", reviewerLogin); err != nil {
			return LandingReviewRequestResponse{}, err
		}
	} else {
		if len(agentName) > 255 {
			return LandingReviewRequestResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingReviewRequest", Field: "agent", Code: "invalid"})
		}
		if err := validateSafeText("LandingReviewRequest", "agent", agentName); err != nil {
			return LandingReviewRequestResponse{}, err
		}
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return LandingReviewRequestResponse{}, err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return LandingReviewRequestResponse{}, err
	}
	landingRow, err := s.getLandingByNumber(ctx, repository.ID, number)
	if err != nil {
		return LandingReviewRequestResponse{}, err
	}

	var reviewer *db.User
	reviewerID := pgtype.Int8{}
	if reviewerLogin != "" {
		resolved, err := s.queries.GetUserByLowerUsername(ctx, strings.ToLower(reviewerLogin))
		if err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return LandingReviewRequestResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingReviewRequest", Field: "reviewer", Code: "invalid"})
			}
			return LandingReviewRequestResponse{}, pkgerrors.Internal("failed to load landing reviewer").WithCause(err)
		}
		canRead, err := s.canReadRepo(ctx, repository, resolved.ID)
		if err != nil {
			return LandingReviewRequestResponse{}, pkgerrors.Internal("failed to validate landing reviewer access").WithCause(err)
		}
		if !canRead {
			return LandingReviewRequestResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingReviewRequest", Field: "reviewer", Code: "invalid"})
		}
		reviewer = &resolved
		reviewerID = pgtype.Int8{Int64: resolved.ID, Valid: true}
	}

	q, ok := s.queries.(landingReviewRequestQuerier)
	if !ok {
		return LandingReviewRequestResponse{}, pkgerrors.Internal("landing review request store unavailable")
	}
	created, err := q.CreateLandingReviewRequest(ctx, db.CreateLandingReviewRequestParams{
		LandingRequestID: landingRow.ID,
		RequestedBy:      actor.ID,
		ReviewerID:       reviewerID,
		AgentName:        agentName,
	})
	if err != nil {
		if isUniqueViolation(err) {
			return LandingReviewRequestResponse{}, pkgerrors.Conflict("review has already been requested from this reviewer")
		}
		return LandingReviewRequestResponse{}, pkgerrors.Internal("failed to create landing review request").WithCause(err)
	}

	if err := s.updateLandingTurn(ctx, repository, owner, landingRow, actor, "reviewer", "request", ""); err != nil {
		return LandingReviewRequestResponse{}, err
	}

	if reviewer != nil && s.notifSvc != nil {
		if _, err := s.notifSvc.Create(ctx, db.CreateNotificationParams{
			UserID:     reviewer.ID,
			SourceType: "landing",
			SourceID:   pgtype.Int8{Int64: landingRow.ID, Valid: true},
			Subject:    fmt.Sprintf("@%s requested your review on landing #%d", actor.Username, landingRow.Number),
			Body:       landingRow.Title,
		}); err != nil {
			slog.Warn("landing review request notification failed", "landing_request_id", landingRow.ID, "review_request_id", created.ID, "error", err)
		}
	}

	updatedRow, err := s.getLandingByNumber(ctx, repository.ID, number)
	if err != nil {
		return LandingReviewRequestResponse{}, err
	}
	landingResponse, err := s.mapLandingRow(ctx, repository, owner, updatedRow)
	if err != nil {
		return LandingReviewRequestResponse{}, err
	}
	if err := s.dispatchLandingRequestEvent(ctx, repository, actor, "review_requested", landingResponse); err != nil {
		return LandingReviewRequestResponse{}, err
	}

	return s.mapLandingReviewRequest(ctx, created)
}

// DismissLandingReviewRequest dismisses one still-pending request belonging to
// the addressed landing. Fulfilled and previously dismissed history is immutable.
func (s *LandingService) DismissLandingReviewRequest(ctx context.Context, actor *db.User, owner, repo string, number, requestID int64) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	if requestID <= 0 {
		return pkgerrors.BadRequest("invalid review request id")
	}
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return err
	}
	landingRow, err := s.getLandingByNumber(ctx, repository.ID, number)
	if err != nil {
		return err
	}
	q, ok := s.queries.(landingReviewRequestQuerier)
	if !ok {
		return pkgerrors.Internal("landing review request store unavailable")
	}
	if _, err := q.DismissLandingReviewRequest(ctx, db.DismissLandingReviewRequestParams{ID: requestID, LandingRequestID: landingRow.ID}); err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("landing review request not found")
		}
		return pkgerrors.Internal("failed to dismiss landing review request").WithCause(err)
	}
	return nil
}

func (s *LandingService) ListLandingReviews(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]db.LandingRequestReview, int64, error) {
	repository, landingRow, err := s.resolveReadableLanding(ctx, viewer, owner, repo, number)
	if err != nil {
		return nil, 0, err
	}
	_ = repository

	pageSize, pageOffset, _, _ := normalizePage(page, perPage)
	reviews, err := s.queries.ListLandingRequestReviews(ctx, db.ListLandingRequestReviewsParams{
		LandingRequestID: landingRow.ID,
		PageOffset:       pageOffset,
		PageSize:         pageSize,
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to list landing reviews").WithCause(err)
	}
	total, err := s.queries.CountLandingRequestReviews(ctx, landingRow.ID)
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to count landing reviews").WithCause(err)
	}
	return reviews, total, nil
}

func (s *LandingService) CreateLandingReview(ctx context.Context, actor *db.User, owner, repo string, number int64, req CreateLandingReviewInput) (db.LandingRequestReview, error) {
	if actor == nil {
		return db.LandingRequestReview{}, pkgerrors.Unauthorized("authentication required")
	}
	// A system-issued credential acts as its user, but an agent holds it:
	// its review is an agent review and never a human approval.
	reviewerKind := "human"
	if actor.UserType == "bot" || actor.UserType == "service" || actsThroughRunCredential(ctx, actor.ID) {
		reviewerKind = "agent"
	}
	reviewType := strings.ToLower(strings.TrimSpace(req.Type))
	verdict := strings.ToLower(strings.TrimSpace(req.Verdict))
	confidence := strings.ToLower(strings.TrimSpace(req.ConfidenceBucket))
	summary := strings.TrimSpace(req.Summary)
	commitID := strings.TrimSpace(req.CommitID)
	if reviewerKind == "agent" {
		if verdict != "lgtm" && verdict != "concerns" {
			return db.LandingRequestReview{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingReview", Field: "verdict", Code: "invalid"})
		}
		if confidence != "high" && confidence != "medium" && confidence != "low" {
			return db.LandingRequestReview{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingReview", Field: "confidence_bucket", Code: "invalid"})
		}
		if summary == "" {
			return db.LandingRequestReview{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingReview", Field: "summary", Code: "missing_field"})
		}
		if commitID == "" {
			return db.LandingRequestReview{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingReview", Field: "commit_id", Code: "missing_field"})
		}
		if len(commitID) > 255 {
			return db.LandingRequestReview{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingReview", Field: "commit_id", Code: "invalid"})
		}
		if err := validateSafeText("LandingReview", "summary", summary); err != nil {
			return db.LandingRequestReview{}, err
		}
		if err := validateSafeText("LandingReview", "commit_id", commitID); err != nil {
			return db.LandingRequestReview{}, err
		}
		if verdict == "lgtm" {
			reviewType = "approve"
		} else {
			reviewType = "request_changes"
		}
	} else {
		if !isAllowedReviewType(reviewType) {
			return db.LandingRequestReview{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingReview", Field: "type", Code: "invalid"})
		}
		// Human callers cannot mint agent verdict fields by putting them in the
		// request. reviewer_kind is always derived from the authenticated actor.
		verdict, confidence, summary, commitID = "", "", "", ""
	}
	body := req.Body
	if reviewerKind == "agent" {
		body = summary
	}
	if (reviewType == "comment" || reviewType == "request_changes") && strings.TrimSpace(body) == "" {
		return db.LandingRequestReview{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingReview", Field: "body", Code: "missing_field"})
	}
	if verr := validateSafeText("LandingReview", "body", body); verr != nil {
		return db.LandingRequestReview{}, verr
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return db.LandingRequestReview{}, err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return db.LandingRequestReview{}, err
	}

	landingRow, err := s.getLandingByNumber(ctx, repository.ID, number)
	if err != nil {
		return db.LandingRequestReview{}, err
	}

	// Neither a human approval nor an agent LGTM can be self-authored.
	if reviewType == "approve" && landingRow.AuthorID == actor.ID {
		return db.LandingRequestReview{}, pkgerrors.UnprocessableEntity("author cannot approve their own landing request")
	}

	revision, err := s.resolveLandingRevision(ctx, repository.ID, owner, repo, landingRow.ID, req.CommitID, "LandingReview")
	if err != nil {
		return db.LandingRequestReview{}, err
	}

	// The server, not the client, records exactly which revision vector the
	// reviewer saw. This applies to comments and change requests as well as
	// approvals so each reviewer has a trustworthy last_reviewed_seq.
	_, revisions, err := s.syncLandingChangeRevisions(ctx, repository.ID, owner, repo, landingRow.ChangeIds)
	if err != nil {
		return db.LandingRequestReview{}, err
	}
	if reviewerKind == "agent" {
		// An agent LGTM only counts for the revision it actually reviewed, so
		// narrow the snapshot to that change. Match against the freshly synced
		// snapshot, before the reviewed-revision pin below, so the pin can
		// never vouch for a commit that is no longer a current revision.
		selected, found, err := landingReviewRevisionForCommit(revisions, commitID)
		if err != nil {
			return db.LandingRequestReview{}, pkgerrors.Internal("failed to decode landing revision snapshot").WithCause(err)
		}
		if !found {
			return db.LandingRequestReview{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingReview", Field: "commit_id", Code: "invalid"})
		}
		revisions = selected
	} else {
		var snapshot map[string]approvalRevision
		if err = json.Unmarshal(revisions, &snapshot); err != nil {
			return db.LandingRequestReview{}, pkgerrors.Internal("failed to decode landing revision snapshot").WithCause(err)
		}
		// The review request pins the revision visible to the client. Keep the
		// complete stack snapshot used by protection rules, but never replace
		// the reviewed change with a newer head observed while processing it.
		snapshot[revision.ChangeID] = approvalRevision{CommitID: revision.CommitID, Seq: revision.Seq}
		revisions, err = json.Marshal(snapshot)
		if err != nil {
			return db.LandingRequestReview{}, pkgerrors.Internal("failed to encode landing revision snapshot").WithCause(err)
		}
	}
	review, err := s.queries.CreateLandingRequestReview(ctx, db.CreateLandingRequestReviewParams{
		LandingRequestID: landingRow.ID,
		ReviewerID:       pgtype.Int8{Int64: actor.ID, Valid: true},
		ReviewerKind:     reviewerKind,
		Type:             reviewType,
		Verdict:          verdict,
		ConfidenceBucket: confidence,
		Summary:          summary,
		CommitID:         revision.CommitID,
		Body:             body,
		ChangeRevisions:  revisions,
	})
	if err != nil {
		return db.LandingRequestReview{}, pkgerrors.Internal("failed to create landing review").WithCause(err)
	}
	if reviewType != "pending" {
		if q, ok := s.queries.(landingReviewRequestQuerier); ok {
			err = q.FulfillLandingReviewRequestsForUser(ctx, db.FulfillLandingReviewRequestsForUserParams{
				LandingRequestID: landingRow.ID,
				ReviewerID:       pgtype.Int8{Int64: actor.ID, Valid: true},
			})
			if err != nil {
				return db.LandingRequestReview{}, pkgerrors.Internal("failed to fulfill landing review request").WithCause(err)
			}
			// Agents are authenticated users too. Fulfill user-targeted requests
			// above as well as requests addressed to their agent name.
			if reviewerKind == "agent" {
				if err := q.FulfillLandingReviewRequestsForAgent(ctx, db.FulfillLandingReviewRequestsForAgentParams{
					LandingRequestID: landingRow.ID,
					AgentName:        actor.Username,
				}); err != nil {
					return db.LandingRequestReview{}, pkgerrors.Internal("failed to fulfill landing review request").WithCause(err)
				}
			}
		}
	}
	switch {
	case reviewType == "pending":
		if err := s.updateLandingTurn(ctx, repository, owner, landingRow, actor, "reviewer", "request", req.Body); err != nil {
			return db.LandingRequestReview{}, err
		}
	case (reviewType == "comment" || reviewType == "request_changes") && !landingActionIsFromAuthor(ctx, landingRow, actor):
		if err := s.updateLandingTurn(ctx, repository, owner, landingRow, actor, "author", "comment", req.Body); err != nil {
			return db.LandingRequestReview{}, err
		}
	}
	if err := s.dispatchLandingReviewEvent(ctx, repository, landingRow, actor, review); err != nil {
		return db.LandingRequestReview{}, err
	}
	return review, nil
}

func (s *LandingService) ListLandingComments(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]LandingCommentResponse, int64, error) {
	repository, landingRow, err := s.resolveReadableLanding(ctx, viewer, owner, repo, number)
	if err != nil {
		return nil, 0, err
	}
	pageSize, pageOffset, _, _ := normalizePage(page, perPage)
	comments, err := s.queries.ListLandingRequestComments(ctx, db.ListLandingRequestCommentsParams{
		LandingRequestID: landingRow.ID,
		PageOffset:       pageOffset,
		PageSize:         pageSize,
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to list landing comments").WithCause(err)
	}
	total, err := s.queries.CountLandingRequestComments(ctx, landingRow.ID)
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to count landing comments").WithCause(err)
	}
	userLogins := s.resolveLandingCommentUserLogins(ctx, comments)
	responses := make([]LandingCommentResponse, 0, len(comments))
	for _, comment := range comments {
		response, err := s.landingCommentResponse(ctx, repository, owner, repo, landingRow.ID, comment, userLogins[comment.UserID.Int64])
		if err != nil {
			return nil, 0, err
		}
		responses = append(responses, response)
	}
	return responses, total, nil
}

func (s *LandingService) CreateLandingComment(ctx context.Context, actor *db.User, owner, repo string, number int64, req CreateLandingCommentInput) (LandingCommentResponse, error) {
	if actor == nil {
		return LandingCommentResponse{}, pkgerrors.Unauthorized("authentication required")
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		return LandingCommentResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingComment", Field: "body", Code: "missing_field"})
	}
	if req.Line < 0 {
		return LandingCommentResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingComment", Field: "line", Code: "invalid"})
	}
	path := strings.TrimSpace(req.Path)
	if req.Line > 0 && path == "" {
		return LandingCommentResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingComment", Field: "path", Code: "missing_field"})
	}
	side := strings.ToLower(strings.TrimSpace(req.Side))
	if side == "" {
		side = "right"
	}
	if side != "left" && side != "right" && side != "both" {
		return LandingCommentResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingComment", Field: "side", Code: "invalid"})
	}
	if verr := validateSafeText("LandingComment", "body", req.Body); verr != nil {
		return LandingCommentResponse{}, verr
	}
	if verr := validateSafeText("LandingComment", "path", path); verr != nil {
		return LandingCommentResponse{}, verr
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return LandingCommentResponse{}, err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return LandingCommentResponse{}, err
	}
	landingRow, err := s.getLandingByNumber(ctx, repository.ID, number)
	if err != nil {
		return LandingCommentResponse{}, err
	}
	revision, err := s.resolveLandingRevision(ctx, repository.ID, owner, repo, landingRow.ID, req.CommitID, "LandingComment")
	if err != nil {
		return LandingCommentResponse{}, err
	}
	anchorHash := ""
	if req.Line > 0 {
		anchorHash, _, err = s.commentAnchorAt(ctx, owner, repo, revision.CommitID, path, req.Line, side)
		if err != nil {
			return LandingCommentResponse{}, err
		}
	}

	comment, err := s.queries.CreateLandingRequestComment(ctx, db.CreateLandingRequestCommentParams{
		LandingRequestID: landingRow.ID,
		UserID:           pgtype.Int8{Int64: actor.ID, Valid: true},
		Path:             path,
		Line:             req.Line,
		Side:             side,
		Body:             req.Body,
		CommitID:         revision.CommitID,
		AnchorHash:       anchorHash,
	})
	if err != nil {
		return LandingCommentResponse{}, pkgerrors.Internal("failed to create landing comment").WithCause(err)
	}
	if !landingActionIsFromAuthor(ctx, landingRow, actor) {
		if err := s.updateLandingTurn(ctx, repository, owner, landingRow, actor, "author", "comment", req.Body); err != nil {
			return LandingCommentResponse{}, err
		}
	}
	if err := s.dispatchLandingCommentEvent(ctx, repository, landingRow, actor, comment); err != nil {
		return LandingCommentResponse{}, err
	}
	// Process @mentions in the comment body. Errors are non-fatal.
	if s.mentionSvc != nil && req.Body != "" {
		authorID := pgtype.Int8{Int64: actor.ID, Valid: true}
		lrID := pgtype.Int8{Int64: landingRow.ID, Valid: true}
		commentID := pgtype.Int8{Int64: comment.ID, Valid: true}
		subject := fmt.Sprintf("mentioned you in a comment on landing request #%d", number)
		_ = s.mentionSvc.ProcessMentions(ctx, req.Body, MentionContext{
			RepositoryID:     repository.ID,
			LandingRequestID: lrID,
			CommentType:      "landing_comment",
			CommentID:        commentID,
			AuthorUserID:     authorID,
		}, subject)
	}
	return s.landingCommentResponse(ctx, repository, owner, repo, landingRow.ID, comment, actor.Username)
}

func (s *LandingService) resolveLandingCommentUserLogins(ctx context.Context, comments []db.LandingRequestComment) map[int64]string {
	logins := make(map[int64]string)
	for _, comment := range comments {
		if !comment.UserID.Valid {
			continue
		}
		userID := comment.UserID.Int64
		if _, seen := logins[userID]; seen {
			continue
		}
		user, err := s.queries.GetUserByID(ctx, userID)
		if err != nil {
			logins[userID] = ""
			continue
		}
		logins[userID] = user.Username
	}
	return logins
}

func (s *LandingService) resolveLandingRevision(ctx context.Context, repositoryID int64, owner, repo string, landingRequestID int64, commitID, resource string) (db.ChangeRevision, error) {
	commitID = strings.TrimSpace(commitID)
	if commitID == "" {
		return db.ChangeRevision{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: resource, Field: "commit_id", Code: "missing_field"})
	}
	if verr := validateSafeText(resource, "commit_id", commitID); verr != nil {
		return db.ChangeRevision{}, verr
	}
	revision, err := s.queries.GetLandingRequestChangeRevisionByCommitID(ctx, db.GetLandingRequestChangeRevisionByCommitIDParams{
		LandingRequestID: landingRequestID,
		RepositoryID:     repositoryID,
		CommitID:         commitID,
	})
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return s.recoverImportedLandingRevision(ctx, repositoryID, owner, repo, landingRequestID, commitID, resource)
	}
	if err != nil {
		return db.ChangeRevision{}, pkgerrors.Internal("failed to resolve landing revision").WithCause(err)
	}
	return revision, nil
}

func (s *LandingService) landingCommentResponse(ctx context.Context, repository db.Repository, owner, repo string, landingRequestID int64, comment db.LandingRequestComment, userLogin string) (LandingCommentResponse, error) {
	response := LandingCommentResponse{LandingRequestComment: comment, AnchorState: "stale", UserLogin: userLogin}
	if strings.TrimSpace(comment.CommitID) == "" {
		return response, nil
	}
	revision, err := s.resolveLandingRevision(ctx, repository.ID, owner, repo, landingRequestID, comment.CommitID, "LandingComment")
	if err != nil {
		var apiErr *pkgerrors.APIError
		if stdErrors.As(err, &apiErr) && apiErr.Status == 422 {
			return response, nil
		}
		return LandingCommentResponse{}, err
	}
	current, err := s.repoHost.GetChange(ctx, owner, repo, revision.ChangeID)
	if err != nil {
		return LandingCommentResponse{}, mapLandingRepoHostError(err, "failed to load current comment revision")
	}
	if current.CommitID == comment.CommitID {
		response.AnchorState = "current"
		return response, nil
	}
	if comment.Line <= 0 || strings.TrimSpace(comment.AnchorHash) == "" {
		return response, nil
	}

	originalDiff, err := diffview.BuildChangeDiff(ctx, s.repoHost, strings.TrimSpace(owner), repository.Name, comment.CommitID, diffview.BuildOptions{})
	if err != nil {
		return LandingCommentResponse{}, mapLandingRepoHostError(err, "failed to load comment revision diff")
	}
	_, bodyLine, ok := findCommentAnchor(originalDiff.FileDiffs, comment.Path, comment.Line, comment.Side)
	if !ok {
		return response, nil
	}
	currentDiff, err := diffview.BuildChangeDiff(ctx, s.repoHost, strings.TrimSpace(owner), repository.Name, revision.ChangeID, diffview.BuildOptions{})
	if err != nil {
		return LandingCommentResponse{}, mapLandingRepoHostError(err, "failed to load current comment diff")
	}
	newLine, ok := findMatchingCommentAnchor(currentDiff.FileDiffs, comment.Path, comment.AnchorHash, comment.Side, bodyLine, comment.Line)
	if !ok {
		return response, nil
	}
	if newLine == comment.Line {
		response.AnchorState = "current"
		return response, nil
	}
	response.AnchorState = "moved"
	response.CurrentLine = newLine
	return response, nil
}

func (s *LandingService) commentAnchorAt(ctx context.Context, owner, repo, commitID, filePath string, line int64, side string) (string, int, error) {
	diff, err := diffview.BuildChangeDiff(ctx, s.repoHost, strings.TrimSpace(owner), strings.TrimSpace(repo), commitID, diffview.BuildOptions{})
	if err != nil {
		return "", 0, mapLandingRepoHostError(err, "failed to load comment revision diff")
	}
	hash, bodyLine, ok := findCommentAnchor(diff.FileDiffs, filePath, line, side)
	if !ok {
		return "", 0, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingComment", Field: "line", Code: "invalid"})
	}
	return hash, bodyLine, nil
}

type commentDiffHunk struct {
	oldStart int64
	newStart int64
	body     []string
	hash     string
}

var commentHunkHeader = regexp.MustCompile(`^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@`)

func parseCommentDiffHunks(patch string) []commentDiffHunk {
	var hunks []commentDiffHunk
	var current *commentDiffHunk
	flush := func() {
		if current == nil {
			return
		}
		sum := sha256.Sum256([]byte(strings.Join(current.body, "\n")))
		current.hash = fmt.Sprintf("%x", sum)
		hunks = append(hunks, *current)
	}
	for _, raw := range strings.Split(patch, "\n") {
		line := strings.TrimSuffix(raw, "\r")
		matches := commentHunkHeader.FindStringSubmatch(line)
		if len(matches) == 3 {
			flush()
			oldStart, _ := strconv.ParseInt(matches[1], 10, 64)
			newStart, _ := strconv.ParseInt(matches[2], 10, 64)
			current = &commentDiffHunk{oldStart: oldStart, newStart: newStart}
			continue
		}
		if current != nil {
			current.body = append(current.body, line)
		}
	}
	flush()
	return hunks
}

func findCommentAnchor(files []repohost.FileDiff, filePath string, line int64, side string) (string, int, bool) {
	for _, file := range files {
		if file.Path != filePath && file.OldPath != filePath {
			continue
		}
		for _, hunk := range parseCommentDiffHunks(file.Patch) {
			if bodyLine, ok := commentHunkBodyLine(hunk, line, side); ok {
				return hunk.hash, bodyLine, true
			}
		}
	}
	return "", 0, false
}

func findMatchingCommentAnchor(files []repohost.FileDiff, filePath, anchorHash, side string, bodyLine int, originalLine int64) (int64, bool) {
	var best int64
	found := false
	for _, file := range files {
		if file.Path != filePath && file.OldPath != filePath {
			continue
		}
		for _, hunk := range parseCommentDiffHunks(file.Patch) {
			if hunk.hash != anchorHash {
				continue
			}
			line, ok := commentHunkLineAt(hunk, bodyLine, side)
			if !ok {
				continue
			}
			if !found || absInt64(line-originalLine) < absInt64(best-originalLine) {
				best, found = line, true
			}
		}
	}
	return best, found
}

func commentHunkBodyLine(hunk commentDiffHunk, target int64, side string) (int, bool) {
	oldLine, newLine := hunk.oldStart, hunk.newStart
	for index, text := range hunk.body {
		if text == "" || strings.HasPrefix(text, `\ No newline`) {
			continue
		}
		prefix := text[0]
		oldPresent := prefix != '+'
		newPresent := prefix != '-'
		if (side == "left" || side == "both") && oldPresent && oldLine == target {
			return index, true
		}
		if (side == "right" || side == "both") && newPresent && newLine == target {
			return index, true
		}
		if oldPresent {
			oldLine++
		}
		if newPresent {
			newLine++
		}
	}
	return 0, false
}

func commentHunkLineAt(hunk commentDiffHunk, bodyLine int, side string) (int64, bool) {
	oldLine, newLine := hunk.oldStart, hunk.newStart
	for index, text := range hunk.body {
		if text == "" || strings.HasPrefix(text, `\ No newline`) {
			continue
		}
		prefix := text[0]
		oldPresent := prefix != '+'
		newPresent := prefix != '-'
		if index == bodyLine {
			switch side {
			case "left":
				return oldLine, oldPresent
			case "right":
				return newLine, newPresent
			case "both":
				if newPresent {
					return newLine, true
				}
				return oldLine, oldPresent
			}
		}
		if oldPresent {
			oldLine++
		}
		if newPresent {
			newLine++
		}
	}
	return 0, false
}

func absInt64(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}

// MarkLandingThreadDone records that the landing-request author addressed a
// review thread in the current tip revision. The original reviewer must still
// acknowledge the thread before it stops blocking landing.
func (s *LandingService) MarkLandingThreadDone(ctx context.Context, actor *db.User, owner, repo string, number, threadID int64) (db.LandingRequestComment, error) {
	repository, landingRow, thread, err := s.resolveWritableLandingThread(ctx, actor, owner, repo, number, threadID)
	if err != nil {
		return db.LandingRequestComment{}, err
	}
	if actor.ID != landingRow.AuthorID {
		return db.LandingRequestComment{}, pkgerrors.Forbidden("only the landing request author can mark a review comment done")
	}
	revision, err := s.currentLandingTipRevision(ctx, repository.ID, owner, repo, landingRow.ChangeIds)
	if err != nil {
		return db.LandingRequestComment{}, err
	}
	updated, err := s.queries.MarkLandingRequestThreadDone(ctx, db.MarkLandingRequestThreadDoneParams{
		DoneBy:             pgtype.Int8{Int64: actor.ID, Valid: true},
		ResolvedInRevision: revision,
		ID:                 thread.ID,
		LandingRequestID:   landingRow.ID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.LandingRequestComment{}, pkgerrors.Conflict("review comment is not open")
		}
		return db.LandingRequestComment{}, pkgerrors.Internal("failed to mark review comment done").WithCause(err)
	}
	if err := s.dispatchLandingCommentEventAction(ctx, repository, landingRow, actor, updated, "done"); err != nil {
		return db.LandingRequestComment{}, err
	}
	return updated, nil
}

// AckLandingThread lets the reviewer who opened the thread accept the
// author's completed work and resolve the thread.
func (s *LandingService) AckLandingThread(ctx context.Context, actor *db.User, owner, repo string, number, threadID int64) (db.LandingRequestComment, error) {
	repository, landingRow, thread, err := s.resolveWritableLandingThread(ctx, actor, owner, repo, number, threadID)
	if err != nil {
		return db.LandingRequestComment{}, err
	}
	if !thread.UserID.Valid || actor.ID != thread.UserID.Int64 {
		return db.LandingRequestComment{}, pkgerrors.Forbidden("only the reviewer who opened the thread can acknowledge it")
	}
	updated, err := s.queries.AckLandingRequestThread(ctx, db.AckLandingRequestThreadParams{
		ResolvedBy:       pgtype.Int8{Int64: actor.ID, Valid: true},
		ID:               thread.ID,
		LandingRequestID: landingRow.ID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.LandingRequestComment{}, pkgerrors.Conflict("review comment is not done")
		}
		return db.LandingRequestComment{}, pkgerrors.Internal("failed to acknowledge review comment").WithCause(err)
	}
	if err := s.dispatchLandingCommentEventAction(ctx, repository, landingRow, actor, updated, "resolved"); err != nil {
		return db.LandingRequestComment{}, err
	}
	return updated, nil
}

// ReopenLandingThread returns a done or resolved thread to open. Either side
// of the review conversation may do this.
func (s *LandingService) ReopenLandingThread(ctx context.Context, actor *db.User, owner, repo string, number, threadID int64) (db.LandingRequestComment, error) {
	repository, landingRow, thread, err := s.resolveWritableLandingThread(ctx, actor, owner, repo, number, threadID)
	if err != nil {
		return db.LandingRequestComment{}, err
	}
	isAuthor := actor.ID == landingRow.AuthorID
	isReviewer := thread.UserID.Valid && actor.ID == thread.UserID.Int64
	if !isAuthor && !isReviewer {
		return db.LandingRequestComment{}, pkgerrors.Forbidden("only the landing request author or thread reviewer can reopen it")
	}
	updated, err := s.queries.ReopenLandingRequestThread(ctx, db.ReopenLandingRequestThreadParams{
		ID:               thread.ID,
		LandingRequestID: landingRow.ID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.LandingRequestComment{}, pkgerrors.Conflict("review comment is already open")
		}
		return db.LandingRequestComment{}, pkgerrors.Internal("failed to reopen review comment").WithCause(err)
	}
	if err := s.dispatchLandingCommentEventAction(ctx, repository, landingRow, actor, updated, "reopened"); err != nil {
		return db.LandingRequestComment{}, err
	}
	return updated, nil
}

func (s *LandingService) resolveWritableLandingThread(ctx context.Context, actor *db.User, owner, repo string, number, threadID int64) (db.Repository, db.GetLandingRequestWithChangeIDsByNumberRow, db.LandingRequestComment, error) {
	if actor == nil {
		return db.Repository{}, db.GetLandingRequestWithChangeIDsByNumberRow{}, db.LandingRequestComment{}, pkgerrors.Unauthorized("authentication required")
	}
	if threadID <= 0 {
		return db.Repository{}, db.GetLandingRequestWithChangeIDsByNumberRow{}, db.LandingRequestComment{}, pkgerrors.BadRequest("invalid thread id")
	}
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return db.Repository{}, db.GetLandingRequestWithChangeIDsByNumberRow{}, db.LandingRequestComment{}, err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return db.Repository{}, db.GetLandingRequestWithChangeIDsByNumberRow{}, db.LandingRequestComment{}, err
	}
	landingRow, err := s.getLandingByNumber(ctx, repository.ID, number)
	if err != nil {
		return db.Repository{}, db.GetLandingRequestWithChangeIDsByNumberRow{}, db.LandingRequestComment{}, err
	}
	thread, err := s.queries.GetLandingRequestCommentByID(ctx, db.GetLandingRequestCommentByIDParams{ID: threadID, LandingRequestID: landingRow.ID})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Repository{}, db.GetLandingRequestWithChangeIDsByNumberRow{}, db.LandingRequestComment{}, pkgerrors.NotFound("review comment not found")
		}
		return db.Repository{}, db.GetLandingRequestWithChangeIDsByNumberRow{}, db.LandingRequestComment{}, pkgerrors.Internal("failed to load review comment").WithCause(err)
	}
	return repository, landingRow, thread, nil
}

func (s *LandingService) currentLandingTipRevision(ctx context.Context, repositoryID int64, owner, repo string, changeIDs []string) (json.RawMessage, error) {
	if len(changeIDs) == 0 {
		return nil, pkgerrors.Conflict("landing request has no changes")
	}
	changeID := changeIDs[len(changeIDs)-1]
	if q, ok := s.queries.(landingRevisionQuerier); ok {
		revisions, err := q.ListChangeRevisions(ctx, db.ListChangeRevisionsParams{RepositoryID: repositoryID, ChangeID: changeID})
		if err != nil {
			return nil, pkgerrors.Internal("failed to load current landing revision").WithCause(err)
		}
		if len(revisions) == 0 {
			return nil, pkgerrors.Conflict("current landing revision has not been recorded")
		}
		current := revisions[len(revisions)-1]
		revision, err := json.Marshal(approvalRevision{CommitID: current.CommitID, Seq: current.Seq})
		if err != nil {
			return nil, pkgerrors.Internal("failed to encode current landing revision").WithCause(err)
		}
		return revision, nil
	}

	// Lightweight test doubles and older embedders may not expose revision
	// queries. Fall back to repo-host while keeping production pinned to the
	// persisted change_revisions history.
	change, err := s.repoHost.GetChange(ctx, owner, repo, changeID)
	if err != nil {
		return nil, mapLandingRepoHostError(err, "failed to load current landing revision")
	}
	revision, err := json.Marshal(approvalRevision{CommitID: change.CommitID, Seq: 1})
	if err != nil {
		return nil, pkgerrors.Internal("failed to encode current landing revision").WithCause(err)
	}
	return revision, nil
}

func (s *LandingService) ListLandingChanges(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]LandingChangeResponse, int64, error) {
	repository, landingRow, err := s.resolveReadableLanding(ctx, viewer, owner, repo, number)
	if err != nil {
		return nil, 0, err
	}
	_ = repository

	pageSize, pageOffset, _, _ := normalizePage(page, perPage)
	changes, err := s.queries.ListLandingRequestChanges(ctx, db.ListLandingRequestChangesParams{
		LandingRequestID: landingRow.ID,
		PageOffset:       pageOffset,
		PageSize:         pageSize,
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to list landing changes").WithCause(err)
	}
	total, err := s.queries.CountLandingRequestChanges(ctx, landingRow.ID)
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to count landing changes").WithCause(err)
	}
	items := make([]LandingChangeResponse, 0, len(changes))
	for _, ref := range changes {
		// An unmerged request still follows its live change head. Reading it
		// must not depend on a review/landing having recorded a revision yet.
		if landingRow.State != landingStateMerged {
			change, err := s.repoHost.GetChange(ctx, strings.TrimSpace(owner), repository.Name, ref.ChangeID)
			if err != nil {
				return nil, 0, mapLandingRepoHostError(err, "failed to load landing change")
			}
			items = append(items, LandingChangeResponse{LandingRequestChange: ref, CommitID: change.CommitID, Description: change.Description, AuthorName: change.AuthorName, Timestamp: change.Timestamp})
			continue
		}
		change, err := s.queries.GetChangeByChangeID(ctx, db.GetChangeByChangeIDParams{RepositoryID: repository.ID, ChangeID: ref.ChangeID})
		if err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return nil, 0, pkgerrors.NotFound("landing change not found")
			}
			return nil, 0, pkgerrors.Internal("failed to load landing change").WithCause(err)
		}
		revision, err := s.landingDisplayRevision(ctx, repository.ID, landingRow, ref.ChangeID)
		if err != nil {
			return nil, 0, err
		}
		if change.CommitID != revision.CommitID {
			return nil, 0, pkgerrors.Conflict("landing commit metadata no longer matches its retained revision")
		}
		items = append(items, LandingChangeResponse{LandingRequestChange: ref, CommitID: revision.CommitID, Description: change.Description, AuthorName: change.AuthorName, Timestamp: revision.CreatedAt.Format(time.RFC3339Nano)})
	}
	return items, total, nil
}

func (s *LandingService) GetLandingConflicts(ctx context.Context, viewer *db.User, owner, repo string, number int64) (LandingConflictsResponse, error) {
	repository, landingRow, err := s.resolveReadableLanding(ctx, viewer, owner, repo, number)
	if err != nil {
		return LandingConflictsResponse{}, err
	}

	resp := LandingConflictsResponse{
		ConflictStatus: landingRow.ConflictStatus,
		HasConflicts:   landingRow.ConflictStatus == "conflicted",
	}
	if !resp.HasConflicts {
		return resp, nil
	}

	conflicts := make(map[string][]LandingConflict, len(landingRow.ChangeIds))
	for _, changeID := range landingRow.ChangeIds {
		rows, err := s.repoHost.GetChangeConflicts(ctx, strings.TrimSpace(owner), repository.Name, changeID)
		if err != nil {
			return LandingConflictsResponse{}, mapLandingRepoHostError(err, "failed to load landing conflicts")
		}
		items := make([]LandingConflict, 0, len(rows))
		for _, row := range rows {
			items = append(items, LandingConflict{
				FilePath:     row.FilePath,
				ConflictType: row.ConflictType,
			})
		}
		conflicts[changeID] = items
	}
	resp.ConflictsByChange = conflicts
	return resp, nil
}

// DismissLandingReviewInput holds the fields for dismissing a landing review.
type DismissLandingReviewInput struct {
	Message string `json:"message"`
}

// LandingDiffEntry holds the per-change diff data for a landing request.
type LandingDiffEntry struct {
	ChangeID  string              `json:"change_id"`
	FileDiffs []repohost.FileDiff `json:"file_diffs"`
}

// LandingDiffResponse holds the full diff for all changes in a landing request.
type LandingDiffResponse struct {
	LandingNumber int64              `json:"landing_number"`
	Changes       []LandingDiffEntry `json:"changes"`
}

type LandingDiffOptions struct {
	IgnoreWhitespace bool
}

// DismissLandingReview sets a review's state to dismissed.
func (s *LandingService) DismissLandingReview(ctx context.Context, actor *db.User, owner, repo string, number, reviewID int64, req DismissLandingReviewInput) (db.LandingRequestReview, error) {
	if actor == nil {
		return db.LandingRequestReview{}, pkgerrors.Unauthorized("authentication required")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return db.LandingRequestReview{}, err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return db.LandingRequestReview{}, err
	}

	landingRow, err := s.getLandingByNumber(ctx, repository.ID, number)
	if err != nil {
		return db.LandingRequestReview{}, err
	}

	// Verify the review belongs to this landing request.
	review, err := s.queries.GetLandingRequestReviewByID(ctx, reviewID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.LandingRequestReview{}, pkgerrors.NotFound("review not found")
		}
		return db.LandingRequestReview{}, pkgerrors.Internal("failed to load review").WithCause(err)
	}
	if review.LandingRequestID != landingRow.ID {
		return db.LandingRequestReview{}, pkgerrors.NotFound("review not found")
	}
	if review.ReviewerKind == "human" && actsThroughRunCredential(ctx, actor.ID) {
		return db.LandingRequestReview{}, pkgerrors.Forbidden("a run credential cannot dismiss a person's review")
	}

	updated, err := s.queries.UpdateLandingRequestReviewState(ctx, db.UpdateLandingRequestReviewStateParams{
		ID:    reviewID,
		State: "dismissed",
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.LandingRequestReview{}, pkgerrors.NotFound("review not found")
		}
		return db.LandingRequestReview{}, pkgerrors.Internal("failed to dismiss review").WithCause(err)
	}
	return updated, nil
}

// GetLandingDiff aggregates per-change diffs from repo-host for all changes
// in a landing request.
func (s *LandingService) GetLandingDiff(ctx context.Context, viewer *db.User, owner, repo string, number int64, opts LandingDiffOptions) (LandingDiffResponse, error) {
	repository, landingRow, err := s.resolveReadableLanding(ctx, viewer, owner, repo, number)
	if err != nil {
		return LandingDiffResponse{}, err
	}

	entries := make([]LandingDiffEntry, 0, len(landingRow.ChangeIds))
	revisionHost, ok := s.repoHost.(landingRevisionDiffRepoHost)
	if landingRow.State == landingStateMerged && !ok {
		return LandingDiffResponse{}, pkgerrors.Internal("landing revision diff unavailable")
	}
	for _, changeID := range landingRow.ChangeIds {
		var diff repohost.ChangeDiff
		if landingRow.State == landingStateMerged {
			revision, revisionErr := s.landingDisplayRevision(ctx, repository.ID, landingRow, changeID)
			if revisionErr != nil {
				return LandingDiffResponse{}, revisionErr
			}
			diff, err = diffview.BuildRevisionDiff(ctx, revisionHost, strings.TrimSpace(owner), repository.Name, changeID, revision.ParentCommitID, revision.CommitID, "", diffview.BuildOptions{IgnoreWhitespace: opts.IgnoreWhitespace})
		} else {
			diff, err = diffview.BuildChangeDiff(ctx, s.repoHost, strings.TrimSpace(owner), repository.Name, changeID, diffview.BuildOptions{IgnoreWhitespace: opts.IgnoreWhitespace})
		}
		if err != nil {
			return LandingDiffResponse{}, mapLandingRepoHostError(err, "failed to load change diff")
		}
		entries = append(entries, LandingDiffEntry{
			ChangeID:  changeID,
			FileDiffs: diff.FileDiffs,
		})
	}

	return LandingDiffResponse{
		LandingNumber: landingRow.Number,
		Changes:       entries,
	}, nil
}

// landingDisplayRevision pins a landing read to the immutable revision it
// merged. Open requests use the latest recorded revision. The live change head
// may no longer exist after jj abandons a landed change, so display reads must
// never resolve history through GetChange(changeID).
func (s *LandingService) landingDisplayRevision(ctx context.Context, repositoryID int64, landing db.GetLandingRequestWithChangeIDsByNumberRow, changeID string) (db.ChangeRevision, error) {
	q, ok := s.queries.(landingRevisionQuerier)
	if !ok {
		return db.ChangeRevision{}, pkgerrors.Internal("landing revision history unavailable")
	}
	revisions, err := q.ListChangeRevisions(ctx, db.ListChangeRevisionsParams{RepositoryID: repositoryID, ChangeID: changeID})
	if err != nil {
		return db.ChangeRevision{}, pkgerrors.Internal("failed to load landing revision").WithCause(err)
	}
	wanted := ""
	if landing.State == landingStateMerged {
		if len(landing.LandedRevisions) == 0 {
			return db.ChangeRevision{}, pkgerrors.NotFound("landed revision not recorded")
		}
		var pins map[string]approvalRevision
		if err := json.Unmarshal(landing.LandedRevisions, &pins); err != nil {
			return db.ChangeRevision{}, pkgerrors.Internal("failed to decode landed revisions").WithCause(err)
		}
		wanted = pins[changeID].CommitID
		if wanted == "" {
			return db.ChangeRevision{}, pkgerrors.NotFound("landed revision not recorded")
		}
	}
	for index := len(revisions) - 1; index >= 0; index-- {
		revision := revisions[index]
		if wanted == "" || revision.CommitID == wanted {
			return revision, nil
		}
	}
	return db.ChangeRevision{}, pkgerrors.NotFound("landing revision not found")
}

func mapLandingRepoHostError(err error, fallbackMessage string) error {
	status, ok := extractRepoHostStatusCode(err)
	if !ok {
		return pkgerrors.Internal(fallbackMessage)
	}

	switch status {
	case 404:
		return pkgerrors.NotFound("change not found")
	case 409:
		return pkgerrors.Conflict("landing conflict data unavailable")
	default:
		return pkgerrors.Internal(fallbackMessage)
	}
}

func extractRepoHostStatusCode(err error) (int, bool) {
	if err == nil {
		return 0, false
	}
	var statusError *repohost.StatusError
	if stdErrors.As(err, &statusError) {
		return statusError.StatusCode, true
	}

	const marker = "repo-host returned status "
	idx := strings.LastIndex(err.Error(), marker)
	if idx < 0 {
		return 0, false
	}

	tail := strings.TrimSpace(err.Error()[idx+len(marker):])
	if tail == "" {
		return 0, false
	}
	codeText := strings.Fields(tail)[0]
	status, parseErr := strconv.Atoi(codeText)
	if parseErr != nil {
		return 0, false
	}
	return status, true
}

func (s *LandingService) resolveRepoByOwnerAndName(ctx context.Context, owner, repo string) (db.Repository, error) {
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

func (s *LandingService) getLandingByNumber(ctx context.Context, repoID, number int64) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
	if number <= 0 {
		return db.GetLandingRequestWithChangeIDsByNumberRow{}, pkgerrors.BadRequest("invalid landing number")
	}

	row, err := s.queries.GetLandingRequestWithChangeIDsByNumber(ctx, db.GetLandingRequestWithChangeIDsByNumberParams{
		RepositoryID: repoID,
		Number:       number,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.GetLandingRequestWithChangeIDsByNumberRow{}, pkgerrors.NotFound("landing request not found")
		}
		return db.GetLandingRequestWithChangeIDsByNumberRow{}, pkgerrors.Internal("failed to load landing request").WithCause(err)
	}
	return row, nil
}

func (s *LandingService) mapLandingRow(ctx context.Context, repository db.Repository, owner string, row db.GetLandingRequestWithChangeIDsByNumberRow) (LandingRequestResponse, error) {
	record := landingRecordFromRow(row)
	return s.mapLandingRecord(ctx, repository, owner, record, row.ChangeIds)
}

func (s *LandingService) mapLandingRecord(ctx context.Context, repository db.Repository, owner string, row db.LandingRequest, changeIDs []string) (LandingRequestResponse, error) {
	author, err := s.queries.GetUserByID(ctx, row.AuthorID)
	if err != nil {
		return LandingRequestResponse{}, pkgerrors.Internal("failed to load landing request author").WithCause(err)
	}
	response := LandingRequestResponse{
		Number:         row.Number,
		RequestID:      uuidString(row.RequestID),
		Title:          row.Title,
		Body:           row.Body,
		State:          row.State,
		Author:         LandingRequestAuthor{ID: author.ID, Login: author.Username},
		ChangeIDs:      changeIDs,
		TargetBookmark: row.TargetBookmark,
		ConflictStatus: row.ConflictStatus,
		StackSize:      row.StackSize,
		AgentAuthored:  row.AgentAuthored,
		Turn: resolveLandingTurnWithCache(ctx, s.queries, row.TurnParty, row.TurnActorID, row.TurnSince, row.TurnReason, map[string]string{
			strconv.FormatInt(author.ID, 10): author.Username,
		}),
		ReviewRequests: []LandingReviewRequestResponse{},
		AutoLand:       LandingAutoLand{Enabled: row.AutoLandEnabled, WaitingOn: []LandingBlock{}},
		CreatedAt:      row.CreatedAt,
		UpdatedAt:      row.UpdatedAt,
	}
	if err := s.populateLandingReadiness(ctx, repository, owner, row.ID, row.TargetBookmark, row.ConflictStatus, changeIDs, &response); err != nil {
		return LandingRequestResponse{}, err
	}
	if err := s.populateLandingReviewRequests(ctx, row.ID, &response); err != nil {
		return LandingRequestResponse{}, err
	}
	if err := s.populateLandingGitHubMerge(ctx, row, &response); err != nil {
		return LandingRequestResponse{}, err
	}
	return s.populateAutoLandMetadata(ctx, row, response)
}

type landingGitHubMergeQuerier interface {
	GetLandingGitHubMerge(ctx context.Context, landingRequestID int64) (db.LandingGitHubMerge, error)
}

func (s *LandingService) populateLandingGitHubMerge(ctx context.Context, row db.LandingRequest, response *LandingRequestResponse) error {
	q, ok := s.queries.(landingGitHubMergeQuerier)
	if !ok || row.State != landingStateMerged {
		return nil
	}
	merge, err := q.GetLandingGitHubMerge(ctx, row.ID)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return pkgerrors.Internal("failed to load landing GitHub merge").WithCause(err)
	}
	response.GitHubMerge = &LandingGitHubMergeReceipt{Repository: merge.GithubRepository, PullNumber: merge.PullNumber,
		HeadSHA: merge.HeadSha, MergeCommit: merge.MergeCommit}
	return nil
}

type landingTurnIdentityQuerier interface {
	GetUserByID(ctx context.Context, id int64) (db.User, error)
}

type landingTurnAgentQuerier interface {
	GetAgentSession(ctx context.Context, id string) (db.AgentSession, error)
}

func resolveLandingTurnWithCache(ctx context.Context, queries landingTurnIdentityQuerier, party, actorID string, since time.Time, reason string, logins map[string]string) LandingRequestTurn {
	turn := LandingRequestTurn{Party: party, ActorID: actorID, Since: since, Reason: reason}
	turn.ActorLogin = resolveActorLoginWithCache(ctx, queries, actorID, logins)
	return turn
}

func resolveActorLoginWithCache(ctx context.Context, queries landingTurnIdentityQuerier, actorID string, logins map[string]string) string {
	if login, ok := logins[actorID]; ok {
		return login
	}
	login := ""
	if userID, err := strconv.ParseInt(actorID, 10, 64); err == nil && userID > 0 {
		if user, err := queries.GetUserByID(ctx, userID); err == nil {
			login = user.Username
		}
		if logins != nil {
			logins[actorID] = login
		}
		return login
	}
	if _, err := uuid.Parse(actorID); err != nil {
		return login
	}
	agentQueries, ok := queries.(landingTurnAgentQuerier)
	if !ok {
		return login
	}
	if session, err := agentQueries.GetAgentSession(ctx, actorID); err == nil {
		login = session.Title
	}
	if logins != nil {
		logins[actorID] = login
	}
	return login
}

func (s *LandingService) populateLandingReviewRequests(ctx context.Context, landingRequestID int64, response *LandingRequestResponse) error {
	response.ReviewRequests = []LandingReviewRequestResponse{}
	q, ok := s.queries.(landingReviewRequestQuerier)
	if !ok {
		return nil
	}
	rows, err := q.ListLandingReviewRequests(ctx, landingRequestID)
	if err != nil {
		return pkgerrors.Internal("failed to list landing review requests").WithCause(err)
	}
	for _, row := range rows {
		mapped, err := s.mapLandingReviewRequest(ctx, row)
		if err != nil {
			return err
		}
		response.ReviewRequests = append(response.ReviewRequests, mapped)
	}
	return nil
}

func (s *LandingService) mapLandingReviewRequest(ctx context.Context, row db.LandingReviewRequest) (LandingReviewRequestResponse, error) {
	requester, err := s.queries.GetUserByID(ctx, row.RequestedBy)
	if err != nil {
		return LandingReviewRequestResponse{}, pkgerrors.Internal("failed to load landing review requester").WithCause(err)
	}
	response := LandingReviewRequestResponse{
		ID:          row.ID,
		RequestedBy: LandingRequestAuthor{ID: requester.ID, Login: requester.Username},
		State:       row.State,
		CreatedAt:   row.CreatedAt,
	}
	if row.ReviewerID.Valid {
		reviewer, err := s.queries.GetUserByID(ctx, row.ReviewerID.Int64)
		if err != nil {
			return LandingReviewRequestResponse{}, pkgerrors.Internal("failed to load landing reviewer").WithCause(err)
		}
		mapped := LandingRequestAuthor{ID: reviewer.ID, Login: reviewer.Username}
		response.Reviewer = &mapped
	}
	if row.AgentName.Valid {
		response.Agent = row.AgentName.String
	}
	return response, nil
}

func (s *LandingService) populateAutoLandMetadata(ctx context.Context, row db.LandingRequest, response LandingRequestResponse) (LandingRequestResponse, error) {
	response.AutoLand.Enabled = row.AutoLandEnabled
	if !row.AutoLandEnabled {
		response.AutoLand.WaitingOn = []LandingBlock{}
		return response, nil
	}
	if !row.AutoLandSetBy.Valid || !row.AutoLandSetAt.Valid {
		return LandingRequestResponse{}, pkgerrors.Internal("landing request has invalid auto-land intent")
	}
	setter, err := s.queries.GetUserByID(ctx, row.AutoLandSetBy.Int64)
	if err != nil {
		return LandingRequestResponse{}, pkgerrors.Internal("failed to load auto-land setter").WithCause(err)
	}
	setBy := LandingRequestAuthor{ID: setter.ID, Login: setter.Username}
	setAt := row.AutoLandSetAt.Time
	response.AutoLand.SetBy = &setBy
	response.AutoLand.SetAt = &setAt
	if response.AutoLand.WaitingOn == nil {
		response.AutoLand.WaitingOn = []LandingBlock{}
	}
	return response, nil
}

func (s *LandingService) populateAutoLandWaiting(ctx context.Context, repository db.Repository, owner, repo string, row db.GetLandingRequestWithChangeIDsByNumberRow, response LandingRequestResponse) (LandingRequestResponse, error) {
	if !row.AutoLandEnabled || row.State != landingStateOpen {
		response.AutoLand.WaitingOn = []LandingBlock{}
		return response, nil
	}
	blocks, err := s.landingBlockers(ctx, repository, owner, repo, row)
	if err != nil {
		return LandingRequestResponse{}, err
	}
	response.AutoLand.WaitingOn = blocks
	return response, nil
}

func landingRecordWithChangeIDs(row db.LandingRequest, changeIDs []string) db.GetLandingRequestWithChangeIDsByNumberRow {
	return db.GetLandingRequestWithChangeIDsByNumberRow{
		ID: row.ID, RepositoryID: row.RepositoryID, Number: row.Number, RequestID: row.RequestID, CreateRequestHash: row.CreateRequestHash, Title: row.Title, Body: row.Body,
		State: row.State, AuthorID: row.AuthorID, TargetBookmark: row.TargetBookmark, SourceBookmark: row.SourceBookmark,
		ConflictStatus: row.ConflictStatus, StackSize: row.StackSize, AgentAuthored: row.AgentAuthored,
		AuthorAgentSessionID: row.AuthorAgentSessionID, TurnParty: row.TurnParty, TurnActorID: row.TurnActorID,
		TurnSince: row.TurnSince, TurnReason: row.TurnReason,
		AutoLandEnabled: row.AutoLandEnabled, AutoLandSetBy: row.AutoLandSetBy, AutoLandSetAt: row.AutoLandSetAt,
		AutoLandCheckedAt: row.AutoLandCheckedAt, QueuedBy: row.QueuedBy, QueuedAt: row.QueuedAt,
		LandingStartedAt: row.LandingStartedAt, ClosedAt: row.ClosedAt, MergedAt: row.MergedAt,
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, ChangeIds: changeIDs,
	}
}

func landingRecordFromRow(row db.GetLandingRequestWithChangeIDsByNumberRow) db.LandingRequest {
	return db.LandingRequest{
		ID: row.ID, RepositoryID: row.RepositoryID, Number: row.Number, RequestID: row.RequestID, CreateRequestHash: row.CreateRequestHash, Title: row.Title, Body: row.Body,
		State: row.State, AuthorID: row.AuthorID, TargetBookmark: row.TargetBookmark, SourceBookmark: row.SourceBookmark,
		ConflictStatus: row.ConflictStatus, StackSize: row.StackSize, AgentAuthored: row.AgentAuthored,
		AuthorAgentSessionID: row.AuthorAgentSessionID, TurnParty: row.TurnParty, TurnActorID: row.TurnActorID,
		TurnSince: row.TurnSince, TurnReason: row.TurnReason,
		AutoLandEnabled: row.AutoLandEnabled, AutoLandSetBy: row.AutoLandSetBy, AutoLandSetAt: row.AutoLandSetAt,
		AutoLandCheckedAt: row.AutoLandCheckedAt, QueuedBy: row.QueuedBy, QueuedAt: row.QueuedAt,
		LandingStartedAt: row.LandingStartedAt, ClosedAt: row.ClosedAt, MergedAt: row.MergedAt,
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	}
}

func landingRecordFromKeysetRow(row db.ListLandingRequestsByRepoFilteredKeysetRow) db.LandingRequest {
	return db.LandingRequest{
		ID: row.ID, RepositoryID: row.RepositoryID, Number: row.Number, RequestID: row.RequestID, CreateRequestHash: row.CreateRequestHash, Title: row.Title, Body: row.Body,
		State: row.State, AuthorID: row.AuthorID, TargetBookmark: row.TargetBookmark, SourceBookmark: row.SourceBookmark,
		ConflictStatus: row.ConflictStatus, StackSize: row.StackSize, AgentAuthored: row.AgentAuthored,
		AuthorAgentSessionID: row.AuthorAgentSessionID, TurnParty: row.TurnParty, TurnActorID: row.TurnActorID,
		TurnSince: row.TurnSince, TurnReason: row.TurnReason,
		AutoLandEnabled: row.AutoLandEnabled, AutoLandSetBy: row.AutoLandSetBy, AutoLandSetAt: row.AutoLandSetAt,
		AutoLandCheckedAt: row.AutoLandCheckedAt, QueuedBy: row.QueuedBy, QueuedAt: row.QueuedAt,
		LandingStartedAt: row.LandingStartedAt, ClosedAt: row.ClosedAt, MergedAt: row.MergedAt,
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	}
}

func (s *LandingService) resolveLandingAuthor(ctx context.Context, cache map[int64]LandingRequestAuthor, userID int64) (LandingRequestAuthor, error) {
	if author, ok := cache[userID]; ok {
		return author, nil
	}
	user, err := s.queries.GetUserByID(ctx, userID)
	if err != nil {
		return LandingRequestAuthor{}, pkgerrors.Internal("failed to load landing request author").WithCause(err)
	}
	author := LandingRequestAuthor{
		ID:    user.ID,
		Login: user.Username,
	}
	cache[userID] = author
	return author, nil
}

func (s *LandingService) dispatchLandingRequestEvent(ctx context.Context, repository db.Repository, actor *db.User, action string, row LandingRequestResponse) error {
	if s.dispatcher != nil {
		payload := webhooks.LandingRequestEventPayload{
			Action:         action,
			LandingRequest: landingResponseToWebhookPayload(row),
			Repository: webhooks.RepositoryPayload{
				ID:   repository.ID,
				Name: repository.Name,
			},
			Sender: webhookSender(actor),
		}

		if err := s.dispatcher.DispatchEvent(ctx, repository.ID, webhooks.EventTypeLandingRequest, payload); err != nil {
			return pkgerrors.Internal("failed to enqueue webhook delivery").WithCause(err)
		}
	}

	// Dispatch workflow runs for landing_request events (non-fatal).
	if s.workflowRunSvc != nil {
		event := TriggerEvent{
			Type:   "landing_request",
			Action: action,
			Ref:    row.TargetBookmark,
		}
		if len(row.ChangeIDs) > 0 {
			event.ChangeID = row.ChangeIDs[0]
		}
		input := DispatchForEventInput{
			RepositoryID: repository.ID,
			Event:        event,
		}
		if actor != nil {
			input.UserID = actor.ID
		}
		if _, err := s.workflowRunSvc.DispatchForEvent(ctx, input); err != nil {
			slog.Error("workflow dispatch for landing_request failed", "repo_id", repository.ID, "action", action, "error", err)
		}
	}

	return nil
}

func (s *LandingService) dispatchLandingConflictEvent(
	ctx context.Context,
	repository db.Repository,
	actor *db.User,
	previousStatus string,
	row LandingRequestResponse,
) error {
	if s.dispatcher == nil {
		return nil
	}

	action := "resolved"
	if row.ConflictStatus == "conflicted" {
		action = "conflicted"
	}

	payload := webhooks.LandingConflictEventPayload{
		Action:         action,
		PreviousStatus: previousStatus,
		LandingRequest: landingResponseToWebhookPayload(row),
		Repository: webhooks.RepositoryPayload{
			ID:   repository.ID,
			Name: repository.Name,
		},
		Sender: webhookSender(actor),
	}

	if err := s.dispatcher.DispatchEvent(ctx, repository.ID, webhooks.EventTypeLandingConflict, payload); err != nil {
		return pkgerrors.Internal("failed to enqueue webhook delivery").WithCause(err)
	}
	return nil
}

func (s *LandingService) dispatchLandingReviewEvent(
	ctx context.Context,
	repository db.Repository,
	landingRow db.GetLandingRequestWithChangeIDsByNumberRow,
	actor *db.User,
	review db.LandingRequestReview,
) error {
	if s.dispatcher == nil {
		return nil
	}

	author, err := s.queries.GetUserByID(ctx, landingRow.AuthorID)
	if err != nil {
		return pkgerrors.Internal("failed to load landing request author").WithCause(err)
	}

	payload := webhooks.LandingRequestReviewEventPayload{
		Action: "submitted",
		Review: webhooks.LandingReviewPayload{
			ID:               review.ID,
			LandingRequestID: review.LandingRequestID,
			ReviewerKind:     review.ReviewerKind,
			Type:             review.Type,
			Verdict:          review.Verdict.String,
			ConfidenceBucket: review.ConfidenceBucket.String,
			Summary:          review.Summary,
			CommitID:         review.CommitID,
			Body:             review.Body,
			State:            review.State,
			Reviewer:         webhookSender(actor),
		},
		LandingRequest: webhooks.LandingRequestPayload{
			Number:         landingRow.Number,
			Title:          landingRow.Title,
			Body:           landingRow.Body,
			State:          landingRow.State,
			Author:         webhooks.UserPayload{ID: author.ID, Login: author.Username},
			ChangeIDs:      landingRow.ChangeIds,
			TargetBookmark: landingRow.TargetBookmark,
			ConflictStatus: landingRow.ConflictStatus,
			StackSize:      landingRow.StackSize,
			CreatedAt:      landingRow.CreatedAt,
			UpdatedAt:      landingRow.UpdatedAt,
		},
		Repository: webhooks.RepositoryPayload{
			ID:   repository.ID,
			Name: repository.Name,
		},
		Sender: webhookSender(actor),
	}

	if err := s.dispatcher.DispatchEvent(ctx, repository.ID, webhooks.EventTypeLandingRequestReview, payload); err != nil {
		return pkgerrors.Internal("failed to enqueue webhook delivery").WithCause(err)
	}
	return nil
}

func (s *LandingService) dispatchLandingCommentEvent(
	ctx context.Context,
	repository db.Repository,
	landingRow db.GetLandingRequestWithChangeIDsByNumberRow,
	actor *db.User,
	comment db.LandingRequestComment,
) error {
	return s.dispatchLandingCommentEventAction(ctx, repository, landingRow, actor, comment, "created")
}

func (s *LandingService) dispatchLandingCommentEventAction(
	ctx context.Context,
	repository db.Repository,
	landingRow db.GetLandingRequestWithChangeIDsByNumberRow,
	actor *db.User,
	comment db.LandingRequestComment,
	action string,
) error {
	if s.dispatcher == nil {
		return nil
	}

	author, err := s.queries.GetUserByID(ctx, landingRow.AuthorID)
	if err != nil {
		return pkgerrors.Internal("failed to load landing request author").WithCause(err)
	}

	payload := webhooks.LandingRequestCommentEventPayload{
		Action: action,
		Comment: webhooks.LandingCommentPayload{
			ID:                 comment.ID,
			LandingRequestID:   comment.LandingRequestID,
			Path:               comment.Path,
			Line:               comment.Line,
			Side:               comment.Side,
			Body:               comment.Body,
			CommitID:           comment.CommitID,
			AnchorHash:         comment.AnchorHash,
			State:              comment.State,
			ResolvedInRevision: comment.ResolvedInRevision,
			User:               webhookSender(actor),
		},
		LandingRequest: webhooks.LandingRequestPayload{
			Number:         landingRow.Number,
			Title:          landingRow.Title,
			Body:           landingRow.Body,
			State:          landingRow.State,
			Author:         webhooks.UserPayload{ID: author.ID, Login: author.Username},
			ChangeIDs:      landingRow.ChangeIds,
			TargetBookmark: landingRow.TargetBookmark,
			ConflictStatus: landingRow.ConflictStatus,
			StackSize:      landingRow.StackSize,
			CreatedAt:      landingRow.CreatedAt,
			UpdatedAt:      landingRow.UpdatedAt,
		},
		Repository: webhooks.RepositoryPayload{
			ID:   repository.ID,
			Name: repository.Name,
		},
		Sender: webhookSender(actor),
	}

	if err := s.dispatcher.DispatchEvent(ctx, repository.ID, webhooks.EventTypeLandingRequestComment, payload); err != nil {
		return pkgerrors.Internal("failed to enqueue webhook delivery").WithCause(err)
	}
	return nil
}

func landingResponseToWebhookPayload(row LandingRequestResponse) webhooks.LandingRequestPayload {
	return webhooks.LandingRequestPayload{
		Number:         row.Number,
		Title:          row.Title,
		Body:           row.Body,
		State:          row.State,
		Author:         webhooks.UserPayload{ID: row.Author.ID, Login: row.Author.Login},
		ChangeIDs:      row.ChangeIDs,
		TargetBookmark: row.TargetBookmark,
		ConflictStatus: row.ConflictStatus,
		StackSize:      row.StackSize,
		CreatedAt:      row.CreatedAt,
		UpdatedAt:      row.UpdatedAt,
	}
}

func webhookSender(actor *db.User) webhooks.UserPayload {
	if actor == nil {
		return webhooks.UserPayload{}
	}
	return webhooks.UserPayload{
		ID:    actor.ID,
		Login: actor.Username,
	}
}

func (s *LandingService) resolveReadableLanding(ctx context.Context, viewer *db.User, owner, repo string, number int64) (db.Repository, db.GetLandingRequestWithChangeIDsByNumberRow, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return db.Repository{}, db.GetLandingRequestWithChangeIDsByNumberRow{}, err
	}
	if err := s.requireReadAccess(ctx, repository, viewer); err != nil {
		return db.Repository{}, db.GetLandingRequestWithChangeIDsByNumberRow{}, err
	}
	landingRow, err := s.getLandingByNumber(ctx, repository.ID, number)
	if err != nil {
		return db.Repository{}, db.GetLandingRequestWithChangeIDsByNumberRow{}, err
	}
	return repository, landingRow, nil
}

func (s *LandingService) requireReadAccess(ctx context.Context, repository db.Repository, viewer *db.User) error {
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

func (s *LandingService) requireWriteAccess(ctx context.Context, repository db.Repository, actor *db.User) error {
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

func (s *LandingService) requireLandAccess(ctx context.Context, repository db.Repository, actor *db.User) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	allowed, err := canLandRepo(ctx, s.queries, repository, actor.ID)
	if err != nil {
		return err
	}
	if !allowed {
		return pkgerrors.Forbidden("permission denied")
	}
	return nil
}

func (s *LandingService) canReadRepo(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canReadRepo(ctx, s.queries, repository, userID)
}

func (s *LandingService) canWriteRepo(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canWriteRepo(ctx, s.queries, repository, userID)
}

func isAllowedLandingState(state string) bool {
	switch state {
	case landingStateOpen, landingStateClosed, landingStateDraft, landingStateMerged, landingStateFailed:
		return true
	default:
		return false
	}
}

func isAllowedConflictStatus(status string) bool {
	switch status {
	case "clean", "conflicted", "unknown":
		return true
	default:
		return false
	}
}

func normalizeLandingFilterState(state string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(state))
	if normalized == "" {
		return "", nil
	}
	if !isAllowedLandingState(normalized) {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingRequest", Field: "state", Code: "invalid"})
	}
	return normalized, nil
}

func isValidLandingTransition(fromState, toState string) bool {
	if fromState == toState {
		return true
	}
	switch fromState {
	case landingStateOpen:
		return toState == landingStateDraft || toState == landingStateClosed
	case landingStateDraft:
		return toState == landingStateOpen || toState == landingStateClosed
	case landingStateClosed:
		return toState == landingStateOpen
	case landingStateFailed:
		return toState == landingStateOpen || toState == landingStateDraft || toState == landingStateClosed
	case landingStateMerged:
		return false
	default:
		return false
	}
}

// applyOptionalTitle returns the trimmed update value when non-nil, or the
// current value unchanged. Returns a validation error when the update is
// present but blank.
func applyOptionalTitle(current string, update *string) (string, error) {
	if update == nil {
		return current, nil
	}
	trimmed := strings.TrimSpace(*update)
	if trimmed == "" {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingRequest", Field: "title", Code: "missing_field"})
	}
	if len(trimmed) > 255 {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingRequest", Field: "title", Code: "too_long"})
	}
	if verr := validateSafeText("LandingRequest", "title", trimmed); verr != nil {
		return "", verr
	}
	return trimmed, nil
}

// applyOptionalState returns the resolved next state when an update is
// provided, performing all transition validation. Returns the current state
// unchanged when update is nil.
func applyOptionalState(current string, update *string) (string, error) {
	if update == nil {
		return current, nil
	}
	nextState := strings.ToLower(strings.TrimSpace(*update))
	if nextState == "" {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingRequest", Field: "state", Code: "invalid"})
	}
	if nextState == landingStateMerged || nextState == landingStateFailed {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingRequest", Field: "state", Code: "invalid"})
	}
	if !isAllowedLandingState(nextState) {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingRequest", Field: "state", Code: "invalid"})
	}
	if !isValidLandingTransition(current, nextState) {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingRequest", Field: "state", Code: "invalid"})
	}
	return nextState, nil
}

// applyOptionalBookmark returns the trimmed update value when non-nil, or the
// current value unchanged. Returns a validation error when the update is
// present but blank. The field parameter is used in the error message.
func applyOptionalBookmark(current string, update *string, field string) (string, error) {
	if update == nil {
		return current, nil
	}
	trimmed := strings.TrimSpace(*update)
	if trimmed == "" {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingRequest", Field: field, Code: "missing_field"})
	}
	return trimmed, nil
}

// applyOptionalConflictStatus returns the normalized conflict status when an
// update is provided. Returns the current value unchanged when update is nil.
func applyOptionalConflictStatus(current string, update *string) (string, error) {
	if update == nil {
		return current, nil
	}
	normalized := strings.ToLower(strings.TrimSpace(*update))
	if !isAllowedConflictStatus(normalized) {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingRequest", Field: "conflict_status", Code: "invalid"})
	}
	return normalized, nil
}

func normalizeChangeIDs(changeIDs []string) ([]string, error) {
	if len(changeIDs) == 0 {
		return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingRequest", Field: "change_ids", Code: "missing_field"})
	}
	if len(changeIDs) > maxLandingStackChanges {
		return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingRequest", Field: "change_ids", Code: "too_long"})
	}
	normalized := make([]string, 0, len(changeIDs))
	for _, raw := range changeIDs {
		clean := strings.TrimSpace(raw)
		if clean == "" || len(clean) > 255 {
			return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LandingRequest", Field: "change_ids", Code: "invalid"})
		}
		normalized = append(normalized, clean)
	}
	return normalized, nil
}

func isAllowedReviewType(reviewType string) bool {
	switch reviewType {
	case "pending", "approve", "comment", "request_changes":
		return true
	default:
		return false
	}
}

func normalizeLandingCreateError(err error, fallbackMsg string) error {
	if err == nil {
		return nil
	}

	var apiErr *pkgerrors.APIError
	if stdErrors.As(err, &apiErr) {
		return apiErr
	}

	var pgErr *pgconn.PgError
	if stdErrors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return pkgerrors.Conflict("landing request already exists")
		case "22001", "22021", "22P05":
			// 22001 = string_data_right_truncation (a value past a VARCHAR
			// limit, e.g. an oversized title/bookmark/change_id); 22021/22P05 =
			// invalid/NUL byte in a text column. All are malformed client
			// input, not a server fault — return a clean 422 instead of the
			// 500 that would otherwise leak the raw driver error.
			return pkgerrors.ValidationFailed(pkgerrors.FieldError{
				Resource: "LandingRequest",
				Field:    landingCreateErrorField(pgErr.ConstraintName),
				Code:     "invalid",
			})
		case "23502", "23503", "23514":
			return pkgerrors.ValidationFailed(pkgerrors.FieldError{
				Resource: "LandingRequest",
				Field:    landingCreateErrorField(pgErr.ConstraintName),
				Code:     "invalid",
			})
		}
	}

	return pkgerrors.Internal(fallbackMsg)
}

func landingCreateErrorField(constraint string) string {
	name := strings.ToLower(strings.TrimSpace(constraint))
	switch {
	case strings.Contains(name, "target_bookmark"):
		return "target_bookmark"
	case strings.Contains(name, "change"):
		return "change_ids"
	case strings.Contains(name, "stack_size"):
		return "stack_size"
	case strings.Contains(name, "conflict_status"):
		return "conflict_status"
	default:
		return "landing_request"
	}
}
