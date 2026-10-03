package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const defaultStackTargetRef = "main"

type StackChangeInput struct {
	BranchName   string `json:"branch_name"`
	ChangeID     string `json:"change_id"`
	CIStatus     string `json:"ci_status,omitempty"`
	Position     int    `json:"position"`
	PRNumber     *int64 `json:"pr_number"`
	PRState      string `json:"pr_state,omitempty"`
	ReviewStatus string `json:"review_status,omitempty"`
}

type UpsertActiveStackInput struct {
	Changes   []StackChangeInput `json:"changes"`
	TargetRef string             `json:"target_ref"`
}

type StackChangeResponse struct {
	BranchName   string `json:"branch_name"`
	ChangeID     string `json:"change_id"`
	CIStatus     string `json:"ci_status,omitempty"`
	Position     int    `json:"position"`
	PRNumber     *int64 `json:"pr_number"`
	PRURL        string `json:"pr_url,omitempty"`
	PRState      string `json:"pr_state,omitempty"`
	ReviewStatus string `json:"review_status,omitempty"`
}

type StackResponse struct {
	ID        int64                 `json:"id"`
	Changes   []StackChangeResponse `json:"changes"`
	CreatedAt time.Time             `json:"created_at"`
	State     string                `json:"state"`
	TargetRef string                `json:"target_ref"`
	UpdatedAt time.Time             `json:"updated_at"`
}

type StackQuerier interface {
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)

	GetActiveStack(ctx context.Context, arg db.GetActiveStackParams) (db.Stack, error)
	UpsertActiveStack(ctx context.Context, arg db.UpsertActiveStackParams) (db.Stack, error)
	UpsertStackChange(ctx context.Context, arg db.UpsertStackChangeParams) (db.StackChange, error)
	ListStackChangesByStack(ctx context.Context, stackID int64) ([]db.StackChange, error)
	DeleteStackChangesNotInSet(ctx context.Context, arg db.DeleteStackChangesNotInSetParams) error
	DeleteAllStackChanges(ctx context.Context, stackID int64) error
	DeleteStackByID(ctx context.Context, id int64) error
}

type StackService struct {
	githubAppCredentials GitHubAppCredentialReader
	queries              StackQuerier
	submitTxManager      stackSubmitTxManager
	workflowRunner       StackWorkflowRunDispatcher
	githubInstallations  StackGitHubInstallationResolver
}

func WithStackGitHubAppCredentialStore(store GitHubAppCredentialReader) StackServiceOption {
	return func(s *StackService) { s.githubAppCredentials = store }
}

type StackServiceOption func(*StackService)

