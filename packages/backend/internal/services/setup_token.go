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
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// setupTokenKey names the install_settings row holding the one-time setup
// token's digest (spec §5.1.0). The raw token is never stored.
const setupTokenKey = "setup_token"

type setupTokenSetting struct {
	Digest string `json:"digest"`
}

// SetupTokenQuerier stores the setup token's digest.
type SetupTokenQuerier interface {
	InstallHasOwner(ctx context.Context) (bool, error)
	PutInstallSetting(ctx context.Context, arg db.PutInstallSettingParams) error
	DeleteInstallSetting(ctx context.Context, key string) (int64, error)
}

// MintSetupToken gives an install without an owner a fresh one-time setup
// token and stores only its digest, replacing any earlier one: the raw value
// is shown once, so a restart before the claim issues a new token. Once an
// owner exists no token exists, and MintSetupToken returns "".
func MintSetupToken(ctx context.Context, queries SetupTokenQuerier) (string, error) {
	hasOwner, err := queries.InstallHasOwner(ctx)
	if err != nil {
		return "", fmt.Errorf("read install owner: %w", err)
	}
	if hasOwner {
		if _, err := queries.DeleteInstallSetting(ctx, setupTokenKey); err != nil {
			return "", fmt.Errorf("delete setup token: %w", err)
		}
		return "", nil
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate setup token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	value, err := json.Marshal(setupTokenSetting{Digest: SetupTokenDigest(token)})
	if err != nil {
		return "", err
	}
	if err := queries.PutInstallSetting(ctx, db.PutInstallSettingParams{Key: setupTokenKey, Value: value}); err != nil {
		return "", fmt.Errorf("store setup token digest: %w", err)
	}
	return token, nil
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
