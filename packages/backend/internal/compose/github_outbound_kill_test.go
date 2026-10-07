//go:build unix

package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/sandbox/sandboxfake"
	"github.com/stretchr/testify/require"
)

// This control substitutes the accepted candidate/review receipts while
// T-GH-09's packaged stack.propose binding is unavailable. It exercises the
// composed browser callers and production worker, not joint C-DUR-03 acceptance.
// The required matrix also demands github-production-propose, which this
// fixture deliberately cannot emit. Never qualify the substitution as a run.
func TestGitHubOutboundKillComposedCandidateControl(t *testing.T) {
	if os.Getenv("SMITHERS_GITHUB_OUTBOUND_KILL") != "1" {
		t.Skip("enable the composed GitHub kill control explicitly")
	}
	for _, kind := range []string{"push", "open", "body", "merge", "close"} {
		t.Run(kind, func(t *testing.T) {
			r := newRehearsal(t, "SMITHERS_GITHUB_OUTBOUND_KILL", "C-DUR-03", "github-kill-"+kind+"-", 25)
			require.True(t, r.setupSource())
			require.Eventually(t, func() bool {
				var state string
				err := r.pool.QueryRow(r.ctx, `SELECT state FROM mythical_stacks`).Scan(&state)
				return err == nil && state == "active"
			}, 30*time.Second, 50*time.Millisecond)
			r.stopBackend() // leave the repository engine and GitHub peer alive
			r.ctx = t.Context()
			t.Run("crossing", func(t *testing.T) {
				q := db.New(r.pool)
				codec, err := webhook.NewSecretCodec("rehearsal-encryption-key")
				require.NoError(t, err)
				credentials := services.NewGitHubAppCredentialStore(r.pool, codec)
				connections := services.NewRepoConnectionService(r.pool, credentials)
				users := services.NewGitHubUserReposService(q, ownerTokenDecrypter{})
				connections.SetGitHubRepoAccessVerifier(users)
				service := services.NewMythicalService(r.pool, r.repoClient)
				service.SetOrchestration(services.NewMythicalGitHub(q, connections, users, connections), nil, nil)
				service.SetPolicyReader(r.repoClient)
				service.EnableTodoPublication(credentials, connections, services.NewBudgetTracker())
				server := httptest.NewUnstartedServer(nil)
				r.origin = "http://" + server.Listener.Addr().String()
				service.SetPublicURL(r.origin)
				t.Setenv("SMITHERS_PUBLIC_URL", r.origin)
				t.Setenv("SMITHERS_SERVER_ALLOWED_ORIGINS", r.origin)
				server.Config.Handler = startSplitProcess(t, Options{Repository: r.repoClient, Duties: DutiesHTTP, ChatHost: unusedChatHost{}, Workspace: r.processRuntime, ComputeProvider: r.compute, FlowHostProductAPIURL: r.origin})
				server.Start()
				t.Cleanup(server.Close)
				// All source bytes are fixture data. Only the existing publication worker
				// writes the TODO branch, opens its PR and reconciles its pending_op.
				var repository, owner int64
				require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT repository_id,actor_user_id FROM mythical_stacks`).Scan(&repository, &owner))
				head := githubKillCandidate(t, r)
				var number int64
				require.NoError(t, r.pool.QueryRow(r.ctx, `INSERT INTO mythical_items(repository_id,source,state,title,issue_title,revisions,owner_id,candidate_base,candidate_head,candidate_verified,attempt,checks)
    VALUES($1,'todo','proposing','Kill control','Kill control','[{"rev":1,"text":"accepted fixture","acceptance":["passes"]}]',$2,$3,$4,true,1,'{"todo":true,"branch":"smithers/kill-control"}') RETURNING number`, repository, owner, r.mainCommit, head).Scan(&number))
				wake := func() {
					_, err := r.pool.Exec(r.ctx, `UPDATE mythical_stacks SET running=false,lease_expires_at=NOW()-interval '1 second',next_attempt_at=NOW(),requested_generation=requested_generation+1 WHERE repository_id=$1`, repository)
					require.NoError(t, err)
					_, err = r.pool.Exec(r.ctx, `UPDATE mythical_items SET next_attempt_at=NOW() WHERE repository_id=$1`, repository)
					require.NoError(t, err)
				}
				var pr int64
				var published string
				if kind != "push" && kind != "open" {
					wake()
					require.NoError(t, service.PollOnce(r.ctx))
					require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT pr_number,pr_head FROM mythical_items WHERE number=$1 AND state='proposed'`, number).Scan(&pr, &published))
				}
				switch kind {
				case "merge":
					require.NoError(t, r.merge(number, published))
				case "close":
					status, receipt, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", number), `{"op":"drop"}`, "kill-drop")
					require.NoError(t, err)
					require.Equal(t, 202, status, string(receipt))
					status2, replay, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", number), `{"op":"drop"}`, "kill-drop")
					require.NoError(t, err)
					require.Equal(t, status, status2)
					require.JSONEq(t, string(receipt), string(replay))
				case "body":
					review, _ := json.Marshal(map[string]any{"head": published, "candidate": head, "runId": "fixture-review", "verdict": "approve"})
					_, err = r.pool.Exec(r.ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{review}',$2::jsonb) WHERE number=$1`, number, review)
					require.NoError(t, err)
				}
				before := len(r.fake.Writes())
				destination, err := url.Parse(r.fake.URL)
				require.NoError(t, err)
				proxy := httputil.NewSingleHostReverseProxy(destination)
				reached := make(chan struct{})
				release := make(chan struct{})
				var held sync.Once
				var released sync.Once
				unlock := func() { released.Do(func() { close(release) }) }
				defer unlock()
				var traceMu sync.Mutex
				var trace []string
				proxy.ModifyResponse = func(resp *http.Response) error {
					request := resp.Request
					traceMu.Lock()
					trace = append(trace, request.Method+" "+request.URL.Path)
					traceMu.Unlock()
					target := false
					switch kind {
					case "push":
						target = request.Method == "POST" && strings.HasSuffix(request.URL.Path, "/git-receive-pack")
					case "open":
						target = request.Method == "POST" && request.URL.Path == "/repos/rehearsal-owner/app/pulls"
					case "body", "close":
						target = request.Method == "PATCH" && request.URL.Path == fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", pr)
					case "merge":
						target = request.Method == "PUT" && strings.HasSuffix(request.URL.Path, "/merge")
					}
					if target && resp.StatusCode < 300 {
						held.Do(func() { close(reached); <-release })
					}
					return nil
				}
				peer := httptest.NewServer(proxy)
				defer func() { unlock(); peer.Close() }()
				wake()
				child := githubKillWorker(t, peer.URL, r.repositoryRoot)
				defer child.close()
				select {
				case <-reached:
				case err := <-child.done:
					child.waited = true
					t.Fatalf("worker exited before %s crossing: %v; %s", kind, err, child.output())
				case <-time.After(90 * time.Second):
					var state string
					r.pool.QueryRow(r.ctx, `SELECT json_build_object('state',state,'reason',reason,'pending_op',pending_op,'head',candidate_head,'checks',checks)::text FROM mythical_items WHERE number=$1`, number).Scan(&state)
					t.Fatalf("worker did not reach %s: %s; item %s", kind, child.output(), state)
				}
				var slot services.MythicalOutboundOp
				var raw []byte
				require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT pending_op FROM mythical_items WHERE number=$1`, number).Scan(&raw))
				require.NoError(t, json.Unmarshal(raw, &slot))
				require.Equal(t, kind, slot.Kind)
				require.Equal(t, "unknown", slot.State)
				child.kill(t)
				fmt.Printf("CRASH-POINT github-%s subject accepted-candidate-control\n", kind)
				unlock()
				traceMu.Lock()
				trace = nil
				traceMu.Unlock()
				wake()
				restarted := githubKillWorker(t, peer.URL, r.repositoryRoot)
				defer restarted.close()
				require.Eventually(t, func() bool {
					var empty bool
					err := r.pool.QueryRow(r.ctx, `SELECT pending_op IS NULL FROM mythical_items WHERE number=$1`, number).Scan(&empty)
					if err != nil || !empty {
						return false
					}
					card, err := r.todo(number)
					if err != nil {
						return false
					}
					switch kind {
					case "close":
						return card.State == "dropped"
					case "merge":
						return card.State == "merged" || card.State == "merging"
					default:
						return card.State == "in_review"
					}
				}, 60*time.Second, 100*time.Millisecond, "restart: %s", restarted.log.Name())
				traceMu.Lock()
				requests := append([]string(nil), trace...)
				traceMu.Unlock()
				lookup := false
				for _, request := range requests {
					switch kind {
					case "push":
						lookup = lookup || strings.HasPrefix(request, "GET ") && strings.HasSuffix(request, "/info/refs")
					case "open":
						lookup = lookup || request == "GET /repos/rehearsal-owner/app/pulls"
					default:
						lookup = lookup || request == fmt.Sprintf("GET /repos/rehearsal-owner/app/pulls/%d", pr)
					}
				}
				require.True(t, lookup, "restart must look up the recorded operation: %v", requests)
				// An applied write must be looked up, never sent a second time.
				writes := 0
				for _, write := range r.fake.Writes()[before:] {
					switch kind {
					case "push":
						if write.Method == "POST" && strings.HasSuffix(write.Path, "/git-receive-pack") {
							writes++
						}
					case "open":
						if write.Method == "POST" && write.Path == "/repos/rehearsal-owner/app/pulls" {
							writes++
						}
					case "body", "close":
						if write.Method == "PATCH" && write.Path == fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", pr) {
							writes++
						}
					case "merge":
						if write.Method == "PUT" && strings.HasSuffix(write.Path, "/merge") {
							writes++
						}
					}
				}
				require.Equal(t, 1, writes, "one effective write across SIGKILL")
				status, card, err := r.request("GET", fmt.Sprintf("/api/todos/%d", number), "")
				require.NoError(t, err)
				require.Equal(t, 200, status, string(card))
				var projection struct {
					State string `json:"state"`
				}
				require.NoError(t, json.Unmarshal(card, &projection))
				switch kind {
				case "close":
					require.Equal(t, "dropped", projection.State)
				case "merge":
					require.Contains(t, []string{"merged", "merging"}, projection.State)
				default:
					require.Equal(t, "in_review", projection.State)
				}
				remote := filepath.Join(r.gitRoot, "rehearsal-owner/app.git")
				main, err := exec.Command("/usr/bin/git", "--git-dir", remote, "rev-parse", "refs/heads/main").Output()
				require.NoError(t, err)
				if kind != "merge" {
					require.Equal(t, r.mainCommit, strings.TrimSpace(string(main)), "publication never moves main")
				}
				if kind == "push" || kind == "open" || kind == "merge" {
					ref := "refs/heads/smithers/kill-control"
					if kind == "merge" {
						ref = "refs/heads/main"
					}
					contents, err := exec.Command("/usr/bin/git", "--git-dir", remote, "show", ref+":kill.txt").Output()
					require.NoError(t, err)
					require.Equal(t, "accepted fixture\n", string(contents))
				}
				fmt.Printf("CRASH-OBSERVATION {\"point\":\"github-%s\",\"subject\":\"accepted-candidate-control\",\"effectiveWrites\":1}\n", kind)
			})
		})
	}
}

func githubKillCandidate(t *testing.T, r *rehearsal) string {
	t.Helper()
	work := filepath.Join(t.TempDir(), "candidate")
	output, err := exec.Command("/usr/bin/git", "clone", "-q", filepath.Join(r.gitRoot, "rehearsal-owner/app.git"), work).CombinedOutput()
	require.NoError(t, err, string(output))
	require.NoError(t, os.WriteFile(filepath.Join(work, "kill.txt"), []byte("accepted fixture\n"), 0600))
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("/usr/bin/git", append([]string{"-C", work, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test"}, args...)...)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
		return strings.TrimSpace(string(out))
	}
	git("add", "kill.txt")
	git("commit", "-q", "-m", "accepted kill fixture")
	head := git("rev-parse", "HEAD")
	// Import the pack through the engine's existing control-plane receive door.
	pack := exec.Command("/usr/bin/git", "-C", work, "pack-objects", "--all", "--stdout")
	raw, err := pack.Output()
	require.NoError(t, err)
	keep := repohost.MythicalReservedRefNS + "keep/" + head
	update := strings.Repeat("0", 40) + " " + head + " " + keep + "\x00report-status\n"
	body := bytes.NewBufferString(fmt.Sprintf("%04x%s0000", len(update)+4, update))
	_, err = body.Write(raw)
	require.NoError(t, err)
	var repository int64
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT repository_id FROM mythical_stacks`).Scan(&repository))
	var receipt bytes.Buffer
	require.NoError(t, r.repoClient.ProxyReceivePack(r.ctx, "rehearsal-owner", "app", body, &receipt, repohost.ReceivePackMetadata{RepositoryID: repository, ControlPlane: true, PusherLogin: "fixture"}))
	require.Contains(t, receipt.String(), "ok "+keep)
	return head
}

type githubKillProcess struct {
	command *exec.Cmd
	done    chan error
	waited  bool
	log     *os.File
}

func (p *githubKillProcess) output() string { raw, _ := os.ReadFile(p.log.Name()); return string(raw) }

// Stop owned workers before closing their peer on failure. Test cleanup runs
// after function defers; leaving this until Cleanup can strand HTTP shutdown.
func (p *githubKillProcess) close() {
	if !p.waited {
		_ = syscall.Kill(-p.command.Process.Pid, syscall.SIGKILL)
		<-p.done
		p.waited = true
	}
}

func (p *githubKillProcess) kill(t *testing.T) {
	t.Helper()
	require.NoError(t, syscall.Kill(-p.command.Process.Pid, syscall.SIGKILL))
	err := <-p.done
	p.waited = true
	var exit *exec.ExitError
	require.ErrorAs(t, err, &exit)
	require.Equal(t, syscall.SIGKILL, exit.Sys().(syscall.WaitStatus).Signal())
}
func githubKillWorker(t *testing.T, peer, repositoryRoot string) *githubKillProcess {
	t.Helper()
	binary, err := os.Executable()
	require.NoError(t, err)
	log, err := os.Create(filepath.Join(t.TempDir(), "worker.log"))
	require.NoError(t, err)
	command := exec.Command(binary, "-test.run=^TestGitHubOutboundKillChild$", "-test.v")
	command.Env = append(os.Environ(), // This candidate control consumes no blob artifacts. Give each owned
		// worker its own blob store; filesystem stores permit one owner only.
		"SMITHERS_GITHUB_KILL_CHILD=1", "SMITHERS_GITHUB_KILL_REPO_ROOT="+repositoryRoot, "SMITHERS_BLOB_DATA_DIR="+t.TempDir(), "SMITHERS_GITHUB_APP_API_BASE_URL="+peer, "SMITHERS_GITHUB_GIT_BASE_URL="+peer)
	t.Logf("owned worker log: %s", log.Name())
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Stdout = log
	command.Stderr = log
	require.NoError(t, command.Start())
	p := &githubKillProcess{command: command, done: make(chan error, 1), log: log}
	go func() { p.done <- command.Wait() }()
	t.Cleanup(func() {
		p.close()
		require.NoError(t, log.Close())
	})
	return p
}
func TestGitHubOutboundKillChild(t *testing.T) {
	if os.Getenv("SMITHERS_GITHUB_KILL_CHILD") != "1" {
		t.Skip("owned subprocess only")
	}
	engine, err := repository.OpenLocal(repository.Config{StoragePath: os.Getenv("SMITHERS_GITHUB_KILL_REPO_ROOT"), AuthToken: "rehearsal-repo", FFILibraryPath: os.Getenv("SMITHERS_FFI_LIBRARY_PATH"), InstallMainMirror: true})
	require.NoError(t, err)
	defer engine.Shutdown(context.Background())
	require.NoError(t, StartWithOptions(context.Background(), nil, io.Discard, os.Stderr, Options{Repository: engine.Client(), Duties: DutiesWorkers, ComputeProvider: sandboxfake.New()}, func(http.Handler) {}))
}