// stackSubmitTx is a transaction handle for the SubmitActiveStack write
// sequence. stack_changes has UNIQUE (stack_id, position) DEFERRABLE INITIALLY
// DEFERRED, so running the per-row upserts and the prune in one transaction
// lets a submit reorder existing changes (e.g. swap two positions): the
// constraint is checked once at commit instead of failing on the first
// transiently-colliding row. It also keeps partial updates from leaking when
// a later row or the prune errors.
type stackSubmitTx interface {
	UpsertActiveStack(ctx context.Context, arg db.UpsertActiveStackParams) (db.Stack, error)
	UpsertStackChange(ctx context.Context, arg db.UpsertStackChangeParams) (db.StackChange, error)
	DeleteStackChangesNotInSet(ctx context.Context, arg db.DeleteStackChangesNotInSetParams) error
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

// stackSubmitTxManager begins a new transaction for the submit write path.
type stackSubmitTxManager interface {
	BeginSubmitTx(ctx context.Context) (stackSubmitTx, error)
}

type pgxStackSubmitTxManager struct {
	pool *pgxpool.Pool
}

func (m *pgxStackSubmitTxManager) BeginSubmitTx(ctx context.Context) (stackSubmitTx, error) {
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &pgxStackSubmitTx{tx: tx, q: db.New(tx)}, nil
}

type pgxStackSubmitTx struct {
	tx pgx.Tx
	q  *db.Queries
}

func (t *pgxStackSubmitTx) UpsertActiveStack(ctx context.Context, arg db.UpsertActiveStackParams) (db.Stack, error) {
	return t.q.UpsertActiveStack(ctx, arg)
}

func (t *pgxStackSubmitTx) UpsertStackChange(ctx context.Context, arg db.UpsertStackChangeParams) (db.StackChange, error) {
	return t.q.UpsertStackChange(ctx, arg)
}

func (t *pgxStackSubmitTx) DeleteStackChangesNotInSet(ctx context.Context, arg db.DeleteStackChangesNotInSetParams) error {
	return t.q.DeleteStackChangesNotInSet(ctx, arg)
}

func (t *pgxStackSubmitTx) Commit(ctx context.Context) error {
	return t.tx.Commit(ctx)
}

func (t *pgxStackSubmitTx) Rollback(ctx context.Context) error {
	return t.tx.Rollback(ctx)
}

// StackGitHubInstallationResolver resolves the GitHub App installation for a
// GitHub owner/repo scoped to the viewing user's repo_connections binding.
// Smithers owner/repo names are freely chosen, so an unscoped string-match
// lookup would let a name-colliding Smithers repo read a victim installation's
// private PR/review/check metadata.
type StackGitHubInstallationResolver interface {
	GetGitHubInstallationIDForUserRepo(ctx context.Context, userID int64, owner string, repo string) (int64, error)
}

// WithStackGitHubInstallationResolver enables GitHub PR/CI enrichment of stack
// responses. Without it, stack responses use local defaults only.
func WithStackGitHubInstallationResolver(resolver StackGitHubInstallationResolver) StackServiceOption {
	return func(s *StackService) {
		s.githubInstallations = resolver
	}
}

// StackWorkflowRunDispatcher dispatches workflow runs from synthetic stack events.
type StackWorkflowRunDispatcher interface {
	DispatchForEvent(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error)
}

// WithStackWorkflowRunDispatcher enables stack_submit synthetic workflow events.
func WithStackWorkflowRunDispatcher(dispatcher StackWorkflowRunDispatcher) StackServiceOption {
	return func(s *StackService) {
		s.workflowRunner = dispatcher
	}
}

func NewStackService(q StackQuerier, opts ...StackServiceOption) *StackService {
	svc := &StackService{queries: q}
	for _, opt := range opts {
		if opt != nil {
			opt(svc)
		}
	}
	return svc
}

// NewStackServiceWithPool wires the transactional submit path used by
// SubmitActiveStack (required in production so stack reorders that swap
// positions commit atomically under the deferred position constraint).
func NewStackServiceWithPool(q StackQuerier, pool *pgxpool.Pool, opts ...StackServiceOption) *StackService {
	svc := NewStackService(q, opts...)
	if pool != nil {
		svc.submitTxManager = &pgxStackSubmitTxManager{pool: pool}
	}
	return svc
}

func (s *StackService) GetActiveStack(
	ctx context.Context,
	viewer *db.User,
	owner,
	repo,
	targetRef string,
) (StackResponse, error) {
	if viewer == nil {
		return StackResponse{}, pkgerrors.Unauthorized("authentication required")
	}

	repository, err := s.resolveRepo(ctx, owner, repo)
	if err != nil {
		return StackResponse{}, err
	}
	if err := s.requireReadAccess(ctx, repository, viewer); err != nil {
		return StackResponse{}, err
	}

	stack, err := s.queries.GetActiveStack(ctx, db.GetActiveStackParams{
		RepositoryID: repository.ID,
		UserID:       viewer.ID,
		TargetRef:    normalizeStackTargetRef(targetRef),
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return StackResponse{}, pkgerrors.NotFound("active stack not found")
		}
		return StackResponse{}, pkgerrors.Internal("failed to load active stack").WithCause(err)
	}

	changes, err := s.queries.ListStackChangesByStack(ctx, stack.ID)
	if err != nil {
		return StackResponse{}, pkgerrors.Internal("failed to load stack changes").WithCause(err)
	}

	response := mapStackResponse(stack, changes)
	if err := s.enrichStackResponseWithGitHub(ctx, viewer.ID, owner, repo, &response); err != nil {
		return StackResponse{}, err
	}
	return response, nil
}

func (s *StackService) UpsertActiveStack(
	ctx context.Context,
	actor *db.User,
	owner,
	repo string,
	input UpsertActiveStackInput,
) (StackResponse, error) {
	if actor == nil {
		return StackResponse{}, pkgerrors.Unauthorized("authentication required")
	}

	repository, err := s.resolveRepo(ctx, owner, repo)
	if err != nil {
		return StackResponse{}, err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return StackResponse{}, err
	}

	changes, err := normalizeStackChanges(input.Changes)
	if err != nil {
		return StackResponse{}, err
	}
	targetRef := normalizeStackTargetRef(input.TargetRef)

	stack, err := s.replaceStackChanges(ctx, repository.ID, actor.ID, targetRef, changes)
	if err != nil {
		return StackResponse{}, err
	}

	persistedChanges, err := s.queries.ListStackChangesByStack(ctx, stack.ID)
	if err != nil {
		return StackResponse{}, pkgerrors.Internal("failed to load stack changes").WithCause(err)
	}
	s.dispatchStackSubmitEvent(ctx, repository.ID, actor.ID, targetRef, persistedChanges)

	return mapStackResponse(stack, persistedChanges), nil
}

// stackSubmitQuerier is the write surface shared by the plain querier and the
// transactional handle used by replaceStackChanges.
type stackSubmitQuerier interface {
	UpsertActiveStack(ctx context.Context, arg db.UpsertActiveStackParams) (db.Stack, error)
	UpsertStackChange(ctx context.Context, arg db.UpsertStackChangeParams) (db.StackChange, error)
	DeleteStackChangesNotInSet(ctx context.Context, arg db.DeleteStackChangesNotInSetParams) error
}

// replaceStackChanges persists a submitted change set for the actor's active
// stack. In production the upserts and the prune run inside one transaction:
// uq_stack_changes_stack_position is DEFERRABLE INITIALLY DEFERRED, so a
// reorder that swaps existing positions is validated once at commit instead of
// failing on the first transiently-colliding row, and a mid-sequence error
// rolls the whole submit back. Without a pool (unit tests) the writes run
// sequentially on the plain querier.
func (s *StackService) replaceStackChanges(
	ctx context.Context,
	repositoryID int64,
	userID int64,
	targetRef string,
	changes []StackChangeInput,
) (db.Stack, error) {
	if s.submitTxManager == nil {
		return applyStackChanges(ctx, s.queries, repositoryID, userID, targetRef, changes)
	}

	tx, err := s.submitTxManager.BeginSubmitTx(ctx)
	if err != nil {
		return db.Stack{}, pkgerrors.Internal("failed to begin stack transaction").WithCause(err)
	}
	stack, err := applyStackChanges(ctx, tx, repositoryID, userID, targetRef, changes)
	if err != nil {
		_ = tx.Rollback(ctx)
		return db.Stack{}, err
	}
	// The deferred position constraint is checked here, so a genuinely
	// conflicting submit surfaces as a commit error.
	if err := tx.Commit(ctx); err != nil {
		_ = tx.Rollback(ctx)
		return db.Stack{}, normalizeStackWriteError(err, "failed to commit stack changes")
	}
	return stack, nil
}

func applyStackChanges(
	ctx context.Context,
	q stackSubmitQuerier,
	repositoryID int64,
	userID int64,
	targetRef string,
	changes []StackChangeInput,
) (db.Stack, error) {
	stack, err := q.UpsertActiveStack(ctx, db.UpsertActiveStackParams{
		RepositoryID: repositoryID,
		UserID:       userID,
		TargetRef:    targetRef,
	})
	if err != nil {
		return db.Stack{}, normalizeStackWriteError(err, "failed to upsert active stack")
	}

	changeIDs := make([]string, 0, len(changes))
	for _, change := range changes {
		if change.Position > math.MaxInt32 {
			return db.Stack{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{
				Resource: "Stack",
				Field:    "position",
				Code:     "invalid",
			})
		}

		arg := db.UpsertStackChangeParams{
			StackID:      stack.ID,
			ChangeID:     change.ChangeID,
			Position:     int32(change.Position),
			BranchName:   change.BranchName,
			PRState:      trimOptionalText(change.PRState),
			ReviewStatus: trimOptionalText(change.ReviewStatus),
			CiStatus:     trimOptionalText(change.CIStatus),
		}
		if change.PRNumber != nil {
			arg.PRNumber = pgtype.Int8{Int64: *change.PRNumber, Valid: true}
		}

		if _, err := q.UpsertStackChange(ctx, arg); err != nil {
			return db.Stack{}, normalizeStackWriteError(err, "failed to upsert stack changes")
		}
		changeIDs = append(changeIDs, change.ChangeID)
	}

	if err := q.DeleteStackChangesNotInSet(ctx, db.DeleteStackChangesNotInSetParams{
		StackID:   stack.ID,
		ChangeIds: changeIDs,
	}); err != nil {
		return db.Stack{}, pkgerrors.Internal("failed to prune stack changes").WithCause(err)
	}

	return stack, nil
}

func (s *StackService) DeleteActiveStack(
	ctx context.Context,
	actor *db.User,
	owner,
	repo,
	targetRef string,
) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}

	repository, err := s.resolveRepo(ctx, owner, repo)
	if err != nil {
		return err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return err
	}

	stack, err := s.queries.GetActiveStack(ctx, db.GetActiveStackParams{
		RepositoryID: repository.ID,
		UserID:       actor.ID,
		TargetRef:    normalizeStackTargetRef(targetRef),
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			// Idempotent behavior: deleting an already-missing stack succeeds.
			return nil
		}
		return pkgerrors.Internal("failed to load active stack").WithCause(err)
	}

	if err := s.queries.DeleteAllStackChanges(ctx, stack.ID); err != nil {
		return pkgerrors.Internal("failed to delete stack changes").WithCause(err)
	}
	if err := s.queries.DeleteStackByID(ctx, stack.ID); err != nil {
		return pkgerrors.Internal("failed to delete active stack").WithCause(err)
	}

	return nil
}

