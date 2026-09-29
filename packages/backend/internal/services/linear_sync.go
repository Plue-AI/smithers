package services

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type LinearSyncQuerier interface {
	GetLinearIntegration(ctx context.Context, id int64) (db.LinearIntegration, error)
	GetLinearIntegrationByLinearTeamID(ctx context.Context, linearTeamID string) (db.LinearIntegration, error)
	ListLinearIntegrationsByRepo(ctx context.Context, smithersRepoID int64) ([]db.LinearIntegration, error)
	UpdateLinearIntegrationLastSync(ctx context.Context, id int64) error
	CreateLinearIssueMap(ctx context.Context, arg db.CreateLinearIssueMapParams) (db.LinearIssueMap, error)
	GetLinearIssueMapBySmithersIssue(ctx context.Context, arg db.GetLinearIssueMapBySmithersIssueParams) (db.LinearIssueMap, error)
	GetLinearIssueMapByLinearIssue(ctx context.Context, arg db.GetLinearIssueMapByLinearIssueParams) (db.LinearIssueMap, error)
	ListLinearIssueMaps(ctx context.Context, integrationID int64) ([]db.LinearIssueMap, error)
	CreateLinearCommentMap(ctx context.Context, arg db.CreateLinearCommentMapParams) (db.LinearCommentMap, error)
	GetLinearCommentMapBySmithersComment(ctx context.Context, arg db.GetLinearCommentMapBySmithersCommentParams) (db.LinearCommentMap, error)
	GetLinearCommentMapByLinearComment(ctx context.Context, arg db.GetLinearCommentMapByLinearCommentParams) (db.LinearCommentMap, error)
	DeleteLinearCommentMapBySmithersComment(ctx context.Context, arg db.DeleteLinearCommentMapBySmithersCommentParams) error
	DeleteLinearCommentMapByLinearComment(ctx context.Context, arg db.DeleteLinearCommentMapByLinearCommentParams) error
	LogLinearSyncOp(ctx context.Context, arg db.LogLinearSyncOpParams) (db.LinearSyncOp, error)
	RecentLinearSyncOpExists(ctx context.Context, arg db.RecentLinearSyncOpExistsParams) (bool, error)
	CreateIssue(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error)

	// Issue comment queries used for Linear→Smithers sync. Denormalized
	// counters (repositories.num_issues, issues.comment_count) are maintained
	// by database triggers, not by this service.
	GetIssueCommentByID(ctx context.Context, id int64) (db.IssueComment, error)
	UpdateIssueComment(ctx context.Context, arg db.UpdateIssueCommentParams) (db.IssueComment, error)
	DeleteIssueComment(ctx context.Context, id int64) error
}

// LinearSyncOperationsQuerier contains the durable feed, retry, and run
// operations added after the original sync engine. Keeping it separate leaves
// the event-only test doubles small while production's *db.Queries implements
// both contracts.
type LinearSyncOperationsQuerier interface {
	ListLinearSyncOps(ctx context.Context, arg db.ListLinearSyncOpsParams) ([]db.LinearSyncOp, error)
	GetLinearSyncOp(ctx context.Context, arg db.GetLinearSyncOpParams) (db.LinearSyncOp, error)
	CreateLinearSyncOpRetry(ctx context.Context, arg db.CreateLinearSyncOpRetryParams) (db.LinearSyncOp, error)
	CompleteLinearSyncOpRetry(ctx context.Context, arg db.CompleteLinearSyncOpRetryParams) (db.LinearSyncOp, error)
	CreateLinearSyncRun(ctx context.Context, integrationID int64) (db.LinearSyncRun, error)
	GetLinearSyncRun(ctx context.Context, arg db.GetLinearSyncRunParams) (db.LinearSyncRun, error)
	MarkLinearSyncRunRunning(ctx context.Context, id int64) (db.LinearSyncRun, error)
	SetLinearSyncRunTotals(ctx context.Context, arg db.SetLinearSyncRunTotalsParams) (db.LinearSyncRun, error)
	RecordLinearSyncRunResult(ctx context.Context, arg db.RecordLinearSyncRunResultParams) (db.LinearSyncRun, error)
	FinishLinearSyncRun(ctx context.Context, id int64) (db.LinearSyncRun, error)
	FailLinearSyncRun(ctx context.Context, id int64) (db.LinearSyncRun, error)
	GetIssueByID(ctx context.Context, id int64) (db.Issue, error)
	GetLinearCommentMapBySmithersCommentID(ctx context.Context, arg db.GetLinearCommentMapBySmithersCommentIDParams) (db.LinearCommentMap, error)
	GetLinearIssueMapBySmithersCommentID(ctx context.Context, arg db.GetLinearIssueMapBySmithersCommentIDParams) (db.LinearIssueMap, error)
}

type linearIssueImportQuerier interface {
	CreateIssue(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error)
	CreateLinearIssueMap(ctx context.Context, arg db.CreateLinearIssueMapParams) (db.LinearIssueMap, error)
}

type linearIssueImportTx interface {
	linearIssueImportQuerier
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

type linearIssueImportTxManager interface {
	BeginLinearIssueImportTx(ctx context.Context) (linearIssueImportTx, error)
}

type pgxLinearIssueImportTxManager struct {
	pool *pgxpool.Pool
}

func (m *pgxLinearIssueImportTxManager) BeginLinearIssueImportTx(ctx context.Context) (linearIssueImportTx, error) {
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &pgxLinearIssueImportTx{
		tx: tx,
		q:  db.New(tx),
	}, nil
}

type pgxLinearIssueImportTx struct {
	tx pgx.Tx
	q  *db.Queries
}

func (t *pgxLinearIssueImportTx) CreateIssue(ctx context.Context, arg db.CreateIssueParams) (db.Issue, error) {
	return t.q.CreateIssue(ctx, arg)
}

func (t *pgxLinearIssueImportTx) SetIssueTextEditor(ctx context.Context, arg db.SetIssueTextEditorParams) error {
	return t.q.SetIssueTextEditor(ctx, arg)
}

func (t *pgxLinearIssueImportTx) CreateLinearIssueMap(ctx context.Context, arg db.CreateLinearIssueMapParams) (db.LinearIssueMap, error) {
	return t.q.CreateLinearIssueMap(ctx, arg)
}

func (t *pgxLinearIssueImportTx) Commit(ctx context.Context) error {
	return t.tx.Commit(ctx)
}

func (t *pgxLinearIssueImportTx) Rollback(ctx context.Context) error {
	return t.tx.Rollback(ctx)
}

type LinearSyncService struct {
	queries              LinearSyncQuerier
	operations           LinearSyncOperationsQuerier
	integrationSvc       *LinearIntegrationService
	httpClient           *http.Client
	issueImportTxManager linearIssueImportTxManager
	now                  func() time.Time
	initialSyncInFlight  sync.Map // integration ID -> struct{}
}

var linearGraphQLURL = "https://api.linear.app/graphql"

// linearWebhookMaxAge bounds how far a signed webhookTimestamp may drift from
// the server clock before the delivery is rejected as a replay.
const linearWebhookMaxAge = 5 * time.Minute

// linearInitialSyncTimeout bounds a background initial sync so a stuck Linear
// API call cannot pin a goroutine forever.
const linearInitialSyncTimeout = 10 * time.Minute

func NewLinearSyncService(q LinearSyncQuerier, integrationSvc *LinearIntegrationService) *LinearSyncService {
	operations, _ := q.(LinearSyncOperationsQuerier)
	return &LinearSyncService{
		queries:        q,
		operations:     operations,
		integrationSvc: integrationSvc,
		httpClient:     observability.NewHTTPClient(15 * time.Second),
		now:            time.Now,
	}
}

type LinearSyncCount struct {
	Done   int32 `json:"done"`
	Total  int32 `json:"total"`
	Failed int32 `json:"failed"`
}

type LinearSyncRunStatus struct {
	State      string           `json:"state"`
	Counts     LinearSyncCounts `json:"counts"`
	StartedAt  *time.Time       `json:"started_at"`
	FinishedAt *time.Time       `json:"finished_at"`
}

type LinearSyncCounts struct {
	Issues   LinearSyncCount `json:"issues"`
	Comments LinearSyncCount `json:"comments"`
}

type LinearSyncOp struct {
	ID           int64     `json:"id"`
	RunID        *int64    `json:"run_id,omitempty"`
	RetryOfID    *int64    `json:"retry_of_id,omitempty"`
	Source       string    `json:"source"`
	Target       string    `json:"target"`
	Entity       string    `json:"entity"`
	EntityID     string    `json:"entity_id"`
	Action       string    `json:"action"`
	Status       string    `json:"status"`
	ErrorMessage string    `json:"error_message"`
	CreatedAt    time.Time `json:"created_at"`
}

type LinearSyncOpsFilter struct {
	Status string
	Since  *time.Time
	Cursor string
	Limit  int32
}

type LinearSyncOpsPage struct {
	Ops        []LinearSyncOp
	NextCursor string
}

func encodeLinearSyncOpsCursor(createdAt time.Time, id int64) string {
	value := strconv.FormatInt(createdAt.UTC().UnixMicro(), 10) + ":" + strconv.FormatInt(id, 10)
	return base64.RawURLEncoding.EncodeToString([]byte(value))
}

func decodeLinearSyncOpsCursor(cursor string) (time.Time, int64, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(cursor))
	if err != nil {
		return time.Time{}, 0, pkgerrors.BadRequest("invalid sync operations cursor")
	}
	createdAtRaw, idRaw, ok := strings.Cut(string(decoded), ":")
	if !ok {
		return time.Time{}, 0, pkgerrors.BadRequest("invalid sync operations cursor")
	}
	createdAtMicros, err := strconv.ParseInt(createdAtRaw, 10, 64)
	if err != nil || createdAtMicros <= 0 {
		return time.Time{}, 0, pkgerrors.BadRequest("invalid sync operations cursor")
	}
	id, err := strconv.ParseInt(idRaw, 10, 64)
	if err != nil || id <= 0 {
		return time.Time{}, 0, pkgerrors.BadRequest("invalid sync operations cursor")
	}
	createdAt := time.UnixMicro(createdAtMicros).UTC()
	if createdAt.Year() < 1 || createdAt.Year() > 9999 {
		return time.Time{}, 0, pkgerrors.BadRequest("invalid sync operations cursor")
	}
	return createdAt, id, nil
}

