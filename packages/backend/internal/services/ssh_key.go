package services

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	stdErrors "errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/ssh"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

type SSHKeyQuerier interface {
	ListUserSSHKeys(ctx context.Context, userID int64) ([]db.SshKey, error)
	CreateSSHKey(ctx context.Context, arg db.CreateSSHKeyParams) (db.SshKey, error)
	GetSSHKeyByID(ctx context.Context, id int64) (db.SshKey, error)
	GetSSHKeyByFingerprint(ctx context.Context, fingerprint string) (db.SshKey, error)
	DeleteSSHKey(ctx context.Context, arg db.DeleteSSHKeyParams) error
}

type SSHKeyService struct {
	queries     SSHKeyQuerier
	revocations revocation.Publisher
}

type CreateSSHKeyRequest struct {
	Title string `json:"title"`
	Key   string `json:"key"`
}

type SSHKeyResponse struct {
	Source      string    `json:"source"`
	ID          int64     `json:"id"`
	Name        string    `json:"name"`
	Fingerprint string    `json:"fingerprint"`
	KeyType     string    `json:"key_type"`
	CreatedAt   time.Time `json:"created_at"`
}

func NewSSHKeyService(q SSHKeyQuerier) *SSHKeyService {
	return &SSHKeyService{queries: q}
}

func (s *SSHKeyService) ListKeys(ctx context.Context, userID int64) ([]SSHKeyResponse, error) {
	if userID <= 0 {
		return nil, pkgerrors.BadRequest("invalid user")
	}

	keys, err := s.queries.ListUserSSHKeys(ctx, userID)
	if err != nil {
		return nil, pkgerrors.Internal("failed to list ssh keys").WithCause(err)
	}

	result := make([]SSHKeyResponse, 0, len(keys))
	for _, key := range keys {
		if key.UserID != userID {
			continue
		}
		result = append(result, mapSSHKeyResponse(key))
	}

	return result, nil
}

func (s *SSHKeyService) GetKeyByID(ctx context.Context, userID int64, keyID int64) (SSHKeyResponse, error) {
	if userID <= 0 {
		return SSHKeyResponse{}, pkgerrors.BadRequest("invalid user")
	}
	if keyID <= 0 {
		return SSHKeyResponse{}, pkgerrors.BadRequest("invalid ssh key id")
	}

	key, err := s.queries.GetSSHKeyByID(ctx, keyID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return SSHKeyResponse{}, pkgerrors.NotFound("ssh key not found")
		}
		return SSHKeyResponse{}, pkgerrors.Internal("failed to load ssh key").WithCause(err)
	}

	if key.UserID != userID {
		return SSHKeyResponse{}, pkgerrors.NotFound("ssh key not found")
	}

	return mapSSHKeyResponse(key), nil
}

func (s *SSHKeyService) CreateKey(ctx context.Context, userID int64, req CreateSSHKeyRequest) (SSHKeyResponse, error) {
	if userID <= 0 {
		return SSHKeyResponse{}, pkgerrors.BadRequest("invalid user")
	}

	title := strings.TrimSpace(req.Title)
	if title == "" {
		return SSHKeyResponse{}, validationFieldError("title", "missing_field")
	}
	if len(title) > 255 {
		return SSHKeyResponse{}, validationFieldError("title", "invalid")
	}

	rawKey := strings.TrimSpace(req.Key)
	if rawKey == "" {
		return SSHKeyResponse{}, validationFieldError("key", "missing_field")
	}

	publicKey, canonicalKey, err := parseAuthorizedKey(rawKey)
	if err != nil {
		return SSHKeyResponse{}, validationFieldError("key", "invalid")
	}

	if err := validatePublicKey(publicKey); err != nil {
		return SSHKeyResponse{}, validationFieldError("key", "invalid")
	}

	fingerprint := fingerprintSHA256(publicKey)
	if _, err := s.queries.GetSSHKeyByFingerprint(ctx, fingerprint); err == nil {
		return SSHKeyResponse{}, pkgerrors.Conflict("ssh key already registered")
	} else if !stdErrors.Is(err, pgx.ErrNoRows) {
		return SSHKeyResponse{}, pkgerrors.Internal("failed to check duplicate ssh key")
	}

	if err := validateSafeText("SSHKey", "title", title); err != nil {
		return SSHKeyResponse{}, err
	}
	created, err := s.queries.CreateSSHKey(ctx, db.CreateSSHKeyParams{
		UserID:      userID,
		Name:        title,
		PublicKey:   canonicalKey,
		Fingerprint: fingerprint,
		KeyType:     normalizeKeyType(publicKey),
	})
	if err != nil {
		if isSSHKeyUniqueViolation(err) {
			return SSHKeyResponse{}, pkgerrors.Conflict("ssh key already registered")
		}
		return SSHKeyResponse{}, pkgerrors.Internal("failed to create ssh key").WithCause(err)
	}

	return mapSSHKeyResponse(created), nil
}