func (s *StackService) resolveRepo(ctx context.Context, owner, repo string) (db.Repository, error) {
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

func (s *StackService) requireReadAccess(ctx context.Context, repository db.Repository, viewer *db.User) error {
	if viewer == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	if repository.IsPublic {
		return nil
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

func (s *StackService) requireWriteAccess(ctx context.Context, repository db.Repository, actor *db.User) error {
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

func (s *StackService) canReadRepo(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canReadRepo(ctx, s.queries, repository, userID)
}

func (s *StackService) canWriteRepo(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canWriteRepo(ctx, s.queries, repository, userID)
}

func normalizeStackTargetRef(targetRef string) string {
	trimmed := strings.TrimSpace(targetRef)
	if trimmed == "" {
		return defaultStackTargetRef
	}
	return trimmed
}

func normalizeStackChanges(changes []StackChangeInput) ([]StackChangeInput, error) {
	if len(changes) == 0 {
		return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "Stack",
			Field:    "changes",
			Code:     "missing_field",
		})
	}

	normalized := make([]StackChangeInput, 0, len(changes))
	seenChangeIDs := make(map[string]struct{}, len(changes))
	seenPositions := make(map[int]struct{}, len(changes))
	for index, raw := range changes {
		changeID := strings.TrimSpace(raw.ChangeID)
		if changeID == "" {
			return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{
				Resource: "Stack",
				Field:    "change_id",
				Code:     "missing_field",
			})
		}
		if _, exists := seenChangeIDs[changeID]; exists {
			return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{
				Resource: "Stack",
				Field:    "change_id",
				Code:     "invalid",
			})
		}
		seenChangeIDs[changeID] = struct{}{}

		branchName := strings.TrimSpace(raw.BranchName)
		if branchName == "" {
			return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{
				Resource: "Stack",
				Field:    "branch_name",
				Code:     "missing_field",
			})
		}

		position := raw.Position
		if position < 0 {
			position = index
		}
		if _, exists := seenPositions[position]; exists {
			return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{
				Resource: "Stack",
				Field:    "position",
				Code:     "invalid",
			})
		}
		seenPositions[position] = struct{}{}

		if raw.PRNumber != nil && *raw.PRNumber <= 0 {
			return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{
				Resource: "Stack",
				Field:    "pr_number",
				Code:     "invalid",
			})
		}

		normalized = append(normalized, StackChangeInput{
			BranchName:   branchName,
			ChangeID:     changeID,
			CIStatus:     strings.TrimSpace(raw.CIStatus),
			Position:     position,
			PRNumber:     raw.PRNumber,
			PRState:      strings.TrimSpace(raw.PRState),
			ReviewStatus: strings.TrimSpace(raw.ReviewStatus),
		})
	}

	return normalized, nil
}

