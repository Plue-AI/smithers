package compose

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The fault wrappers call the real issuer and launcher, then terminate the
// entire worker process without running cleanup. They never replace either
// provider. The parent retains PostgreSQL and the authenticated install HTTP
// router, and a fresh worker recovers exclusively from the committed journal.
type crashTurnAPI struct {
	services.InstallAPI
	point, receipt string
}

func (a crashTurnAPI) Begin(ctx context.Context, c middleware.Credential, user int64, turn string, generation int64) (services.TurnAPI, error) {
	credential, err := a.InstallAPI.Begin(ctx, c, user, turn, generation)
	if err == nil && a.point != "recover" {
		raw, _ := json.Marshal(credential)
		if err := os.WriteFile(a.receipt, raw, 0600); err != nil {
			os.Exit(84)
		}
		if a.point == "after-mint" {
			os.Exit(82)
		}
	}
	return credential, err
}

type crashTurnLauncher struct {
	modelhost.Launcher
	point, receipt string
}

func (l crashTurnLauncher) LaunchChatHost(ctx context.Context, grant ports.ChatTurnGrant, binding modelhost.Binding) (modelhost.Lease, error) {
	lease, err := l.Launcher.LaunchChatHost(ctx, grant, binding)
	if err == nil && l.point == "after-lease" {
		endpoint, _, _ := lease.Endpoint()
		if err := os.WriteFile(l.receipt+".endpoint", []byte(endpoint), 0600); err != nil {
			os.Exit(84)
		}
		os.Exit(83)
	}
	return lease, err
}

