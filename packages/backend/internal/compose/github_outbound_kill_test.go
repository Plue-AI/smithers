//go:build unix

package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/sandbox/sandboxfake"
	"github.com/stretchr/testify/require"
)

// Production proposal admission and claimed worker recovery on the reference
// install, using its real machine writer/observations, PostgreSQL, githubfake
// and a bare remote. Linux historical fixture receipts remain supplemental.
func TestGitHubOutboundKillProductionProposal(t *testing.T) {
	if os.Getenv("SMITHERS_GITHUB_OUTBOUND_KILL") != "1" {
		t.Skip("enable the composed GitHub kill control explicitly")
	}
	if os.Getenv("SMITHERS_FAULT_HOST") != "reference" {
		t.Skip("reference machine required for the packaged native writer")
	}
	t.Setenv(pinnedMicroVMRehearsal, "1")
	for _, scenario := range []string{"push", "open", "body", "merge", "close", "open-drop"} {
		kind := strings.TrimSuffix(scenario, "-drop")
		dropLate := scenario == "open-drop"
		for _, point := range []string{"before-send", "potentially-sent", "remote-success"} {
			if dropLate && point != "remote-success" {
				continue
			}
			t.Run(scenario+"/"+point, func(t *testing.T) {
				r := newRehearsal(t, pinnedMicroVMRehearsal, "C-DUR-03", "github-kill-"+kind+"-", 25)
				require.True(t, r.install("Install through Machine ready"))
				// Pause the first intended push at its reconciliation read. No accepted
				// candidate, check result or outbound intent is inserted by this test.
				initialReached, initialRelease := make(chan struct{}), make(chan struct{})
				var initialOnce, initialUnlock sync.Once
				unlockInitial := func() { initialUnlock.Do(func() { close(initialRelease) }) }
				destination, err := url.Parse(r.fake.URL)
				require.NoError(t, err)
				initialProxy := httputil.NewSingleHostReverseProxy(destination)
				initialPeer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
					if request.Method == "GET" && strings.HasSuffix(request.URL.Path, "/info/refs") {
						var pending bool
						_ = r.pool.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM mythical_items WHERE pending_op->>'kind'='push' AND pending_op->>'state'='intended')`).Scan(&pending)
						if pending {
							initialOnce.Do(func() { close(initialReached) })
							select {
							case <-initialRelease:
							case <-request.Context().Done():
								return
							}
						}
					}
					initialProxy.ServeHTTP(w, request)
				}))
				defer func() { unlockInitial(); initialPeer.Close() }()
				t.Setenv("SMITHERS_GITHUB_GIT_BASE_URL", initialPeer.URL)
				var proposalPath, proposalBearer, proposalBody string
				number, err := r.file("Kill control", "Add a greeting to JOURNEY.md")
				require.NoError(t, err)
				// Enter the reserved dispatcher using the actual run's credential
				// and accepted generation, rather than substituting its receipts.
				var workspace string
				var generation, repositoryID, ownerID int64
				var currentRun string
				require.Eventually(t, func() bool {
					return r.pool.QueryRow(r.ctx, `SELECT workspace_id,generation,repository_id,owner_id,request_run_id FROM mythical_items WHERE number=$1 AND candidate_verified AND pending_op->>'kind'='push' AND pending_op->>'state'='intended'`, number).Scan(&workspace, &generation, &repositoryID, &ownerID, &currentRun) == nil
				}, 3*time.Minute, 5*time.Millisecond, "real candidate must reach production propose before publication: %s", r.logs.String())
				// Fixture credential bound to the live attempt, with production
				// authentication/authorization and current membership enforced.
				plaintext := "smithers_1111111111111111111111111111111111111111"
				digest := sha256.Sum256([]byte(plaintext))
				hash := hex.EncodeToString(digest[:])
				scopes := strings.Join([]string{"write:repository", middleware.RepositoryRestrictionScope(repositoryID), middleware.WorkspaceRestrictionScope(workspace), middleware.AgentSessionRestrictionScope(currentRun)}, ",")
				_, err = db.New(r.pool).CreateAccessToken(r.ctx, db.CreateAccessTokenParams{UserID: ownerID, Name: "kill-current-run", TokenHash: hash, TokenLastEight: hash[len(hash)-8:], SystemIssued: true, Scopes: scopes, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
				require.NoError(t, err)
				proposalBearer = "Bearer " + plaintext
				proposalPath = fmt.Sprintf("/api/repos/rehearsal-owner/app/workspaces/%s/stack/propose", workspace)
				proposalBody = fmt.Sprintf(`{"requestId":"22222222-2222-4222-8222-222222222222","generation":%d}`, generation)
				r.stopBackend()
				r.ctx = t.Context()
				unlockInitial()
				t.Setenv("SMITHERS_GITHUB_GIT_BASE_URL", r.fake.URL)
				t.Run("crossing", func(t *testing.T) {
					options := r.options
					options.Duties = DutiesHTTP
					server := httptest.NewUnstartedServer(nil)
					r.origin = "http://" + server.Listener.Addr().String()
					t.Setenv("SMITHERS_PUBLIC_URL", r.origin)
					t.Setenv("SMITHERS_SERVER_ALLOWED_ORIGINS", r.origin)
					options.FlowHostProductAPIURL = r.origin
					server.Config.Handler = startSplitProcess(t, options)
					server.Start()
					t.Cleanup(server.Close)
					var repository int64
					var head string
					require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT repository_id,candidate_head FROM mythical_items WHERE number=$1 AND candidate_verified`, number).Scan(&repository, &head))
					// An accepted proposal replay while its slot is unsettled requests
					// the same work, and cannot replace the durable operation.
					path, bearer, body := proposalPath, proposalBearer, proposalBody
					var proposalReceipt []byte
					var beforeReplay []byte
					require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT pending_op FROM mythical_items WHERE number=$1`, number).Scan(&beforeReplay))
					for range 3 {
						request, err := http.NewRequest("POST", r.origin+path, strings.NewReader(body))
						require.NoError(t, err)
						request.Header.Set("Authorization", bearer)
						request.Header.Set("Content-Type", "application/json")
						response, err := http.DefaultClient.Do(request)
						require.NoError(t, err)
						raw, err := io.ReadAll(response.Body)
						_ = response.Body.Close()
						require.NoError(t, err)
						require.Equal(t, 202, response.StatusCode, string(raw))
						if proposalReceipt == nil {
							proposalReceipt = raw
						} else {
							require.JSONEq(t, string(proposalReceipt), string(raw))
						}
					}
					var afterReplay []byte
					require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT pending_op FROM mythical_items WHERE number=$1`, number).Scan(&afterReplay))
					require.JSONEq(t, string(beforeReplay), string(afterReplay))
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
						prepared := githubKillWorker(t, r.fake.URL, r.repositoryRoot)
						_, err := r.waitTodoWithin(number, 60*time.Second, "in_review")
						prepared.close()
						require.NoError(t, err, prepared.output())
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
					targetWrite := func(request *http.Request) bool {
						switch kind {
						case "push":
							return request.Method == "POST" && strings.HasSuffix(request.URL.Path, "/git-receive-pack")
						case "open":
							return request.Method == "POST" && request.URL.Path == "/repos/rehearsal-owner/app/pulls"
						case "body", "close":
							return request.Method == "PATCH" && request.URL.Path == fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", pr)
						case "merge":
							return request.Method == "PUT" && strings.HasSuffix(request.URL.Path, "/merge")
						}
						return false
					}
					proxy.ModifyResponse = func(resp *http.Response) error {
						if point == "remote-success" && targetWrite(resp.Request) && resp.StatusCode < 300 {
							held.Do(func() { close(reached); <-release })
						}
						return nil
					}
					peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
						traceMu.Lock()
						trace = append(trace, request.Method+" "+request.URL.Path)
						traceMu.Unlock()
						pause := point == "potentially-sent" && targetWrite(request)
						if point == "before-send" && request.Method == "GET" {
							_ = r.pool.QueryRow(t.Context(), `SELECT COALESCE(pending_op->>'kind'=$2 AND pending_op->>'state'='intended',false) FROM mythical_items WHERE number=$1`, number, kind).Scan(&pause)
						}
						if pause {
							blocked := false
							held.Do(func() { blocked = true; close(reached); <-release })
							// The original request is discarded at this barrier even if
							// TCP cancellation is observed after its release.
							if blocked {
								return
							}
						}
						proxy.ServeHTTP(w, request)
					}))
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
					expectedSlot := "unknown"
					if point == "before-send" {
						expectedSlot = "intended"
					}
					require.Equal(t, expectedSlot, slot.State)
					if dropLate {
						// Drop is a real person command while CreatePull's response is
						// held. Its receipt must return without waiting for the worker.
						began := time.Now()
						status, receipt, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", number), `{"op":"drop"}`, "kill-late-drop")
						require.NoError(t, err)
						require.Equal(t, 202, status, string(receipt))
						require.Less(t, time.Since(began), time.Second)
						status2, replay, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", number), `{"op":"drop"}`, "kill-late-drop")
						require.NoError(t, err)
						require.Equal(t, status, status2)
						require.JSONEq(t, string(receipt), string(replay))
						var retained []byte
						require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT pending_op FROM mythical_items WHERE number=$1 AND state='cancelled'`, number).Scan(&retained))
						require.JSONEq(t, string(raw), string(retained), "Drop must retain the uncertain open")
					}
					child.kill(t)
					fmt.Printf("CRASH-POINT github-%s-%s subject todo\n", scenario, point)
					fmt.Println("CRASH-POINT github-production-propose subject todo")
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
						if dropLate {
							return card.State == "dropped"
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
						parts := strings.SplitN(request, " ", 2)
						if len(parts) == 2 && targetWrite(&http.Request{Method: parts[0], URL: &url.URL{Path: parts[1]}}) {
							require.True(t, lookup, "repeat must follow lookup, not merely accompany it: %v", requests)
						}
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
					if dropLate {
						closes := 0
						for _, write := range r.fake.Writes()[before:] {
							if write.Method == "PATCH" && strings.Contains(write.Path, "/pulls/") && strings.Contains(string(write.Body), `"closed"`) {
								closes++
							}
						}
						require.Equal(t, 1, closes, "Drop retains exactly one close obligation for the late-created PR")
					}
					var settled, retainedGeneration int64
					require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='todo.github_operation_settled' AND payload->>'n'=$1 AND payload->'operation'->>'kind'=$2`, fmt.Sprint(number), kind).Scan(&settled))
					require.EqualValues(t, 1, settled, "one committed settlement fact across restart")
					require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT generation FROM mythical_items WHERE number=$1`, number).Scan(&retainedGeneration))
					require.Equal(t, generation, retainedGeneration, "replay and recovery never allocate another candidate")
					// Replay the original accepted request after crash recovery, including
					// after Drop. It returns its receipt without scheduling publication again.
					restarted.close()
					writesBeforeReplay := len(r.fake.Writes())
					var requestsBeforeReplay int64
					require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests`).Scan(&requestsBeforeReplay))
					for range 3 {
						request, err := http.NewRequest("POST", r.origin+path, strings.NewReader(body))
						require.NoError(t, err)
						request.Header.Set("Authorization", bearer)
						request.Header.Set("Content-Type", "application/json")
						response, err := http.DefaultClient.Do(request)
						require.NoError(t, err)
						raw, err := io.ReadAll(response.Body)
						_ = response.Body.Close()
						require.NoError(t, err)
						require.Equal(t, 202, response.StatusCode, string(raw))
						require.JSONEq(t, string(proposalReceipt), string(raw))
					}
					var requestsAfterReplay int64
					require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests`).Scan(&requestsAfterReplay))
					require.Equal(t, requestsBeforeReplay, requestsAfterReplay, "settled replay creates no durable work")
					require.Len(t, r.fake.Writes(), writesBeforeReplay)
					var settledSlot []byte
					require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT pending_op FROM mythical_items WHERE number=$1`, number).Scan(&settledSlot))
					require.Empty(t, settledSlot, "settled replay cannot recreate an outbound slot")
					status, card, err := r.request("GET", fmt.Sprintf("/api/todos/%d", number), "")
					require.NoError(t, err)
					require.Equal(t, 200, status, string(card))
					var projection struct {
						State string `json:"state"`
					}
					require.NoError(t, json.Unmarshal(card, &projection))
					switch {
					case kind == "close" || dropLate:
						require.Equal(t, "dropped", projection.State)
					case kind == "merge":
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
						contents, err := exec.Command("/usr/bin/git", "--git-dir", remote, "show", ref+":JOURNEY.md").Output()
						require.NoError(t, err)
						require.Equal(t, "Add a greeting to JOURNEY.md\nHello from Smithers!\nHello from Smithers!\n", string(contents))
					}
					if dropLate {
						var recoveredPR int64
						require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT pr_number FROM mythical_items WHERE number=$1 AND pending_op IS NULL AND pr_state='closed'`, number).Scan(&recoveredPR))
						closes := 0
						for _, write := range r.fake.Writes()[before:] {
							if write.Method == "PATCH" && write.Path == fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", recoveredPR) && strings.Contains(string(write.Body), `"state":"closed"`) {
								closes++
							}
						}
						require.Equal(t, 1, closes, "one compensating close after late PR recovery")
					}
					fmt.Printf("CRASH-OBSERVATION {\"point\":\"github-%s-%s\",\"subject\":\"todo\",\"effectiveWrites\":1}\n", scenario, point)
				})
			})
		}
	}
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