func (s *SSHKeyService) DeleteKey(ctx context.Context, userID int64, keyID int64) error {
	if userID <= 0 {
		return pkgerrors.BadRequest("invalid user")
	}
	if keyID <= 0 {
		return pkgerrors.BadRequest("invalid ssh key id")
	}

	key, err := s.queries.GetSSHKeyByID(ctx, keyID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("ssh key not found")
		}
		return pkgerrors.Internal("failed to load ssh key").WithCause(err)
	}
	if key.UserID != userID {
		return pkgerrors.NotFound("ssh key not found")
	}

	if err := s.queries.DeleteSSHKey(ctx, db.DeleteSSHKeyParams{ID: keyID, UserID: userID}); err != nil {
		return pkgerrors.Internal("failed to delete ssh key").WithCause(err)
	}

	// End every live SSH session this key authenticated.
	revocation.PublishBestEffort(ctx, s.revocations, revocation.Event{
		Kind:           revocation.KindSSHKeyRevoked,
		UserID:         userID,
		KeyFingerprint: key.Fingerprint,
		Reason:         "ssh key deleted",
		ActorID:        userID,
	})
	return nil
}

func parseAuthorizedKey(raw string) (ssh.PublicKey, string, error) {
	keyData := strings.TrimSpace(raw)
	if keyData == "" {
		return nil, "", fmt.Errorf("empty key")
	}

	publicKey, _, _, rest, err := ssh.ParseAuthorizedKey([]byte(keyData))
	if err != nil {
		return nil, "", err
	}
	if strings.TrimSpace(string(rest)) != "" {
		return nil, "", fmt.Errorf("multiple keys are not allowed")
	}

	canonical := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(publicKey)))
	return publicKey, canonical, nil
}

func fingerprintSHA256(pub ssh.PublicKey) string {
	hash := sha256.Sum256(pub.Marshal())
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(hash[:])
}

func validatePublicKey(pub ssh.PublicKey) error {
	cryptoPub, ok := pub.(ssh.CryptoPublicKey)
	if !ok {
		return fmt.Errorf("unsupported key type")
	}

	switch typed := cryptoPub.CryptoPublicKey().(type) {
	case *ecdsa.PublicKey:
		switch typed.Curve {
		case elliptic.P256(), elliptic.P384(), elliptic.P521():
			return nil
		default:
			return fmt.Errorf("unsupported ecdsa curve")
		}
	case *rsa.PublicKey:
		if typed.N.BitLen() < 2048 {
			return fmt.Errorf("rsa keys must be at least 2048 bits")
		}
		return nil
	}

	if pub.Type() == ssh.KeyAlgoED25519 {
		return nil
	}

	return fmt.Errorf("unsupported key type")
}

func normalizeKeyType(pub ssh.PublicKey) string {
	// For MVP user keys we persist the parsed algorithm string (e.g. ssh-ed25519).
	return pub.Type()
}

func mapSSHKeyResponse(key db.SshKey) SSHKeyResponse {
	return SSHKeyResponse{
		ID:          key.ID,
		Source:      key.Source,
		Name:        key.Name,
		Fingerprint: key.Fingerprint,
		KeyType:     key.KeyType,
		CreatedAt:   key.CreatedAt,
	}
}

func validationFieldError(field, code string) error {
	return pkgerrors.ValidationFailed(pkgerrors.FieldError{
		Resource: "SSHKey",
		Field:    field,
		Code:     code,
	})
}

func isSSHKeyUniqueViolation(err error) bool {
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