func TestBranchTurnCrashWorker(t *testing.T) {
	point := os.Getenv("SMITHERS_CONVERSATION_CRASH_POINT")
	if point == "" {
		t.Skip("subprocess entry for TestBranchTurnQueueRecovery")
	}
	ctx := t.Context()
	pool, err := postgresfixture.Open(ctx, os.Getenv("SMITHERS_CONVERSATION_CRASH_DB"), 4)
	require.NoError(t, err)
	defer pool.Close()
	q := db.New(pool)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	auth := services.NewAuthService(q, cfg.Auth, nil, nil)
	auth.Members = &services.Members{Pool: pool, Credentials: rosterAppCredentials{}, Minter: services.NewRepoConnectionService(nil, rosterAppCredentials{})}
	runtime, err := process.New(process.Config{Root: os.Getenv("SMITHERS_CONVERSATION_CRASH_ROOT")})
	require.NoError(t, err)
	defer runtime.Close()
	launcher, err := modelhost.NewLocalLauncher(modelhost.LocalConfig{Runtime: runtime, NodeBinary: os.Getenv("SMITHERS_CONVERSATION_CRASH_NODE"), BundlePath: os.Getenv("SMITHERS_CONVERSATION_CRASH_BUNDLE")})
	require.NoError(t, err)
	resolver, err := modelhost.NewOwnerSecretResolver(func() string { return os.Getenv("SMITHERS_CONVERSATION_CRASH_DB") }, func() string { return "local-chat-secret-key" })
	require.NoError(t, err)
	host, err := modelhost.New(resolver, crashTurnLauncher{Launcher: launcher, point: point, receipt: os.Getenv("SMITHERS_CONVERSATION_CRASH_RECEIPT")})
	require.NoError(t, err)
	defer host.Close(context.Background())
	var repoID int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM repositories WHERE lower_name='chatrepo'`).Scan(&repoID))
	source := conversationContextSource(t, &localChat{ctx: ctx, pool: pool, repoID: repoID})
	composition, err := newChatComposition(runOptions{topology: localTopology, Options: Options{ChatHost: host}}, pool, chat.RuntimeOptions{
		Lease: time.Second, Concurrency: 1, ContextRepository: source.Read,
		API: crashTurnAPI{InstallAPI: services.InstallAPI{Auth: auth}, point: point, receipt: os.Getenv("SMITHERS_CONVERSATION_CRASH_RECEIPT")},
	})
	require.NoError(t, err)
	defer composition.close()
	composition.runtime.Handler.ResolveBranch = conversationBranchResolver(source.Branches.(*services.WorkspaceService))
	upstream, err := url.Parse(os.Getenv("SMITHERS_CONVERSATION_CRASH_ORIGIN"))
	require.NoError(t, err)
	composition.server.Handler = chatCallbackHandler(composition.runtime, httputil.NewSingleHostReverseProxy(upstream))
	go composition.server.Serve(composition.listener)
	defer composition.server.Close()
	require.NoError(t, composition.runtime.Run(ctx))
}

func TestBranchTurnQueueRecovery(t *testing.T) {
	for _, point := range []string{"after-mint", "after-lease"} {
		t.Run(point, func(t *testing.T) {
			f := workingConversation(t)
			// Keep the public install running, but put dispatch in a separate process
			// so the crash genuinely bypasses every Go defer and launcher cleanup.
			f.local.stopDispatch()
			require.NoError(t, <-f.local.dispatchDone)
			f.local.dispatchDone <- nil // local.stop still owns final fixture shutdown.
			turn := f.prompt(t, "ben", "Recover this prompt")
			root, receipt := t.TempDir(), filepath.Join(t.TempDir(), "credential.json")
			run := func(phase string) (*exec.Cmd, *lockedBuffer) {
				command := exec.Command(os.Args[0], "-test.run=^TestBranchTurnCrashWorker$", "-test.timeout=60s")
				command.Env = append(os.Environ(),
					"SMITHERS_CONVERSATION_CRASH_POINT="+phase,
					"SMITHERS_CONVERSATION_CRASH_DB="+f.local.pool.Config().ConnString(),
					"SMITHERS_CONVERSATION_CRASH_ROOT="+root,
					"SMITHERS_CONVERSATION_CRASH_NODE="+f.local.nodeBinary,
					"SMITHERS_CONVERSATION_CRASH_BUNDLE="+f.local.hostBundle,
					"SMITHERS_CONVERSATION_CRASH_RECEIPT="+receipt,
					"SMITHERS_CONVERSATION_CRASH_ORIGIN="+f.origin)
				output := &lockedBuffer{}
				command.Stdout, command.Stderr = output, output
				require.NoError(t, command.Start())
				return command, output
			}
			crashed, logs := run(point)
			err := crashed.Wait()
			var exit *exec.ExitError
			require.ErrorAs(t, err, &exit, logs.String())
			expected := 82
			if point == "after-lease" {
				expected = 83
			}
			require.Equal(t, expected, exit.ExitCode(), logs.String())
			raw, err := os.ReadFile(receipt)
			require.NoError(t, err)
			var old services.TurnAPI
			require.NoError(t, json.Unmarshal(raw, &old))
			require.NotEmpty(t, old.Token)
			// Authentication must fence the abandoned generation even before restart.
			require.Eventually(t, func() bool {
				request, err := http.NewRequest("GET", f.origin+"/api/user", nil)
				if err != nil {
					return false
				}
				request.Header.Set("Authorization", "Bearer "+old.Token)
				response, err := f.local.client.Do(request)
				if err != nil {
					return false
				}
				io.Copy(io.Discard, response.Body)
				response.Body.Close()
				return response.StatusCode == 401
			}, 5*time.Second, 25*time.Millisecond)
			f.mu.Lock()
			require.Empty(t, f.requests, "the crash precedes provider dispatch")
			f.mu.Unlock()
			recovered, recoveryLogs := run("recover")
			t.Cleanup(func() {
				_ = recovered.Process.Kill()
				_ = recovered.Wait()
				if t.Failed() {
					t.Log(recoveryLogs.String())
				}
			})
			f.terminal(t, turn, "completed", 25*time.Second)
			var generation int64
			var leased bool
			require.NoError(t, f.local.pool.QueryRow(f.local.ctx, `SELECT producer_generation,producer_lease_expires_at IS NOT NULL FROM chat_turns WHERE id=$1`, turn).Scan(&generation, &leased))
			require.Equal(t, int64(2), generation, recoveryLogs.String())
			require.False(t, leased)
			// The final producer hash is retained solely for idempotent batch
			// retries; terminal state plus a missing lease rejects authority.
			require.Eventually(t, func() bool {
				request, _ := http.NewRequest("GET", f.origin+"/api/user", nil)
				request.Header.Set("Authorization", "Bearer "+old.Token)
				response, err := f.local.client.Do(request)
				if err != nil {
					return false
				}
				response.Body.Close()
				return response.StatusCode == 401
			}, time.Second, 25*time.Millisecond)
			body := string(f.call(t, "ben", "GET", "/api/conversations/main", "", 200))
			require.Contains(t, body, "Host answer.")
			require.NotContains(t, body, old.Token)
			require.NotContains(t, recoveryLogs.String(), old.Token)
			if point == "after-lease" {
				endpoint, err := os.ReadFile(receipt + ".endpoint")
				require.NoError(t, err)
				client := &http.Client{Timeout: time.Second}
				response, err := client.Get(string(endpoint) + "/health")
				if response != nil {
					response.Body.Close()
				}
				require.Error(t, err, "the old private host must be gone after restart")
			}
		})
	}
}