func linearSyncRunStatus(run db.LinearSyncRun) LinearSyncRunStatus {
	status := LinearSyncRunStatus{
		State: run.State,
		Counts: LinearSyncCounts{
			Issues:   LinearSyncCount{Done: run.IssuesDone, Total: run.IssuesTotal, Failed: run.IssuesFailed},
			Comments: LinearSyncCount{Done: run.CommentsDone, Total: run.CommentsTotal, Failed: run.CommentsFailed},
		},
	}
	if run.StartedAt.Valid {
		startedAt := run.StartedAt.Time
		status.StartedAt = &startedAt
	}
	if run.FinishedAt.Valid {
		finishedAt := run.FinishedAt.Time
		status.FinishedAt = &finishedAt
	}
	return status
}

func linearSyncOp(op db.LinearSyncOp) LinearSyncOp {
	result := LinearSyncOp{
		ID: op.ID, Source: op.Source, Target: op.Target, Entity: op.Entity,
		EntityID: op.EntityID, Action: op.Action, Status: op.Status,
		ErrorMessage: op.ErrorMessage, CreatedAt: op.CreatedAt,
	}
	if op.RunID.Valid {
		runID := op.RunID.Int64
		result.RunID = &runID
	}
	if op.RetryOfID.Valid {
		retryOfID := op.RetryOfID.Int64
		result.RetryOfID = &retryOfID
	}
	return result
}

func (s *LinearSyncService) ownedIntegration(ctx context.Context, userID, integrationID int64) (db.LinearIntegration, error) {
	if s.integrationSvc == nil {
		return db.LinearIntegration{}, pkgerrors.Internal("linear integration service unavailable")
	}
	integration, err := s.integrationSvc.GetIntegration(ctx, userID, integrationID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.LinearIntegration{}, pkgerrors.NotFound("linear integration not found")
		}
		return db.LinearIntegration{}, err
	}
	return integration, nil
}

// ListSyncOps returns the private operation DTO rather than the DB row so the
// replay payload never leaves the server. Error messages are copied byte for
// byte; clients depend on the provider's verbatim failure text.
func (s *LinearSyncService) ListSyncOps(ctx context.Context, userID, integrationID int64, filter LinearSyncOpsFilter) (LinearSyncOpsPage, error) {
	if s.operations == nil {
		return LinearSyncOpsPage{}, pkgerrors.Internal("linear sync operations unavailable")
	}
	switch filter.Status {
	case "", "pending", "success", "failed", "skipped":
	default:
		return LinearSyncOpsPage{}, pkgerrors.BadRequest("invalid sync operation status")
	}
	if _, err := s.ownedIntegration(ctx, userID, integrationID); err != nil {
		return LinearSyncOpsPage{}, err
	}

	limit := filter.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}
	var since pgtype.Timestamptz
	if filter.Since != nil {
		since = pgtype.Timestamptz{Time: filter.Since.UTC(), Valid: true}
	}
	var cursorCreatedAt pgtype.Timestamptz
	var cursorID pgtype.Int8
	if strings.TrimSpace(filter.Cursor) != "" {
		createdAt, id, err := decodeLinearSyncOpsCursor(filter.Cursor)
		if err != nil {
			return LinearSyncOpsPage{}, err
		}
		cursorCreatedAt = pgtype.Timestamptz{Time: createdAt, Valid: true}
		cursorID = pgtype.Int8{Int64: id, Valid: true}
	}
	rows, err := s.operations.ListLinearSyncOps(ctx, db.ListLinearSyncOpsParams{
		IntegrationID:   integrationID,
		StatusFilter:    filter.Status,
		Since:           since,
		CursorCreatedAt: cursorCreatedAt,
		CursorID:        cursorID,
		PageSize:        limit + 1,
	})
	if err != nil {
		return LinearSyncOpsPage{}, pkgerrors.Internal("failed to list linear sync operations").WithCause(err)
	}
	hasMore := len(rows) > int(limit)
	if hasMore {
		rows = rows[:limit]
	}
	ops := make([]LinearSyncOp, 0, len(rows))
	for _, row := range rows {
		ops = append(ops, linearSyncOp(row))
	}
	page := LinearSyncOpsPage{Ops: ops}
	if hasMore && len(rows) > 0 {
		last := rows[len(rows)-1]
		page.NextCursor = encodeLinearSyncOpsCursor(last.CreatedAt, last.ID)
	}
	return page, nil
}

// StartInitialSyncRun creates the durable polling handle before launching any
// provider work. Only one initial sync per integration runs in this process.
func (s *LinearSyncService) StartInitialSyncRun(ctx context.Context, userID, integrationID int64) (int64, error) {
	if s.operations == nil {
		return 0, pkgerrors.Internal("linear sync operations unavailable")
	}
	integration, err := s.ownedIntegration(ctx, userID, integrationID)
	if err != nil {
		return 0, err
	}
	if !integration.IsActive {
		return 0, pkgerrors.Conflict("linear integration is inactive")
	}
	if _, loaded := s.initialSyncInFlight.LoadOrStore(integration.ID, int64(0)); loaded {
		return 0, pkgerrors.Conflict("linear sync already running")
	}

	run, err := s.operations.CreateLinearSyncRun(ctx, integration.ID)
	if err != nil {
		s.initialSyncInFlight.Delete(integration.ID)
		return 0, pkgerrors.Internal("failed to create linear sync run").WithCause(err)
	}
	s.initialSyncInFlight.Store(integration.ID, run.ID)
	SafeGo("linear-initial-sync", func() {
		defer s.initialSyncInFlight.Delete(integration.ID)
		runCtx, cancel := context.WithTimeout(context.Background(), linearInitialSyncTimeout)
		defer cancel()
		s.runTrackedInitialSync(runCtx, integration, run.ID)
	})
	return run.ID, nil
}