func normalizeStackWriteError(err error, fallbackMessage string) error {
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
		// 22001 = value too long for VARCHAR; 22021 = invalid byte (NUL). These are
		// client-caused (an over-long/NUL change_id, branch_name, ci_status, etc.)
		// and must surface as 422, not an opaque 500.
		case "22001", "22021", "23502", "23503", "23514":
			return pkgerrors.ValidationFailed(pkgerrors.FieldError{
				Resource: "Stack",
				Field:    "stack",
				Code:     "invalid",
			})
		case "23505":
			return pkgerrors.Conflict("duplicate stack change")
		}
	}

	return pkgerrors.Internal(fallbackMessage)
}

func trimOptionalText(value string) pgtype.Text {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: trimmed, Valid: true}
}

func mapStackResponse(stack db.Stack, changes []db.StackChange) StackResponse {
	result := StackResponse{
		ID:        stack.ID,
		State:     stack.State,
		TargetRef: stack.TargetRef,
		CreatedAt: stack.CreatedAt,
		UpdatedAt: stack.UpdatedAt,
		Changes:   make([]StackChangeResponse, 0, len(changes)),
	}
	for _, row := range changes {
		change := StackChangeResponse{
			BranchName: row.BranchName,
			ChangeID:   row.ChangeID,
			Position:   int(row.Position),
		}
		if row.PRNumber.Valid {
			prNumber := row.PRNumber.Int64
			change.PRNumber = &prNumber
		}
		if row.PRState.Valid {
			change.PRState = normalizeStackPRState(row.PRState.String)
		}
		if row.ReviewStatus.Valid {
			change.ReviewStatus = normalizeStackReviewStatus(row.ReviewStatus.String)
		}
		if row.CiStatus.Valid {
			change.CIStatus = normalizeStackCIStatus(row.CiStatus.String)
		}
		result.Changes = append(result.Changes, change)
	}
	return result
}

