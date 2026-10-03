package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"time"
)

// InstallSetupSessions uses the shared §5.1.0 install_settings namespace. Claim
// deletes these keys; an owner row also fences old sessions during claim rollout.
type InstallSetupSessions struct {
	Pool        *pgxpool.Pool
	TokenDigest [32]byte
}

func (s *InstallSetupSessions) Exchange(ctx context.Context, token string) (string, error) {
	if s == nil || s.Pool == nil {
		return "", pkgerrors.Internal("setup session authority unavailable")
	}
	digest := sha256.Sum256([]byte(token))
	if token == "" || s.TokenDigest == ([32]byte{}) || subtle.ConstantTimeCompare(digest[:], s.TokenDigest[:]) != 1 {
		return "", pkgerrors.Unauthorized("setup token required")
	}
	if _, err := db.New(s.Pool).GetSelfHostOwner(ctx); !errors.Is(err, pgx.ErrNoRows) {
		if err != nil {
			return "", err
		}
		return "", pkgerrors.New(pkgerrors.CodeSetupClosed, "setup_closed")
	}
	random := make([]byte, 32)
	rand.Read(random)
	session := hex.EncodeToString(random)
	value, _ := json.Marshal(map[string]time.Time{"expires_at": time.Now().Add(24 * time.Hour)})
	err := db.New(s.Pool).UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.session." + GitHubAppStateDigest(session), Value: value})
	return session, err
}
func (s *InstallSetupSessions) Validate(ctx context.Context, session string) error {
	if s == nil || s.Pool == nil {
		return pkgerrors.Internal("setup session authority unavailable")
	}
	if len(session) != 64 {
		return pkgerrors.New(pkgerrors.CodeUnauthenticated, "setup session required")
	}
	q := db.New(s.Pool)
	if _, err := q.GetSelfHostOwner(ctx); !errors.Is(err, pgx.ErrNoRows) {
		if err != nil {
			return err
		}
		return pkgerrors.New(pkgerrors.CodeSetupClosed, "setup_closed")
	}
	// Atomic sliding expiry: deleted, expired and claim-invalidated keys cannot
	// be recreated by a request holding an old cookie.
	result, err := s.Pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_build_object('expires_at',now()+interval '24 hours'),updated_at=now() WHERE key=$1 AND (value->>'expires_at')::timestamptz > now()`, "setup.session."+GitHubAppStateDigest(session))
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return pkgerrors.New(pkgerrors.CodeUnauthenticated, "invalid or expired setup session")
	}
	return nil
}
