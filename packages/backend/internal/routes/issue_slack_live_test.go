package routes

import (
	"context"
	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// Opt-in real-provider test. It creates one isolated DB and only its own Slack thread.
func TestIssueSlackLive(t *testing.T) {
	if os.Getenv("SMITHERS_SLACK_LIVE") != "1" {
		t.Skip("explicit live Slack opt-in required")
	}
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	var user db.User
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email) VALUES('sync_test','sync_test','sync@example.test','sync@example.test') RETURNING id,username`).Scan(&user.ID, &user.Username))
	_, err := pool.Exec(ctx, `INSERT INTO repositories(user_id,name,lower_name,is_public) VALUES($1,'sync-test','sync-test',false)`, user.ID)
	require.NoError(t, err)
	h := &IssueHandler{Service: services.NewIssueService(db.New(pool))}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), middleware.UserContextKey, &user)))
		})
	})
	r.Route("/api/repos/{owner}/{repo}/issues", func(r chi.Router) {
		r.Post("/", h.CreateIssue)
		r.Get("/{number}", h.GetIssue)
		r.Get("/{number}/comments", h.ListIssueComments)
		r.Put("/{number}/comments/{comment}/reactions", h.IssueReaction)
		r.Get("/{number}/comments/{comment}/reactions", h.IssueReaction)
		r.Post("/{number}/comments", h.PostIssueComment)
		r.Patch("/comments/{id}", h.PatchIssueComment)
		r.Delete("/comments/{id}", h.DeleteIssueComment)
		r.Put("/{number}/sync", h.IssueSync)
		r.Get("/{number}/sync", h.IssueSync)
		r.Put("/sync/channels", h.IssueSyncChannel)
		r.Post("/sync/events", h.IssueSyncEvent)
		r.Get("/sync/deliveries", h.IssueSyncDeliveries)
		r.Post("/sync/deliveries/{id}", h.IssueSyncReceipt)
		r.Put("/sync/deliveries/{id}", h.IssueSyncReceipt)
	})
	server := httptest.NewServer(r)
	defer server.Close()
	root, err := filepath.Abs("../../../..")
	require.NoError(t, err)
	runCtx, cancel := context.WithTimeout(ctx, 12*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(runCtx, "bun", "run", "test/SlackIssueLive.ts")
	cmd.Dir = filepath.Join(root, "packages/smithers/agent/integrations")
	cmd.Env = append(os.Environ(), "ISSUE_TEST_URL="+server.URL)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	require.NoError(t, cmd.Run())
}