type stackGitHubPullRequest struct {
	Head struct {
		SHA string `json:"sha"`
	} `json:"head"`
	HTMLURL string `json:"html_url"`
	State   string `json:"state"`
}

type stackGitHubReview struct {
	State string `json:"state"`
	User  struct {
		Login string `json:"login"`
	} `json:"user"`
}

type stackGitHubCheckRun struct {
	Conclusion *string `json:"conclusion"`
	Status     string  `json:"status"`
}

type stackGitHubCheckRunList struct {
	CheckRuns []stackGitHubCheckRun `json:"check_runs"`
}

type stackGitHubTokenResponse struct {
	Message   string `json:"message"`
	Token     string `json:"token"`
	ExpiresAt string `json:"expires_at"`
}

// stackGitHubEnrichTimeout bounds all GitHub lookups for one stack read, and
// stackGitHubEnrichConcurrency bounds how many changes are looked up at once.
// Changes that miss the deadline keep their local defaults.
var stackGitHubEnrichTimeout = 5 * time.Second

const stackGitHubEnrichConcurrency = 4

type stackGitHubState struct {
	PRState      string
	PRURL        string
	ReviewStatus string
	CIStatus     string
}

func (s *StackService) enrichStackResponseWithGitHub(
	ctx context.Context,
	viewerID int64,
	owner,
	repo string,
	response *StackResponse,
) error {
	if response == nil || len(response.Changes) == 0 {
		return nil
	}

	normalizedOwner := strings.ToLower(strings.TrimSpace(owner))
	normalizedRepo := strings.ToLower(strings.TrimSpace(repo))
	if normalizedOwner == "" || normalizedRepo == "" || s.githubInstallations == nil {
		for index := range response.Changes {
			applyStackChangeDefaults(&response.Changes[index], owner, repo)
		}
		return nil
	}

	installationID, err := s.githubInstallations.GetGitHubInstallationIDForUserRepo(ctx, viewerID, normalizedOwner, normalizedRepo)
	if err != nil {
		// GitHub state is decoration on a readable local stack; degrade to
		// defaults instead of failing the whole read.
		slog.Warn("stack: failed to load github app installation", "owner", normalizedOwner, "repo", normalizedRepo, "error", err)
		installationID = 0
	}
	if installationID <= 0 {
		for index := range response.Changes {
			applyStackChangeDefaults(&response.Changes[index], owner, repo)
		}
		return nil
	}

	token, err := createStackGitHubInstallationToken(ctx, installationID, s.githubAppCredentials)
	if err != nil {
		for index := range response.Changes {
			applyStackChangeDefaults(&response.Changes[index], owner, repo)
		}
		return nil
	}

	enrichCtx, cancel := context.WithTimeout(ctx, stackGitHubEnrichTimeout)
	defer cancel()
	states := make([]*stackGitHubState, len(response.Changes))
	sem := make(chan struct{}, stackGitHubEnrichConcurrency)
	var wg sync.WaitGroup
	for index, change := range response.Changes {
		if change.PRNumber == nil || *change.PRNumber <= 0 {
			continue
		}
		wg.Add(1)
		go func(index int, prNumber int64) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-enrichCtx.Done():
				return
			}
			defer func() { <-sem }()
			state, err := loadStackGitHubState(enrichCtx, token, owner, repo, prNumber)
			if err == nil {
				states[index] = &state
			}
		}(index, *change.PRNumber)
	}
	wg.Wait()

	for index := range response.Changes {
		change := &response.Changes[index]
		if state := states[index]; state != nil {
			if state.PRState != "" {
				change.PRState = normalizeStackPRState(state.PRState)
			}
			if state.PRURL != "" {
				change.PRURL = strings.TrimSpace(state.PRURL)
			}
			change.ReviewStatus = normalizeStackReviewStatus(state.ReviewStatus)
			change.CIStatus = normalizeStackCIStatus(state.CIStatus)
		}
		applyStackChangeDefaults(change, owner, repo)
	}

	return nil
}