func (s *LinearSyncService) GetInitialSyncRun(ctx context.Context, userID, integrationID, runID int64) (LinearSyncRunStatus, error) {
	if s.operations == nil {
		return LinearSyncRunStatus{}, pkgerrors.Internal("linear sync operations unavailable")
	}
	if _, err := s.ownedIntegration(ctx, userID, integrationID); err != nil {
		return LinearSyncRunStatus{}, err
	}
	run, err := s.operations.GetLinearSyncRun(ctx, db.GetLinearSyncRunParams{ID: runID, IntegrationID: integrationID})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return LinearSyncRunStatus{}, pkgerrors.NotFound("linear sync run not found")
		}
		return LinearSyncRunStatus{}, pkgerrors.Internal("failed to load linear sync run").WithCause(err)
	}
	return linearSyncRunStatus(run), nil
}

func (s *LinearSyncService) RetrySyncOp(ctx context.Context, userID, integrationID, opID int64) (LinearSyncOp, error) {
	if s.operations == nil {
		return LinearSyncOp{}, pkgerrors.Internal("linear sync operations unavailable")
	}
	integration, err := s.ownedIntegration(ctx, userID, integrationID)
	if err != nil {
		return LinearSyncOp{}, err
	}
	original, err := s.operations.GetLinearSyncOp(ctx, db.GetLinearSyncOpParams{ID: opID, IntegrationID: integrationID})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return LinearSyncOp{}, pkgerrors.NotFound("linear sync operation not found")
		}
		return LinearSyncOp{}, pkgerrors.Internal("failed to load linear sync operation").WithCause(err)
	}
	if original.Status != "failed" {
		return LinearSyncOp{}, pkgerrors.Conflict("only failed linear sync operations can be retried")
	}

	retry, err := s.operations.CreateLinearSyncOpRetry(ctx, db.CreateLinearSyncOpRetryParams{
		OpID: opID, IntegrationID: integrationID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return LinearSyncOp{}, pkgerrors.Conflict("linear sync operation is no longer retryable")
		}
		return LinearSyncOp{}, pkgerrors.Internal("failed to enqueue linear sync retry").WithCause(err)
	}
	SafeGo("linear-sync-op-retry", func() {
		retryCtx, cancel := context.WithTimeout(context.Background(), linearInitialSyncTimeout)
		defer cancel()
		retryCtx = context.WithValue(retryCtx, linearRetryOpContextKey{}, retry.ID)
		retryErr := s.executeSyncOpRetry(retryCtx, integration, retry)
		status, message := "success", ""
		if retryErr != nil {
			status, message = "failed", retryErr.Error()
		}
		if _, completeErr := s.operations.CompleteLinearSyncOpRetry(retryCtx, db.CompleteLinearSyncOpRetryParams{
			ID: retry.ID, Status: status, ErrorMessage: message,
		}); completeErr != nil && !stdErrors.Is(completeErr, pgx.ErrNoRows) {
			slog.Error("linear sync: failed to complete retry", "op_id", retry.ID, "error", completeErr)
		}
	})
	return linearSyncOp(retry), nil
}

type linearRetryOpContextKey struct{}

func (s *LinearSyncService) executeSyncOpRetry(ctx context.Context, integration db.LinearIntegration, op db.LinearSyncOp) error {
	switch op.Source {
	case "jjhub", "smithers": // "smithers" supports legacy rows from pre-constraint test databases.
		return s.retrySmithersSyncOp(ctx, integration, op)
	case "linear":
		return s.retryLinearSyncOp(ctx, integration, op)
	default:
		return fmt.Errorf("unsupported linear sync source %q", op.Source)
	}
}

func (s *LinearSyncService) retrySmithersSyncOp(ctx context.Context, integration db.LinearIntegration, op db.LinearSyncOp) error {
	switch op.Entity {
	case "issue":
		var event webhooks.IssueEventPayload
		_ = json.Unmarshal(op.Payload, &event)
		if event.Issue.ID == 0 {
			issueID, err := strconv.ParseInt(op.EntityID, 10, 64)
			if err != nil {
				return fmt.Errorf("invalid Smithers issue id %q", op.EntityID)
			}
			issue, err := s.operations.GetIssueByID(ctx, issueID)
			if err != nil {
				return fmt.Errorf("load Smithers issue for retry: %w", err)
			}
			if issue.RepositoryID != integration.JjhubRepoID {
				return fmt.Errorf("Smithers issue does not belong to the integration repository")
			}
			event.Issue = webhooks.IssuePayload{
				ID: issue.ID, Number: issue.Number, Title: issue.Title, Body: issue.Body,
				State: issue.State, CreatedAt: issue.CreatedAt, UpdatedAt: issue.UpdatedAt,
			}
		}
		event.Action = mapLinearIssueActionToWebhook(op.Action)
		if event.Action == "" {
			return fmt.Errorf("unsupported issue retry action %q", op.Action)
		}
		return s.syncIssueToLinear(ctx, integration, event)

	case "comment":
		var event webhooks.IssueCommentEventPayload
		_ = json.Unmarshal(op.Payload, &event)
		commentID, err := strconv.ParseInt(op.EntityID, 10, 64)
		if err != nil {
			return fmt.Errorf("invalid Smithers comment id %q", op.EntityID)
		}
		if event.Comment.ID == 0 {
			comment, getErr := s.queries.GetIssueCommentByID(ctx, commentID)
			if getErr == nil {
				event.Comment = webhooks.IssueCommentPayload{
					ID: comment.ID, IssueID: comment.IssueID, Body: comment.Body,
					Commenter: comment.Commenter, CreatedAt: comment.CreatedAt, UpdatedAt: comment.UpdatedAt,
				}
				event.Issue.ID = comment.IssueID
			} else if op.Action != "delete" {
				return fmt.Errorf("load Smithers comment for retry: %w", getErr)
			}
		}
		if event.Issue.ID == 0 {
			issueMap, mapErr := s.operations.GetLinearIssueMapBySmithersCommentID(ctx, db.GetLinearIssueMapBySmithersCommentIDParams{
				IntegrationID: integration.ID, JjhubCommentID: commentID,
			})
			if mapErr != nil {
				return fmt.Errorf("load Linear comment mapping for retry: %w", mapErr)
			}
			event.Issue.ID = issueMap.JjhubIssueID
			event.Comment.ID = commentID
			event.Comment.IssueID = issueMap.JjhubIssueID
		}
		event.Action = mapLinearCommentActionToWebhook(op.Action)
		if event.Action == "" {
			return fmt.Errorf("unsupported comment retry action %q", op.Action)
		}
		return s.syncCommentToLinear(ctx, integration, event)
	default:
		return fmt.Errorf("unsupported linear sync entity %q", op.Entity)
	}
}

func (s *LinearSyncService) retryLinearSyncOp(ctx context.Context, integration db.LinearIntegration, op db.LinearSyncOp) error {
	if len(op.Payload) == 0 || string(op.Payload) == "{}" {
		return fmt.Errorf("linear sync operation has no replay payload")
	}
	if op.Entity == "issue" && op.Action == "initial_sync" {
		var issue struct {
			ID          string `json:"id"`
			Identifier  string `json:"identifier"`
			Title       string `json:"title"`
			Description string `json:"description"`
		}
		if err := json.Unmarshal(op.Payload, &issue); err != nil {
			return fmt.Errorf("decode Linear issue retry payload: %w", err)
		}
		if issue.ID == "" {
			issue.ID = op.EntityID
		}
		return s.importLinearIssue(ctx, integration, issue.ID, issue.Identifier, issue.Title, issue.Description)
	}
	if op.Entity == "issue" {
		return s.handleLinearIssueWebhook(ctx, integration, op.Action, op.Payload)
	}
	if op.Entity == "comment" {
		action := op.Action
		if action == "delete" {
			action = "remove"
		}
		return s.handleLinearCommentWebhook(ctx, integration, action, op.Payload)
	}
	return fmt.Errorf("unsupported linear sync entity %q", op.Entity)
}

