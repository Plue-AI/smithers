package compose

import (
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/stretchr/testify/require"
)

// Omission at the composition boundary must not launch a model with ambient
// authority. Only model responses and GitHub are scripted; repository context,
// prompt admission, journal, dispatcher and author authentication are real.
func TestBranchConversationUnavailableProviders(t *testing.T) {
	for _, missing := range []string{"delegated-issuer", "branch-membership", "context-reader", "model-assignment", "model-credential", "live-topics", "live-revocation"} {
		t.Run(missing, func(t *testing.T) {
			f := workingConversationWithContext(t, nil, func(local *localChat, options *chat.RuntimeOptions) {
				if missing == "delegated-issuer" {
					// Do not refill the intentionally missing issuer with the
					// local fixture's normal command API.
					local.omitCommandAPI = true
					options.API = nil
				}
				if missing == "live-topics" {
					local.configureExtras = func(extras *routerExtras) { extras.Live.Topics = nil }
				}
			})
			if missing == "live-topics" || missing == "live-revocation" {
				if missing == "live-revocation" {
					routes.SetRevocationSource(nil)
				}
				body := f.call(t, "ben", "GET", "/api/live", "", 503)
				require.Contains(t, string(body), "live_unavailable")
				require.NotContains(t, string(body), "Host answer.")
			} else if missing == "branch-membership" {
				f.local.composition.runtime.Handler.ResolveBranch = nil
				f.call(t, "ben", "GET", "/api/conversations/main", "", 503)
				f.call(t, "ben", "POST", "/api/conversations/main/prompt", `{"prompt":"must not run","idempotencyKey":"missing-branch"}`, 503)
				var count int
				require.NoError(t, f.local.pool.QueryRow(f.local.ctx, `SELECT count(*) FROM chat_turns`).Scan(&count))
				require.Zero(t, count)
			} else {
				if missing == "context-reader" {
					f.local.composition.runtime.Handler.ContextRepository = nil
				}
				if missing == "model-assignment" {
					_, err := f.local.pool.Exec(f.local.ctx, `DELETE FROM install_settings WHERE key LIKE 'agent:%'; DELETE FROM owner_model_defaults`)
					require.NoError(t, err)
				}
				if missing == "model-credential" {
					_, err := f.local.pool.Exec(f.local.ctx, `DELETE FROM owner_model_credentials`)
					require.NoError(t, err)
				}
				turn := f.prompt(t, "ben", "must not run")
				timeout := 20 * time.Second
				if missing == "context-reader" {
					// The packaged host refuses before provider startup, so the
					// dispatcher exhausts five attempts with 15s of backoff.
					// Leave time for host startup and recovery polling under load.
					timeout = time.Minute
				}
				f.terminal(t, turn, "failed", timeout)
				if missing == "context-reader" {
					var generation int64
					require.NoError(t, f.local.pool.QueryRow(f.local.ctx, `SELECT producer_generation FROM chat_turns WHERE id=$1`, turn).Scan(&generation))
					require.Equal(t, int64(5), generation, "missing context must exhaust the bounded retry policy without a model call")
				}
				if missing == "delegated-issuer" {
					body := string(f.call(t, "ben", "GET", "/api/conversations/main", "", 200))
					require.Contains(t, body, "credential_issuer_unavailable")
				}
			}
			f.mu.Lock()
			require.Empty(t, f.requests, "no omitted provider may spend on the model")
			f.mu.Unlock()
			require.Eventually(t, func() bool {
				var credentials int
				err := f.local.pool.QueryRow(f.local.ctx, `SELECT count(*) FROM access_tokens WHERE name LIKE 'app-turn-%'`).Scan(&credentials)
				return err == nil && credentials == 0
			}, 5*time.Second, 10*time.Millisecond)
		})
	}
}