func applyStackChangeDefaults(change *StackChangeResponse, owner, repo string) {
	if change == nil {
		return
	}
	change.ReviewStatus = normalizeStackReviewStatus(change.ReviewStatus)
	change.CIStatus = normalizeStackCIStatus(change.CIStatus)
	if change.PRNumber != nil && *change.PRNumber > 0 {
		if strings.TrimSpace(change.PRState) == "" {
			change.PRState = "open"
		} else {
			change.PRState = normalizeStackPRState(change.PRState)
		}
		if strings.TrimSpace(change.PRURL) == "" {
			change.PRURL = stackPullRequestURL(owner, repo, *change.PRNumber)
		}
	}
}

func stackPullRequestURL(owner, repo string, prNumber int64) string {
	if prNumber <= 0 {
		return ""
	}
	trimmedOwner := strings.TrimSpace(owner)
	trimmedRepo := strings.TrimSpace(repo)
	if trimmedOwner == "" || trimmedRepo == "" {
		return ""
	}
	return fmt.Sprintf("https://github.com/%s/%s/pull/%d", trimmedOwner, trimmedRepo, prNumber)
}

func loadStackGitHubState(
	ctx context.Context,
	token,
	owner,
	repo string,
	prNumber int64,
) (stackGitHubState, error) {
	var pull stackGitHubPullRequest
	pullPath := fmt.Sprintf(
		"/repos/%s/%s/pulls/%d",
		url.PathEscape(strings.TrimSpace(owner)),
		url.PathEscape(strings.TrimSpace(repo)),
		prNumber,
	)
	if err := callStackGitHubJSON(ctx, token, pullPath, &pull); err != nil {
		return stackGitHubState{}, err
	}

	reviewStatus := "pending"
	var reviews []stackGitHubReview
	reviewsPath := fmt.Sprintf(
		"/repos/%s/%s/pulls/%d/reviews",
		url.PathEscape(strings.TrimSpace(owner)),
		url.PathEscape(strings.TrimSpace(repo)),
		prNumber,
	)
	if err := callStackGitHubJSON(ctx, token, reviewsPath, &reviews); err == nil {
		reviewStatus = aggregateStackReviewStatus(reviews)
	}

	ciStatus := "pending"
	headSHA := strings.TrimSpace(pull.Head.SHA)
	if headSHA != "" {
		var checkRuns stackGitHubCheckRunList
		checkRunsPath := fmt.Sprintf(
			"/repos/%s/%s/commits/%s/check-runs",
			url.PathEscape(strings.TrimSpace(owner)),
			url.PathEscape(strings.TrimSpace(repo)),
			url.PathEscape(headSHA),
		)
		if err := callStackGitHubJSON(ctx, token, checkRunsPath, &checkRuns); err == nil {
			ciStatus = aggregateStackCIStatus(checkRuns.CheckRuns)
		}
	}

	return stackGitHubState{
		PRState:      normalizeStackPRState(pull.State),
		PRURL:        strings.TrimSpace(pull.HTMLURL),
		ReviewStatus: reviewStatus,
		CIStatus:     ciStatus,
	}, nil
}