func mapLinearIssueActionToWebhook(action string) string {
	switch action {
	case "create":
		return "opened"
	case "update":
		return "edited"
	case "close":
		return "closed"
	case "reopen":
		return "reopened"
	default:
		return ""
	}
}

func mapLinearIssueWebhookToAction(action string) string {
	switch action {
	case "opened":
		return "create"
	case "edited":
		return "update"
	case "closed":
		return "close"
	case "reopened":
		return "reopen"
	default:
		return ""
	}
}

func mapLinearCommentActionToWebhook(action string) string {
	switch action {
	case "create":
		return "created"
	case "update":
		return "edited"
	case "delete":
		return "deleted"
	default:
		return ""
	}
}

func mapLinearCommentWebhookToAction(action string) string {
	switch action {
	case "created":
		return "create"
	case "edited":
		return "update"
	case "deleted":
		return "delete"
	default:
		return ""
	}
}

func normalizeLinearInboundAction(action string) string {
	if action == "remove" {
		return "delete"
	}
	return action
}

func NewLinearSyncServiceWithPool(q LinearSyncQuerier, integrationSvc *LinearIntegrationService, pool *pgxpool.Pool) *LinearSyncService {
	svc := NewLinearSyncService(q, integrationSvc)
	if pool != nil {
		svc.issueImportTxManager = &pgxLinearIssueImportTxManager{pool: pool}
	}
	return svc
}

// HandleSmithersIssueEvent syncs a Smithers issue event to Linear for all active integrations on the repo.
func (s *LinearSyncService) HandleSmithersIssueEvent(ctx context.Context, repoID int64, event webhooks.IssueEventPayload) {
	integrations, err := s.queries.ListLinearIntegrationsByRepo(ctx, repoID)
	if err != nil {
		slog.Error("linear sync: failed to list integrations for repo", "repo_id", repoID, "error", err)
		return
	}

	for _, integration := range integrations {
		if err := s.syncIssueToLinear(ctx, integration, event); err != nil {
			slog.Error("linear sync: issue sync to linear failed",
				"integration_id", integration.ID,
				"issue_number", event.Issue.Number,
				"error", err,
			)
		}
	}
}

// HandleSmithersCommentEvent syncs a Smithers issue comment event to Linear.
func (s *LinearSyncService) HandleSmithersCommentEvent(ctx context.Context, repoID int64, event webhooks.IssueCommentEventPayload) {
	integrations, err := s.queries.ListLinearIntegrationsByRepo(ctx, repoID)
	if err != nil {
		slog.Error("linear sync: failed to list integrations for repo", "repo_id", repoID, "error", err)
		return
	}

	for _, integration := range integrations {
		if err := s.syncCommentToLinear(ctx, integration, event); err != nil {
			slog.Error("linear sync: comment sync to linear failed",
				"integration_id", integration.ID,
				"comment_id", event.Comment.ID,
				"error", err,
			)
		}
	}
}

// HandleLinearWebhook processes an inbound webhook from Linear.
func (s *LinearSyncService) HandleLinearWebhook(ctx context.Context, body []byte, signature string) error {
	var envelope struct {
		Action           string          `json:"action"`
		Type             string          `json:"type"`
		OrganizationID   string          `json:"organizationId"`
		WebhookTimestamp int64           `json:"webhookTimestamp"`
		Data             json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return pkgerrors.BadRequest("invalid webhook payload")
	}

	// URL verification challenge
	if envelope.Type == "AppAuthorization" || envelope.Action == "urlVerification" {
		return nil
	}

	var teamID string
	var dataMap map[string]any
	if err := json.Unmarshal(envelope.Data, &dataMap); err == nil {
		if team, ok := dataMap["teamId"].(string); ok {
			teamID = team
		} else if team, ok := dataMap["team"].(map[string]any); ok {
			if id, ok := team["id"].(string); ok {
				teamID = id
			}
		}
	}

	if teamID == "" {
		slog.Debug("linear webhook: no team ID in payload, skipping")
		return nil
	}

	integration, err := s.queries.GetLinearIntegrationByLinearTeamID(ctx, teamID)
	if err != nil {
		slog.Debug("linear webhook: no integration for team", "team_id", teamID)
		return nil
	}

	// Verify per-integration HMAC signature (secret is stored encrypted at rest).
	if s.integrationSvc == nil {
		return pkgerrors.Unauthorized("invalid webhook signature")
	}
	webhookSecret, secErr := s.integrationSvc.GetDecryptedWebhookSecret(integration)
	if secErr != nil {
		slog.Warn("linear webhook: cannot decrypt webhook secret; rejecting", "integration_id", integration.ID)
		return pkgerrors.Unauthorized("invalid webhook signature")
	}
	if !s.verifyWebhookSignature(body, signature, webhookSecret) {
		return pkgerrors.Unauthorized("invalid webhook signature")
	}

	// Replay guard: webhookTimestamp is part of the HMAC-signed body, so a
	// captured payload cannot be re-sent outside the freshness window and an
	// attacker cannot forge a fresher one without the secret.
	if !s.webhookTimestampFresh(envelope.WebhookTimestamp) {
		return pkgerrors.Unauthorized("stale webhook timestamp")
	}

	// Actor filtering: skip if the action was performed by our integration user
	if actorID, ok := dataMap["creatorId"].(string); ok && actorID == integration.LinearActorID {
		slog.Debug("linear webhook: skipping own action", "actor_id", actorID)
		return nil
	}

	switch envelope.Type {
	case "Issue":
		return s.handleLinearIssueWebhook(ctx, integration, envelope.Action, envelope.Data)
	case "Comment":
		return s.handleLinearCommentWebhook(ctx, integration, envelope.Action, envelope.Data)
	}

	return nil
}

func (s *LinearSyncService) syncIssueToLinear(ctx context.Context, integration db.LinearIntegration, event webhooks.IssueEventPayload) error {
	entityID := fmt.Sprintf("%d", event.Issue.ID)
	action := mapLinearIssueWebhookToAction(event.Action)
	if action == "" {
		return nil
	}

	// Loop guard: check temporal dedup
	exists, err := s.queries.RecentLinearSyncOpExists(ctx, db.RecentLinearSyncOpExistsParams{
		IntegrationID: integration.ID,
		Entity:        "issue",
		EntityID:      entityID,
		Action:        action,
	})
	if err == nil && exists {
		return nil
	}

	integration, err = s.integrationSvc.RefreshTokenIfNeeded(ctx, integration)
	if err != nil {
		s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "issue", entityID, action, "failed", err.Error(), event)
		return err
	}

	accessToken, err := s.integrationSvc.GetDecryptedAccessToken(ctx, integration)
	if err != nil {
		s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "issue", entityID, action, "failed", err.Error(), event)
		return err
	}

	switch event.Action {
	case "opened":
		return s.createLinearIssue(ctx, integration, accessToken, event)
	case "edited":
		return s.updateLinearIssue(ctx, integration, accessToken, event)
	case "closed":
		return s.closeLinearIssue(ctx, integration, accessToken, event)
	case "reopened":
		return s.reopenLinearIssue(ctx, integration, accessToken, event)
	}

	return nil
}

