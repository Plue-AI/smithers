// Package turncredential is a hosted chat turn's platform-model credential.
// It is a leaf so the metered model proxy can verify it without importing
// the chat journal.
package turncredential

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Prefix marks a chat turn's platform-model credential.
const Prefix = "smithers_chatturn_"

// ErrInvalid refuses a credential that names no live producer generation or
// does not match it.
var ErrInvalid = errors.New("chat turn model credential is invalid")

// Mint is the credential one producer generation of a turn spends managed
// models with through the metered proxy: an HMAC keyed by the producer
// token's stored hash. It grants no producer control, and reclaiming the
// turn rotates the token, so an earlier generation's credential stops
// verifying.
func Mint(turnID string, generation int64, producerToken string) string {
	sum := sha256.Sum256([]byte(producerToken))
	return mint(turnID, generation, hex.EncodeToString(sum[:]))
}

func mint(turnID string, generation int64, tokenHash string) string {
	mac := hmac.New(sha256.New, []byte(tokenHash))
	mac.Write([]byte("smithers-model-proxy:" + turnID + ":" + strconv.FormatInt(generation, 10)))
	return Prefix + turnID + "." + strconv.FormatInt(generation, 10) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Turn is the running turn a credential belongs to.
type Turn struct {
	TurnID       string
	UserID       int64
	RepositoryID int64
}

// Verify resolves a credential to its turn. Only the current producer
// generation of a running turn whose lease is live and whose cancellation is
// not requested verifies.
func Verify(ctx context.Context, pool *pgxpool.Pool, token string) (Turn, error) {
	rest, ok := strings.CutPrefix(token, Prefix)
	if !ok || pool == nil {
		return Turn{}, ErrInvalid
	}
	parts := strings.Split(rest, ".")
	if len(parts) != 3 || parts[2] == "" {
		return Turn{}, ErrInvalid
	}
	generation, err := strconv.ParseInt(parts[1], 10, 64)
	if _, uuidErr := uuid.Parse(parts[0]); uuidErr != nil || err != nil || generation <= 0 {
		return Turn{}, ErrInvalid
	}
	out := Turn{TurnID: parts[0]}
	var tokenHash string
	err = pool.QueryRow(ctx, `SELECT user_id, repository_id, producer_token_hash FROM chat_turns
		WHERE id=$1 AND producer_generation=$2 AND state='running' AND NOT terminal AND cancel_requested_at IS NULL
		AND producer_token_hash IS NOT NULL AND producer_lease_expires_at>$3`, out.TurnID, generation, time.Now().UTC()).
		Scan(&out.UserID, &out.RepositoryID, &tokenHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return Turn{}, ErrInvalid
	}
	if err != nil {
		return Turn{}, err
	}
	if !hmac.Equal([]byte(token), []byte(mint(out.TurnID, generation, tokenHash))) {
		return Turn{}, ErrInvalid
	}
	return out, nil
}