func aggregateStackReviewStatus(reviews []stackGitHubReview) string {
	latestByReviewer := make(map[string]string, len(reviews))
	for index, review := range reviews {
		state := strings.ToUpper(strings.TrimSpace(review.State))
		if state != "APPROVED" && state != "CHANGES_REQUESTED" {
			continue
		}

		reviewer := strings.ToLower(strings.TrimSpace(review.User.Login))
		if reviewer == "" {
			reviewer = fmt.Sprintf("unknown-%d", index)
		}
		latestByReviewer[reviewer] = state
	}

	hasApproved := false
	for _, state := range latestByReviewer {
		if state == "CHANGES_REQUESTED" {
			return "changes_requested"
		}
		if state == "APPROVED" {
			hasApproved = true
		}
	}
	if hasApproved {
		return "approved"
	}
	return "pending"
}

func aggregateStackCIStatus(checkRuns []stackGitHubCheckRun) string {
	if len(checkRuns) == 0 {
		return "pending"
	}

	hasPending := false
	for _, run := range checkRuns {
		status := strings.ToLower(strings.TrimSpace(run.Status))
		conclusion := ""
		if run.Conclusion != nil {
			conclusion = strings.ToLower(strings.TrimSpace(*run.Conclusion))
		}

		if status != "completed" || conclusion == "" {
			hasPending = true
			continue
		}

		switch conclusion {
		case "failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale":
			return "failing"
		case "success", "neutral", "skipped":
			continue
		default:
			hasPending = true
		}
	}

	if hasPending {
		return "pending"
	}
	return "passing"
}