func (s *LinearSyncService) createLinearIssue(ctx context.Context, integration db.LinearIntegration, token string, event webhooks.IssueEventPayload) error {
	// Check if already mapped
	_, err := s.queries.GetLinearIssueMapBySmithersIssue(ctx, db.GetLinearIssueMapBySmithersIssueParams{
		IntegrationID: integration.ID,
		JjhubIssueID:  event.Issue.ID,
	})
	if err == nil {
		return nil // already mapped
	}

	query := `mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }`
	vars := map[string]any{
		"input": map[string]any{
			"teamId":      integration.LinearTeamID,
			"title":       event.Issue.Title,
			"description": event.Issue.Body,
		},
	}

	result, err := s.linearGraphQLMutation(ctx, token, query, vars)
	if err != nil {
		s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "issue", fmt.Sprintf("%d", event.Issue.ID), "create", "failed", err.Error(), event)
		return err
	}

	issueCreate, ok := result["issueCreate"].(map[string]any)
	if !ok {
		err := fmt.Errorf("unexpected issueCreate response shape")
		s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "issue", fmt.Sprintf("%d", event.Issue.ID), "create", "failed", err.Error(), event)
		return err
	}
	issue, ok := issueCreate["issue"].(map[string]any)
	if !ok {
		err := fmt.Errorf("no issue in issueCreate response")
		s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "issue", fmt.Sprintf("%d", event.Issue.ID), "create", "failed", err.Error(), event)
		return err
	}

	linearIssueID, _ := issue["id"].(string)
	linearIdentifier, _ := issue["identifier"].(string)

	_, err = s.queries.CreateLinearIssueMap(ctx, db.CreateLinearIssueMapParams{
		IntegrationID:    integration.ID,
		JjhubIssueID:     event.Issue.ID,
		JjhubIssueNumber: event.Issue.Number,
		LinearIssueID:    linearIssueID,
		LinearIdentifier: linearIdentifier,
	})
	if err != nil {
		err = fmt.Errorf("failed to create issue map: %w", err)
		s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "issue", fmt.Sprintf("%d", event.Issue.ID), "create", "failed", err.Error(), event)
		return err
	}

	s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "issue", fmt.Sprintf("%d", event.Issue.ID), "create", "success", "", event)
	return nil
}

func (s *LinearSyncService) updateLinearIssue(ctx context.Context, integration db.LinearIntegration, token string, event webhooks.IssueEventPayload) error {
	issueMap, err := s.queries.GetLinearIssueMapBySmithersIssue(ctx, db.GetLinearIssueMapBySmithersIssueParams{
		IntegrationID: integration.ID,
		JjhubIssueID:  event.Issue.ID,
	})
	if err != nil {
		return nil // not mapped, skip
	}

	query := `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`
	vars := map[string]any{
		"id": issueMap.LinearIssueID,
		"input": map[string]any{
			"title":       event.Issue.Title,
			"description": event.Issue.Body,
		},
	}

	if _, err := s.linearGraphQLMutation(ctx, token, query, vars); err != nil {
		s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "issue", fmt.Sprintf("%d", event.Issue.ID), "update", "failed", err.Error(), event)
		return err
	}

	s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "issue", fmt.Sprintf("%d", event.Issue.ID), "update", "success", "", event)
	return nil
}

func (s *LinearSyncService) closeLinearIssue(ctx context.Context, integration db.LinearIntegration, token string, event webhooks.IssueEventPayload) error {
	issueMap, err := s.queries.GetLinearIssueMapBySmithersIssue(ctx, db.GetLinearIssueMapBySmithersIssueParams{
		IntegrationID: integration.ID,
		JjhubIssueID:  event.Issue.ID,
	})
	if err != nil {
		return nil
	}

	// Get "Done" state ID
	doneStateID, err := s.getLinearWorkflowStateID(ctx, token, integration.LinearTeamID, "Done")
	if err != nil {
		s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "issue", fmt.Sprintf("%d", event.Issue.ID), "close", "failed", err.Error(), event)
		return err
	}

	query := `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`
	vars := map[string]any{
		"id": issueMap.LinearIssueID,
		"input": map[string]any{
			"stateId": doneStateID,
		},
	}

	if _, err := s.linearGraphQLMutation(ctx, token, query, vars); err != nil {
		s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "issue", fmt.Sprintf("%d", event.Issue.ID), "close", "failed", err.Error(), event)
		return err
	}

	s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "issue", fmt.Sprintf("%d", event.Issue.ID), "close", "success", "", event)
	return nil
}

func (s *LinearSyncService) reopenLinearIssue(ctx context.Context, integration db.LinearIntegration, token string, event webhooks.IssueEventPayload) error {
	issueMap, err := s.queries.GetLinearIssueMapBySmithersIssue(ctx, db.GetLinearIssueMapBySmithersIssueParams{
		IntegrationID: integration.ID,
		JjhubIssueID:  event.Issue.ID,
	})
	if err != nil {
		return nil
	}

	todoStateID, err := s.getLinearWorkflowStateID(ctx, token, integration.LinearTeamID, "Todo")
	if err != nil {
		s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "issue", fmt.Sprintf("%d", event.Issue.ID), "reopen", "failed", err.Error(), event)
		return err
	}

	query := `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`
	vars := map[string]any{
		"id": issueMap.LinearIssueID,
		"input": map[string]any{
			"stateId": todoStateID,
		},
	}

	if _, err := s.linearGraphQLMutation(ctx, token, query, vars); err != nil {
		s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "issue", fmt.Sprintf("%d", event.Issue.ID), "reopen", "failed", err.Error(), event)
		return err
	}

	s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "issue", fmt.Sprintf("%d", event.Issue.ID), "reopen", "success", "", event)
	return nil
}

func (s *LinearSyncService) syncCommentToLinear(ctx context.Context, integration db.LinearIntegration, event webhooks.IssueCommentEventPayload) error {
	entityID := fmt.Sprintf("%d", event.Comment.ID)
	action := mapLinearCommentWebhookToAction(event.Action)
	if action == "" {
		return nil
	}

	exists, err := s.queries.RecentLinearSyncOpExists(ctx, db.RecentLinearSyncOpExistsParams{
		IntegrationID: integration.ID,
		Entity:        "comment",
		EntityID:      entityID,
		Action:        action,
	})
	if err == nil && exists {
		return nil
	}

	issueMap, err := s.queries.GetLinearIssueMapBySmithersIssue(ctx, db.GetLinearIssueMapBySmithersIssueParams{
		IntegrationID: integration.ID,
		JjhubIssueID:  event.Issue.ID,
	})
	if err != nil {
		return nil // issue not mapped, skip
	}

	integration, err = s.integrationSvc.RefreshTokenIfNeeded(ctx, integration)
	if err != nil {
		s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "comment", entityID, action, "failed", err.Error(), event)
		return err
	}

	accessToken, err := s.integrationSvc.GetDecryptedAccessToken(ctx, integration)
	if err != nil {
		s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "comment", entityID, action, "failed", err.Error(), event)
		return err
	}

	switch event.Action {
	case "created":
		return s.createLinearComment(ctx, integration, accessToken, issueMap, event)
	case "edited":
		return s.updateLinearComment(ctx, integration, accessToken, issueMap, event)
	case "deleted":
		return s.deleteLinearComment(ctx, integration, accessToken, issueMap, event)
	}

	return nil
}

func (s *LinearSyncService) createLinearComment(ctx context.Context, integration db.LinearIntegration, token string, issueMap db.LinearIssueMap, event webhooks.IssueCommentEventPayload) error {
	// Check if already mapped
	_, err := s.queries.GetLinearCommentMapBySmithersComment(ctx, db.GetLinearCommentMapBySmithersCommentParams{
		IssueMapID:     issueMap.ID,
		JjhubCommentID: event.Comment.ID,
	})
	if err == nil {
		return nil
	}

	body := fmt.Sprintf("**%s** commented on Smithers:\n\n%s", event.Comment.Commenter, event.Comment.Body)

	query := `mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`
	vars := map[string]any{
		"input": map[string]any{
			"issueId": issueMap.LinearIssueID,
			"body":    body,
		},
	}

	result, err := s.linearGraphQLMutation(ctx, token, query, vars)
	if err != nil {
		s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "comment", fmt.Sprintf("%d", event.Comment.ID), "create", "failed", err.Error(), event)
		return err
	}

	commentCreate, ok := result["commentCreate"].(map[string]any)
	if !ok {
		err := fmt.Errorf("unexpected commentCreate response shape")
		s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "comment", fmt.Sprintf("%d", event.Comment.ID), "create", "failed", err.Error(), event)
		return err
	}
	comment, ok := commentCreate["comment"].(map[string]any)
	if !ok {
		err := fmt.Errorf("no comment in commentCreate response")
		s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "comment", fmt.Sprintf("%d", event.Comment.ID), "create", "failed", err.Error(), event)
		return err
	}
	linearCommentID, _ := comment["id"].(string)

	_, err = s.queries.CreateLinearCommentMap(ctx, db.CreateLinearCommentMapParams{
		IssueMapID:      issueMap.ID,
		JjhubCommentID:  event.Comment.ID,
		LinearCommentID: linearCommentID,
	})
	if err != nil {
		err = fmt.Errorf("failed to create comment map: %w", err)
		s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "comment", fmt.Sprintf("%d", event.Comment.ID), "create", "failed", err.Error(), event)
		return err
	}

	s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "comment", fmt.Sprintf("%d", event.Comment.ID), "create", "success", "", event)
	return nil
}

