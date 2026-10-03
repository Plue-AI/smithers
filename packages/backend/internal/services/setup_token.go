package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// setupTokenKey names the install_settings row holding the one-time setup
// token's digest (spec §5.1.0). The raw token is never stored.
const setupTokenKey = "setup_token"

// InstallPublicOriginsKey holds the JSON array shared with address settings (T-INS-04).
const InstallPublicOriginsKey = "public_origins"

type setupTokenSetting struct {
	Digest string `json:"digest"`
}

// installSetupOwnerLockID serializes token rotation, terminal emission and claim.
const installSetupOwnerLockID int64 = 0x534d544853455455

type setupTokenBeginner interface {
	Begin(context.Context) (pgx.Tx, error)
}

// MintSetupToken commits a fresh digest only while the install is unclaimed.
func MintSetupToken(ctx context.Context, pool setupTokenBeginner) (string, error) {
	var token string
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", installSetupOwnerLockID); err != nil {
			return err
		}
		q := db.New(tx)
		hasOwner, err := q.InstallHasOwner(ctx)
		if err != nil {
			return fmt.Errorf("read install owner: %w", err)
		}
		if hasOwner {
			return nil
		}
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			return fmt.Errorf("generate setup token: %w", err)
		}
		token = base64.RawURLEncoding.EncodeToString(raw)
		value, err := json.Marshal(setupTokenSetting{Digest: SetupTokenDigest(token)})
		if err != nil {
			return err
		}
		return q.PutInstallSetting(ctx, db.PutInstallSettingParams{Key: setupTokenKey, Value: value})
	})
	if err != nil {
		return "", err
	}
	return token, nil
}

// EmitSetupURLs holds the same lock through the post-commit write. A transaction
// lock alone would leave a window for claim to commit before stdout emission.
func EmitSetupURLs(ctx context.Context, pool *pgxpool.Pool, stdout io.Writer) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", installSetupOwnerLockID); err != nil {
		_ = conn.Conn().Close(context.Background())
		return err
	}
	defer func() {
		// Never return a session-locked connection to the pool after cancellation.
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := conn.Exec(cleanup, "SELECT pg_advisory_unlock($1)", installSetupOwnerLockID); err != nil {
			_ = conn.Conn().Close(context.Background())
		}
	}()
	origins := []string{}
	value, err := db.New(conn).GetInstallSetting(ctx, InstallPublicOriginsKey)
	if err != nil && err != pgx.ErrNoRows {
		return err
	}
	if err == nil {
		if err := json.Unmarshal(value, &origins); err != nil {
			return fmt.Errorf("read public origins: %w", err)
		}
	}
	token, err := MintSetupToken(ctx, conn)
	if err != nil {
		return err
	}
	if token == "" {
		return nil
	}
	urls := []string{"http://localhost:4000/setup?token=" + token}
	for _, origin := range origins {
		urls = append(urls, strings.TrimRight(origin, "/")+"/setup?token="+token)
	}
	line, err := json.Marshal(struct {
		URLs []string `json:"setup_urls"`
	}{urls})
	if err != nil {
		return err
	}
	n, err := fmt.Fprintf(stdout, "%s\n", line)
	if err == nil && n != len(line)+1 {
		return io.ErrShortWrite
	}
	return err
}

// SetupTokenDigest is the stored and carried form of a setup token: the
// lowercase hex SHA-256 of the token as printed.
func SetupTokenDigest(token string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(token)))
	return hex.EncodeToString(sum[:])
}

// setupTokenMatches compares a carried digest with the stored setting in
// constant time.
func setupTokenMatches(stored []byte, digest string) bool {
	var setting setupTokenSetting
	if json.Unmarshal(stored, &setting) != nil || setting.Digest == "" || digest == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(setting.Digest), []byte(digest)) == 1
}

// errSetupTokenInvalid refuses a claim without the current setup token.
func errSetupTokenInvalid() *pkgerrors.APIError {
	return pkgerrors.New(pkgerrors.CodeSetupTokenInvalid, "open the setup URL printed when the install started to claim it")
}
