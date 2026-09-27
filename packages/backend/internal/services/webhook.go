package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type CreateWebhookInput struct {
	URL      string   `json:"url"`
	Secret   string   `json:"secret"`
	Events   []string `json:"events"`
	IsActive bool     `json:"is_active"`
}

type UpdateWebhookInput struct {
	URL      *string   `json:"url,omitempty"`
	Secret   *string   `json:"secret,omitempty"`
	Events   *[]string `json:"events,omitempty"`
	IsActive *bool     `json:"is_active,omitempty"`
}

type WebhookQuerier interface {
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)

	ListRepoWebhooksByOwnerAndRepo(ctx context.Context, arg db.ListRepoWebhooksByOwnerAndRepoParams) ([]db.Webhook, error)
	CountWebhooksByRepo(ctx context.Context, repositoryID int64) (int64, error)
	GetRepoWebhookByOwnerAndRepo(ctx context.Context, arg db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error)
	CreateWebhook(ctx context.Context, arg db.CreateWebhookParams) (db.Webhook, error)
	UpdateRepoWebhookByOwnerAndRepo(ctx context.Context, arg db.UpdateRepoWebhookByOwnerAndRepoParams) (db.Webhook, error)
	DeleteRepoWebhookByOwnerAndRepo(ctx context.Context, arg db.DeleteRepoWebhookByOwnerAndRepoParams) (int64, error)
	CreateWebhookDelivery(ctx context.Context, arg db.CreateWebhookDeliveryParams) (db.WebhookDelivery, error)
	UpdateWebhookDeliveryResult(ctx context.Context, arg db.UpdateWebhookDeliveryResultParams) error
	ListWebhookDeliveriesForRepo(ctx context.Context, arg db.ListWebhookDeliveriesForRepoParams) ([]db.WebhookDelivery, error)
	GetWebhookDeliveryForRepo(ctx context.Context, arg db.GetWebhookDeliveryForRepoParams) (db.WebhookDelivery, error)
}

type WebhookService struct {
	queries        WebhookQuerier
	secretCodec    webhook.SecretCodec
	httpClient     *http.Client
	ownershipGuard RepoOwnershipGuard
}

type WebhookServiceOption func(*WebhookService)

// WithWebhookOwnershipGuard fences webhook creation against concurrent
// repository transfers, so a request authorized against the old owner cannot
// attach a webhook (an event-exfiltration channel) to the new owner's repo.
// Update/delete are already keyed on owner/repo name and need no fence.
func WithWebhookOwnershipGuard(g RepoOwnershipGuard) WebhookServiceOption {
	return func(s *WebhookService) {
		s.ownershipGuard = g
	}
}

const redactedWebhookSecret = "********"
const maxWebhooksPerRepo = 20

