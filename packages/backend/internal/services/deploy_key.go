package services

import (
	"context"
	stdErrors "errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

type DeployKeyQuerier interface {
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	CreateDeployKey(ctx context.Context, arg db.CreateDeployKeyParams) (db.DeployKey, error)
	GetDeployKeyByID(ctx context.Context, id int64) (db.DeployKey, error)
	GetDeployKeyByFingerprint(ctx context.Context, arg db.GetDeployKeyByFingerprintParams) (db.DeployKey, error)
	ListDeployKeysByRepo(ctx context.Context, repositoryID int64) ([]db.DeployKey, error)
	DeleteDeployKey(ctx context.Context, id int64) error
}

type DeployKeyService struct {
	install         *installDeployKeyStore
	installAdmitted bool
	queries         DeployKeyQuerier
	revocations     revocation.Publisher
}

type CreateDeployKeyRequest struct {
	Title    string `json:"title"`
	Key      string `json:"key"`
	ReadOnly bool   `json:"read_only"`
}

type DeployKeyResponse struct {
	ID             int64      `json:"id"`
	Title          string     `json:"title"`
	KeyFingerprint string     `json:"key_fingerprint"`
	PublicKey      string     `json:"public_key"`
	KeyType        string     `json:"key_type"`
	ReadOnly       bool       `json:"read_only"`
	LastUsedAt     *time.Time `json:"last_used_at,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
}

func NewDeployKeyService(q DeployKeyQuerier, options ...DeployKeyServiceOption) *DeployKeyService {
	s := &DeployKeyService{queries: q}
	for _, option := range options {
		option(s)
	}
	return s
}

func (s *DeployKeyService) ListDeployKeys(ctx context.Context, owner, repo string) ([]DeployKeyResponse, error) {
	if s.install != nil && !s.installAdmitted {
		return withInstallDeployKey(s, ctx, owner, repo, "deploy-keys.read", 0, struct{}{}, func(scoped *DeployKeyService, ctx context.Context) ([]DeployKeyResponse, error) {
			return scoped.ListDeployKeys(ctx, owner, repo)
		})
	}
	repository, err := s.loadRepository(ctx, owner, repo)
	if err != nil {
		return nil, err
	}

	keys, err := s.queries.ListDeployKeysByRepo(ctx, repository.ID)
	if err != nil {
		return nil, pkgerrors.Internal("failed to list deploy keys").WithCause(err)
	}

	result := make([]DeployKeyResponse, 0, len(keys))
	for _, key := range keys {
		result = append(result, mapDeployKeyResponse(key))
	}
	return result, nil
}

func (s *DeployKeyService) CreateDeployKey(ctx context.Context, owner, repo string, req CreateDeployKeyRequest) (DeployKeyResponse, error) {
	if s.install != nil && !s.installAdmitted {
		return withInstallDeployKey(s, ctx, owner, repo, "deploy-keys.create", 0, req, func(scoped *DeployKeyService, ctx context.Context) (DeployKeyResponse, error) {
			return scoped.CreateDeployKey(ctx, owner, repo, req)
		})
	}
	repository, err := s.loadRepository(ctx, owner, repo)
	if err != nil {
		return DeployKeyResponse{}, err
	}

	title := strings.TrimSpace(req.Title)
	if title == "" {
		return DeployKeyResponse{}, deployKeyValidationFieldError("title", "missing_field")
	}
	if len(title) > 255 {
		return DeployKeyResponse{}, deployKeyValidationFieldError("title", "invalid")
	}

	rawKey := strings.TrimSpace(req.Key)
	if rawKey == "" {
		return DeployKeyResponse{}, deployKeyValidationFieldError("key", "missing_field")
	}

	publicKey, canonicalKey, err := parseAuthorizedKey(rawKey)
	if err != nil {
		return DeployKeyResponse{}, deployKeyValidationFieldError("key", "invalid")
	}
	if err := validatePublicKey(publicKey); err != nil {
		return DeployKeyResponse{}, deployKeyValidationFieldError("key", "invalid")
	}

	fingerprint := fingerprintSHA256(publicKey)
	if _, err := s.queries.GetDeployKeyByFingerprint(ctx, db.GetDeployKeyByFingerprintParams{
		RepositoryID:   repository.ID,
		KeyFingerprint: fingerprint,
	}); err == nil {
		return DeployKeyResponse{}, pkgerrors.Conflict("deploy key already registered")
	} else if !stdErrors.Is(err, pgx.ErrNoRows) {
		return DeployKeyResponse{}, pkgerrors.Internal("failed to check duplicate deploy key")
	}

	created, err := s.queries.CreateDeployKey(ctx, db.CreateDeployKeyParams{
		RepositoryID:   repository.ID,
		Title:          title,
		KeyFingerprint: fingerprint,
		PublicKey:      canonicalKey,
		ReadOnly:       req.ReadOnly,
	})
	if err != nil {
		if isDeployKeyUniqueViolation(err) {
			return DeployKeyResponse{}, pkgerrors.Conflict("deploy key already registered")
		}
		return DeployKeyResponse{}, pkgerrors.Internal("failed to create deploy key").WithCause(err)
	}

	return mapDeployKeyResponse(created), nil
}

func (s *DeployKeyService) DeleteDeployKey(ctx context.Context, owner, repo string, keyID int64) error {
	if s.install != nil && !s.installAdmitted {
		_, err := withInstallDeployKey(s, ctx, owner, repo, "deploy-keys.delete", keyID, struct{}{}, func(scoped *DeployKeyService, ctx context.Context) (struct{}, error) {
			return struct{}{}, scoped.DeleteDeployKey(ctx, owner, repo, keyID)
		})
		return err
	}
	if keyID <= 0 {
		return pkgerrors.BadRequest("invalid deploy key id")
	}

	repository, err := s.loadRepository(ctx, owner, repo)
	if err != nil {
		return err
	}

	key, err := s.queries.GetDeployKeyByID(ctx, keyID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("deploy key not found")
		}
		return pkgerrors.Internal("failed to load deploy key").WithCause(err)
	}
	if key.RepositoryID != repository.ID {
		return pkgerrors.NotFound("deploy key not found")
	}

	if err := s.queries.DeleteDeployKey(ctx, keyID); err != nil {
		return pkgerrors.Internal("failed to delete deploy key").WithCause(err)
	}

	// End every live SSH git session this deploy key authenticated.
	event := revocation.Event{
		Kind:           revocation.KindSSHKeyRevoked,
		RepositoryID:   repository.ID,
		KeyFingerprint: key.KeyFingerprint,
		Reason:         "deploy key deleted",
	}
	if s.installAdmitted {
		return s.revocations.Publish(ctx, event)
	}
	revocation.PublishBestEffort(ctx, s.revocations, event)
	return nil
}

func (s *DeployKeyService) loadRepository(ctx context.Context, owner, repo string) (db.Repository, error) {
	repository, err := s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
		Owner:     strings.TrimSpace(owner),
		LowerName: strings.ToLower(strings.TrimSpace(repo)),
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Repository{}, pkgerrors.NotFound("repository")
		}
		return db.Repository{}, pkgerrors.Internal("failed to load repository").WithCause(err)
	}
	return repository, nil
}

func mapDeployKeyResponse(key db.DeployKey) DeployKeyResponse {
	response := DeployKeyResponse{
		ID:             key.ID,
		Title:          key.Title,
		KeyFingerprint: key.KeyFingerprint,
		PublicKey:      key.PublicKey,
		KeyType:        authorizedKeyType(key.PublicKey),
		ReadOnly:       key.ReadOnly,
		CreatedAt:      key.CreatedAt,
	}
	if key.LastUsedAt.Valid {
		t := key.LastUsedAt.Time
		response.LastUsedAt = &t
	}
	return response
}

func authorizedKeyType(raw string) string {
	fields := strings.Fields(strings.TrimSpace(raw))
	if len(fields) == 0 {
		return "unknown"
	}
	return fields[0]
}

func deployKeyValidationFieldError(field, code string) error {
	return pkgerrors.ValidationFailed(pkgerrors.FieldError{
		Resource: "DeployKey",
		Field:    field,
		Code:     code,
	})
}

func isDeployKeyUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if stdErrors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	lower := strings.ToLower(err.Error())
	return strings.Contains(lower, "duplicate key") || strings.Contains(lower, "unique")
}
