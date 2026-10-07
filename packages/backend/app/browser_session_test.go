package app_test

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// Owner identity and live access have already been seeded. Sign-in itself is
// covered by the owner OAuth integration tests; these tests exercise app actions.
func ownerBrowserSession(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	q := db.New(pool)
	owner, err := q.GetSelfHostOwner(t.Context())
	require.NoError(t, err)
	raw := make([]byte, 32)
	_, err = rand.Read(raw)
	require.NoError(t, err)
	session := hex.EncodeToString(raw)
	digest := sha256.Sum256([]byte(session))
	_, err = q.CreateAuthSession(t.Context(), db.CreateAuthSessionParams{
		UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	return session
}

func attachBrowserSession(r *http.Request, session string) {
	r.AddCookie(&http.Cookie{Name: "smithers_session", Value: session})
	r.AddCookie(&http.Cookie{Name: "__csrf", Value: "app-fixture-csrf"})
	r.Header.Set("X-CSRF-Token", "app-fixture-csrf")
	r.Header.Set("Origin", "http://127.0.0.1:4000")
}
