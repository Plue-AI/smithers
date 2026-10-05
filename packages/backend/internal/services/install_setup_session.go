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
	"io"
	"strings"
	"sync"
	"time"
)

// InstallSetupSessions uses the shared §5.1.0 install_settings namespace. Claim
// deletes these keys; an owner row also fences old sessions during claim rollout.
const installSetupOwnerLockID int64 = 3443
const installSetupTokenKey = "setup.token"

type installSetupContextKey struct{}

// WithInstallSetupSession carries a host-only cookie, never a URL credential.
func WithInstallSetupSession(ctx context.Context, session string) context.Context {
	return context.WithValue(ctx, installSetupContextKey{}, session)
}

type InstallSetupSessions struct {
	Pool   *pgxpool.Pool
	mu     sync.Mutex
	urls   []byte
	digest string
}

func (s *InstallSetupSessions) Exchange(ctx context.Context, token string) (string, error) {
	if s == nil || s.Pool == nil {
		return "", pkgerrors.Internal("setup session authority unavailable")
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", installSetupOwnerLockID); err != nil {
		return "", err
	}
	q := db.New(tx)
	if _, err := q.GetSelfHostOwner(ctx); !errors.Is(err, pgx.ErrNoRows) {
		if err != nil {
			return "", err
		}
		return "", pkgerrors.New(pkgerrors.CodeSetupClosed, "setup_closed")
	}
	setting, err := q.GetInstallSetting(ctx, installSetupTokenKey)
	if err != nil {
		return "", pkgerrors.New(pkgerrors.CodeUnauthenticated, "setup token required")
	}
	var expected string
	if err := json.Unmarshal(setting.Value, &expected); err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(token))
	if token == "" || subtle.ConstantTimeCompare([]byte(hex.EncodeToString(digest[:])), []byte(expected)) != 1 {
		return "", pkgerrors.New(pkgerrors.CodeUnauthenticated, "setup token required")
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	session := hex.EncodeToString(random)
	value, _ := json.Marshal(map[string]time.Time{"expires_at": time.Now().Add(24 * time.Hour)})
	err = q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.session." + GitHubAppStateDigest(session), Value: value})
	if err != nil {
		return "", err
	}
	return session, tx.Commit(ctx)
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

// Mint rotates only the durable token; existing setup sessions survive restart.
// The lock serializes startup against claim, and no URL is emitted before commit.
func (s *InstallSetupSessions) Mint(ctx context.Context, origins []string, output io.Writer) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", installSetupOwnerLockID); err != nil {
		return err
	}
	q := db.New(tx)
	if _, err := q.GetSelfHostOwner(ctx); !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return err
	}
	token := hex.EncodeToString(random)
	digest := sha256.Sum256([]byte(token))
	value, _ := json.Marshal(hex.EncodeToString(digest[:]))
	if err := q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: installSetupTokenKey, Value: value}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	urls := []string{"http://localhost:4000/setup?token=" + token}
	seen := map[string]bool{"http://localhost:4000": true}
	for _, origin := range origins {
		origin = strings.TrimRight(origin, "/")
		if origin != "" && !seen[origin] {
			urls = append(urls, origin+"/setup?token="+token)
			seen[origin] = true
		}
	}
	line, err := json.Marshal(map[string]any{"setup_urls": urls})
	if err != nil {
		return err
	}
	s.urls = append(line, '\n')
	s.digest = hex.EncodeToString(digest[:])
	return s.emitLocked(ctx, output)
}

// Emit replays only this process's committed URLs under the claim lock.
func (s *InstallSetupSessions) Emit(ctx context.Context, output io.Writer) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.emitLocked(ctx, output)
}
func (s *InstallSetupSessions) emitLocked(ctx context.Context, output io.Writer) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", installSetupOwnerLockID); err != nil {
		return err
	}
	q := db.New(tx)
	if _, err = q.GetSelfHostOwner(ctx); err == nil {
		s.urls = nil
		s.digest = ""
		return pkgerrors.New(pkgerrors.CodeSetupClosed, "setup_closed")
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	row, err := q.GetInstallSetting(ctx, installSetupTokenKey)
	if err != nil {
		return err
	}
	var digest string
	if err = json.Unmarshal(row.Value, &digest); err != nil {
		return err
	}
	if len(s.urls) == 0 || digest != s.digest {
		return pkgerrors.New(pkgerrors.CodeSetupClosed, "setup_closed")
	}
	_, err = output.Write(s.urls)
	return err
}

