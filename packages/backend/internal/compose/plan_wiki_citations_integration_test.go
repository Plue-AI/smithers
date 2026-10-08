package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Component qualification of the production TODO HTTP projection. This is not
// C-J8-04's real-machine dispatcher/selector qualification.
func TestPlanWikiCitationsComposedTodoRoute(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "wiki-owner", LowerUsername: "wiki-owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES(true,$1)`, owner.ID)
	require.NoError(t, err)
	sum := sha256.Sum256([]byte("wiki-browser"))
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES($1,$2,$3,NOW()+interval '1 hour')`, hex.EncodeToString(sum[:]), owner.ID, owner.Username)
	require.NoError(t, err)
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo.ID)
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(`{"owner_login":"wiki-owner","repository_name":"app","repository_id":100}`)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(`{"last_access_check_at":"` + time.Now().UTC().Format(time.RFC3339Nano) + `","owner_login":"wiki-owner","repository_name":"app","repository_id":100}`)}))
	service := services.NewMythicalService(pool, nil)
	filed, err := service.FileTodo(middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, SessionHash: hex.EncodeToString(sum[:])}), repo.ID, owner.ID, services.MythicalTodoInput{Title: "Retry deliveries", Prompt: "Retry failed webhook deliveries", Request: "wiki"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET attempt=2,candidate_head='second',plan=$2,checks=$3 WHERE repository_id=$1`, repo.ID,
		`{"wikiCitations":[{"slug":"retry-policy","pageID":"42","revision":7,"digest":"0b2889240d13d49add99a1daef222ddce288814a94826dbce1fbf456f03adc6b"}]}`,
		`{"attempts":[{"attempt":1,"revision":"first","items":[{"kind":"wiki","slug":"retry-policy","pageID":"42","revision":3,"digest":"0590d40eefc0d1d5a9a5c8d407e4acfcb1cae6de15729033c56dc64ddb9abe47"}]}]}`)
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://smithers.test"
	cfg.Server.AllowedOrigins = []string{"http://smithers.test"}
	router := todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: service})
	request := httptest.NewRequest("GET", "http://smithers.test/api/todos/"+strconv.FormatInt(filed.Number, 10), nil)
	request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "wiki-browser"})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	require.Equal(t, 200, response.Code, response.Body.String())
	var card struct {
		Evidence []struct {
			Attempt int `json:"attempt"`
			Items   []struct {
				Kind     string `json:"kind"`
				Revision int    `json:"revision"`
				URL      string `json:"url"`
			} `json:"items"`
		} `json:"evidence"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &card))
	require.Len(t, card.Evidence, 2)
	require.Equal(t, 3, card.Evidence[0].Items[0].Revision)
	require.Equal(t, "/api/repos/wiki-owner/app/wiki/history/42/3/content?visibility=public", card.Evidence[0].Items[0].URL)
	require.Equal(t, 7, card.Evidence[1].Items[0].Revision)
	require.Equal(t, "/api/repos/wiki-owner/app/wiki/history/42/7/content?visibility=public", card.Evidence[1].Items[0].URL)

	// The plan step can finish well before a candidate exists. Only its own
	// attempt/run receipt may expose citations, never retained Retry input.
	for _, tc := range []struct {
		name    string
		receipt string
		current bool
	}{
		{"no receipt", `null`, false},
		{"earlier attempt", `{"attempt":1,"runId":"current-run","cursor":{"sequence":1}}`, false},
		{"other run", `{"attempt":2,"runId":"old-run","cursor":{"sequence":1}}`, false},
		{"empty run", `{"attempt":2,"runId":"","cursor":{"sequence":1}}`, false},
		{"current planner", `{"attempt":2,"runId":"current-run","cursor":{"sequence":1}}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, `UPDATE mythical_items SET flow_digest=$2,candidate_head='',request_run_id='current-run',checks=jsonb_set(checks,'{planReceipt}',$3::jsonb) WHERE repository_id=$1`, repo.ID, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", tc.receipt)
			require.NoError(t, err)
			request := httptest.NewRequest("GET", "http://smithers.test/api/todos/"+strconv.FormatInt(filed.Number, 10), nil)
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "wiki-browser"})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			require.Equal(t, 200, response.Code, response.Body.String())
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &card))
			require.Len(t, card.Evidence, 2)
			require.Equal(t, 3, card.Evidence[0].Items[0].Revision, "earlier attempt remains readable")
			currentCitations := 0
			for _, item := range card.Evidence[1].Items {
				if item.Kind == "wiki" {
					currentCitations++
					require.Equal(t, 7, item.Revision)
					require.Equal(t, "/api/repos/wiki-owner/app/wiki/history/42/7/content?visibility=public", item.URL)
				}
			}
			if tc.current {
				require.Equal(t, 1, currentCitations)
			} else {
				require.Zero(t, currentCitations)
			}
		})
	}
}

