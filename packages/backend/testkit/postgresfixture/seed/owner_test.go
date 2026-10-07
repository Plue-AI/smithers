package seed_test

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture/seed"
	"github.com/stretchr/testify/require"
)

func TestOwnerTokenPrerequisite(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	token, err := seed.OwnerToken(ctx, pool, "owner")
	require.NoError(t, err)
	digest := sha256.Sum256([]byte(token))
	row, err := db.New(pool).GetAuthInfoByTokenHash(ctx, hex.EncodeToString(digest[:]))
	require.NoError(t, err)
	require.Equal(t, "owner", row.Username)
	owner, err := db.New(pool).GetSelfHostOwner(ctx)
	require.NoError(t, err)
	require.Equal(t, "owner", owner.Username)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key IN ('github.repository','owner.access')`).Scan(&count))
	require.Equal(t, 2, count)
}

// The fixture must authenticate through the real HTTP boundary, not merely
// match its own hash in the database.
func TestOwnerTokenAuthenticatesRequests(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	token, err := seed.OwnerToken(t.Context(), pool, "httpowner")
	require.NoError(t, err)

	for _, scheme := range []string{"token", "Bearer"} {
		t.Run(scheme, func(t *testing.T) {
			handler := middleware.AuthLoader(db.New(pool), config.AuthConfig{Mode: "selfhost"})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				user := middleware.UserFromContext(r.Context())
				require.NotNil(t, user)
				require.Equal(t, "httpowner", user.Username)
				require.True(t, user.IsAdmin)
				w.WriteHeader(http.StatusNoContent)
			}))
			req := httptest.NewRequest(http.MethodGet, "/api/user", nil)
			req.Header.Set("Authorization", scheme+" "+token)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, req)
			require.Equal(t, http.StatusNoContent, response.Code, response.Body.String())
		})
	}
}
