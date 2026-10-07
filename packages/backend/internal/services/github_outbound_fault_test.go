package services

import (
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
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// These are process-fault receipts for the production claimed worker and App
// adapters, not the joint C-DUR-03 acceptance: candidate setup still uses the
// publication fixture until the production stack.propose dispatcher is bound.
func TestGitHubOutboundProcessKill(t *testing.T) {
	for _, kind := range []string{"push", "open", "body", "merge", "close"} {
		for _, cut := range []string{"before-send", "potentially-sent", "remote-success", "drop-after-open", "held-create", "v2-after-body"} {
			if cut == "v2-after-body" && kind != "body" {
				continue
			}
			if (cut == "drop-after-open" || cut == "held-create") && kind != "open" {
				continue
			}
			t.Run(kind+"/"+cut, func(t *testing.T) {
				bodyV2 := cut == "v2-after-body"
				if bodyV2 {
					cut = "remote-success"
				}
				heldCreate := cut == "held-create"
				dropAfterOpen := cut == "drop-after-open" || heldCreate
				if dropAfterOpen && !heldCreate {
					cut = "remote-success"
				}
				h := newMergeHarness(t)
				var n, pr int64
				var head string
				if kind == "push" || kind == "open" {
					item := h.todo("Crash recovery", "Do crash recovery", h.main, "crash.md", "fixed candidate bytes\n")
					n = item.Number.Int64
				} else {
					n, head, pr = h.first("Crash recovery")
				}
				switch kind {
				case "close":
					_, err := h.drop(n, "drop-crash")
					require.NoError(t, err)
				case "merge":
					require.NoError(t, h.press(h.ctx, n, head))
				case "body":
					h.reviewed(n, "approve")
				}
				pool := h.pool.(*pgxpool.Pool)
				ready := filepath.Join(t.TempDir(), "barrier")
				release := func() {}
				if heldCreate {
					destination, err := url.Parse(h.fake.URL)
					require.NoError(t, err)
					proxy := httputil.NewSingleHostReverseProxy(destination)
					held := make(chan struct{})
					var once sync.Once
					release = func() { once.Do(func() { close(held) }) }
					defer release()
					proxy.ModifyResponse = func(response *http.Response) error {
						if response.Request.Method == "POST" && response.Request.URL.Path == "/repos/rehearsal-owner/app/pulls" {
							if err := os.WriteFile(ready, []byte("ready"), 0600); err != nil {
								return err
							}
							<-held
						}
						return nil
					}
					server := httptest.NewServer(proxy)
					t.Cleanup(server.Close)
					t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", server.URL)
				}
				binary, err := os.Executable()
				require.NoError(t, err)
				command := exec.Command(binary, "-test.run=^TestGitHubOutboundFaultWorker$", "-test.v", "-test.short")
				command.Env = append(os.Environ(),
					"SMITHERS_FAULT_DATABASE="+pool.Config().ConnString(),
					"SMITHERS_FAULT_HOST="+h.hostDir,
					"SMITHERS_FAULT_REPO="+strconv.FormatInt(h.repoID, 10),
					"SMITHERS_FAULT_KIND="+kind, "SMITHERS_FAULT_CUT="+cut,
					"SMITHERS_FAULT_READY="+ready)
				// Kill only this child and its git children; no shared VM process is signalled.
				command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
				log, err := os.Create(filepath.Join(t.TempDir(), "worker.log"))
				require.NoError(t, err)
				defer log.Close()
				command.Stdout, command.Stderr = log, log
				require.NoError(t, command.Start())
				done := make(chan error, 1)
				go func() { done <- command.Wait() }()
				waited := false
				defer func() {
					if !waited {
						_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
						_ = <-done
					}
				}()
				deadline := time.Now().Add(45 * time.Second)
				for {
					select {
					case err := <-done:
						waited = true
						raw, _ := os.ReadFile(log.Name())
						t.Fatalf("worker exited before %s: %v\n%s", cut, err, raw)
					default:
					}
					if _, err := os.Stat(ready); err == nil {
						break
					}
					if time.Now().After(deadline) {
						raw, _ := os.ReadFile(log.Name())
						t.Fatalf("worker did not reach %s: %s", cut, raw)
					}
					time.Sleep(20 * time.Millisecond)
				}
				pending := h.operation(n)
				require.Equal(t, kind, pending.Kind)
				expectedState := "unknown"
				if cut == "before-send" {
					expectedState = "intended"
				}
				require.Equal(t, expectedState, pending.State)
				if heldCreate {
					_, err := h.drop(n, "drop-held-create")
					require.NoError(t, err)
				}
				require.NoError(t, syscall.Kill(-command.Process.Pid, syscall.SIGKILL))
				err = <-done
				waited = true
				var exit *exec.ExitError
				require.ErrorAs(t, err, &exit)
				require.Equal(t, syscall.SIGKILL, exit.Sys().(syscall.WaitStatus).Signal())
				t.Logf("killed %s at %s; retained slot=%s", kind, cut, h.item(n).PendingOp)
				if dropAfterOpen && !heldCreate {
					_, err := h.drop(n, "drop-after-lost-open")
					require.NoError(t, err)
					require.Equal(t, "open", h.operation(n).Kind, "Drop retains the late-created PR obligation")
				}

				if bodyV2 {
					h.reviewed(n, "request-changes")
					require.Equal(t, pending, h.operation(n), "v2 cannot replace the uncertain v1 slot")
				}

				// Model lease expiry after the killed process. The restarted worker claims
				// the same durable stack; it never calls a recovery helper directly.
				h.exec(`UPDATE mythical_stacks SET lease_expires_at=NOW()-interval '1 second',next_attempt_at=NOW() WHERE repository_id=$1`, h.repoID)
				restartCtx, cancelRestart := context.WithTimeout(context.Background(), 60*time.Second)
				defer cancelRestart()
				restart := exec.CommandContext(restartCtx, binary, "-test.run=^TestGitHubOutboundFaultWorker$", "-test.v", "-test.short")
				for _, env := range command.Env {
					if strings.HasPrefix(env, "SMITHERS_FAULT_CUT=") {
						env = "SMITHERS_FAULT_CUT=restart"
					}
					restart.Env = append(restart.Env, env)
				}
				restart.Stdout, restart.Stderr = log, log
				require.NoError(t, restart.Run(), "restarted process failed; log at %s", log.Name())
				// The restarted worker reconciles the applied creation while its
				// original response is still held. Drop closes it without another POST.
				release()
				trace, err := os.ReadFile(ready)
				require.NoError(t, err)
				lookups, err := strconv.Atoi(string(trace))
				require.NoError(t, err)
				settled := h.item(n)
				require.Empty(t, settled.PendingOp, settled.Reason)
				require.Positive(t, lookups, "restart must consult GitHub")
				switch kind {
				case "push", "open":
					if dropAfterOpen {
						require.Equal(t, "cancelled", settled.State)
						require.Equal(t, "closed", h.pull(settled.PRNumber.Int64).State)
						require.Len(t, h.bodyWrites(), 1)
					} else {
						require.Equal(t, "proposed", settled.State)
					}
					require.Len(t, h.pullCreates(), 1, "one PR across SIGKILL")
					pushes := 0
					for _, write := range h.writes() {
						if write == "POST /rehearsal-owner/app.git/git-receive-pack" {
							pushes++
						}
					}
					require.Equal(t, 1, pushes, "one remote push across SIGKILL")
					require.Equal(t, settled.PRHead, h.githubRef("smithers/crash-recovery"))
					require.Equal(t, h.hostTree(settled.CandidateHead), h.git(h.github, "rev-parse", settled.PRHead+"^{tree}"))
				case "body":
					if bodyV2 {
						require.Contains(t, h.pull(pr).Body, "Review: request-changes")
						require.Len(t, h.bodyWrites(), 2, "v2 follows settled v1")
						var bodies []string
						for _, write := range h.fake.Writes() {
							if write.Method == "PATCH" && write.Path == "/repos/rehearsal-owner/app/pulls/1" {
								var payload struct{ Body string }
								require.NoError(t, json.Unmarshal(write.Body, &payload))
								bodies = append(bodies, payload.Body)
							}
						}
						require.Len(t, bodies, 2)
						require.Contains(t, bodies[0], "Review: approve")
						require.Contains(t, bodies[1], "Review: request-changes")
					} else {
						require.Contains(t, h.pull(pr).Body, "Review: approve")
						require.Len(t, h.bodyWrites(), 1, "one effective body update across SIGKILL")
					}
					require.Equal(t, "proposed", settled.State)
				case "merge":
					require.True(t, h.pull(pr).Merged)
					require.Len(t, h.merges(), 1, "one merge across SIGKILL")
					require.Equal(t, "landed", settled.State)
				case "close":
					require.Equal(t, "closed", h.pull(pr).State)
					require.Len(t, h.bodyWrites(), 1, "one close across SIGKILL")
					require.Len(t, h.comments(pr), 1, "canonical marker deduplicates the Drop comment")
					require.Equal(t, "cancelled", settled.State)
				}
				t.Logf("settled state=%s pr_state=%s lookups=%d", settled.State, settled.PRState, lookups)
			})
		}
	}
}

func TestGitHubOutboundFaultWorker(t *testing.T) {
	dsn := os.Getenv("SMITHERS_FAULT_DATABASE")
	if dsn == "" {
		t.Skip("subprocess fixture only")
	}
	ctx := context.Background()
	pool, err := postgresfixture.Open(ctx, dsn, 3)
	require.NoError(t, err)
	defer pool.Close()
	host := &recordingRepoHost{gitBackedRepoHost: newGitBackedRepoHost(t, os.Getenv("SMITHERS_FAULT_HOST"))}
	require.NoError(t, host.importGitRefs())
	service := NewMythicalService(pool, host)
	service.scratchRoot = filepath.Join(t.TempDir(), "scratch")
	codec, err := webhook.NewSecretCodec("publication-sealing-key")
	require.NoError(t, err)
	credentials := NewGitHubAppCredentialStore(pool, codec)
	userRepos := NewGitHubUserReposService(db.New(pool), fakeOAuthTokenDecrypter{token: "ghu_githubfake_owner"})
	connections := NewRepoConnectionService(pool, credentials)
	connections.SetGitHubRepoAccessVerifier(userRepos)
	service.SetOrchestration(NewMythicalGitHub(db.New(pool), connections, userRepos, connections), nil, nil)
	service.SetPolicyReader(mergePolicy())
	service.SetPublicURL("http://smithers.test")
	service.EnableTodoPublication(credentials, connections, NewBudgetTracker())
	kind, cut := os.Getenv("SMITHERS_FAULT_KIND"), os.Getenv("SMITHERS_FAULT_CUT")
	barrier := func() {
		require.NoError(t, os.WriteFile(os.Getenv("SMITHERS_FAULT_READY"), []byte("ready"), 0600))
		select {} // parent must SIGKILL, so defers cannot manufacture graceful recovery
	}
	lookups := 0
	lookup := service.outbound.Lookup
	service.outbound.Lookup = func(st *mythicalItemStep, ctx context.Context, item db.MythicalItem, op MythicalOutboundOp) (string, bool, error) {
		if op.Kind == kind {
			lookups++
		}
		if op.Kind == kind && cut == "before-send" {
			barrier()
		}
		return lookup(st, ctx, item, op)
	}
	send := service.outbound.Send
	service.outbound.Send = func(st *mythicalItemStep, ctx context.Context, item db.MythicalItem, op MythicalOutboundOp) error {
		if op.Kind == kind && cut == "potentially-sent" {
			barrier()
		}
		err := send(st, ctx, item, op)
		if err == nil && op.Kind == kind && cut == "remote-success" {
			barrier()
		}
		return err
	}
	prepare := service.outbound.PrepareMerge
	service.outbound.PrepareMerge = func(st *mythicalItemStep, ctx context.Context, item db.MythicalItem, op MythicalOutboundOp) (mythicalMergeDispatch, error) {
		dispatch, err := prepare(st, ctx, item, op)
		if err != nil {
			return dispatch, err
		}
		send := dispatch.send
		dispatch.send = func(ctx context.Context, item db.MythicalItem) error {
			if cut == "potentially-sent" {
				barrier()
			}
			err := send(ctx, item)
			if err == nil && cut == "remote-success" {
				barrier()
			}
			return err
		}
		return dispatch, nil
	}
	repo, err := strconv.ParseInt(os.Getenv("SMITHERS_FAULT_REPO"), 10, 64)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at=NOW() WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	service.MainMoved(ctx, repo)
	require.NoError(t, service.PollOnce(ctx))
	if cut == "restart" {
		for i := 0; i < 3; i++ {
			_, err := pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at=NOW() WHERE repository_id=$1`, repo)
			require.NoError(t, err)
			service.MainMoved(ctx, repo)
			require.NoError(t, service.PollOnce(ctx))
		}
		require.NoError(t, os.WriteFile(os.Getenv("SMITHERS_FAULT_READY"), []byte(strconv.Itoa(lookups)), 0600))
		return
	}
	row, err := db.New(pool).GetMythicalStack(ctx, repo)
	require.NoError(t, err)
	raw, _ := json.Marshal(row)
	t.Fatal(fmt.Sprintf("worker ended before barrier: %s", strings.TrimSpace(string(raw))))
}
