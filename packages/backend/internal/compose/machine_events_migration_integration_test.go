package compose

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
	"github.com/stretchr/testify/require"
)

// Exercise the install's public migration command against PostgreSQL, without
// replacing applyProductSchema or pre-migrating the fixture.
func TestRunMigrateMachineEventsPostgres(t *testing.T) {
	database := testdb.New(t)
	t.Setenv("SMITHERS_DATABASE_URL", database.URL)
	ctx := t.Context()
	require.NoError(t, runMigrate(ctx, []string{"apply"}, io.Discard, io.Discard))
	var status bytes.Buffer
	require.NoError(t, runMigrate(ctx, []string{"status"}, &status, io.Discard))
	require.Equal(t, "applied\n", status.String())
	pool, err := postgresfixture.Open(ctx, database.URL, 0)
	require.NoError(t, err)
	defer pool.Close()
	for table, columns := range map[string][]string{
		"burst_files":            {"event_id", "path", "change", "before_blob", "after_blob", "post_digest", "renamed_to"},
		"machine_event_receipts": {"workspace_id", "event_id", "outcome", "at", "transcript_checkpoint", "payload_digest", "capture_payload"},
	} {
		var actual []string
		require.NoError(t, pool.QueryRow(ctx, `SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, table).Scan(&actual))
		require.Equal(t, columns, actual)
	}

	// The composed HTTP reader must still refuse to count edits until W3/W6
	// provide real producer coverage; table existence alone is not readiness.
	q := db.New(pool)
	var owner, repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('i6-owner','i6-owner') RETURNING id`).Scan(&owner))
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, owner).Scan(&repo))
	binding := fmt.Sprintf(`{"owner_login":"i6-owner","repository_name":"app","repository_id":%d}`, repo)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(binding[:len(binding)-1] + `,"last_access_check_at":"2026-10-05T10:00:00Z"}`)}))
	sum := sha256.Sum256([]byte("i6-cookie"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner, Username: "i6-owner", SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.AllowedOrigins = []string{"http://localhost:4000"}
	router := githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{InstallScorecard: composeInstallScorecard(cfg, q, pool)})
	req := httptest.NewRequest("GET", "http://localhost:4000/api/install/scorecard?from=2026-10-01T00:00:00Z&to=2026-10-15T00:00:00Z", nil)
	req.RemoteAddr = "127.0.0.1:61000"
	req.AddCookie(&http.Cookie{Name: "session", Value: "i6-cookie"})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var scorecard services.Scorecard
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &scorecard))
	require.Equal(t, "source_missing", scorecard.Measures["terminal_edits"].Verdict)
	require.Nil(t, scorecard.Measures["terminal_edits"].Value)
}
