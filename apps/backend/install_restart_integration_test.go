package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Uses the existing compiled test-backend entry and real production composition.
// The process runtime is tests-only; this never qualifies VM recipe isolation.
func TestInstallSetupCompiledHostRestart(t *testing.T) {
	for _, boundary := range []string{"running admission", "address effect"} {
		t.Run(boundary, func(t *testing.T) { testInstallSetupCompiledHostRestart(t, boundary) })
	}
}

func testInstallSetupCompiledHostRestart(t *testing.T, boundary string) {
	if os.Getenv("SMITHERS_FFI_LIBRARY_PATH") == "" {
		t.Skip("SMITHERS_FFI_LIBRARY_PATH required for compiled host restart")
	}
	pool, databaseURL := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	root := t.TempDir()
	// No flow/model executes during address setup. Pinned unused host fixtures
	// satisfy the ordinary composition without adding a production fault hook.
	host := []byte("#!/bin/sh\nexit 1\n")
	for _, name := range []string{"coding-host", "model-host"} {
		require.NoError(t, os.WriteFile(filepath.Join(root, name), host, 0700))
	}
	sum := sha256.Sum256(host)
	digest := hex.EncodeToString(sum[:])
	require.NoError(t, os.WriteFile(filepath.Join(root, "model-host.sha256"), []byte(digest+"  model-host\n"), 0600))
	manifest := `{"version":1,"hosts":{"coding":{"executable":"coding-host","sha256":"` + digest + `","flows":["coding/dispatch"]}}}`
	require.NoError(t, os.WriteFile(filepath.Join(root, "flow-hosts.json"), []byte(manifest), 0600))
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := listener.Addr().String()
	require.NoError(t, listener.Close())
	origin := "http://" + addr
	state := filepath.Join(root, "state")
	environment := map[string]string{
		testBackendServe: "1", "SMITHERS_WORKSPACE_ISOLATION": "process",
		"SMITHERS_DATABASE_URL": databaseURL, "SMITHERS_DATA_ROOT": state,
		"SMITHERS_NATIVE_POSTGRES_BIN": "", "SMITHERS_NATIVE_STATE_DIR": state,
		"SMITHERS_BLOB_DATA_DIR": filepath.Join(state, "blobs"),
		"SMITHERS_AUTH_MODE":     "selfhost", "SMITHERS_AUTH_BOOTSTRAP_TOKEN": "restart-bootstrap",
		"SMITHERS_AUTH_SESSION_SECRET": "restart-session-secret", "SMITHERS_LFS_SIGNING_SECRET": "restart-lfs-secret",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "restart-encryption-secret",
		"SMITHERS_REPO_HOST_AUTH_TOKEN":          "restart-repo-token", "SMITHERS_PUSH_HOOK_CALLBACK_TOKEN": "restart-push-token",
		"SMITHERS_SERVER_ADDR": addr, "SMITHERS_PUBLIC_URL": origin,
		"SMITHERS_FLOW_HOST_MANIFEST": filepath.Join(root, "flow-hosts.json"),
		"SMITHERS_MODEL_HOST_BUNDLE":  filepath.Join(root, "model-host"), "SMITHERS_NODE_BINARY": "/bin/sh",
		"SMITHERS_FEATURE_FLAGS_WORKFLOWS": "false", "SMITHERS_FEATURE_FLAGS_SANDBOXES": "true",
		"SMITHERS_WORKSPACE_JJ_EXPORT_BINARY": filepath.Join(filepath.Dir(os.Getenv("SMITHERS_FFI_LIBRARY_PATH")), "smithers-jj-export"),
	}
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	client := &http.Client{Jar: jar, Timeout: 3 * time.Second}
	start := func() (*exec.Cmd, <-chan []string) {
		command := exec.Command(os.Args[0], "-test.run=^TestServeTrustedProcessBackend$", "-test.count=1", "-test.timeout=0")
		command.Env = os.Environ()
		for key, value := range environment {
			command.Env = append(command.Env, key+"="+value)
		}
		stdout, err := command.StdoutPipe()
		require.NoError(t, err)
		// Captures stay local: setup tokens must never enter test logs.
		stderr := &bytes.Buffer{}
		command.Stderr = stderr
		bootFailure := make(chan string, 1)
		minted := make(chan []string, 1)
		require.NoError(t, command.Start())
		go func() {
			scanner := bufio.NewScanner(stdout)
			for scanner.Scan() {
				if strings.Contains(scanner.Text(), "test_backend_test.go:") {
					bootFailure <- scanner.Text()
				}
				var line struct {
					URLs []string `json:"setup_urls"`
				}
				if json.Unmarshal(scanner.Bytes(), &line) == nil && len(line.URLs) > 0 {
					select {
					case minted <- line.URLs:
					default:
					}
				}
			}
		}()
		t.Cleanup(func() { _ = command.Process.Kill(); _ = command.Wait() })
		require.Eventually(t, func() bool {
			select {
			case failure := <-bootFailure:
				t.Fatalf("compiled host startup: %s", failure)
			default:
			}
			response, err := client.Get(origin + "/readyz")
			if err != nil {
				return false
			}
			response.Body.Close()
			return response.StatusCode == 200
		}, 60*time.Second, 100*time.Millisecond, "compiled host did not become ready")
		return command, minted
	}
	command, minted := start()
	var setupURLs []string
	select {
	case setupURLs = <-minted:
	case <-time.After(5 * time.Second):
		t.Fatal("setup URL was not emitted")
	}
	// Exchange once, then use only the setup-session cookie, including after restart.
	setupURL, err := url.Parse(setupURLs[0])
	require.NoError(t, err)
	response, err := client.Get(origin + setupURL.RequestURI())
	require.NoError(t, err)
	response.Body.Close()
	// Hold the selected crash boundary using a test-owned PostgreSQL lock.
	// Running admission commits before either worker claim or completion.
	lock, err := pool.Acquire(ctx)
	require.NoError(t, err)
	defer lock.Release()
	_, err = lock.Exec(ctx, `SELECT pg_advisory_lock(90345506)`)
	require.NoError(t, err)
	barrierTable := "install_settings"
	if boundary == "running admission" {
		barrierTable = "product_job_dispatches"
		_, err = pool.Exec(ctx, `CREATE FUNCTION hold_setup_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.claim_token IS NOT NULL THEN PERFORM pg_advisory_xact_lock(90345506); END IF; RETURN NEW; END $$; CREATE TRIGGER hold_setup_completion BEFORE UPDATE ON product_job_dispatches FOR EACH ROW EXECUTE FUNCTION hold_setup_completion()`)
	} else {
		_, err = pool.Exec(ctx, `CREATE FUNCTION hold_setup_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key='setup.step.address' AND NEW.value->>'status'='done' THEN PERFORM pg_advisory_xact_lock(90345506); END IF; RETURN NEW; END $$; CREATE TRIGGER hold_setup_completion BEFORE UPDATE ON install_settings FOR EACH ROW EXECUTE FUNCTION hold_setup_completion()`)
	}
	require.NoError(t, err)
	post := func(key string) jobs.RequestReceipt {
		request, err := http.NewRequestWithContext(ctx, "POST", origin+"/api/install/setup/address", strings.NewReader(`{"bind":"127.0.0.1:4000","origins":["http://localhost:4000"]}`))
		require.NoError(t, err)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", origin)
		request.Header.Set("Idempotency-Key", key)
		for _, cookie := range jar.Cookies(request.URL) {
			if cookie.Name == "__csrf" {
				request.Header.Set("X-CSRF-Token", cookie.Value)
			}
		}
		response, err := client.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		require.Equal(t, 202, response.StatusCode)
		var receipt jobs.RequestReceipt
		require.NoError(t, json.NewDecoder(response.Body).Decode(&receipt))
		return receipt
	}
	admitted := post("before-crash")
	require.Eventually(t, func() bool {
		var held bool
		err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=90345506 AND NOT granted)`).Scan(&held)
		return err == nil && held
	}, 10*time.Second, 20*time.Millisecond)
	var before struct {
		Status      string `json:"status"`
		OperationID string `json:"operation_id"`
	}
	var stored []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT value FROM install_settings WHERE key='setup.step.address'`).Scan(&stored))
	require.NoError(t, json.Unmarshal(stored, &before))
	require.Equal(t, "running", before.Status)
	require.Equal(t, admitted.OperationID, before.OperationID)
	var externalStarted bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT external_started_at IS NOT NULL FROM product_job_dispatches WHERE operation_id=$1`, admitted.OperationID).Scan(&externalStarted))
	require.Equal(t, boundary == "address effect", externalStarted)
	require.NoError(t, command.Process.Kill())
	require.Error(t, command.Wait())
	_, err = lock.Exec(ctx, `SELECT pg_advisory_unlock(90345506)`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `DROP TRIGGER hold_setup_completion ON `+barrierTable+`; DROP FUNCTION hold_setup_completion()`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1 AND status='claimed'`, admitted.OperationID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_set(value,'{expires_at}',to_jsonb(clock_timestamp()-interval '1 second')) WHERE key='setup.step.address'`)
	require.NoError(t, err)
	// Restart with identical state root and database; cookie remains valid.
	command, _ = start()
	// Recovery may finish before Retry. GET must eventually certify completion.
	require.Eventually(t, func() bool {
		response, err := client.Get(origin + "/api/install")
		if err != nil {
			return false
		}
		defer response.Body.Close()
		var model struct{ Steps []struct{ ID, State string } }
		return response.StatusCode == 200 && json.NewDecoder(response.Body).Decode(&model) == nil && len(model.Steps) == 7 && model.Steps[0].ID == "address" && model.Steps[0].State == "done"
	}, 15*time.Second, 50*time.Millisecond)
	var operation string
	var completions int
	require.NoError(t, pool.QueryRow(ctx, `SELECT value->>'operation_id' FROM install_settings WHERE key='setup.step.address'`).Scan(&operation))
	require.Equal(t, admitted.OperationID, operation)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE operation_id=$1 AND event_type='operation.completed'`, operation).Scan(&completions))
	require.Equal(t, 1, completions)

	// Exercise the owner setting through the compiled HTTP boundary, then
	// restart: existing hosts must observe the durable gate without rebuilding.
	var ownerID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('restart-owner','restart-owner') RETURNING id`).Scan(&ownerID))
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, ownerID)
	require.NoError(t, err)
	// Repository choice has its own GitHub qualification. This setting test
	// starts with a chosen repository and never requests its remote inventory.
	_, err = pool.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES('repository','"restart-owner/app"')`)
	require.NoError(t, err)
	ownerToken := "restart-owner-session"
	ownerHash := sha256.Sum256([]byte(ownerToken))
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES($1,$2,'restart-owner',$3)`, hex.EncodeToString(ownerHash[:]), ownerID, time.Now().Add(time.Hour))
	require.NoError(t, err)
	ownerURL, err := url.Parse(origin)
	require.NoError(t, err)
	jar.SetCookies(ownerURL, []*http.Cookie{
		{Name: "smithers_setup_session", Value: "", Path: "/", MaxAge: -1},
		{Name: "smithers_session", Value: ownerToken, Path: "/"},
	})
	setChatGPT := func(enabled bool) {
		t.Helper()
		body, err := json.Marshal(map[string]bool{"chatgpt": enabled})
		require.NoError(t, err)
		request, err := http.NewRequestWithContext(ctx, "PUT", origin+"/api/install", bytes.NewReader(body))
		require.NoError(t, err)
		request.Header.Set("Origin", origin)
		request.Header.Set("Content-Type", "application/json")
		for _, cookie := range jar.Cookies(ownerURL) {
			if cookie.Name == "__csrf" {
				request.Header.Set("X-CSRF-Token", cookie.Value)
			}
		}
		response, err := client.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		raw, readErr := io.ReadAll(response.Body)
		require.NoError(t, readErr)
		require.Equal(t, 200, response.StatusCode, string(raw))
		var status struct {
			ChatGPT bool `json:"chatgpt"`
		}
		require.NoError(t, json.Unmarshal(raw, &status))
		require.Equal(t, enabled, status.ChatGPT)
	}
	setChatGPT(true)
	// Only the test-owned child is killed. Its successor reads the same database.
	require.NoError(t, command.Process.Kill())
	require.Error(t, command.Wait())
	start()
	response, err = client.Get(origin + "/api/install")
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, 200, response.StatusCode)
	var status struct {
		ChatGPT bool `json:"chatgpt"`
	}
	require.NoError(t, json.NewDecoder(response.Body).Decode(&status))
	require.True(t, status.ChatGPT)
	setChatGPT(false)
}
