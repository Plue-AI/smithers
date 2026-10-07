package compose

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

// This is packaged model-host / HTTP credential lifecycle evidence, not native
// repository-context evidence. Only the repository context and model response
// are scripted; admission, issuer, process host, dispatcher and PostgreSQL are
// the same paths a member's shared conversation uses.
func TestTurnCredentialPackagedHostLifecyclePostgres(t *testing.T) {
	for _, outcome := range []string{"completion", "provider-failure", "author-removal"} {
		t.Run(outcome, func(t *testing.T) {
			f := workingConversationWithContext(t, func(context.Context, middleware.Credential, int64, int64, string) (json.RawMessage, error) {
				return json.RawMessage(`{"state":"main","candidates":[],"tokenBudget":24000}`), nil
			})
			prompt := "SLOW"
			if outcome == "provider-failure" {
				prompt += " FAIL"
			}
			turn := f.prompt(t, "alice", prompt)
			select {
			case <-f.slow:
			case <-time.After(20 * time.Second):
				t.Fatal(f.local.logs.String())
			}
			name := "app-turn-" + turn + "/1"
			var scopes, author string
			var expires time.Time
			var issued bool
			require.NoError(t, f.local.pool.QueryRow(f.local.ctx, `SELECT a.scopes,u.username,a.expires_at,a.system_issued FROM access_tokens a JOIN users u ON u.id=a.user_id WHERE a.name=$1`, name).Scan(&scopes, &author, &expires, &issued))
			require.Equal(t, "alice", author)
			require.True(t, issued)
			require.Contains(t, scopes, "via:smithers")
			require.Contains(t, scopes, "terminal-session:"+turn+"/1")
			require.NotContains(t, scopes, "approval")
			require.WithinDuration(t, time.Now().Add(time.Hour), expires, 30*time.Second)
			visible := string(f.call(t, "alice", "GET", "/api/conversations/main", "", 200))
			require.NotContains(t, visible, "terminal-session:")
			require.NotContains(t, visible, "smithers_")
			assertRevoked := func(timeout time.Duration) {
				require.Eventually(t, func() bool {
					var count int
					err := f.local.pool.QueryRow(f.local.ctx, `SELECT count(*) FROM access_tokens WHERE name=$1`, name).Scan(&count)
					return err == nil && count == 0
				}, timeout, 10*time.Millisecond, "the packaged host must revoke its bearer after settling")
			}
			started := time.Now()
			state := "completed"
			if outcome != "author-removal" {
				close(f.release)
			} else {
				// A queued turn by another member must still execute after cancellation;
				// cleaning Alice's subject must not delete Ben's replacement credential.
				next := f.prompt(t, "ben", "Ben next")
				f.call(t, "chatowner", "DELETE", "/api/members/alice", "", 204)
				state = "cancelled"
				f.terminal(t, turn, state, 5*time.Second-time.Since(started))
				assertRevoked(5*time.Second - time.Since(started))
				require.Less(t, time.Since(started), 5*time.Second)
				f.terminal(t, next, "completed", 20*time.Second)
				close(f.release)
			}
			if outcome == "provider-failure" {
				// A failed model response can seal an uncertain turn after the
				// provider started. Both outcomes must be terminal and revoke.
				require.Eventually(t, func() bool {
					var terminal bool
					err := f.local.pool.QueryRow(f.local.ctx, `SELECT terminal,state FROM chat_turns WHERE id=$1`, turn).Scan(&terminal, &state)
					return err == nil && terminal
				}, 20*time.Second, 20*time.Millisecond)
				require.Contains(t, []string{"failed", "uncertain"}, state)
			} else {
				f.terminal(t, turn, state, 20*time.Second)
			}
			assertRevoked(5 * time.Second)
			f.mu.Lock()
			defer f.mu.Unlock()
			for _, request := range f.requests {
				require.NotContains(t, request, "smithers_")
				require.NotContains(t, request, "terminal-session:")
			}
		})
	}
}
