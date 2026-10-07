package compose

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/stretchr/testify/require"
)

// Omission at the composition boundary must not launch a model with ambient
// authority. Only repository context and model responses are scripted here;
// prompt admission, journal, dispatcher and author authentication are real.
func TestBranchConversationUnavailableProviders(t *testing.T) {
	for _, missing := range []string{"delegated-issuer", "branch-membership", "context-reader", "model-assignment", "model-credential", "live-topics", "live-revocation"} {
		t.Run(missing, func(t *testing.T) {
			f := workingConversationWithContext(t, func(context.Context, middleware.Credential, int64, int64, string) (json.RawMessage, error) {
				return json.RawMessage(`{"state":"main","candidates":[],"tokenBudget":24000}`), nil
			}, func(local *localChat, options *chat.RuntimeOptions) {
				if missing == "delegated-issuer" {
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
				f.terminal(t, turn, "failed", 20*time.Second)
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