func NewWebhookService(q WebhookQuerier, codec webhook.SecretCodec, opts ...WebhookServiceOption) *WebhookService {
	secretCodec := webhook.SecretCodec(webhook.NoopSecretCodec{})
	if codec != nil {
		secretCodec = codec
	}
	s := &WebhookService{
		queries:     q,
		secretCodec: secretCodec,
		httpClient:  webhook.DefaultHTTPClient(),
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

func (s *WebhookService) ListWebhooks(ctx context.Context, actor *db.User, owner, repo string) ([]db.Webhook, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, err
	}
	if err := s.requireAdminAccess(ctx, repository, actor); err != nil {
		return nil, err
	}

	hooks, err := s.queries.ListRepoWebhooksByOwnerAndRepo(ctx, db.ListRepoWebhooksByOwnerAndRepoParams{
		Owner: owner,
		Repo:  repo,
	})
	if err != nil {
		return nil, pkgerrors.Internal("failed to list webhooks").WithCause(err)
	}

	redacted := make([]db.Webhook, 0, len(hooks))
	for _, hook := range hooks {
		redacted = append(redacted, redactWebhookSecret(hook))
	}
	return redacted, nil
}

func (s *WebhookService) GetWebhook(ctx context.Context, actor *db.User, owner, repo string, webhookID int64) (db.Webhook, error) {
	if webhookID <= 0 {
		return db.Webhook{}, pkgerrors.BadRequest("invalid webhook id")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return db.Webhook{}, err
	}
	if err := s.requireAdminAccess(ctx, repository, actor); err != nil {
		return db.Webhook{}, err
	}

	hook, err := s.queries.GetRepoWebhookByOwnerAndRepo(ctx, db.GetRepoWebhookByOwnerAndRepoParams{
		WebhookID: webhookID,
		Owner:     owner,
		Repo:      repo,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Webhook{}, pkgerrors.NotFound("webhook not found")
		}
		return db.Webhook{}, pkgerrors.Internal("failed to load webhook").WithCause(err)
	}
	return s.decryptWebhookSecret(hook)
}

func (s *WebhookService) CreateWebhook(ctx context.Context, actor *db.User, owner, repo string, req CreateWebhookInput) (db.Webhook, error) {
	if actor == nil {
		return db.Webhook{}, pkgerrors.Unauthorized("authentication required")
	}

	url := strings.TrimSpace(req.URL)
	if url == "" {
		return db.Webhook{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Webhook", Field: "url", Code: "missing_field"})
	}
	if !strings.HasPrefix(url, "https://") {
		return db.Webhook{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Webhook", Field: "url", Code: "invalid"})
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return db.Webhook{}, err
	}
	if err := s.requireAdminAccess(ctx, repository, actor); err != nil {
		return db.Webhook{}, err
	}

	webhookCount, err := s.queries.CountWebhooksByRepo(ctx, repository.ID)
	if err != nil {
		return db.Webhook{}, pkgerrors.Internal("failed to count webhooks").WithCause(err)
	}
	if webhookCount >= maxWebhooksPerRepo {
		return db.Webhook{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "Webhook",
			Field:    "repository_id",
			Code:     "invalid",
		})
	}

	events := req.Events
	if events == nil {
		events = []string{}
	}
	if err := webhooks.ValidateSubscribedEvents(events); err != nil {
		return db.Webhook{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Webhook", Field: "events", Code: "invalid"})
	}

	encryptedSecret, err := s.secretCodec.EncryptString(req.Secret)
	if err != nil {
		return db.Webhook{}, pkgerrors.Internal("failed to encrypt webhook secret").WithCause(err)
	}

	var created db.Webhook
	if err := guardedRepoWrite(ctx, s.ownershipGuard, repository, func() error {
		var werr error
		created, werr = s.queries.CreateWebhook(ctx, db.CreateWebhookParams{
			RepositoryID: repository.ID,
			Url:          url,
			Secret:       encryptedSecret,
			Events:       events,
			IsActive:     req.IsActive,
		})
		if werr != nil {
			// The count check above is a friendly pre-check only; the
			// trg_webhooks_repo_cap trigger enforces maxWebhooksPerRepo
			// atomically and rejects inserts that race past the pre-check.
			var pgErr *pgconn.PgError
			if stdErrors.As(werr, &pgErr) && pgErr.ConstraintName == "webhooks_repo_cap" {
				return pkgerrors.ValidationFailed(pkgerrors.FieldError{
					Resource: "Webhook",
					Field:    "repository_id",
					Code:     "invalid",
				})
			}
			return pkgerrors.Internal("failed to create webhook").WithCause(werr)
		}
		return nil
	}); err != nil {
		return db.Webhook{}, err
	}
	return s.decryptWebhookSecret(created)
}

func (s *WebhookService) UpdateWebhook(ctx context.Context, actor *db.User, owner, repo string, webhookID int64, req UpdateWebhookInput) (db.Webhook, error) {
	if actor == nil {
		return db.Webhook{}, pkgerrors.Unauthorized("authentication required")
	}
	if webhookID <= 0 {
		return db.Webhook{}, pkgerrors.BadRequest("invalid webhook id")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return db.Webhook{}, err
	}
	if err := s.requireAdminAccess(ctx, repository, actor); err != nil {
		return db.Webhook{}, err
	}

	current, err := s.queries.GetRepoWebhookByOwnerAndRepo(ctx, db.GetRepoWebhookByOwnerAndRepoParams{
		WebhookID: webhookID,
		Owner:     owner,
		Repo:      repo,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Webhook{}, pkgerrors.NotFound("webhook not found")
		}
		return db.Webhook{}, pkgerrors.Internal("failed to load webhook").WithCause(err)
	}

	url := current.Url
	if req.URL != nil {
		url = strings.TrimSpace(*req.URL)
		if url == "" {
			return db.Webhook{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Webhook", Field: "url", Code: "missing_field"})
		}
		if !strings.HasPrefix(url, "https://") {
			return db.Webhook{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Webhook", Field: "url", Code: "invalid"})
		}
	}

	secret := current.Secret
	if req.Secret != nil {
		secret, err = s.secretCodec.EncryptString(*req.Secret)
		if err != nil {
			return db.Webhook{}, pkgerrors.Internal("failed to encrypt webhook secret").WithCause(err)
		}
	}

	events := current.Events
	if req.Events != nil {
		events = *req.Events
		if err := webhooks.ValidateSubscribedEvents(events); err != nil {
			return db.Webhook{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Webhook", Field: "events", Code: "invalid"})
		}
	}

	isActive := current.IsActive
	if req.IsActive != nil {
		isActive = *req.IsActive
	}

	updated, err := s.queries.UpdateRepoWebhookByOwnerAndRepo(ctx, db.UpdateRepoWebhookByOwnerAndRepoParams{
		WebhookID: webhookID,
		Owner:     owner,
		Repo:      repo,
		Url:       url,
		Secret:    secret,
		Events:    events,
		IsActive:  isActive,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Webhook{}, pkgerrors.NotFound("webhook not found")
		}
		return db.Webhook{}, pkgerrors.Internal("failed to update webhook").WithCause(err)
	}
	return s.decryptWebhookSecret(updated)
}

func (s *WebhookService) DeleteWebhook(ctx context.Context, actor *db.User, owner, repo string, webhookID int64) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	if webhookID <= 0 {
		return pkgerrors.BadRequest("invalid webhook id")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return err
	}
	if err := s.requireAdminAccess(ctx, repository, actor); err != nil {
		return err
	}

	rowsAffected, err := s.queries.DeleteRepoWebhookByOwnerAndRepo(ctx, db.DeleteRepoWebhookByOwnerAndRepoParams{
		WebhookID: webhookID,
		Owner:     owner,
		Repo:      repo,
	})
	if err != nil {
		return pkgerrors.Internal("failed to delete webhook").WithCause(err)
	}
	if rowsAffected == 0 {
		return pkgerrors.NotFound("webhook not found")
	}
	return nil
}

// ListWebhookDeliveries returns up to 30 recent deliveries for a webhook, newest first.
func (s *WebhookService) ListWebhookDeliveries(ctx context.Context, actor *db.User, owner, repo string, webhookID int64, page, perPage int) ([]db.WebhookDelivery, error) {
	if webhookID <= 0 {
		return nil, pkgerrors.BadRequest("invalid webhook id")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, err
	}
	if err := s.requireAdminAccess(ctx, repository, actor); err != nil {
		return nil, err
	}

	// Confirm the webhook belongs to this repo (returns 404 if not).
	if _, err := s.queries.GetRepoWebhookByOwnerAndRepo(ctx, db.GetRepoWebhookByOwnerAndRepoParams{
		WebhookID: webhookID,
		Owner:     owner,
		Repo:      repo,
	}); err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, pkgerrors.NotFound("webhook not found")
		}
		return nil, pkgerrors.Internal("failed to load webhook").WithCause(err)
	}

	pageSize, pageOffset, _, _ := normalizeWebhookPage(page, perPage)
	deliveries, err := s.queries.ListWebhookDeliveriesForRepo(ctx, db.ListWebhookDeliveriesForRepoParams{
		WebhookID:  webhookID,
		Owner:      owner,
		Repo:       repo,
		PageOffset: ClampInt32(pageOffset),
		PageSize:   int32(pageSize),
	})
	if err != nil {
		return nil, pkgerrors.Internal("failed to list webhook deliveries").WithCause(err)
	}
	return deliveries, nil
}

func (s *WebhookService) RedeliverWebhookDelivery(ctx context.Context, actor *db.User, owner, repo string, webhookID, deliveryID int64) (db.WebhookDelivery, error) {
	if actor == nil {
		return db.WebhookDelivery{}, pkgerrors.Unauthorized("authentication required")
	}
	if webhookID <= 0 {
		return db.WebhookDelivery{}, pkgerrors.BadRequest("invalid webhook id")
	}
	if deliveryID <= 0 {
		return db.WebhookDelivery{}, pkgerrors.BadRequest("invalid webhook delivery id")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return db.WebhookDelivery{}, err
	}
	if err := s.requireAdminAccess(ctx, repository, actor); err != nil {
		return db.WebhookDelivery{}, err
	}

	source, err := s.queries.GetWebhookDeliveryForRepo(ctx, db.GetWebhookDeliveryForRepoParams{
		DeliveryID: deliveryID,
		WebhookID:  webhookID,
		Owner:      owner,
		Repo:       repo,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.WebhookDelivery{}, pkgerrors.NotFound("webhook delivery not found")
		}
		return db.WebhookDelivery{}, pkgerrors.Internal("failed to load webhook delivery").WithCause(err)
	}

	created, err := s.queries.CreateWebhookDelivery(ctx, db.CreateWebhookDeliveryParams{
		WebhookID: source.WebhookID,
		EventType: source.EventType,
		Payload:   source.Payload,
		Status:    "pending",
	})
	if err != nil {
		return db.WebhookDelivery{}, pkgerrors.Internal("failed to queue webhook redelivery").WithCause(err)
	}
	return created, nil
}

func normalizeWebhookPage(page, perPage int) (size, offset, pageNum, pages int) {
	if page < 1 {
		page = 1
	}
	if perPage < 1 || perPage > 30 {
		perPage = 30
	}
	// Cap page so the SQL offset (page-1)*perPage cannot overflow int32 below.
	if maxPage := math.MaxInt32/perPage + 1; page > maxPage {
		page = maxPage
	}
	offset = (page - 1) * perPage
	return perPage, offset, page, 0
}

func (s *WebhookService) decryptWebhookSecret(h db.Webhook) (db.Webhook, error) {
	secret, err := s.secretCodec.DecryptString(h.Secret)
	if err != nil {
		return db.Webhook{}, pkgerrors.Internal("failed to decrypt webhook secret").WithCause(err)
	}
	h.Secret = secret
	return h, nil
}

func redactWebhookSecret(h db.Webhook) db.Webhook {
	if h.Secret == "" {
		return h
	}
	h.Secret = redactedWebhookSecret
	return h
}

// TestWebhookResult is the outcome of a ping delivery. Error is set, and
// StatusCode is 0, when the endpoint could not be reached at all.
type TestWebhookResult struct {
	StatusCode int    `json:"status_code"`
	Body       string `json:"body"`
	Error      string `json:"error,omitempty"`
}

func (s *WebhookService) TestWebhook(ctx context.Context, actor *db.User, owner, repo string, webhookID int64) (*TestWebhookResult, error) {
	if actor == nil {
		return nil, pkgerrors.Unauthorized("authentication required")
	}
	if webhookID <= 0 {
		return nil, pkgerrors.BadRequest("invalid webhook id")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, err
	}
	if err := s.requireAdminAccess(ctx, repository, actor); err != nil {
		return nil, err
	}

	hook, err := s.queries.GetRepoWebhookByOwnerAndRepo(ctx, db.GetRepoWebhookByOwnerAndRepoParams{
		WebhookID: webhookID,
		Owner:     owner,
		Repo:      repo,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, pkgerrors.NotFound("webhook not found")
		}
		return nil, pkgerrors.Internal("failed to load webhook").WithCause(err)
	}

	decryptedSecret, err := s.secretCodec.DecryptString(hook.Secret)
	if err != nil {
		return nil, pkgerrors.Internal("failed to decrypt webhook secret").WithCause(err)
	}

	pingPayload, _ := json.Marshal(map[string]any{
		"event":   "ping",
		"zen":     "Approachable is better than simple.",
		"hook_id": hook.ID,
	})

	delivery, err := s.queries.CreateWebhookDelivery(ctx, db.CreateWebhookDeliveryParams{
		WebhookID: hook.ID,
		EventType: "ping",
		Payload:   pingPayload,
		Status:    "pending",
	})
	if err != nil {
		return nil, pkgerrors.Internal("failed to create ping delivery").WithCause(err)
	}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	statusCode, body, deliveryErr := webhook.Deliver(ctx, s.httpClient, webhook.DeliveryRequest{
		URL:        hook.Url,
		Secret:     decryptedSecret,
		EventType:  "ping",
		DeliveryID: fmt.Sprintf("%d", delivery.ID),
		Payload:    pingPayload,
	})

	finalStatus := "success"
	if deliveryErr != nil || statusCode < 200 || statusCode >= 300 {
		finalStatus = "failed"
	}

	// Record the delivery result on a context detached from the (possibly
	// expired) request/delivery context so a slow endpoint cannot prevent
	// the result from being persisted.
	writeCtx, writeCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer writeCancel()
	if err := s.queries.UpdateWebhookDeliveryResult(writeCtx, db.UpdateWebhookDeliveryResultParams{
		ID:             delivery.ID,
		Status:         finalStatus,
		ResponseStatus: toNullableInt4(statusCode),
		ResponseBody:   body,
	}); err != nil {
		slog.Error("failed to record webhook test delivery result",
			"webhook_id", hook.ID, "delivery_id", delivery.ID, "error", err)
	}

	if deliveryErr != nil {
		// The endpoint, not the server, failed: report it as a result the
		// admin can act on instead of a 500 blamed on the server.
		return &TestWebhookResult{Error: deliveryErr.Error()}, nil
	}

	return &TestWebhookResult{
		StatusCode: statusCode,
		Body:       body,
	}, nil
}

// --- permission helpers (same pattern as issue/label services) ---

func (s *WebhookService) resolveRepoByOwnerAndName(ctx context.Context, owner, repo string) (db.Repository, error) {
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

func (s *WebhookService) requireAdminAccess(ctx context.Context, repository db.Repository, actor *db.User) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	isAdmin, err := s.isRepoAdmin(ctx, repository, actor.ID)
	if err != nil {
		return err
	}
	if !isAdmin {
		return pkgerrors.Forbidden("permission denied")
	}
	return nil
}

func (s *WebhookService) isRepoAdmin(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canAdminRepo(ctx, s.queries, repository, userID)
}

func toNullableInt4(statusCode int) pgtype.Int4 {
	if statusCode <= 0 {
		return pgtype.Int4{}
	}
	return pgtype.Int4{Int32: int32(statusCode), Valid: true}
}
