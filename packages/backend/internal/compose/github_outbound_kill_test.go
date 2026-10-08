//go:build unix

package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowmanifest"
	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/process"
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
	enable := pinnedMicroVMRehearsal
	if os.Getenv("SMITHERS_GITHUB_OUTBOUND_LINUX") == "1" {
		// Supplemental crossing proof only: Linux uses the existing file writer
		// fixture, never qualifies the packaged writer or guest isolation.
		enable = "SMITHERS_GITHUB_OUTBOUND_LINUX"
	} else if os.Getenv("SMITHERS_FAULT_HOST") != "reference" {
		t.Skip("reference machine required for the packaged native writer")
	}
	t.Setenv(enable, "1")
	proposalStatus := http.StatusAccepted

	for _, scenario := range []string{"push", "open", "body", "merge", "close", "open-drop", "body-order", "push-foreign", "close-reopen", "close-person-event", "close-other-app-event", "close-canonical-event", "close-person-marker", "close-other-app-marker", "close-canonical-marker", "merge-revoked", "merge-stale-head", "merge-missing-approval", "merge-competing-fence"} {
		kind := strings.SplitN(scenario, "-", 2)[0]
		variant := strings.TrimPrefix(scenario, kind+"-")
		mergeRefusal := kind == "merge" && variant != "merge" && variant != "competing-fence"
		dropLate := scenario == "open-drop"
		for _, point := range []string{"before-send", "potentially-sent", "remote-success"} {
			if (dropLate || variant == "order" || variant == "reopen") && point != "remote-success" {
				continue
			}
			if (strings.HasSuffix(variant, "event") || strings.HasSuffix(variant, "marker")) && point != "potentially-sent" {
				continue
			}
			t.Run(scenario+"/"+point, func(t *testing.T) {
				r := newRehearsal(t, enable, "C-DUR-03", "github-kill-"+kind+"-", 25)
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
				if enable == "SMITHERS_GITHUB_OUTBOUND_LINUX" {
					// The replacement owns this retained disk. Retire every original
					// diagnostic writer and daemon before reopening it in the child.
					runtimeBinding := r.options.Workspace.(bindingProcessRuntime)
					runtimeBinding.daemonStops.Range(func(key, value any) bool {
						value.(func())()
						runtimeBinding.daemonStops.Delete(key)
						return true
					})
					require.NoError(t, r.processRuntime.Close())
					// The HTTP composition needs a live isolated observation port
					// for reserved proposal replay. Reopen the retained checkout;
					// do not reuse the retired install's closed runtime/registry.
					runtime, err := process.New(process.Config{Root: r.workspaceStateRoot, Environment: map[string]string{"PATH": os.Getenv("PATH")}})
					require.NoError(t, err)
					t.Cleanup(func() { require.NoError(t, runtime.Close()) })
					_, err = runtime.StartWorkspace(t.Context(), workspace)
					require.NoError(t, err)
					registry := new(machined.Registry)
					t.Cleanup(func() { require.NoError(t, registry.Close()) })
					runtimeBinding.rehearsalAdmissionRuntime = &rehearsalAdmissionRuntime{Runtime: runtime, aliases: map[string]string{}}
					runtimeBinding.daemons, runtimeBinding.daemonStops = registry, new(sync.Map)
					r.options.Workspace, r.options.Machined, r.options.BranchCapture = runtimeBinding, registry, registry
				}
				r.ctx = t.Context()
				unlockInitial()
				t.Setenv("SMITHERS_GITHUB_GIT_BASE_URL", r.fake.URL)
				t.Run("crossing", func(t *testing.T) {
					options := r.options
					options.Duties = DutiesHTTP
					// Keep the installed address: retained checkout receipts bind its Git origin.
					handler := startSplitProcess(t, options)
					r.serving.Store(&handler)
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
						require.Equal(t, proposalStatus, response.StatusCode, string(raw))
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
						prepared := githubKillWorker(t, r, r.fake.URL, r.repositoryRoot, 90*time.Second)
						defer prepared.close()
						_, err := r.waitTodoWithin(number, 60*time.Second, "in_review")
						require.NoError(t, err, prepared.output())
						require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT pr_number,pr_head FROM mythical_items WHERE number=$1 AND state='proposed'`, number).Scan(&pr, &published))
						if kind == "merge" {
							// Publication alone is not the composition's acknowledgement.
							// The retained caller must observe stack.propose's settled
							// receipt before a person can merge. Use the original run's
							// authenticated production door, never clear proposal_run in SQL.
							ackCtx, cancelAck := context.WithTimeout(t.Context(), 60*time.Second)
							defer cancelAck()
							var ackStatus int
							var receipt []byte
							var ackErr error
							require.Eventually(t, func() bool {
								request, err := http.NewRequestWithContext(ackCtx, "POST", r.origin+path, strings.NewReader(body))
								if err != nil {
									ackErr = err
									return false
								}
								request.Header.Set("Authorization", bearer)
								request.Header.Set("Content-Type", "application/json")
								response, err := http.DefaultClient.Do(request)
								if err != nil {
									ackErr = err
									return false
								}
								ackStatus = response.StatusCode
								receipt, ackErr = io.ReadAll(response.Body)
								closeErr := response.Body.Close()
								return ackErr == nil && closeErr == nil && ackStatus == http.StatusOK
							}, 60*time.Second, 20*time.Millisecond, "the published proposal must settle before Merge")
							require.NoError(t, ackErr)
							require.Equal(t, http.StatusOK, ackStatus, string(receipt))
							require.JSONEq(t, fmt.Sprintf(`{"generation":%d,"head":%q}`, generation, published), string(receipt))
							card, err := r.todo(number)
							require.NoError(t, err)
							require.Equal(t, "ready", card.Merge.State, "Merge waits for the production proposal acknowledgement")
						}
						prepared.close()
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
					var recoveryIntent json.RawMessage
					t.Cleanup(func() {
						ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
						defer cancel()
						var facts json.RawMessage
						err := r.pool.QueryRow(ctx, `SELECT json_build_object('state',state,'reason',reason,'pending_op',pending_op,'pr_state',pr_state,'pr_head',pr_head,'generation',generation,'checks',checks) FROM mythical_items WHERE number=$1`, number).Scan(&facts)
						require.NoError(t, err)
						traceMu.Lock()
						requests := append([]string(nil), trace...)
						traceMu.Unlock()
						commit, commitErr := exec.Command("git", "-C", r.root, "rev-parse", "HEAD").Output()
						require.NoError(t, commitErr)
						status := "passed"
						if t.Failed() {
							status = "failed"
						}
						receipt, err := json.MarshalIndent(map[string]any{"commit": strings.TrimSpace(string(commit)), "status": status, "scenario": scenario, "point": point, "qualification": enable, "before_pending_op": recoveryIntent, "item": facts, "requests": requests, "writes": r.fake.Writes()[before:]}, "", "  ")
						require.NoError(t, err)
						require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "outbound-recovery.json"), receipt, 0600))
					})
					var bodies []string
					recovering := false
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
						traceMu.Lock()
						isRecovering := recovering
						traceMu.Unlock()
						if isRecovering && strings.HasSuffix(variant, "marker") && resp.Request.Method == "GET" && resp.Request.URL.Path == fmt.Sprintf("/repos/rehearsal-owner/app/issues/%d/comments", pr) && resp.StatusCode == 200 {
							original, err := io.ReadAll(resp.Body)
							if err != nil {
								return err
							}
							_ = resp.Body.Close()
							var comments []map[string]any
							if err := json.Unmarshal(original, &comments); err != nil {
								return err
							}
							if len(comments) > 0 && variant != "canonical-marker" {
								spoof := map[string]any{}
								for key, value := range comments[0] {
									spoof[key] = value
								}
								spoof["id"] = 999999
								actor, app := "Bot", 42
								if variant == "person-marker" {
									actor = "User"
								}
								if variant == "other-app-marker" {
									app = 43
								}
								spoof["user"] = map[string]string{"type": actor}
								spoof["performed_via_github_app"] = map[string]int{"id": app}
								comments = append([]map[string]any{spoof}, comments...)
							}
							encoded, err := json.Marshal(comments)
							if err != nil {
								return err
							}
							resp.Body = io.NopCloser(strings.NewReader(string(encoded)))
							resp.ContentLength = int64(len(encoded))
							resp.Header.Set("Content-Length", fmt.Sprint(len(encoded)))
						}
						if point == "remote-success" && targetWrite(resp.Request) && resp.StatusCode < 300 {
							held.Do(func() { close(reached); <-release })
						}
						return nil
					}
					peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
						traceMu.Lock()
						trace = append(trace, request.Method+" "+request.URL.Path)
						if kind == "body" && targetWrite(request) {
							raw, err := io.ReadAll(request.Body)
							require.NoError(t, err)
							request.Body = io.NopCloser(strings.NewReader(string(raw)))
							var input struct {
								Body string `json:"body"`
							}
							require.NoError(t, json.Unmarshal(raw, &input))
							bodies = append(bodies, input.Body)
							if variant == "order" && len(bodies) == 2 {
								var settled int
								var precondition string
								require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests WHERE operation='todo.github_operation_settled' AND payload->>'n'=$1 AND payload->'operation'->>'kind'='body'`, fmt.Sprint(number)).Scan(&settled))
								require.Equal(t, 1, settled, "v1 must be durably settled before v2 is sent")
								require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT pending_op->>'precondition' FROM mythical_items WHERE number=$1`, number).Scan(&precondition))
								var first services.MythicalOutboundOp
								require.NoError(t, json.Unmarshal(recoveryIntent, &first))
								require.Equal(t, first.Desired, precondition, "v2 is leased against the settled v1 digest")
							}
						}
						isRecovering := recovering
						traceMu.Unlock()
						if isRecovering && strings.HasSuffix(variant, "event") && request.Method == "GET" && request.URL.Path == fmt.Sprintf("/repos/rehearsal-owner/app/issues/%d/events", pr) {
							actor, app := "Bot", int64(42)
							if variant == "person-event" {
								actor = "User"
							}
							if variant == "other-app-event" {
								app = 43
							}
							w.Header().Set("Content-Type", "application/json")
							require.NoError(t, json.NewEncoder(w).Encode([]any{map[string]any{"event": "closed", "created_at": time.Now().UTC(), "actor": map[string]string{"type": actor}, "performed_via_github_app": map[string]int64{"id": app}}}))
							return
						}
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
					child := githubKillWorker(t, r, peer.URL, r.repositoryRoot, 90*time.Second)
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
					recoveryIntent = append(json.RawMessage(nil), raw...)
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
						var retained, dropRequest []byte
						require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT pending_op,checks->'drop_requested' FROM mythical_items WHERE number=$1`, number).Scan(&retained, &dropRequest))
						require.JSONEq(t, string(raw), string(retained), "Drop must retain the uncertain open")
						var requested struct {
							Request string `json:"request"`
							By      string `json:"by"`
						}
						require.NoError(t, json.Unmarshal(dropRequest, &requested))
						require.NotEmpty(t, requested.Request, "the acknowledgment must retain a durable Drop request")
						require.Equal(t, "rehearsal-owner", requested.By)
						var facts int
						require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='todo.drop-requested' AND payload->>'n'=$1`, fmt.Sprint(number)).Scan(&facts))
						require.Equal(t, 1, facts, "replaying the acknowledgment must retain one Drop request fact")
					}
					// Attempt mutation through the real machine proxy while the slot is
					// uncertain, and again after restart. Both refuse before minting.
					assertProxyRefuses := func(worker *githubKillProcess) {
						// Isolate this HTTP probe from legitimate background token/read
						// traffic. Only our owned worker group is paused; held requests
						// stay held and resume before the fault/recovery proceeds.
						if worker != nil && !worker.waited {
							require.NoError(t, syscall.Kill(-worker.command.Process.Pid, syscall.SIGSTOP))
							defer func() { require.NoError(t, syscall.Kill(-worker.command.Process.Pid, syscall.SIGCONT)) }()
							time.Sleep(20 * time.Millisecond)
						}

						var retained []byte
						require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT pending_op FROM mythical_items WHERE number=$1`, number).Scan(&retained))
						writes, reads := len(r.fake.Writes()), len(r.fake.Reads())
						for _, method := range []string{"POST", "PUT", "PATCH", "DELETE"} {
							payload := fmt.Sprintf(`{"method":%q,"path":"/repos/rehearsal-owner/app/pulls","body":{"state":"closed"}}`, method)
							request, err := http.NewRequest("POST", r.origin+"/api/repos/rehearsal-owner/app/github-proxy", strings.NewReader(payload))
							require.NoError(t, err)
							request.Header.Set("Authorization", proposalBearer)
							request.Header.Set("Content-Type", "application/json")
							response, err := http.DefaultClient.Do(request)
							require.NoError(t, err)
							receipt, err := io.ReadAll(response.Body)
							require.NoError(t, err)
							require.NoError(t, response.Body.Close())
							require.Equal(t, 403, response.StatusCode, string(receipt))
						}
						require.Len(t, r.fake.Writes(), writes, "proxy refusal mints no installation token and writes nothing upstream")
						require.Len(t, r.fake.Reads(), reads, "proxy refusal makes no upstream lookup")
						var after []byte
						require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT pending_op FROM mythical_items WHERE number=$1`, number).Scan(&after))
						if len(retained) == 0 {
							require.Empty(t, after, "proxy refusal cannot create an operation")
						} else {
							require.JSONEq(t, string(retained), string(after), "proxy refusal cannot change the uncertain slot")
						}
					}
					assertProxyRefuses(child)
					child.kill(t)
					// Change the world only after the owned worker is dead. The recorded
					// slot came from the production caller, never a fabricated intent.
					var foreignHead string
					switch variant {
					case "foreign":
						remote := filepath.Join(r.gitRoot, "rehearsal-owner/app.git")
						cmd := exec.Command("/usr/bin/git", "--git-dir", remote, "update-ref", "refs/heads/"+slot.Target, r.mainCommit)
						output, err := cmd.CombinedOutput()
						require.NoError(t, err, string(output))
						foreignHead, err = r.fake.PushAs("rehearsal-owner/app", slot.Target, 8, "person", "Foreign push", map[string]string{"PERSON.txt": "keep me\n"})
						require.NoError(t, err)
					case "order":
						review, _ := json.Marshal(map[string]any{"head": published, "candidate": head, "runId": "fixture-review-v2", "verdict": "request-changes"})
						_, err = r.pool.Exec(r.ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{review}',$2::jsonb) WHERE number=$1`, number, review)
						require.NoError(t, err)
						var retained []byte
						require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT pending_op FROM mythical_items WHERE number=$1`, number).Scan(&retained))
						require.JSONEq(t, string(raw), string(retained), "v2 cannot overwrite the uncertain v1 slot")
					case "reopen", "person-event", "other-app-event", "canonical-event":
						r.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { p.State = "open" })
					case "revoked":
						r.fake.SetCollaborator(7, "rehearsal-owner", "read")
					case "stale-head":
						_, err = r.fake.PushAs("rehearsal-owner/app", "smithers/kill-control", 8, "person", "Head changed after approval", map[string]string{"PERSON.txt": "new head\n"})
						require.NoError(t, err)
					case "missing-approval":
						_, err = r.pool.Exec(r.ctx, `UPDATE mythical_items SET checks=checks-'land' WHERE number=$1`, number)
						require.NoError(t, err)
					}
					writesAtRestart := len(r.fake.Writes())
					t.Logf("CRASH-POINT github-%s-%s subject todo", scenario, point)
					t.Log("CRASH-POINT github-production-propose subject todo")
					assertProxyRefuses(child)
					unlock()
					traceMu.Lock()
					trace = nil
					recovering = true
					traceMu.Unlock()
					wake()
					if variant == "competing-fence" {
						_, err = r.pool.Exec(r.ctx, `UPDATE mythical_stacks SET running=true,claim=999999,lease_expires_at=NOW()+interval '1 hour' WHERE repository_id=$1`, repository)
						require.NoError(t, err)
					}
					recoveryDeadline := time.Now().Add(60 * time.Second)
					restarted := githubKillWorker(t, r, peer.URL, r.repositoryRoot, time.Until(recoveryDeadline))
					defer restarted.close()
					require.Positive(t, time.Until(recoveryDeadline), "startup counts against the recovery deadline")
					if variant == "competing-fence" {
						require.Eventually(t, func() bool { return strings.Contains(restarted.output(), "github-kill-worker-ready") }, time.Until(recoveryDeadline), 20*time.Millisecond, "worker must be composed before inspecting the competing fence")
						require.Never(t, func() bool {
							traceMu.Lock()
							defer traceMu.Unlock()
							for _, request := range trace {
								parts := strings.SplitN(request, " ", 2)
								if len(parts) == 2 && targetWrite(&http.Request{Method: parts[0], URL: &url.URL{Path: parts[1]}}) {
									return true
								}
							}
							return false
						}, time.Second, 20*time.Millisecond, "another live stack claim prevents a recovering merge send")
						var retained []byte
						require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT pending_op FROM mythical_items WHERE number=$1`, number).Scan(&retained))
						require.JSONEq(t, string(raw), string(retained), "competing fence preserves the exact operation")
						wake()
					}
					if variant == "foreign" || mergeRefusal && point != "remote-success" {
						require.Eventually(t, func() bool {
							traceMu.Lock()
							defer traceMu.Unlock()
							for _, request := range trace {
								if request == fmt.Sprintf("GET /repos/rehearsal-owner/app/pulls/%d", pr) || kind == "push" && strings.HasSuffix(request, "/info/refs") {
									return true
								}
							}
							return false
						}, time.Until(recoveryDeadline), 10*time.Millisecond, "recovery must first look up the remote")
						// Stop only after the durable refusal/conflict is visible.
						require.Eventually(t, func() bool {
							var state, reason string
							var pending []byte
							if r.pool.QueryRow(r.ctx, `SELECT state,reason,pending_op FROM mythical_items WHERE number=$1`, number).Scan(&state, &reason, &pending) != nil {
								return false
							}
							if variant == "foreign" {
								if !strings.Contains(string(pending), `"conflict"`) {
									return false
								}
								card, err := r.todo(number)
								if err != nil || card.State != "needs_you" {
									return false
								}
								var facts int
								return r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_push' AND state='needs_you' AND data->>'n'=$1`, fmt.Sprint(number)).Scan(&facts) == nil && facts == 1
							}
							if point == "before-send" {
								return len(pending) == 0
							}
							if variant == "missing-approval" {
								return string(pending) == string(raw)
							}
							if variant == "stale-head" {
								return len(pending) == 0
							}
							return strings.Contains(restarted.output(), "mythical.outbound_pending")
						}, time.Until(recoveryDeadline), 20*time.Millisecond, "recovery must retain uncertainty or record a refusal")
						require.Eventually(t, func() bool {
							var running bool
							return r.pool.QueryRow(r.ctx, `SELECT running FROM mythical_stacks WHERE repository_id=$1`, repository).Scan(&running) == nil && !running
						}, time.Until(recoveryDeadline), 20*time.Millisecond, "recovery pass must finish before its refusal is inspected")
						restarted.close()
						assertProxyRefuses(restarted)
						var pending []byte
						var itemState string
						require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT state,pending_op FROM mythical_items WHERE number=$1`, number).Scan(&itemState, &pending))
						if kind == "merge" {
							require.Equal(t, "proposed", itemState)
							var settlements int
							require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='todo.github_operation_settled' AND payload->>'n'=$1 AND payload->'operation'->>'kind'='merge'`, fmt.Sprint(number)).Scan(&settlements))
							require.Equal(t, 0, settlements, "refused recovery must not fabricate a successful merge fact")
							remote := filepath.Join(r.gitRoot, "rehearsal-owner/app.git")
							main, err := exec.Command("/usr/bin/git", "--git-dir", remote, "rev-parse", "refs/heads/main").Output()
							require.NoError(t, err)
							require.Equal(t, r.mainCommit, strings.TrimSpace(string(main)), "refused recovery cannot move the person's main")
							r.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) {
								require.Equal(t, "open", p.State)
								require.False(t, p.Merged, "a refused merge remains unmerged upstream")
							})
							if point == "potentially-sent" && variant != "stale-head" {
								require.JSONEq(t, string(raw), string(pending), "unknown send remains fenced without authority or approval")
							} else {
								require.Empty(t, pending, "definitively unsent or stale merge is refused")
							}
							status, card, err := r.request("GET", fmt.Sprintf("/api/todos/%d", number), "")
							require.NoError(t, err)
							require.Equal(t, 200, status)
							var projection struct {
								State string `json:"state"`
								Merge struct {
									State string `json:"state"`
								} `json:"merge"`
							}
							require.NoError(t, json.Unmarshal(card, &projection))
							require.Equal(t, "in_review", projection.State)
							if len(pending) > 0 {
								require.Equal(t, "merging", projection.Merge.State)
							} else {
								require.NotEqual(t, "merging", projection.Merge.State)
							}
						}
						for _, write := range r.fake.Writes()[writesAtRestart:] {
							require.False(t, targetWrite(&http.Request{Method: write.Method, URL: &url.URL{Path: write.Path}}), "refused recovery must send nothing: %s %s", write.Method, write.Path)
						}
						if variant == "foreign" {
							pushes := 0
							for _, write := range r.fake.Writes()[before:] {
								if targetWrite(&http.Request{Method: write.Method, URL: &url.URL{Path: write.Path}}) {
									pushes++
								}
							}
							expectedPushes := 0
							if point == "remote-success" {
								expectedPushes = 1
							}
							require.Equal(t, expectedPushes, pushes, "only the pre-kill successful push may precede the person's foreign head")
							remote := filepath.Join(r.gitRoot, "rehearsal-owner/app.git")
							tip, err := exec.Command("/usr/bin/git", "--git-dir", remote, "rev-parse", "refs/heads/"+slot.Target).Output()
							require.NoError(t, err)
							require.Equal(t, foreignHead, strings.TrimSpace(string(tip)))
							contents, err := exec.Command("/usr/bin/git", "--git-dir", remote, "show", "refs/heads/"+slot.Target+":PERSON.txt").Output()
							require.NoError(t, err)
							require.Equal(t, "keep me\n", string(contents))
							status, card, err := r.request("GET", fmt.Sprintf("/api/todos/%d", number), "")
							require.NoError(t, err)
							require.Equal(t, 200, status)
							var projection struct {
								State string `json:"state"`
								Waits []struct {
									Kind string `json:"kind"`
								} `json:"waits"`
							}
							require.NoError(t, json.Unmarshal(card, &projection))
							require.Equal(t, "needs_you", projection.State)
							require.Len(t, projection.Waits, 1)
							require.Equal(t, "foreign_push", projection.Waits[0].Kind)
						}
						writes := 0
						for _, write := range r.fake.Writes()[before:] {
							if targetWrite(&http.Request{Method: write.Method, URL: &url.URL{Path: write.Path}}) {
								writes++
							}
						}
						expectedWrites := 0
						if point == "remote-success" {
							expectedWrites = 1
						}
						require.Equal(t, expectedWrites, writes, "refused recovery retains only a write already applied before the kill")
						var settled int64
						require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='todo.github_operation_settled' AND payload->>'n'=$1 AND payload->'operation'->>'kind'=$2`, fmt.Sprint(number), kind).Scan(&settled))
						require.Zero(t, settled, "conflict or refusal is not successful settlement")
						t.Logf("CRASH-OBSERVATION {\"point\":\"github-%s-%s\",\"subject\":\"todo\",\"effectiveWrites\":%d,\"settlementFacts\":%d}", scenario, point, writes, settled)
						return
					}
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
						if variant == "order" {
							var posted bool
							_ = r.pool.QueryRow(r.ctx, `SELECT COALESCE((checks->'review'->>'posted')::boolean,false) FROM mythical_items WHERE number=$1`, number).Scan(&posted)
							return card.State == "in_review" && posted
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
					}, time.Until(recoveryDeadline), 100*time.Millisecond, "restart: %s", restarted.log.Name())
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
					expectedWrites := 1
					if variant == "order" {
						expectedWrites = 2
					}
					if variant == "canonical-event" {
						expectedWrites = 0
					}
					require.Equal(t, expectedWrites, writes, "literal effective writes across SIGKILL")
					if variant == "order" {
						traceMu.Lock()
						sentBodies := append([]string(nil), bodies...)
						traceMu.Unlock()
						require.Len(t, sentBodies, 2)
						require.Contains(t, sentBodies[0], "\n\nReview: approve\n\n")
						require.Contains(t, sentBodies[1], "\n\nReview: request-changes\n\n")
					}
					if strings.HasSuffix(variant, "marker") {
						posts, edits := 0, 0
						for _, write := range r.fake.Writes()[before:] {
							require.NotEqual(t, fmt.Sprintf("/repos/rehearsal-owner/app/issues/comments/%d", 999999), write.Path, "another actor's matching marker cannot be edited")
							if write.Method == "POST" && write.Path == fmt.Sprintf("/repos/rehearsal-owner/app/issues/%d/comments", pr) {
								posts++
							}
							if write.Method == "PATCH" && strings.Contains(write.Path, "/issues/comments/") {
								edits++
							}
						}
						require.Equal(t, 1, posts, "one effective canonical App comment across kill")
						require.Equal(t, 1, edits, "repeat edits the canonical marker instead of posting twice")
					}
					if variant == "reopen" || variant == "canonical-event" {
						r.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { require.Equal(t, "open", p.State, "a person's reopen survives recovery") })
					}
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
					expectedSettlements := 1
					if variant == "order" {
						expectedSettlements = 2
					}
					require.EqualValues(t, expectedSettlements, settled, "literal committed settlement facts across restart")
					require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT generation FROM mythical_items WHERE number=$1`, number).Scan(&retainedGeneration))
					require.Equal(t, generation, retainedGeneration, "replay and recovery never allocate another candidate")
					if variant == "missing-approval" && point == "remote-success" {
						var missing bool
						require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT checks->'land' IS NULL FROM mythical_items WHERE number=$1`, number).Scan(&missing))
						require.True(t, missing, "applied merge settlement cannot fabricate a missing approval")
					}
					if kind == "close" || dropLate {
						require.Eventually(t, func() bool {
							var retired bool
							return r.pool.QueryRow(r.ctx, `SELECT retired_at IS NOT NULL FROM mythical_lanes WHERE workspace_id=$1`, workspace).Scan(&retired) == nil && retired
						}, time.Until(recoveryDeadline), 20*time.Millisecond, "Drop must retire its execution lane before credential replay")
					}
					// Replay the original accepted request after crash recovery, including
					// after Drop. It returns its receipt without scheduling publication again.
					restarted.close()
					assertProxyRefuses(restarted)
					writesBeforeReplay := len(r.fake.Writes())
					var requestsBeforeReplay int64
					require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests`).Scan(&requestsBeforeReplay))
					var completionsBeforeReplay int
					require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='stack.propose.completed' AND payload->>'n'=$1`, fmt.Sprint(number)).Scan(&completionsBeforeReplay))
					if kind == "merge" {
						require.Equal(t, 1, completionsBeforeReplay, "Merge follows the caller's durable proposal acknowledgement")
					} else {
						require.Equal(t, 0, completionsBeforeReplay)
					}
					replayStatus := http.StatusOK
					acceptedHead := published
					if acceptedHead == "" {
						acceptedHead = slot.Desired
					}
					if kind == "close" || dropLate {
						// Current authorization rejects an ended attempt, including
						// an original accepted request. Replay cannot revive its grant.
						replayStatus = http.StatusForbidden
					}
					if mergeRefusal && point == "potentially-sent" {
						replayStatus = http.StatusAccepted
					}
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
						require.Equal(t, replayStatus, response.StatusCode, string(raw))
						if replayStatus == http.StatusForbidden {
							require.JSONEq(t, `{"class":"permission","code":"permission","message":"Not your confirmation"}`, string(raw))
						} else if mergeRefusal && point == "potentially-sent" {
							require.JSONEq(t, `{}`, string(raw), "an uncertain merge fence accepts no new proposal work")
						} else {
							require.JSONEq(t, fmt.Sprintf(`{"generation":%d,"head":%q}`, generation, acceptedHead), string(raw), "settled proposal returns its published head receipt")
						}
					}
					var requestsAfterReplay int64
					require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests`).Scan(&requestsAfterReplay))
					expectedRequests := requestsBeforeReplay
					if replayStatus == http.StatusOK {
						expectedRequests += int64(1 - completionsBeforeReplay) // one completion fact, never new publication work
						var completionFacts int
						require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='stack.propose.completed' AND payload->>'n'=$1`, fmt.Sprint(number)).Scan(&completionFacts))
						require.Equal(t, 1, completionFacts, "three replays seal exactly one proposal completion")
					}
					require.Equal(t, expectedRequests, requestsAfterReplay, "settled replay creates only its completion fact")
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
					t.Logf("CRASH-OBSERVATION {\"point\":\"github-%s-%s\",\"subject\":\"todo\",\"effectiveWrites\":%d,\"settlementFacts\":%d}", scenario, point, writes, settled)
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
func githubKillWorker(t *testing.T, r *rehearsal, peer, repositoryRoot string, readyWithin time.Duration) *githubKillProcess {
	t.Helper()
	binary, err := os.Executable()
	require.NoError(t, err)
	log, err := os.CreateTemp(r.evidence, "outbound-worker-*.log")
	require.NoError(t, err)
	command := exec.Command(binary, "-test.run=^TestGitHubOutboundKillChild$", "-test.v")
	command.Env = append(os.Environ(), // This candidate control consumes no blob artifacts. Give each owned
		// worker its own blob store; filesystem stores permit one owner only.
		"SMITHERS_GITHUB_KILL_CHILD=1", "SMITHERS_GITHUB_KILL_REPO_ROOT="+repositoryRoot, "SMITHERS_BLOB_DATA_DIR="+t.TempDir(), "SMITHERS_GITHUB_APP_API_BASE_URL="+peer, "SMITHERS_GITHUB_GIT_BASE_URL="+peer)
	registry, err := json.Marshal(r.options.FlowHostRegistry)
	require.NoError(t, err)
	profile, err := json.Marshal(r.options.HostProfile)
	require.NoError(t, err)
	command.Env = append(command.Env,
		"SMITHERS_GITHUB_KILL_RUNTIME_ROOT="+r.workspaceStateRoot,
		"SMITHERS_GITHUB_KILL_REGISTRY="+string(registry),
		"SMITHERS_GITHUB_KILL_HOST_PROFILE="+string(profile),
		"SMITHERS_GITHUB_KILL_EVIDENCE="+r.evidence)
	if os.Getenv("SMITHERS_GITHUB_OUTBOUND_LINUX") == "1" {
		command.Env = append(command.Env, "SMITHERS_REHEARSAL_MACHINED_BINARY="+buildRehearsalMachined(t, r.root))
	}
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
	require.Eventually(t, func() bool {
		return strings.Contains(p.output(), "github-kill-worker-ready")
	}, readyWithin, 20*time.Millisecond, "retained runtime must be admitted before the fault control advances: %s", p.output())
	var repositoryID int64
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT repository_id FROM mythical_stacks`).Scan(&repositoryID))
	// Native admission may finish after an early fail-closed worker attempt.
	// Request the same engine again without changing its live claim or lease.
	requestCtx, cancel := context.WithTimeout(r.ctx, 250*time.Millisecond)
	defer cancel()
	_, err = db.New(r.pool).RequestMythicalStack(requestCtx, repositoryID)
	if errors.Is(err, context.DeadlineExceeded) {
		// A worker can hold this row while the fault proxy deliberately holds
		// its response. Do not await that write before reaching the kill point.
		var running bool
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT running FROM mythical_stacks WHERE repository_id=$1`, repositoryID).Scan(&running))
		require.True(t, running, "a blocked wake must belong to an already running stack")
	} else {
		require.NoError(t, err)
	}
	return p
}
func TestGitHubOutboundKillChild(t *testing.T) {
	if os.Getenv("SMITHERS_GITHUB_KILL_CHILD") != "1" {
		t.Skip("owned subprocess only")
	}
	engine, err := repository.OpenLocal(repository.Config{StoragePath: os.Getenv("SMITHERS_GITHUB_KILL_REPO_ROOT"), AuthToken: "rehearsal-repo", FFILibraryPath: os.Getenv("SMITHERS_FFI_LIBRARY_PATH"), InstallMainMirror: true})
	require.NoError(t, err)
	defer engine.Shutdown(context.Background())
	options := Options{Repository: engine.Client(), Duties: DutiesWorkers, ComputeProvider: sandboxfake.New()}
	ready := func(http.Handler) { fmt.Fprintln(os.Stderr, "github-kill-worker-ready") }
	if root := os.Getenv("SMITHERS_GITHUB_KILL_RUNTIME_ROOT"); root != "" {
		// Reopen the same retained diagnostic disk. Drop cancellation/capture
		// must use the native daemon and real runtime, not the compute fixture.
		pool, err := pgxpool.New(t.Context(), os.Getenv("SMITHERS_DATABASE_URL"))
		require.NoError(t, err)
		defer pool.Close()
		var hosts flowmanifest.Registry
		require.NoError(t, json.Unmarshal([]byte(os.Getenv("SMITHERS_GITHUB_KILL_REGISTRY")), &hosts))
		var profile microsandbox.HostProfile
		require.NoError(t, json.Unmarshal([]byte(os.Getenv("SMITHERS_GITHUB_KILL_HOST_PROFILE")), &profile))
		options.FlowHostRegistry = &hosts
		options.FlowHostProductAPIURL = os.Getenv("SMITHERS_PUBLIC_URL")
		options.HostProfile = &profile
		var ensureMachined func(context.Context, string) error
		if os.Getenv("SMITHERS_GITHUB_OUTBOUND_LINUX") == "1" {
			runtime, err := process.New(process.Config{Root: root, Environment: map[string]string{"PATH": os.Getenv("PATH")}})
			require.NoError(t, err)
			defer runtime.Close()
			registry := new(machined.Registry)
			defer registry.Close()
			workspace := bindingProcessRuntime{rehearsalAdmissionRuntime: &rehearsalAdmissionRuntime{Runtime: runtime, aliases: map[string]string{}},
				t: t, pool: pool, repository: engine.Client(), daemons: registry, daemonStops: new(sync.Map),
				daemonBinary: os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY"), evidence: os.Getenv("SMITHERS_GITHUB_KILL_EVIDENCE")}
			options.Workspace, options.Machined, options.BranchCapture = workspace, registry, registry
			options.BranchMachines = rehearsalBranchMachines(pool)
			options.FlowHostConfig = flowhost.WorkspaceLauncherConfig{AllowTrustedProcessForTests: true}
			ensureMachined = func(ctx context.Context, id string) error {
				if _, err := runtime.StartWorkspace(ctx, id); err != nil {
					return err
				}
				return workspace.EnsureMachined(ctx, id)
			}
		} else {
			// Qualification reopens only the approved bundle's real microVM
			// runtime and retained state. No process or compute substitution.
			bundle, err := installbundle.Open(os.Getenv("SMITHERS_CHECK_BUNDLE"))
			require.NoError(t, err)
			address, err := url.Parse(options.FlowHostProductAPIURL)
			require.NoError(t, err)
			port, err := strconv.ParseUint(address.Port(), 10, 16)
			require.NoError(t, err)
			sizing := microsandbox.ComputeSizing(profile)
			runtime, err := microsandbox.New(t.Context(), microsandbox.Config{Root: root, Bundle: bundle,
				BundlePrograms: []string{hosts.Coding.Executable}, HostProfile: &profile, HostPorts: []uint16{uint16(port)},
				CPUs: sizing.CPUs, MemoryMiB: sizing.MemoryMiB, DiskMiB: int(microsandbox.MachineDiskBytes >> 20), MaxRunningVMs: sizing.Capacity,
				Environments: &microsandbox.EnvironmentConfig{PrepareCPUs: sizing.CPUs, PrepareMemoryMiB: sizing.MemoryMiB,
					PrepareDiskMiB: int(microsandbox.MachineDiskBytes >> 20), LayerBudgetBytes: sizing.LayerBudgetBytes, MinFreeBytes: microsandbox.MinFreeDiskBytes}})
			require.NoError(t, err)
			defer runtime.Close()
			options.Workspace, options.InstallBranchMachines = runtime, true
			options.ComputeProvider = nil
			ensureMachined = runtime.EnsureMachined
		}
		ready = func(http.Handler) {
			rows, err := pool.Query(t.Context(), `SELECT w.id::text FROM workspaces w JOIN mythical_items i ON i.workspace_id=w.id::text WHERE w.deleted_at IS NULL AND w.vm_id<>'' AND w.branch_archived_at IS NULL`)
			require.NoError(t, err)
			ids := []string{}
			for rows.Next() {
				var id string
				require.NoError(t, rows.Scan(&id))
				ids = append(ids, id)
			}
			require.NoError(t, rows.Err())
			rows.Close()
			for _, id := range ids {
				require.NoError(t, ensureMachined(t.Context(), id))
			}
			fmt.Fprintln(os.Stderr, "github-kill-worker-ready")
		}
	}
	require.NoError(t, StartWithOptions(context.Background(), nil, io.Discard, os.Stderr, options, ready))
}