func (s *LinearSyncService) updateLinearComment(ctx context.Context, integration db.LinearIntegration, token string, issueMap db.LinearIssueMap, event webhooks.IssueCommentEventPayload) error {
	commentMap, err := s.queries.GetLinearCommentMapBySmithersComment(ctx, db.GetLinearCommentMapBySmithersCommentParams{
		IssueMapID:     issueMap.ID,
		JjhubCommentID: event.Comment.ID,
	})
	if err != nil {
		return nil // not mapped, skip
	}

	body := fmt.Sprintf("**%s** commented on Smithers:\n\n%s", event.Comment.Commenter, event.Comment.Body)

	query := `mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }`
	vars := map[string]any{
		"id": commentMap.LinearCommentID,
		"input": map[string]any{
			"body": body,
		},
	}

	if _, err := s.linearGraphQLMutation(ctx, token, query, vars); err != nil {
		s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "comment", fmt.Sprintf("%d", event.Comment.ID), "update", "failed", err.Error(), event)
		return err
	}

	s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "comment", fmt.Sprintf("%d", event.Comment.ID), "update", "success", "", event)
	return nil
}

func (s *LinearSyncService) deleteLinearComment(ctx context.Context, integration db.LinearIntegration, token string, issueMap db.LinearIssueMap, event webhooks.IssueCommentEventPayload) error {
	commentMap, err := s.queries.GetLinearCommentMapBySmithersComment(ctx, db.GetLinearCommentMapBySmithersCommentParams{
		IssueMapID:     issueMap.ID,
		JjhubCommentID: event.Comment.ID,
	})
	if err != nil {
		return nil // not mapped, skip
	}

	query := `mutation CommentDelete($id: String!) { commentDelete(id: $id) { success } }`
	vars := map[string]any{
		"id": commentMap.LinearCommentID,
	}

	if _, err := s.linearGraphQLMutation(ctx, token, query, vars); err != nil {
		s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "comment", fmt.Sprintf("%d", event.Comment.ID), "delete", "failed", err.Error(), event)
		return err
	}

	// Clean up the mapping
	_ = s.queries.DeleteLinearCommentMapBySmithersComment(ctx, db.DeleteLinearCommentMapBySmithersCommentParams{
		IssueMapID:     issueMap.ID,
		JjhubCommentID: event.Comment.ID,
	})

	s.logSyncOpWithPayload(ctx, integration.ID, "jjhub", "linear", "comment", fmt.Sprintf("%d", event.Comment.ID), "delete", "success", "", event)
	return nil
}

// Inbound Linear webhook handlers

func (s *LinearSyncService) handleLinearIssueWebhook(ctx context.Context, integration db.LinearIntegration, action string, data json.RawMessage) error {
	var issue struct {
		ID          string `json:"id"`
		Identifier  string `json:"identifier"`
		Title       string `json:"title"`
		Description string `json:"description"`
		State       struct {
			Type string `json:"type"`
		} `json:"state"`
	}
	if err := json.Unmarshal(data, &issue); err != nil {
		return fmt.Errorf("failed to unmarshal linear issue: %w", err)
	}

	entityID := issue.ID
	opAction := normalizeLinearInboundAction(action)

	// Loop guard
	exists, err := s.queries.RecentLinearSyncOpExists(ctx, db.RecentLinearSyncOpExistsParams{
		IntegrationID: integration.ID,
		Entity:        "issue",
		EntityID:      entityID,
		Action:        opAction,
	})
	if err == nil && exists {
		return nil
	}

	s.logSyncOpWithPayload(ctx, integration.ID, "linear", "jjhub", "issue", entityID, opAction, "success", "", data)
	_ = s.queries.UpdateLinearIntegrationLastSync(ctx, integration.ID)
	return nil
}

func (s *LinearSyncService) handleLinearCommentWebhook(ctx context.Context, integration db.LinearIntegration, action string, data json.RawMessage) error {
	var comment struct {
		ID      string `json:"id"`
		Body    string `json:"body"`
		IssueID string `json:"issueId"`
	}
	if err := json.Unmarshal(data, &comment); err != nil {
		return fmt.Errorf("failed to unmarshal linear comment: %w", err)
	}

	entityID := comment.ID
	opAction := normalizeLinearInboundAction(action)

	exists, err := s.queries.RecentLinearSyncOpExists(ctx, db.RecentLinearSyncOpExistsParams{
		IntegrationID: integration.ID,
		Entity:        "comment",
		EntityID:      entityID,
		Action:        opAction,
	})
	if err == nil && exists {
		return nil
	}

	// Look up the issue mapping to find the Smithers issue.
	issueMap, err := s.queries.GetLinearIssueMapByLinearIssue(ctx, db.GetLinearIssueMapByLinearIssueParams{
		IntegrationID: integration.ID,
		LinearIssueID: comment.IssueID,
	})
	if err != nil {
		slog.Debug("linear webhook: comment's issue not mapped, skipping", "linear_issue_id", comment.IssueID)
		return nil
	}

	switch action {
	case "create":
		// Create-direction from Linear is handled elsewhere; skip if already mapped.
		// (Linear→Smithers comment create could be added here in the future.)
		break

	case "update":
		commentMap, mapErr := s.queries.GetLinearCommentMapByLinearComment(ctx, db.GetLinearCommentMapByLinearCommentParams{
			IssueMapID:      issueMap.ID,
			LinearCommentID: comment.ID,
		})
		if mapErr != nil {
			slog.Debug("linear webhook: comment not mapped, skipping update", "linear_comment_id", comment.ID)
			break
		}

		_, updateErr := s.queries.UpdateIssueComment(ctx, db.UpdateIssueCommentParams{
			ID:   commentMap.JjhubCommentID,
			Body: comment.Body,
		})
		if updateErr != nil {
			s.logSyncOpWithPayload(ctx, integration.ID, "linear", "jjhub", "comment", entityID, "update", "failed", updateErr.Error(), data)
			return updateErr
		}
		s.logSyncOpWithPayload(ctx, integration.ID, "linear", "jjhub", "comment", entityID, "update", "success", "", data)

	case "remove":
		commentMap, mapErr := s.queries.GetLinearCommentMapByLinearComment(ctx, db.GetLinearCommentMapByLinearCommentParams{
			IssueMapID:      issueMap.ID,
			LinearCommentID: comment.ID,
		})
		if mapErr != nil {
			slog.Debug("linear webhook: comment not mapped, skipping remove", "linear_comment_id", comment.ID)
			break
		}

		// Verify the comment still exists before deleting.
		if _, getErr := s.queries.GetIssueCommentByID(ctx, commentMap.JjhubCommentID); getErr != nil {
			slog.Debug("linear webhook: smithers comment already gone", "smithers_comment_id", commentMap.JjhubCommentID)
			break
		}

		// issues.comment_count is maintained by trg_issue_comments_count_del.
		if delErr := s.queries.DeleteIssueComment(ctx, commentMap.JjhubCommentID); delErr != nil {
			s.logSyncOpWithPayload(ctx, integration.ID, "linear", "jjhub", "comment", entityID, "delete", "failed", delErr.Error(), data)
			return delErr
		}

		// Clean up the mapping.
		_ = s.queries.DeleteLinearCommentMapByLinearComment(ctx, db.DeleteLinearCommentMapByLinearCommentParams{
			IssueMapID:      issueMap.ID,
			LinearCommentID: comment.ID,
		})
		s.logSyncOpWithPayload(ctx, integration.ID, "linear", "jjhub", "comment", entityID, "delete", "success", "", data)
	}

	_ = s.queries.UpdateLinearIntegrationLastSync(ctx, integration.ID)
	return nil
}

// GraphQL helpers

