package compose

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// The fixture changes the generation at a recorded browser barrier. All
// requests, private live delivery and person presses use production seams.
func runMergeConfirmationBrowser(t *testing.T, cfg *config.Config, pool *pgxpool.Pool, todos *services.MythicalService, server *httptest.Server, owner db.User, token, confirmation string, number int64, head string, item pgtype.UUID, members *services.Members) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Minute)
	defer cancel()
	q := db.New(pool)
	repository, err := services.InstallRepositoryID(ctx, q)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin') ON CONFLICT(repository_id,user_id) WHERE user_id IS NOT NULL DO UPDATE SET permission='admin'`, repository, owner.ID)
	require.NoError(t, err)
	api := server.Config.Handler
	app, err := filepath.Abs("../../../../apps/app")
	require.NoError(t, err)
	command := exec.CommandContext(ctx, "bun", "e2e/real/delegated-merge.browser.ts")
	command.Dir = app
	command.Env = append(os.Environ(), "SMITHERS_CONFIRMATION_ORIGIN="+server.URL, "SMITHERS_CONFIRMATION_TOKEN="+token,
		"SMITHERS_CONFIRMATION_ID="+confirmation, "SMITHERS_CONFIRMATION_TODO="+fmt.Sprint(number), "SMITHERS_CONFIRMATION_HEAD="+head)
	stdout, err := command.StdoutPipe()
	require.NoError(t, err)
	stdin, err := command.StdinPipe()
	require.NoError(t, err)
	command.Stderr = os.Stderr
	require.NoError(t, command.Start())
	t.Cleanup(func() { cancel(); _ = command.Process.Kill() })
	scanner := bufio.NewScanner(stdout)
	stale, admitted := false, false
	for scanner.Scan() {
		line := scanner.Text()
		t.Log(line)
		switch {
		case strings.HasPrefix(line, "MERGE_BROWSER_READY "):
			vite, err := url.Parse(strings.TrimPrefix(line, "MERGE_BROWSER_READY "))
			require.NoError(t, err)
			proxy := httputil.NewSingleHostReverseProxy(vite)
			server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/api/") {
					api.ServeHTTP(w, r)
				} else {
					proxy.ServeHTTP(w, r)
				}
			})
		case line == "MERGE_BROWSER_STALE":
			_, err := pool.Exec(ctx, `UPDATE mythical_items SET generation=generation+1 WHERE id=$1`, item)
			require.NoError(t, err)
			stale = true
		case line == "MERGE_BROWSER_ADMITTED":
			row, err := q.GetMythicalItem(ctx, item)
			require.NoError(t, err)
			var operation struct{ Kind, State, Desired string }
			require.NoError(t, json.Unmarshal(row.PendingOp, &operation))
			require.Equal(t, "merge", operation.Kind)
			require.Equal(t, "intended", operation.State)
			require.Equal(t, head, operation.Desired)
			admitted = true
		default:
			continue
		}
		_, err = fmt.Fprintln(stdin, "ready")
		require.NoError(t, err)
		if admitted {
			_ = stdin.Close()
		}
	}
	require.NoError(t, scanner.Err())
	_ = stdin.Close()
	require.NoError(t, command.Wait())
	require.True(t, stale)
	require.True(t, admitted)
	var pending, expired int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE state='pending'), count(*) FILTER (WHERE state='expired') FROM approvals WHERE member_id=$1`, owner.ID).Scan(&pending, &expired))
	require.Equal(t, 1, pending)
	require.Equal(t, 1, expired)
}