// ClaimOwner consumes setup authority and creates the person session in one commit.
func (s *InstallSetupSessions) ClaimOwner(ctx context.Context, user db.User, rawSession string, expires time.Time) (db.AuthSession, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return db.AuthSession{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", installSetupOwnerLockID); err != nil {
		return db.AuthSession{}, err
	}
	q := db.New(tx)
	setup, _ := ctx.Value(installSetupContextKey{}).(string)
	if _, err := q.GetSelfHostOwner(ctx); err == nil {
		if setup != "" {
			return db.AuthSession{}, pkgerrors.New(pkgerrors.CodeSetupClosed, "setup_closed")
		}
		owner, err := q.GetSelfHostOwner(ctx)
		if err != nil {
			return db.AuthSession{}, err
		}
		if owner.ID != user.ID {
			return db.AuthSession{}, pkgerrors.Forbidden("not a member")
		}
	} else if errors.Is(err, pgx.ErrNoRows) {
		if len(setup) != 64 {
			return db.AuthSession{}, pkgerrors.New(pkgerrors.CodeUnauthenticated, "setup session required")
		}
		var live bool
		err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM install_settings WHERE key=$1 AND (value->>'expires_at')::timestamptz>now())`, "setup.session."+GitHubAppStateDigest(setup)).Scan(&live)
		if err != nil {
			return db.AuthSession{}, err
		}
		if !live {
			return db.AuthSession{}, pkgerrors.New(pkgerrors.CodeUnauthenticated, "invalid or expired setup session")
		}
		result, err := tx.Exec(ctx, `DELETE FROM install_settings WHERE key=$1`, installSetupTokenKey)
		if err != nil {
			return db.AuthSession{}, err
		}
		if result.RowsAffected() != 1 {
			return db.AuthSession{}, pkgerrors.New(pkgerrors.CodeSetupClosed, "setup_closed")
		}
		if _, err = tx.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, user.ID); err != nil {
			return db.AuthSession{}, err
		}
		// Existing repositories gain the same admin permission the password owner used.
		if _, err = tx.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) SELECT id,$1,'admin' FROM repositories ON CONFLICT(repository_id,user_id) WHERE user_id IS NOT NULL DO UPDATE SET permission='admin'`, user.ID); err != nil {
			return db.AuthSession{}, err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM install_settings WHERE key LIKE 'setup.session.%'`); err != nil {
			return db.AuthSession{}, err
		}
	} else {
		return db.AuthSession{}, err
	}
	session, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: sessionStorageKey(rawSession), UserID: user.ID, Username: user.Username, IsAdmin: user.IsAdmin, ExpiresAt: expires})
	if err != nil {
		return db.AuthSession{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return db.AuthSession{}, err
	}
	s.mu.Lock()
	s.urls = nil
	s.digest = ""
	s.mu.Unlock()
	return session, nil
}

// FailSignIn records a refused pre-claim sign-in on the Setup card's sign_in
// step. Only the live setup session writes it; a claimed install refuses.
func (s *InstallSetupSessions) FailSignIn(ctx context.Context, setup string, failure *InstallReadinessError) error {
	if err := s.Validate(ctx, setup); err != nil {
		return err
	}
	value, err := json.Marshal(InstallStep{ID: "sign_in", Status: InstallFailed, Error: failure})
	if err != nil {
		return err
	}
	return db.New(s.Pool).UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.step.sign_in", Value: value})
}

// AdmitOAuth refuses pre-claim sign-in before GitHub or identity writes.
func (s *InstallSetupSessions) AdmitOAuth(ctx context.Context, setup string) error {
	_, err := db.New(s.Pool).GetSelfHostOwner(ctx)
	if err == nil {
		if setup != "" {
			return pkgerrors.New(pkgerrors.CodeSetupClosed, "setup_closed")
		}
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	return s.Validate(ctx, setup)
}

type githubRedirectKey struct{}

func WithGitHubRedirectURI(ctx context.Context, uri string) context.Context {
	return context.WithValue(ctx, githubRedirectKey{}, uri)
}
func GitHubRedirectURI(ctx context.Context) string {
	uri, _ := ctx.Value(githubRedirectKey{}).(string)
	return uri
}