func (s *StackService) dispatchStackSubmitEvent(
	ctx context.Context,
	repositoryID int64,
	userID int64,
	targetRef string,
	changes []db.StackChange,
) {
	if s.workflowRunner == nil || repositoryID <= 0 || userID <= 0 {
		return
	}

	var latestChangeID string
	if len(changes) > 0 {
		latestChangeID = strings.TrimSpace(changes[len(changes)-1].ChangeID)
	}

	if _, err := s.workflowRunner.DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID: repositoryID,
		UserID:       userID,
		Event: TriggerEvent{
			Type:     "stack_submit",
			Ref:      strings.TrimSpace(targetRef),
			ChangeID: latestChangeID,
		},
	}); err != nil {
		slog.Error(
			"failed to dispatch stack_submit workflow trigger",
			"repository_id", repositoryID,
			"user_id", userID,
			"error", err,
		)
	}
}

func normalizeStackReviewStatus(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "approved":
		return "approved"
	case "changes_requested", "changes-requested", "changes requested":
		return "changes_requested"
	default:
		return "pending"
	}
}

func normalizeStackCIStatus(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "passing", "success", "passed":
		return "passing"
	case "failing", "failure", "failed", "error", "cancelled", "canceled":
		return "failing"
	default:
		return "pending"
	}
}

func normalizeStackPRState(value string) string {
	trimmed := strings.ToLower(strings.TrimSpace(value))
	if trimmed == "" {
		return ""
	}
	return trimmed
}

func createStackGitHubInstallationToken(ctx context.Context, installationID int64, stores ...GitHubAppCredentialReader) (string, error) {
	if installationID <= 0 {
		return "", stdErrors.New("invalid installation id")
	}
	var store GitHubAppCredentialReader
	if len(stores) > 0 {
		store = stores[0]
	}
	if _, err := loadGitHubAppCredentials(ctx, store); err != nil {
		return "", err
	}
	// Installation tokens live about an hour; share the per-installation cache.
	if cached, ok := getCachedInstallationToken(installationID); ok {
		return cached.token, nil
	}

	jwtToken, err := githubAppJWT(ctx, store)
	if err != nil {
		return "", err
	}

	endpoint := fmt.Sprintf(
		"%s/app/installations/%d/access_tokens",
		strings.TrimRight(githubAPIBaseURL(), "/"),
		installationID,
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader("{}"))
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+jwtToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "smithers-server")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	httpClient := observability.NewHTTPClient(10 * time.Second)
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()

	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var payload stackGitHubTokenResponse
	_ = json.Unmarshal(bodyBytes, &payload)

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		message := strings.TrimSpace(payload.Message)
		if message == "" {
			message = "github installation token request failed"
		}
		return "", stdErrors.New(message)
	}

	token := strings.TrimSpace(payload.Token)
	if token == "" {
		return "", stdErrors.New("github installation token response was missing token")
	}
	if expiresAt, err := time.Parse(time.RFC3339, strings.TrimSpace(payload.ExpiresAt)); err == nil {
		storeCachedInstallationToken(installationID, token, expiresAt)
	}
	return token, nil
}

func callStackGitHubJSON(ctx context.Context, token, path string, out any) error {
	base := strings.TrimRight(githubAPIBaseURL(), "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	req.Header.Set("User-Agent", "smithers-server")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	httpClient := observability.NewHTTPClient(10 * time.Second)
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		var payload struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(bodyBytes, &payload)
		message := strings.TrimSpace(payload.Message)
		if message == "" {
			message = fmt.Sprintf("github request failed: %d", resp.StatusCode)
		}
		return stdErrors.New(message)
	}

	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
