package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestSettingsHealthInstallHTTPPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	owner, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: "settingsowner", LowerUsername: "settingsowner"})
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	digest := sha256.Sum256([]byte("settings-owner-session"))
	_, err = q.CreateAuthSession(t.Context(), db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(digest[:]), UserID: owner.ID, Username: owner.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	setup := &services.InstallSetupService{Pool: pool, Capacity: &services.InstallCapacityService{Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, DiskFreeBytes: 200 << 30, PerfCores: 8}}}
	require.NoError(t, setup.Initialize(t.Context()))
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	server.Config.Handler = githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{Setup: setup, Owners: q, Origins: middleware.FixedOrigins(origin)})
	server.Start()
	defer server.Close()
	retry := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name, state, cause, process string
		fail                        bool
	}{
		{"limited", "limited", "rate_limited", "ok", false},
		{"refused", "refused", "permission", "ok", false},
		{"failed read", "stale", "sync read failed", "degraded", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			setup.SyncHealth = func(context.Context) (services.GitHubSyncHealth, error) {
				if test.fail {
					return services.GitHubSyncHealth{}, errors.New(test.cause)
				}
				return services.GitHubSyncHealth{State: test.state, Cause: test.cause, RetryAt: &retry}, nil
			}
			request, err := http.NewRequest("GET", origin+"/api/install", nil)
			require.NoError(t, err)
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "settings-owner-session"})
			response, err := http.DefaultClient.Do(request)
			require.NoError(t, err)
			defer response.Body.Close()
			var result struct {
				Health struct {
					Process       string         `json:"process"`
					PostgresBytes int64          `json:"postgres_bytes"`
					Disk          float64        `json:"disk_free_gb"`
					GitHub        map[string]any `json:"github"`
				} `json:"health"`
			}
			require.NoError(t, json.NewDecoder(response.Body).Decode(&result))
			require.Equal(t, 200, response.StatusCode)
			require.Equal(t, test.process, result.Health.Process)
			require.Positive(t, result.Health.PostgresBytes)
			require.Equal(t, float64(200), result.Health.Disk)
			require.Equal(t, test.state, result.Health.GitHub["health"])
			require.Equal(t, test.cause, result.Health.GitHub["cause"])
			require.NotContains(t, result.Health.GitHub, "rate_remaining")
			require.NotContains(t, result.Health.GitHub, "rate_limit")
			if !test.fail {
				require.Equal(t, "2026-10-06T12:00:00Z", result.Health.GitHub["retry_at"])
			}
		})
	}
}
