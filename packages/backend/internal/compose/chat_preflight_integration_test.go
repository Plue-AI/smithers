package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// This boundary uses the packaged executable, real encrypted credentials,
// AuthLoader, prompt admission, dispatcher, callbacks and durable journal.
// Candidate contents come from the actual native repository and filesystem wiki.
// Only the external model endpoint records scripted selection/answer responses.
func TestLocalSharedPreflightUsesFastRoleThenCodingFallback(t *testing.T) {
	type call struct{ role, key, body string }
	calls := make(chan call, 8)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read", 400)
			return
		}
		var input struct {
			Model string `json:"model"`
		}
		if json.Unmarshal(body, &input) != nil {
			http.Error(w, "json", 400)
			return
		}
		calls <- call{input.Model, r.Header.Get("Authorization"), string(body)}
		answer := "Retries three times."
		if input.Model != "answer" {
			answer = `[{"index":0,"reason":"Retry implementation"}]`
		}
		chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]string{"content": answer}, "finish_reason": nil}}})
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", chunk)
	}))
	defer provider.Close()
	sum := sha256.Sum256([]byte("composed-context-session"))
	credential := middleware.Credential{SessionHash: hex.EncodeToString(sum[:])}
	var revision, itemRevision string
	var memberID int64
	local := startConfiguredLocalChat(t, func(local *localChat, options *chat.RuntimeOptions) {
		q := db.New(local.pool)
		_, err := local.pool.Exec(local.ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, local.ownerID)
		require.NoError(t, err)
		_, err = local.pool.Exec(local.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, local.repoID, local.ownerID)
		require.NoError(t, err)
		repository, _ := json.Marshal(map[string]any{"repository_id": local.repoID, "owner_login": "chatowner", "repository_name": "chatrepo"})
		require.NoError(t, q.UpsertInstallSetting(local.ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: repository}))
		access, _ := json.Marshal(map[string]any{"repository_id": local.repoID, "owner_login": "chatowner", "repository_name": "chatrepo", "last_access_check_at": time.Now().UTC().Format(time.RFC3339)})
		require.NoError(t, q.UpsertInstallSetting(local.ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: access}))
		require.NoError(t, local.pool.QueryRow(local.ctx, `INSERT INTO users(username,lower_username) VALUES('ben','ben') RETURNING id`).Scan(&memberID))
		_, err = local.pool.Exec(local.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, local.repoID, memberID)
		require.NoError(t, err)
		reader, commit, candidate := composedContextSources(t, local)
		revision, itemRevision = commit, candidate
		options.ContextRepository = reader.Read
		seedComposedContextHistory(t, local, memberID)
	})
	defer local.stop(t)
	q := db.New(local.pool)
	_, err := q.CreateAuthSession(local.ctx, db.CreateAuthSessionParams{UserID: memberID, Username: "ben", SessionKey: credential.SessionHash, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	for role, name := range map[string]string{"coding": "CODING_KEY", "fast": "FAST_KEY", "app": "ANSWER_KEY"} {
		modelID := role
		if role == "app" {
			modelID = "answer"
		}
		local.enroll(t, name, provider.URL, role+"-private-key")
		model, _ := json.Marshal(map[string]string{"protocol": "openai-chat", "modelId": modelID, "credential": name, "baseUrl": provider.URL})
		require.NoError(t, q.AssignInstallAgentModel(local.ctx, role, model))
	}
	branches := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(local.pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)))
	local.composition.runtime.Handler.ResolveBranch = conversationBranchResolver(branches)
	router := chi.NewRouter()
	router.Use(middleware.AuthLoader(q, config.AuthConfig{SessionCookieName: "context_session"}))
	local.composition.runtime.MountPublic(router)
	public := httptest.NewServer(router)
	defer public.Close()
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	origin, err := url.Parse(public.URL)
	require.NoError(t, err)
	jar.SetCookies(origin, []*http.Cookie{{Name: "context_session", Value: "composed-context-session"}})
	client := &http.Client{Jar: jar, Timeout: 30 * time.Second}
	_, err = local.pool.Exec(local.ctx, `INSERT INTO approvals(id,repository_id,state,kind,title,member_id,credential_id,command,subject,revision,payload,expires_at)
      VALUES($1,$2,'pending','one_click','canary-C',$3,'alice-credential','todo.drop','{"kind":"todo","ref":"T1"}','revision-1','{"private":"canary-C"}',now()+interval '1 hour')`, uuid.NewString(), local.repoID, local.ownerID)
	require.NoError(t, err)
	for _, role := range []string{"fast", "coding"} {
		if role == "coding" {
			body := strings.NewReader(`{"action":"remove","requestId":"remove-fast-for-fallback","name":"FAST_KEY"}`)
			response, err := local.client.Post(local.public.URL+"/api/model/credential", "application/json", body)
			require.NoError(t, err)
			raw, err := io.ReadAll(response.Body)
			response.Body.Close()
			require.NoError(t, err)
			require.Contains(t, string(raw), `"ok":true`)
		}
		body, _ := json.Marshal(map[string]string{"prompt": "Where do we retry webhooks?", "idempotencyKey": "preflight-" + role})
		response, err := client.Post(public.URL+"/api/conversations/main/prompt", "application/json", strings.NewReader(string(body)))
		require.NoError(t, err)
		raw, err := io.ReadAll(response.Body)
		response.Body.Close()
		require.NoError(t, err)
		require.Equal(t, http.StatusAccepted, response.StatusCode, string(raw))
		var admitted struct {
			TurnID string `json:"turnId"`
			RunID  string `json:"runId"`
		}
		require.NoError(t, json.Unmarshal(raw, &admitted))
		recorded := []call{}
		for range 2 {
			select {
			case got := <-calls:
				recorded = append(recorded, got)
			case <-time.After(20 * time.Second):
				var state string
				_ = local.pool.QueryRow(local.ctx, `SELECT state FROM chat_turns WHERE id=$1`, admitted.TurnID).Scan(&state)
				t.Fatalf("missing model call; durable turn state=%s; logs=%s", state, local.logs.String())
			}
		}
		require.Equal(t, role, recorded[0].role)
		require.Equal(t, "Bearer "+role+"-private-key", recorded[0].key)
		require.Contains(t, recorded[0].body, "Choose relevant context")
		require.Contains(t, recorded[0].body, "unselected-content-canary")
		require.Contains(t, recorded[0].body, "Public wiki context")
		require.NotContains(t, recorded[0].body, "private-wiki-canary")
		require.NotContains(t, recorded[0].body, "canary-C")
		require.Contains(t, recorded[0].body, "Shared prompt 000")
		require.NotContains(t, recorded[0].body, "outside-symlink-canary")
		require.Equal(t, "answer", recorded[1].role)
		require.Equal(t, "Bearer app-private-key", recorded[1].key)
		require.Contains(t, recorded[1].body, "export const retries = 3")
		require.NotContains(t, recorded[1].body, "unselected-content-canary")
		require.NotContains(t, recorded[1].body, "background-content-canary")
		require.NotContains(t, recorded[1].body, "Public wiki context")
		require.NotContains(t, recorded[1].body, "private-wiki-canary")
		require.NotContains(t, recorded[1].body, "canary-C")
		for i := 0; i < 497; i++ {
			require.NotContains(t, recorded[1].body, fmt.Sprintf("Shared prompt %03d", i))
			require.NotContains(t, recorded[1].body, fmt.Sprintf("Shared answer %03d", i))
		}
		for _, i := range []int{498, 499} {
			require.Contains(t, recorded[1].body, fmt.Sprintf("Shared prompt %03d", i))
			require.Contains(t, recorded[1].body, fmt.Sprintf("Shared answer %03d", i))
		}
		if role == "fast" {
			require.Contains(t, recorded[1].body, "Shared prompt 497")
			require.Contains(t, recorded[1].body, "Shared answer 497")
		} else {
			// The first completed answer now occupies the third recent entry.
			require.NotContains(t, recorded[1].body, "Shared prompt 497")
			require.NotContains(t, recorded[1].body, "Shared answer 497")
			require.Contains(t, recorded[1].body, "Retries three times.")
		}
		require.NotContains(t, recorded[1].body, "outside-symlink-canary")
		require.Eventually(t, func() bool {
			var terminal bool
			err := local.pool.QueryRow(local.ctx, `SELECT terminal FROM chat_turns WHERE id=$1`, admitted.TurnID).Scan(&terminal)
			return err == nil && terminal
		}, 10*time.Second, 20*time.Millisecond)
		shared, err := local.composition.runtime.Handler.Store.SharedEntries(local.ctx, chat.Scope{UserID: memberID, RepositoryID: local.repoID, Owner: "ben"}, "main")
		require.NoError(t, err)
		entry := shared.Entries[len(shared.Entries)-1]
		require.Equal(t, admitted.RunID, entry.RunID)
		require.Equal(t, memberID, entry.Author)
		require.NotNil(t, entry.Context)
		require.Len(t, *entry.Context, 1)
		require.JSONEq(t, `{"kind":"file","label":"retry.ts","ref":"src/webhooks/retry.ts","revision":"`+revision+`","reason":"Retry implementation"}`, string((*entry.Context)[0]))
		frames, err := json.Marshal(entry.Frames)
		require.NoError(t, err)
		require.NotContains(t, string(frames), "context.preflight")
		var journal []byte
		require.NoError(t, local.pool.QueryRow(local.ctx, `SELECT jsonb_agg(frame ORDER BY batch_number,position)
          FROM chat_turn_batches b CROSS JOIN LATERAL jsonb_array_elements(b.frames) WITH ORDINALITY AS f(frame,position)
          WHERE b.turn_id=$1 AND frame->>'type'='context.preflight'`, admitted.TurnID).Scan(&journal))
		var steps []struct {
			Phase  string                     `json:"phase"`
			Page   struct{ Index, Total int } `json:"page"`
			Result struct {
				Model string `json:"model"`
			} `json:"result"`
		}
		require.NoError(t, json.Unmarshal(journal, &steps))
		require.Greater(t, len(steps), 2, "large catalog must span bounded journal pages")
		for _, phase := range []string{"started", "completed"} {
			next, total := 0, 0
			for _, step := range steps {
				if step.Phase != phase {
					continue
				}
				require.Equal(t, next, step.Page.Index)
				require.Equal(t, role, step.Result.Model)
				next++
				if total == 0 {
					total = step.Page.Total
				}
				require.Equal(t, total, step.Page.Total)
			}
			require.Greater(t, total, 1)
			require.Equal(t, total, next)
		}
		require.NotContains(t, string(journal), "canary-C")
		require.Contains(t, string(journal), "background-2.txt", "large catalog must not be silently truncated")
		require.Contains(t, string(journal), "catalog-0499-", "last catalog entry must remain inspectable")
		require.NotContains(t, string(journal), "private-wiki-canary")
		require.Equal(t, "started", steps[0].Phase)
		require.Equal(t, "completed", steps[len(steps)-1].Phase)
		for _, key := range []string{"app-private-key", "fast-private-key", "coding-private-key"} {
			require.NotContains(t, string(frames), key)
			require.NotContains(t, string(journal), key)
			require.NotContains(t, local.logs.String(), key)
		}
	}
	// A source refusal occurs before provider start, so the durable dispatcher
	// retries without model spend. Restore the source during that retry window
	// and prove the originally admitted turn recovers without another prompt.
	require.NoError(t, q.UpsertInstallSetting(local.ctx, db.UpsertInstallSettingParams{Key: "setup.step.source", Value: json.RawMessage(`{"status":"pending"}`)}))
	payload, _ := json.Marshal(map[string]string{"prompt": "Where do we retry webhooks?", "idempotencyKey": "source-unavailable"})
	response, err := client.Post(public.URL+"/api/conversations/main/prompt", "application/json", strings.NewReader(string(payload)))
	require.NoError(t, err)
	raw, err := io.ReadAll(response.Body)
	response.Body.Close()
	require.NoError(t, err)
	require.Equal(t, http.StatusAccepted, response.StatusCode, string(raw))
	var admitted struct {
		TurnID string `json:"turnId"`
	}
	require.NoError(t, json.Unmarshal(raw, &admitted))
	require.Eventually(t, func() bool {
		var waiting bool
		err := local.pool.QueryRow(local.ctx, `SELECT NOT terminal AND producer_generation >= 1
          AND producer_started_at IS NULL AND producer_token_hash IS NULL
          AND producer_lease_expires_at > now() FROM chat_turns WHERE id=$1`, admitted.TurnID).Scan(&waiting)
		return err == nil && waiting
	}, 15*time.Second, 20*time.Millisecond)
	require.Empty(t, calls, "source refusal must precede both model calls")
	require.NoError(t, q.UpsertInstallSetting(local.ctx, db.UpsertInstallSettingParams{Key: "setup.step.source", Value: json.RawMessage(`{"status":"done"}`)}))
	var state string
	var generation int64
	require.Eventually(t, func() bool {
		var terminal bool
		err := local.pool.QueryRow(local.ctx, `SELECT terminal,state,producer_generation FROM chat_turns WHERE id=$1`, admitted.TurnID).Scan(&terminal, &state, &generation)
		return err == nil && terminal
	}, 20*time.Second, 20*time.Millisecond)
	require.Equal(t, "completed", state)
	require.GreaterOrEqual(t, generation, int64(2))
	require.Len(t, calls, 2)
	selection, answer := <-calls, <-calls
	require.Equal(t, "coding", selection.role)
	require.Equal(t, "answer", answer.role)
	require.Contains(t, answer.body, "export const retries = 3")

	require.Empty(t, calls)
	var machines int
	require.NoError(t, local.pool.QueryRow(local.ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1`, local.repoID).Scan(&machines))
	require.Zero(t, machines, "source reads must never admit a machine")
	// The sleeping item has an older workspace head, but its accepted candidate
	// names different bytes. Read that candidate through the same public route.
	workspaceID, itemID := uuid.NewString(), uuid.NewString()
	_, err = local.pool.Exec(local.ctx, `INSERT INTO workspaces(id,repository_id,user_id,status,target_bookmark,head_commit_id)
      VALUES($1,$2,$3,'stopped','smithers/retry',$4)`, workspaceID, local.repoID, memberID, revision)
	require.NoError(t, err)
	_, err = local.pool.Exec(local.ctx, `INSERT INTO mythical_items(id,repository_id,source,title,state,workspace_id,candidate_base,candidate_head,candidate_verified,revisions)
      VALUES($1,$2,'todo','Repair retries','waiting',$3,$4,$5,true,'[]')`, itemID, local.repoID, workspaceID, revision, itemRevision)
	require.NoError(t, err)
	_, err = local.pool.Exec(local.ctx, `INSERT INTO mythical_lanes(workspace_id,repository_id,item_id,name) VALUES($1,$2,$3,'coding')`, workspaceID, local.repoID, itemID)
	require.NoError(t, err)
	for _, snapshot := range []bool{true, false} {
		if !snapshot {
			_, err = local.pool.Exec(local.ctx, `UPDATE mythical_items SET candidate_head='',candidate_base='',candidate_verified=false WHERE id=$1`, itemID)
			require.NoError(t, err)
		}
		payload, _ := json.Marshal(map[string]string{"prompt": "Where do we retry webhooks?", "idempotencyKey": fmt.Sprintf("item-snapshot-%t", snapshot)})
		response, err := client.Post(public.URL+"/api/conversations/"+workspaceID+"/prompt", "application/json", strings.NewReader(string(payload)))
		require.NoError(t, err)
		raw, err := io.ReadAll(response.Body)
		response.Body.Close()
		require.NoError(t, err)
		require.Equal(t, http.StatusAccepted, response.StatusCode, string(raw))
		var admitted struct {
			TurnID string `json:"turnId"`
		}
		require.NoError(t, json.Unmarshal(raw, &admitted))
		require.Eventually(t, func() bool {
			var terminal bool
			err := local.pool.QueryRow(local.ctx, `SELECT terminal,state FROM chat_turns WHERE id=$1`, admitted.TurnID).Scan(&terminal, &state)
			return err == nil && terminal
		}, 20*time.Second, 20*time.Millisecond)
		require.Equal(t, "completed", state)
		require.Len(t, calls, 2)
		selection, answer := <-calls, <-calls
		require.Equal(t, "coding", selection.role)
		require.Equal(t, "answer", answer.role)
		require.NotContains(t, selection.body, "export const retries = 3")
		require.NotContains(t, answer.body, "export const retries = 3")
		shared, err := local.composition.runtime.Handler.Store.SharedEntries(local.ctx, chat.Scope{UserID: memberID, RepositoryID: local.repoID, Owner: "ben"}, workspaceID)
		require.NoError(t, err)
		entry := shared.Entries[len(shared.Entries)-1]
		require.NotNil(t, entry.Context)
		if snapshot {
			require.Contains(t, answer.body, "export const retries = 7")
			require.Len(t, *entry.Context, 1)
			require.JSONEq(t, `{"kind":"file","label":"retry.ts","ref":"src/webhooks/retry.ts","revision":"`+itemRevision+`","reason":"Retry implementation"}`, string((*entry.Context)[0]))
		} else {
			require.NotContains(t, selection.body, "export const retries = 7")
			require.NotContains(t, answer.body, "export const retries = 7")
			for _, raw := range *entry.Context {
				var item struct {
					Kind string `json:"kind"`
				}
				require.NoError(t, json.Unmarshal(raw, &item))
				require.NotEqual(t, "file", item.Kind)
			}
		}
		var machineState string
		require.NoError(t, local.pool.QueryRow(local.ctx, `SELECT status FROM workspaces WHERE id=$1`, workspaceID).Scan(&machineState))
		require.Equal(t, "stopped", machineState)
		require.NoError(t, local.pool.QueryRow(local.ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1`, local.repoID).Scan(&machines))
		require.Equal(t, 1, machines, "snapshot reads must not create another machine")
	}

	// Remove the real providers underneath the same admitted route. Each fault
	// is isolated to this fixture database; no recording replacement can grant
	// a successful history read or journal write. Keep source and model endpoint
	// real as above, and restore before the next case.
	for _, fault := range []string{"shared-history", "durable-step", "durable-selection", "model-access", "model-routing"} {
		t.Run("provider-"+fault, func(t *testing.T) {
			execute := func(sql string) {
				t.Helper()
				_, err := local.pool.Exec(local.ctx, sql)
				require.NoError(t, err)
			}
			var restore func()
			switch fault {
			case "shared-history":
				execute(`UPDATE chat_turn_batches SET canonical_bytes=canonical_bytes+1 WHERE turn_id=(SELECT id FROM chat_turns WHERE run_id='shared-history-000')`)
				restore = func() {
					execute(`UPDATE chat_turn_batches SET canonical_bytes=canonical_bytes-1 WHERE turn_id=(SELECT id FROM chat_turns WHERE run_id='shared-history-000')`)
				}
			case "durable-step", "durable-selection":
				phase := "started"
				if fault == "durable-selection" {
					phase = "completed"
				}
				execute(fmt.Sprintf(`CREATE FUNCTION refuse_preflight_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.frames) f WHERE f->>'type'='context.preflight' AND f->>'phase'='%s') THEN
				    RAISE EXCEPTION 'preflight journal unavailable'; END IF; RETURN NEW; END $$;
				  CREATE TRIGGER refuse_preflight_write BEFORE INSERT ON chat_turn_batches FOR EACH ROW EXECUTE FUNCTION refuse_preflight_write()`, phase))
				restore = func() {
					execute(`DROP TRIGGER refuse_preflight_write ON chat_turn_batches; DROP FUNCTION refuse_preflight_write()`)
				}
			case "model-access":
				execute(`CREATE TABLE saved_preflight_access AS SELECT * FROM owner_model_credentials WHERE name='ANSWER_KEY'; DELETE FROM owner_model_credentials WHERE name='ANSWER_KEY'`)
				restore = func() {
					execute(`INSERT INTO owner_model_credentials SELECT * FROM saved_preflight_access; DROP TABLE saved_preflight_access`)
				}
			case "model-routing":
				execute(`CREATE TABLE saved_preflight_roles AS SELECT * FROM install_settings WHERE key IN ('agent:app','agent:fast','agent:coding');
				  CREATE TABLE saved_preflight_defaults AS SELECT * FROM owner_model_defaults;
				  DELETE FROM install_settings WHERE key IN ('agent:app','agent:fast','agent:coding'); DELETE FROM owner_model_defaults`)
				restore = func() {
					execute(`INSERT INTO install_settings SELECT * FROM saved_preflight_roles; INSERT INTO owner_model_defaults SELECT * FROM saved_preflight_defaults;
				  DROP TABLE saved_preflight_roles; DROP TABLE saved_preflight_defaults`)
				}
			}
			restored := false
			defer func() {
				if !restored {
					restore()
				}
			}()
			prompt := func(key string) string {
				t.Helper()
				body, _ := json.Marshal(map[string]string{"prompt": "Where do we retry webhooks?", "idempotencyKey": key})
				response, err := client.Post(public.URL+"/api/conversations/main/prompt", "application/json", strings.NewReader(string(body)))
				require.NoError(t, err)
				raw, err := io.ReadAll(response.Body)
				response.Body.Close()
				require.NoError(t, err)
				require.Equal(t, http.StatusAccepted, response.StatusCode, string(raw))
				var admitted struct {
					TurnID string `json:"turnId"`
				}
				require.NoError(t, json.Unmarshal(raw, &admitted))
				return admitted.TurnID
			}
			turnID := prompt("refuse-" + fault)
			var terminal bool
			var state string
			require.Eventually(t, func() bool {
				var released bool
				err := local.pool.QueryRow(local.ctx, `SELECT terminal,state,coalesce(producer_generation>=1 AND producer_token_hash IS NULL AND producer_lease_expires_at>now(),false) FROM chat_turns WHERE id=$1`, turnID).Scan(&terminal, &state, &released)
				return err == nil && (terminal || released)
			}, 15*time.Second, 20*time.Millisecond, "provider failure did not reach a durable refusal: %s", local.logs.String())
			require.NotEqual(t, "completed", state)
			if fault == "durable-selection" {
				require.True(t, terminal, "a selector that spent cannot be silently retried")
				require.Len(t, calls, 1)
				require.Equal(t, "coding", (<-calls).role)
			} else {
				require.Empty(t, calls, "missing provider must prevent selection and answer")
			}
			var answered, completed int
			require.NoError(t, local.pool.QueryRow(local.ctx, `SELECT count(*) FILTER (WHERE f->>'type'='delta'), count(*) FILTER (WHERE f->>'type'='context.preflight' AND f->>'phase'='completed')
			  FROM chat_turn_batches b CROSS JOIN LATERAL jsonb_array_elements(b.frames) f WHERE b.turn_id=$1`, turnID).Scan(&answered, &completed))
			require.Zero(t, answered)
			require.Zero(t, completed)
			restore()
			restored = true
			// Pre-spend outages recover the admitted turn. Terminal credential or
			// post-selector refusals require a new human prompt, never a rerun.
			if terminal {
				turnID = prompt("restored-" + fault)
			}
			require.Eventually(t, func() bool {
				err := local.pool.QueryRow(local.ctx, `SELECT terminal,state FROM chat_turns WHERE id=$1`, turnID).Scan(&terminal, &state)
				return err == nil && terminal
			}, 20*time.Second, 20*time.Millisecond)
			require.Equal(t, "completed", state, local.logs.String())
			require.Len(t, calls, 2)
			selection, answer := <-calls, <-calls
			require.Equal(t, "coding", selection.role)
			require.Equal(t, "answer", answer.role)
			require.Contains(t, answer.body, "export const retries = 3")
			require.NotContains(t, answer.body, "private-wiki-canary")
			require.NotContains(t, answer.body, "canary-C")
			shared, err := local.composition.runtime.Handler.Store.SharedEntries(local.ctx, chat.Scope{UserID: memberID, RepositoryID: local.repoID, Owner: "ben"}, "main")
			require.NoError(t, err)
			entry := shared.Entries[len(shared.Entries)-1]
			require.Equal(t, turnID, entry.ID)
			require.NotNil(t, entry.Context)
			require.Len(t, *entry.Context, 1)
			require.Contains(t, string((*entry.Context)[0]), `"ref":"src/webhooks/retry.ts"`)
			require.NoError(t, local.pool.QueryRow(local.ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1`, local.repoID).Scan(&machines))
			require.Equal(t, 1, machines, "provider recovery must not admit a machine")
		})
	}

}

// Reuse the composed chat harness and create its real repository-store input.
// jj captures ordinary bytes; no repository tool, plugin or guest is executed.
func composedContextSources(t *testing.T, local *localChat) (services.InstallContext, string, string) {
	t.Helper()
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if library == "" {
		if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1" {
			t.Fatal("native repository library is required")
		}
		t.Skip("SMITHERS_FFI_LIBRARY_PATH is required")
	}
	cfg := repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "context-source", FFILibraryPath: library}
	native := repohostffi.New(library)
	require.NoError(t, native.Load())
	repoPath := cfg.RepoPath("chatowner", "chatrepo")
	_, err := native.InitRepo(repoPath)
	require.NoError(t, err)
	pluginMarker := filepath.Join(t.TempDir(), "plugin-executed")
	markerJSON, _ := json.Marshal(pluginMarker)
	t.Cleanup(func() { require.NoFileExists(t, pluginMarker, "repository recall plugin executed on host") })
	for name, content := range map[string]string{
		"flows/recall/flow.ts":       "import { writeFileSync } from 'node:fs'; writeFileSync(" + string(markerJSON) + ", 'plugin-executed'); export default {};",
		"src/webhooks/retry.ts":      "export const retries = 3",
		"src/webhooks/unselected.ts": "unselected-content-canary",
	} {
		path := filepath.Join(repoPath, name)
		require.NoError(t, os.MkdirAll(filepath.Dir(path), 0755))
		require.NoError(t, os.WriteFile(path, []byte(content), 0644))
	}
	// The native catalog exceeds the former 2 MiB aggregate callback bound.
	// Unrelated files remain candidates without entering the answer.
	for i := 0; i < 3; i++ {
		require.NoError(t, os.WriteFile(filepath.Join(repoPath, fmt.Sprintf("background-%d.txt", i)), []byte(strings.Repeat("background-content-canary ", 32000)), 0644))
	}
	// Metadata alone exceeds one journal batch. These native files must all
	// reach Inspect while each committed page stays inside the existing bound.
	for i := 0; i < 500; i++ {
		name := fmt.Sprintf("catalog-%04d-%s.txt", i, strings.Repeat("c", 180))
		require.NoError(t, os.WriteFile(filepath.Join(repoPath, name), []byte("Catalog filler"), 0644))
	}
	outside := filepath.Join(t.TempDir(), "outside")
	require.NoError(t, os.WriteFile(outside, []byte("outside-symlink-canary"), 0644))
	require.NoError(t, os.Symlink(outside, filepath.Join(repoPath, "outside-link")))
	jj := func(args ...string) string {
		t.Helper()
		argv := append([]string{"--repository", repoPath, "--config", "user.name=Context fixture", "--config", "user.email=context@example.invalid"}, args...)
		command := exec.CommandContext(local.ctx, "jj", argv...)
		command.Env = append(os.Environ(), "JJ_CONFIG=/dev/null")
		output, err := command.CombinedOutput()
		require.NoError(t, err, string(output))
		return strings.TrimSpace(string(output))
	}
	jj("describe", "-m", "Mirrored context fixture")
	jj("bookmark", "create", "main", "-r", "@")
	revision := jj("log", "--no-graph", "-r", "@", "-T", "commit_id")
	require.Regexp(t, `^[a-f0-9]{40}$`, revision)
	jj("new", "@")
	require.NoError(t, os.WriteFile(filepath.Join(repoPath, "src/webhooks/retry.ts"), []byte("export const retries = 7"), 0644))
	jj("describe", "-m", "Accepted item candidate fixture")
	candidate := jj("log", "--no-graph", "-r", "@", "-T", "commit_id")
	require.Regexp(t, `^[a-f0-9]{40}$`, candidate)
	require.NotEqual(t, revision, candidate)
	server, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: httpServer.URL}, cfg.AuthToken)
	q := db.New(local.pool)
	for key, value := range map[string]string{"setup.source.repository": `"chatowner/chatrepo"`, "setup.step.source": `{"status":"done"}`} {
		require.NoError(t, q.UpsertInstallSetting(local.ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	content, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: "http://127.0.0.1:9", SigningKey: []byte(strings.Repeat("c", 32))})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, content.Close()) })
	wiki := services.NewWikiService(q, nil, services.WithWikiContent(content))
	_, err = wiki.CreateWikiPage(local.ctx, local.actor, "chatowner", "chatrepo", services.CreateWikiPageInput{Title: "Webhooks", Slug: "public", Body: "Public wiki context"})
	require.NoError(t, err)
	private, err := services.WithWikiVisibility(local.ctx, "private")
	require.NoError(t, err)
	_, err = wiki.CreateWikiPage(private, local.actor, "chatowner", "chatrepo", services.CreateWikiPageInput{Title: "Private page", Slug: "private", Body: "private-wiki-canary"})
	require.NoError(t, err)
	branches := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(local.pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)))
	return services.InstallContext{Source: services.InstallSource{Pool: local.pool, Repos: services.NewRepoService(q, client, ""), Members: identity.NewMemberBoundary(q)}, Wiki: wiki, Branches: branches}, revision, candidate
}

func seedComposedContextHistory(t *testing.T, local *localChat, author int64) {
	t.Helper()
	store, err := chat.NewStore(local.pool)
	require.NoError(t, err)
	scope := chat.Scope{UserID: author, RepositoryID: local.repoID, Owner: "ben"}
	for i := 0; i < 500; i++ {
		run := fmt.Sprintf("shared-history-%03d", i)
		request, _ := json.Marshal(map[string]any{"runId": run, "conversationId": "main", "sharedConversation": true, "instructions": "Answer", "messages": []map[string]string{{"role": "user", "content": fmt.Sprintf("Shared prompt %03d", i)}}})
		admitted, err := store.Admit(local.ctx, chat.AdmitInput{Scope: scope, RunID: run, Journal: chat.JournalRequest{Version: 1, LegID: "leg-" + run, Token: strings.Repeat("h", 48)}, Request: request})
		require.NoError(t, err)
		grant, err := store.Claim(local.ctx, scope, admitted.TurnID, time.Minute)
		require.NoError(t, err)
		frame, _ := json.Marshal(map[string]string{"runId": run, "type": "delta", "kind": "text", "text": fmt.Sprintf("Shared answer %03d", i)})
		done, _ := json.Marshal(map[string]string{"runId": run, "type": "done", "reason": "stop"})
		_, err = store.Commit(local.ctx, chat.CommitInput{TurnID: admitted.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor, Frames: []json.RawMessage{frame, done}})
		require.NoError(t, err)
	}
}