func (s *LinearSyncService) linearGraphQLMutation(ctx context.Context, token, query string, variables map[string]any) (map[string]any, error) {
	payload, err := json.Marshal(map[string]any{
		"query":     query,
		"variables": variables,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal graphql request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, linearGraphQLURL, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("create graphql request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("graphql request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read graphql response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("graphql request failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	var gqlResp struct {
		Data   map[string]any `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(respBody, &gqlResp); err != nil {
		return nil, fmt.Errorf("decode graphql response: %w", err)
	}
	if len(gqlResp.Errors) > 0 {
		return nil, fmt.Errorf("graphql error: %s", gqlResp.Errors[0].Message)
	}

	return gqlResp.Data, nil
}

func (s *LinearSyncService) getLinearWorkflowStateID(ctx context.Context, token, teamID, stateName string) (string, error) {
	query := `query WorkflowStates($teamId: String!) { workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name type } } }`
	vars := map[string]any{"teamId": teamID}

	result, err := s.linearGraphQLMutation(ctx, token, query, vars)
	if err != nil {
		return "", err
	}

	states, ok := result["workflowStates"].(map[string]any)
	if !ok {
		return "", fmt.Errorf("unexpected workflowStates response")
	}
	nodes, ok := states["nodes"].([]any)
	if !ok {
		return "", fmt.Errorf("no nodes in workflowStates")
	}

	for _, n := range nodes {
		node, ok := n.(map[string]any)
		if !ok {
			continue
		}
		name, _ := node["name"].(string)
		if strings.EqualFold(name, stateName) {
			id, _ := node["id"].(string)
			return id, nil
		}
	}

	// Fallback: match by type for Done/Todo
	targetType := ""
	switch strings.ToLower(stateName) {
	case "done":
		targetType = "completed"
	case "todo":
		targetType = "unstarted"
	}
	if targetType != "" {
		for _, n := range nodes {
			node, ok := n.(map[string]any)
			if !ok {
				continue
			}
			stateType, _ := node["type"].(string)
			if strings.EqualFold(stateType, targetType) {
				id, _ := node["id"].(string)
				return id, nil
			}
		}
	}

	return "", fmt.Errorf("workflow state %q not found for team %s", stateName, teamID)
}

func (s *LinearSyncService) verifyWebhookSignature(body []byte, signature, secret string) bool {
	if signature == "" || secret == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(signature))
}

// webhookTimestampFresh reports whether a Linear webhookTimestamp (Unix
// milliseconds) is within linearWebhookMaxAge of the current time. Linear
// includes the field in every webhook delivery, so a missing timestamp is
// treated as stale.
func (s *LinearSyncService) webhookTimestampFresh(timestampMillis int64) bool {
	if timestampMillis <= 0 {
		return false
	}
	drift := s.now().Sub(time.UnixMilli(timestampMillis))
	if drift < 0 {
		drift = -drift
	}
	return drift <= linearWebhookMaxAge
}

// StartInitialSync launches RunInitialSync in a bounded background context
// unless a sync for the integration is already in flight. It reports whether a
// new sync was started, so callers can surface "already running" instead of
// stacking duplicate imports.
func (s *LinearSyncService) StartInitialSync(integration db.LinearIntegration) bool {
	if _, loaded := s.initialSyncInFlight.LoadOrStore(integration.ID, struct{}{}); loaded {
		return false
	}
	SafeGo("linear-initial-sync", func() {
		defer s.initialSyncInFlight.Delete(integration.ID)
		ctx, cancel := context.WithTimeout(context.Background(), linearInitialSyncTimeout)
		defer cancel()
		s.RunInitialSync(ctx, integration)
	})
	return true
}

type linearSyncRunContextKey struct{}

func (s *LinearSyncService) runTrackedInitialSync(ctx context.Context, integration db.LinearIntegration, runID int64) {
	_, runErr := s.operations.MarkLinearSyncRunRunning(ctx, runID)
	if runErr != nil {
		slog.Error("linear initial sync: failed to start run", "run_id", runID, "error", runErr)
	} else {
		ctx = context.WithValue(ctx, linearSyncRunContextKey{}, runID)
		runErr = s.runInitialSync(ctx, integration, runID)
		if runErr != nil {
			slog.Error("linear initial sync failed", "integration_id", integration.ID, "run_id", runID, "error", runErr)
		}
	}
	// The run's deadline must not prevent its terminal state from being saved.
	terminalCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	var err error
	if runErr != nil {
		_, err = s.operations.FailLinearSyncRun(terminalCtx, runID)
	} else {
		_, err = s.operations.FinishLinearSyncRun(terminalCtx, runID)
	}
	if err != nil {
		slog.Error("linear initial sync: failed to finalize run", "run_id", runID, "error", err)
	}
}

// RunInitialSync performs a one-time sync of existing Linear issues for the integration.
// It fetches open issues from the Linear team and creates mappings for any that don't exist yet.
func (s *LinearSyncService) RunInitialSync(ctx context.Context, integration db.LinearIntegration) {
	if err := s.runInitialSync(ctx, integration, 0); err != nil {
		slog.Error("linear initial sync failed", "integration_id", integration.ID, "error", err)
	}
}

func (s *LinearSyncService) runInitialSync(ctx context.Context, integration db.LinearIntegration, runID int64) error {
	integration, err := s.integrationSvc.RefreshTokenIfNeeded(ctx, integration)
	if err != nil {
		return fmt.Errorf("refresh Linear token: %w", err)
	}

	accessToken, err := s.integrationSvc.GetDecryptedAccessToken(ctx, integration)
	if err != nil {
		return fmt.Errorf("decrypt Linear token: %w", err)
	}

	// Fetch open issues from Linear for this team.
	query := `query Issues($teamId: String!, $after: String) { issues(filter: { team: { id: { eq: $teamId } }, state: { type: { nin: ["canceled", "completed"] } } }, first: 100, after: $after) { nodes { id identifier title description } pageInfo { hasNextPage endCursor } } }`
	vars := map[string]any{"teamId": integration.LinearTeamID}

	issuesChecked := 0
	seenCursors := make(map[string]struct{})
	for {
		result, err := s.linearGraphQLMutation(ctx, accessToken, query, vars)
		if err != nil {
			return fmt.Errorf("fetch Linear issues: %w", err)
		}

		issues, ok := result["issues"].(map[string]any)
		if !ok {
			return fmt.Errorf("unexpected Linear issues response shape")
		}
		nodes, ok := issues["nodes"].([]any)
		if !ok {
			return fmt.Errorf("Linear issues response has no nodes")
		}
		pageInfo, ok := issues["pageInfo"].(map[string]any)
		if !ok {
			return fmt.Errorf("Linear issues response has no page info")
		}
		hasNextPage, ok := pageInfo["hasNextPage"].(bool)
		if !ok {
			return fmt.Errorf("Linear issues response has no next-page flag")
		}
		endCursor, _ := pageInfo["endCursor"].(string)
		if hasNextPage {
			if strings.TrimSpace(endCursor) == "" {
				return fmt.Errorf("Linear issues response has no continuation cursor")
			}
			if _, seen := seenCursors[endCursor]; seen {
				return fmt.Errorf("Linear issues response repeats a continuation cursor")
			}
			seenCursors[endCursor] = struct{}{}
		}
		issuesChecked += len(nodes)

		if runID != 0 {
			if _, err := s.operations.SetLinearSyncRunTotals(ctx, db.SetLinearSyncRunTotalsParams{
				ID: runID, IssuesTotal: int32(issuesChecked), CommentsTotal: 0,
			}); err != nil {
				return fmt.Errorf("set Linear sync run totals: %w", err)
			}
		}

		for _, n := range nodes {
			if err := ctx.Err(); err != nil {
				return err
			}
			node, ok := n.(map[string]any)
			if !ok {
				continue
			}
			linearIssueID, _ := node["id"].(string)
			linearIdentifier, _ := node["identifier"].(string)
			title, _ := node["title"].(string)
			description, _ := node["description"].(string)

			// Check if already mapped.
			_, err := s.queries.GetLinearIssueMapByLinearIssue(ctx, db.GetLinearIssueMapByLinearIssueParams{
				IntegrationID: integration.ID,
				LinearIssueID: linearIssueID,
			})
			if err == nil {
				s.recordSyncRunResult(ctx, runID, "issue", false)
				continue // already mapped
			}

			if err := s.importLinearIssue(ctx, integration, linearIssueID, linearIdentifier, title, description); err != nil {
				s.logSyncOpWithPayload(ctx, integration.ID, "linear", "jjhub", "issue", linearIssueID, "initial_sync", "failed", err.Error(), node)
				s.recordSyncRunResult(ctx, runID, "issue", true)
				slog.Error("linear initial sync: failed to import issue",
					"integration_id", integration.ID,
					"linear_issue_id", linearIssueID,
					"identifier", linearIdentifier,
					"error", err,
				)
				continue
			}
			s.recordSyncRunResult(ctx, runID, "issue", false)
		}

		if !hasNextPage {
			break
		}
		vars["after"] = endCursor
	}

	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.queries.UpdateLinearIntegrationLastSync(ctx, integration.ID); err != nil {
		return fmt.Errorf("update Linear integration sync timestamp: %w", err)
	}
	slog.Info("linear initial sync completed", "integration_id", integration.ID, "issues_checked", issuesChecked)
	return nil
}

func (s *LinearSyncService) recordSyncRunResult(ctx context.Context, runID int64, entity string, failed bool) {
	if runID == 0 || s.operations == nil {
		return
	}
	if _, err := s.operations.RecordLinearSyncRunResult(ctx, db.RecordLinearSyncRunResultParams{
		ID: runID, Entity: entity, Failed: failed,
	}); err != nil {
		slog.Error("linear initial sync: failed to record run progress", "run_id", runID, "entity", entity, "error", err)
	}
}

func (s *LinearSyncService) importLinearIssue(ctx context.Context, integration db.LinearIntegration, linearIssueID, linearIdentifier, title, description string) error {
	if s.issueImportTxManager != nil {
		return s.importLinearIssueWithTx(ctx, integration, linearIssueID, linearIdentifier, title, description)
	}
	created, err := s.createImportedLinearIssueMapping(ctx, s.queries, integration, linearIssueID, linearIdentifier, title, description)
	if err != nil {
		return err
	}
	s.logImportedLinearIssueSuccess(ctx, integration, linearIssueID, linearIdentifier, created)
	return nil
}

func (s *LinearSyncService) importLinearIssueWithTx(ctx context.Context, integration db.LinearIntegration, linearIssueID, linearIdentifier, title, description string) error {
	tx, err := s.issueImportTxManager.BeginLinearIssueImportTx(ctx)
	if err != nil {
		return fmt.Errorf("begin linear issue import transaction: %w", err)
	}

	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	created, err := s.createImportedLinearIssueMapping(ctx, tx, integration, linearIssueID, linearIdentifier, title, description)
	if err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit linear issue import transaction: %w", err)
	}
	committed = true
	s.logImportedLinearIssueSuccess(ctx, integration, linearIssueID, linearIdentifier, created)
	return nil
}

func (s *LinearSyncService) createImportedLinearIssueMapping(ctx context.Context, q linearIssueImportQuerier, integration db.LinearIntegration, linearIssueID, linearIdentifier, title, description string) (db.Issue, error) {
	importedTitle := strings.TrimSpace(title)
	if importedTitle == "" {
		importedTitle = strings.TrimSpace(linearIdentifier)
	}
	if importedTitle == "" {
		importedTitle = "Imported Linear issue"
	}

	// The import files the issue under the integration's account, but no
	// person wrote it: its agent source is "linear" (0060). Outside a
	// transaction nothing is named, and the issue is filed by no one known.
	if named, ok := q.(interface {
		SetIssueTextEditor(context.Context, db.SetIssueTextEditorParams) error
	}); ok {
		if err := named.SetIssueTextEditor(ctx, db.SetIssueTextEditorParams{Source: "linear"}); err != nil {
			return db.Issue{}, fmt.Errorf("name the linear import: %w", err)
		}
	}
	created, err := q.CreateIssue(ctx, db.CreateIssueParams{
		RepositoryID: integration.JjhubRepoID,
		Title:        importedTitle,
		Body:         formatImportedLinearIssueBody(linearIdentifier, description),
		AuthorID:     integration.UserID,
		MilestoneID:  pgtype.Int8{},
	})
	if err != nil {
		return db.Issue{}, fmt.Errorf("create smithers issue: %w", err)
	}

	// repositories.num_issues is maintained by trg_issues_repo_counts_ins.

	if _, err := q.CreateLinearIssueMap(ctx, db.CreateLinearIssueMapParams{
		IntegrationID:    integration.ID,
		JjhubIssueID:     created.ID,
		JjhubIssueNumber: created.Number,
		LinearIssueID:    linearIssueID,
		LinearIdentifier: linearIdentifier,
	}); err != nil {
		return db.Issue{}, fmt.Errorf("create linear issue map: %w", err)
	}

	return created, nil
}

func (s *LinearSyncService) logImportedLinearIssueSuccess(ctx context.Context, integration db.LinearIntegration, linearIssueID, linearIdentifier string, created db.Issue) {
	if s.queries == nil {
		return
	}
	detail := "identifier=" + linearIdentifier
	if created.Number > 0 {
		detail = fmt.Sprintf("%s smithers_issue_number=%d", detail, created.Number)
	}
	s.logSyncOp(ctx, integration.ID, "linear", "jjhub", "issue", linearIssueID, "initial_sync", "success", strings.TrimSpace(detail))
}

func formatImportedLinearIssueBody(linearIdentifier, description string) string {
	body := strings.TrimSpace(description)
	if strings.TrimSpace(linearIdentifier) == "" {
		return body
	}
	if body == "" {
		return fmt.Sprintf("Imported from Linear issue `%s`.", linearIdentifier)
	}
	return fmt.Sprintf("Imported from Linear issue `%s`.\n\n%s", linearIdentifier, body)
}

func (s *LinearSyncService) logSyncOp(ctx context.Context, integrationID int64, source, target, entity, entityID, action, status, errMsg string) {
	s.logSyncOpWithPayload(ctx, integrationID, source, target, entity, entityID, action, status, errMsg, nil)
}

func (s *LinearSyncService) logSyncOpWithPayload(ctx context.Context, integrationID int64, source, target, entity, entityID, action, status, errMsg string, replayPayload any) {
	if retryID, ok := ctx.Value(linearRetryOpContextKey{}).(int64); ok && retryID != 0 && s.operations != nil {
		_, err := s.operations.CompleteLinearSyncOpRetry(ctx, db.CompleteLinearSyncOpRetryParams{
			ID: retryID, Status: status, ErrorMessage: errMsg,
		})
		if err != nil && !stdErrors.Is(err, pgx.ErrNoRows) {
			slog.Error("linear sync: failed to record retry result", "op_id", retryID, "error", err)
		}
		return
	}

	payload := json.RawMessage(`{}`)
	switch value := replayPayload.(type) {
	case json.RawMessage:
		if len(value) > 0 {
			payload = append(json.RawMessage(nil), value...)
		}
	case []byte:
		if len(value) > 0 {
			payload = append(json.RawMessage(nil), value...)
		}
	case nil:
	default:
		if encoded, err := json.Marshal(value); err == nil {
			payload = encoded
		} else {
			slog.Error("linear sync: failed to encode retry payload", "error", err)
		}
	}

	var runID pgtype.Int8
	if id, ok := ctx.Value(linearSyncRunContextKey{}).(int64); ok && id != 0 {
		runID = pgtype.Int8{Int64: id, Valid: true}
	}
	_, err := s.queries.LogLinearSyncOp(ctx, db.LogLinearSyncOpParams{
		IntegrationID: integrationID,
		RunID:         runID,
		Source:        source,
		Target:        target,
		Entity:        entity,
		EntityID:      entityID,
		Action:        action,
		Status:        status,
		ErrorMessage:  errMsg,
		Payload:       payload,
	})
	if err != nil {
		slog.Error("linear sync: failed to log sync op", "error", err)
	}
}