// C-J8-04 reference-host plan step. This shares the install, authenticated
// TODO dispatcher, installed launcher and scripted model transport with J1.
// No plan receipt or evidence row is injected. The selector remains the real
// fast-role shared preflight; only its provider response is recorded.
func TestPlanWikiCitationsReferenceHost(t *testing.T) {
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	t.Setenv("TRACE_MESSAGES", "1")
	r := newRehearsal(t, "SMITHERS_C_J8_04_REFERENCE_HOST", "C-J8-04", "wiki-plan-vm-", 25)
	require.True(t, r.install("Install through Machine ready"))
	// Authored-only vault: an empty pinned generated declaration is valid.
	_, err := r.pushGitHubMain("Enable wiki planning", map[string]string{
		".smithers/coding-project.json": `{"wikiCitations":true,"pages":[]}`,
	})
	require.NoError(t, err)
	const body = "Webhook retries use `retry()` with exponential backoff."
	const digest = "0314a7d6edf2ad4b7057d059f7dfdf17df0ab800ec24b502f02ecb38c1bbed22"
	const edited = "Webhook retries use `retryFixed(5000)`."
	const editedDigest = "e47d2d025a859ead6080b931b2b718bfa2937244433746068d08770278b36c7c"
	api := "/api/repos/rehearsal-owner/app/wiki"
	payload, err := json.Marshal(map[string]any{"title": "Retry policy", "slug": "retry-policy", "body": body})
	require.NoError(t, err)
	raw, err := r.expect("POST", api, string(payload), 201)
	require.NoError(t, err)
	var page struct {
		ID       int64  `json:"id"`
		Revision int64  `json:"revision"`
		Digest   string `json:"content_digest"`
	}
	require.NoError(t, json.Unmarshal(raw, &page))
	require.EqualValues(t, 1, page.Revision)
	require.Equal(t, digest, page.Digest)
	// A real completed plan followed by the existing no-proposal watchdog
	// refusal gives Retry a failed TODO without injecting a run or plan row.
	// The override still calls the shipped Request (route + plan), on the VM.
	_, pinned := activateWatchdogOverride(t, r, `import { Request, RequestInput, StackBase } from "@smthrs/coding"
import { Flow } from "@smthrs/flow"
import { Schema } from "effect"
export default Flow.make("todo", {
 description: "Plan then stop before proposal", capabilities: ["*"], modelInvocable: false,
 effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
 payload: Schema.Struct({ ...RequestInput.fields, base: StackBase }),
 success: Request.successSchema, error: Request.errorSchema,
 body: (input) => Request.child(input)
})
`)
	plan := func(n int64, revision int64, digest string) json.RawMessage {
		t.Helper()
		_, err := r.waitTodoWithin(n, 8*time.Minute, "failed")
		require.NoError(t, err)
		card, err := r.expect("GET", "/api/todos/"+strconv.FormatInt(n, 10), "", 200)
		require.NoError(t, err)
		var result struct {
			Evidence []struct {
				Items []struct {
					Kind     string `json:"kind"`
					Slug     string `json:"slug"`
					Revision int64  `json:"revision"`
					Digest   string `json:"digest"`
					URL      string `json:"url"`
				} `json:"items"`
			} `json:"evidence"`
		}
		require.NoError(t, json.Unmarshal(card, &result))
		citations := 0
		for _, attempt := range result.Evidence {
			for _, item := range attempt.Items {
				if item.Kind != "wiki" {
					continue
				}
				citations++
				require.Equal(t, "retry-policy", item.Slug)
				require.Equal(t, revision, item.Revision)
				require.Equal(t, digest, item.Digest)
				history, err := r.expect("GET", item.URL, "", 200)
				require.NoError(t, err)
				if revision == 1 {
					require.Equal(t, body, string(history))
				} else {
					require.Equal(t, edited, string(history))
				}
			}
		}
		require.Equal(t, 1, citations, string(card))
		var receipt json.RawMessage
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT plan FROM mythical_items WHERE number=$1`, n).Scan(&receipt))
		var recorded struct {
			Citations []struct {
				Slug     string `json:"slug"`
				Revision int64  `json:"revision"`
				Digest   string `json:"digest"`
			} `json:"wikiCitations"`
		}
		require.NoError(t, json.Unmarshal(receipt, &recorded))
		require.Len(t, recorded.Citations, 1)
		require.Equal(t, "retry-policy", recorded.Citations[0].Slug)
		require.Equal(t, revision, recorded.Citations[0].Revision)
		require.Equal(t, digest, recorded.Citations[0].Digest)
		require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "todo-"+strconv.FormatInt(n, 10)+".json"), card, 0600))
		return receipt
	}
	n, err := r.file("Retry deliveries", "[FILE JOURNEY.md] Retry failed webhook deliveries. Follow retry-policy.")
	require.NoError(t, err)
	before := plan(n, 1, digest)
	require.NoError(t, r.drop(n))
	payload, err = json.Marshal(map[string]any{"body": edited, "expected_revision": 1})
	require.NoError(t, err)
	_, err = r.expect("PATCH", api+"/retry-policy", string(payload), 200)
	require.NoError(t, err)
	next, err := r.file("Retry deliveries after decision edit", "[FILE JOURNEY.md] Retry failed webhook deliveries. Follow retry-policy.")
	require.NoError(t, err)
	after := plan(next, 2, editedDigest)
	trace, err := os.ReadFile(filepath.Join(r.evidence, "model-turns.jsonl"))
	require.NoError(t, err)
	require.Contains(t, string(trace), body)
	require.Contains(t, string(trace), edited)
	require.Contains(t, string(trace), digest)
	require.Contains(t, string(trace), editedDigest)
	original, err := r.expect("GET", api+"/history/"+strconv.FormatInt(page.ID, 10)+"/1/content?visibility=public", "", 200)
	require.NoError(t, err)
	require.Equal(t, body, string(original))
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "first-attempt.json"), before, 0600))
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "edited-attempt.json"), after, 0600))
	require.NoError(t, r.drop(next))

	retryNumber, err := r.file("Retry a plan after a decision edit", "[FILE JOURNEY.md] Retry failed webhook deliveries. Follow retry-policy.")
	require.NoError(t, err)
	readFailedPlan := func(revision int64, expectedDigest string) (json.RawMessage, json.RawMessage) {
		t.Helper()
		failed, err := r.waitTodoWithin(retryNumber, 8*time.Minute, "failed")
		require.NoError(t, err)
		require.NotNil(t, failed.FlowVersion)
		require.Equal(t, pinned, failed.FlowVersion.Digest)
		card, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", retryNumber), "", 200)
		require.NoError(t, err)
		var projection struct {
			Failure struct {
				Retryable bool `json:"retryable"`
			} `json:"failure"`
		}
		require.NoError(t, json.Unmarshal(card, &projection))
		require.True(t, projection.Failure.Retryable, string(card))
		var fault string
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT checks->'fault'->>'tag' FROM mythical_items WHERE number=$1`, retryNumber).Scan(&fault))
		require.Equal(t, "no_proposal", fault)
		var receipt json.RawMessage
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT plan FROM mythical_items WHERE number=$1`, retryNumber).Scan(&receipt))
		var recorded struct {
			Citations []struct {
				Slug     string `json:"slug"`
				Revision int64  `json:"revision"`
				Digest   string `json:"digest"`
			} `json:"wikiCitations"`
		}
		require.NoError(t, json.Unmarshal(receipt, &recorded))
		require.Len(t, recorded.Citations, 1)
		require.Equal(t, "retry-policy", recorded.Citations[0].Slug)
		require.Equal(t, revision, recorded.Citations[0].Revision)
		require.Equal(t, expectedDigest, recorded.Citations[0].Digest)
		return receipt, card
	}
	priorReceipt, priorCard := readFailedPlan(2, editedDigest)
	payload, err = json.Marshal(map[string]any{"body": body, "expected_revision": 2})
	require.NoError(t, err)
	_, err = r.expect("PATCH", api+"/retry-policy", string(payload), 200)
	require.NoError(t, err)
	// Editing the page must not rewrite the completed plan's captured context.
	var unchanged json.RawMessage
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT plan FROM mythical_items WHERE number=$1`, retryNumber).Scan(&unchanged))
	require.JSONEq(t, string(priorReceipt), string(unchanged))
	for range 2 {
		status, _, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", retryNumber), `{"op":"retry"}`, "wiki-plan-retry")
		require.NoError(t, err)
		require.Equal(t, 202, status)
	}
	// Await the new attempt before interpreting its terminal projection.
	require.Eventually(t, func() bool {
		var attempt int
		return r.pool.QueryRow(r.ctx, `SELECT attempt FROM mythical_items WHERE number=$1`, retryNumber).Scan(&attempt) == nil && attempt == 2
	}, 2*time.Minute, 100*time.Millisecond)
	newReceipt, newCard := readFailedPlan(3, digest)
	var history struct {
		Evidence []struct {
			Attempt int `json:"attempt"`
			Items   []struct {
				Kind     string `json:"kind"`
				Slug     string `json:"slug"`
				Revision int64  `json:"revision"`
				Digest   string `json:"digest"`
				URL      string `json:"url"`
			} `json:"items"`
		} `json:"evidence"`
	}
	require.NoError(t, json.Unmarshal(newCard, &history))
	seen := map[int]int{}
	for _, attempt := range history.Evidence {
		for _, citation := range attempt.Items {
			if citation.Kind != "wiki" {
				continue
			}
			seen[attempt.Attempt]++
			require.Equal(t, "retry-policy", citation.Slug)
			expectedBody, expectedDigest, expectedRevision := edited, editedDigest, int64(2)
			if attempt.Attempt == 2 {
				expectedBody, expectedDigest, expectedRevision = body, digest, 3
			}
			require.Equal(t, expectedRevision, citation.Revision)
			require.Equal(t, expectedDigest, citation.Digest)
			content, err := r.expect("GET", citation.URL, "", 200)
			require.NoError(t, err)
			require.Equal(t, expectedBody, string(content))
		}
	}
	require.Equal(t, map[int]int{1: 1, 2: 1}, seen, string(newCard))
	for name, receipt := range map[string]json.RawMessage{
		"retry-prior-plan.json": priorReceipt, "retry-prior-card.json": priorCard,
		"retry-next-plan.json": newReceipt, "retry-next-card.json": newCard,
	} {
		require.NoError(t, os.WriteFile(filepath.Join(r.evidence, name), receipt, 0600))
	}
	require.NoError(t, r.drop(retryNumber))
}
