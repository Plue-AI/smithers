package compose

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/stretchr/testify/require"
)

// The installed daemon, inotify, LinuxDisk, native jj, versions and host store
// are real. The existing namespace harness supplies an empty broker census;
// this is daemon/filesystem evidence, not member-cgroup or microVM acceptance.
type realDocumentInstall struct {
	*codeDocumentInstall
	registry               *machined.Registry
	root, evidence, binary string
	restart                *rehearsalRestart
	stopGuest              func()
}

func startRealDocumentInstall(t *testing.T, point string) *realDocumentInstall {
	t.Helper()
	binary := os.Getenv("SMITHERS_REHEARSAL_MACHINED_FAULT_BINARY")
	if binary == "" {
		t.Skip("requires rehearsal_daemon built with --features killpoints and Linux user namespaces")
	}
	native := repohostffi.New(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NoError(t, native.Load())
	cfg := repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "document-daemon"}
	_, err := native.InitRepo(cfg.RepoPath("ben", "demo"))
	require.NoError(t, err)
	server, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, server.Shutdown(context.Background())) })
	client := repohost.NewLocalClient(server.Handler(), cfg.AuthToken)
	client.BindMachineRepository(server.WithMachineRepository)
	evidenceRoot, err := filepath.Abs("../../../../.artifacts/checks/C-DUR-04")
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(evidenceRoot, 0700))
	evidence, err := os.MkdirTemp(evidenceRoot, time.Now().UTC().Format("20060102T150405Z")+"-")
	require.NoError(t, err)
	f := &realDocumentInstall{root: t.TempDir(), evidence: evidence, binary: binary,
		restart: &rehearsalRestart{State: t.TempDir(), Run: t.TempDir(), KillAt: point, Exited: make(chan error, 1)}}
	t.Cleanup(func() {
		if t.Failed() {
			if f.restart.Exited != nil {
				select {
				case err := <-f.restart.Exited:
					t.Logf("guest exited: %v", err)
				default:
				}
			}
			log, _ := os.ReadFile(filepath.Join(f.evidence, "machined-"+f.branch+".log"))
			t.Logf("guest log: %s", log)
		}
	})
	jj, err := rehearsalJJBinary(os.Getenv("PATH"))
	require.NoError(t, err)
	output, err := exec.CommandContext(t.Context(), jj, "git", "init", f.root).CombinedOutput()
	require.NoError(t, err, "%s", output)
	require.NoError(t, os.WriteFile(filepath.Join(f.root, "retry.ts"), nil, 0640))
	f.codeDocumentInstall = startCodeDocumentInstallWithRepository(t, true, client, func(install *codeDocumentInstall, registry *machined.Registry) {
		f.registry = registry
		f.codeDocumentInstall = install
		// The harness mints a boot bound to branch as its machine identity.
		_, err := install.pool.Exec(t.Context(), `UPDATE workspaces SET vm_id=id WHERE id=$1`, install.branch)
		require.NoError(t, err)
		// Bootstrap the same committed object in the host and guest, as real
		// provisioning does. A capture cannot CAS an absent initial branch ref.
		headCommand := exec.CommandContext(t.Context(), jj, "log", "-r", "@", "--no-graph", "-T", "commit_id")
		headCommand.Dir = f.root
		head, err := headCommand.Output()
		require.NoError(t, err)
		seed := strings.TrimSpace(string(head))
		guestGit := filepath.Join(f.root, ".git")
		bundle := filepath.Join(f.evidence, "bootstrap.bundle")
		for _, args := range [][]string{
			{"--git-dir", guestGit, "update-ref", "refs/col08/bootstrap", seed},
			{"--git-dir", guestGit, "bundle", "create", bundle, "refs/col08/bootstrap"},
			{"--git-dir", cfg.GitBackendPath("ben", "demo"), "fetch", "--no-tags", bundle, "refs/col08/bootstrap:refs/smithers/branches/" + install.branch + "/head"},
		} {
			out, err := exec.CommandContext(t.Context(), "git", args...).CombinedOutput()
			require.NoError(t, err, "%s", out)
		}
		_, err = install.pool.Exec(t.Context(), `UPDATE workspaces SET source_commit=$2,head_commit_id=$2 WHERE id=$1`, install.branch, seed)
		require.NoError(t, err)
		f.restart.HostHead = seed
		f.launch(t)
	})
	return f
}

func (f *realDocumentInstall) launch(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	head, err := machineBranchHead(f.pool, f.options.Repository)(ctx, f.branch)
	require.NoError(t, err)
	f.restart.HostHead = head
	require.NoError(t, startRehearsalMachinedWith(t, t.Context(), f.registry, f.branch, f.root, f.evidence, f.binary, &machined.ItemBinding{}, f.restart, func(stop func()) { f.stopGuest = stop }))
}

func (f *realDocumentInstall) resume(t *testing.T) {
	t.Helper()
	require.NoError(t, os.Remove(filepath.Join(f.restart.Run, "machined.sock")))
	f.restart.KillAt = ""
	f.restart.Exited = nil
	f.launch(t)
}

func (f *realDocumentInstall) disk(t *testing.T) string {
	t.Helper()
	file, err := f.registry.ReadFile(t.Context(), f.branch, "retry.ts", "")
	require.NoError(t, err)
	bytes, err := os.ReadFile(filepath.Join(f.root, "retry.ts"))
	require.NoError(t, err)
	require.Equal(t, string(bytes), string(file.Content), "production read_file and actual disk agree")
	return string(bytes)
}

func TestLiveCodeDocumentsRealDaemonRoute(t *testing.T) {
	f := startRealDocumentInstall(t, "")
	ben, alice := f.browser(t, "ben-cookie"), f.browser(t, "alice-cookie")
	ben.sub(t, f.topic)
	bc := ben.assigned(t)
	alice.sub(t, f.topic)
	ac := alice.assigned(t)
	require.NotEqual(t, bc, ac)
	ben.edit(t, codeInsert(bc, "Ben's durable edit. "))
	alice.edit(t, codeInsert(ac, "Alice's durable edit."))
	ben.saved(t, 1)
	alice.saved(t, 1)
	want := f.disk(t)
	require.Contains(t, want, "Ben's durable edit. ")
	require.Contains(t, want, "Alice's durable edit.")
	ben.converge(t, want)
	alice.converge(t, want)
	forbidden := f.browser(t, "alice-cookie")
	forbidden.sub(t, "doc:code:00000000-0000-4000-8000-000000000000:retry.ts")
	forbidden.text(t, `{"t":"err","id":7,"code":"forbidden"}`)
	require.Equal(t, want, f.disk(t))
	// Outside reconciliation has a separate explicit qualification entry point.
	// Its current failure must never be mistaken for real-provider acceptance.
}

func TestLiveCodeDocumentRealProviderQualification(t *testing.T) {
	if os.Getenv("SMITHERS_CODE_DOCUMENT_PROVIDER_QUALIFICATION") != "1" {
		t.Skip("explicit provider qualification: installed watcher must dispatch completed writes into documents")
	}
	f := startRealDocumentInstall(t, "")
	ben, alice := f.browser(t, "ben-cookie"), f.browser(t, "alice-cookie")
	ben.sub(t, f.topic)
	bc := ben.assigned(t)
	alice.sub(t, f.topic)
	alice.assigned(t)
	ben.edit(t, codeInsert(bc, "Ben's durable edit."))
	ben.saved(t, 1)
	want := f.disk(t)
	alice.converge(t, want)

	// A genuine outside inode replacement enters the real watcher/document
	// reconciliation path, never a fixture-generated live frame.
	outside := want + "\n// outside writer\n"
	temp := filepath.Join(f.root, "outside.tmp")
	require.NoError(t, os.WriteFile(temp, []byte(outside), 0640))
	require.NoError(t, os.Rename(temp, filepath.Join(f.root, "retry.ts")))
	ben.converge(t, outside)
	alice.converge(t, outside)
	require.Eventually(t, func() bool { return f.disk(t) == outside }, time.Second, 10*time.Millisecond)

	// Production capture must flush the document and import the real git bundle.
	captured, err := f.registry.Capture(t.Context(), f.branch)
	require.NoError(t, err)
	require.Len(t, captured.Head, 40)
	row, err := f.pool.Query(t.Context(), `SELECT after_blob FROM burst_files WHERE path='retry.ts'`)
	require.NoError(t, err)
	defer row.Close()
	require.True(t, row.Next(), "the watcher/document burst reached the host store and database")

	// A foreign branch subscription is refused by the composed authorization
	// middleware, and cannot mutate even the real working-copy file.
	forbidden := f.browser(t, "alice-cookie")
	forbidden.sub(t, "doc:code:00000000-0000-4000-8000-000000000000:retry.ts")
	forbidden.text(t, `{"t":"err","id":7,"code":"forbidden"}`)
	require.Equal(t, outside, f.disk(t))
}

// Exercise the non-document write door against an already open document. The
// installed daemon, not a scripted peer, must reconcile the transaction into
// both live replicas and refuse the old base without touching disk.
func TestLiveCodeDocumentRealWriteFile(t *testing.T) {
	f := startRealDocumentInstall(t, "")
	ben, alice := f.browser(t, "ben-cookie"), f.browser(t, "alice-cookie")
	ben.sub(t, f.topic)
	client := ben.assigned(t)
	alice.sub(t, f.topic)
	alice.assigned(t)
	ben.edit(t, codeInsert(client, "BROWSER-BEFORE-WRITE"))
	ben.saved(t, 1)
	before, err := f.registry.ReadFile(t.Context(), f.branch, "retry.ts", "")
	require.NoError(t, err)
	write := func(content string, status int) []byte {
		t.Helper()
		body, err := json.Marshal(map[string]string{"content": content, "base_digest": before.Digest})
		require.NoError(t, err)
		request, err := http.NewRequestWithContext(t.Context(), "PUT", f.origin+"/api/repos/ben/demo/workspaces/"+f.branch+"/files/content?path=retry.ts", strings.NewReader(string(body)))
		require.NoError(t, err)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", f.origin)
		request.Header.Set("X-CSRF-Token", "document-qualification")
		request.AddCookie(&http.Cookie{Name: "__csrf", Value: "document-qualification"})
		request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "alice-cookie"})
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		require.Equal(t, status, response.StatusCode, "%s", raw)
		return raw
	}
	want := "BROWSER-BEFORE-WRITE\nALICE-WRITE-FILE"
	// The namespace harness has no admitted member runtime. Its HTTP write
	// door must stay closed; this is not evidence that the install's real
	// microVM write provider is qualified.
	require.Contains(t, string(write(want, http.StatusServiceUnavailable)), `"code":"service_unavailable"`)
	require.Equal(t, "BROWSER-BEFORE-WRITE", f.disk(t))
	tx, err := f.pool.Begin(t.Context())
	require.NoError(t, err)
	actor, err := machined.RecordActorInTx(t.Context(), tx, f.branch, f.branch, machined.ActorIdentity{Kind: "person", MemberID: f.alice, Via: "web"})
	require.NoError(t, err)
	require.NoError(t, tx.Commit(t.Context()))
	result, err := f.registry.WriteFiles(t.Context(), f.branch, actor, []machined.FileChange{{Path: "retry.ts", BaseDigest: &before.Digest, Content: []byte(want)}})
	require.NoError(t, err)
	require.Nil(t, result.Stale)
	require.Len(t, result.Applied, 1)
	ben.converge(t, want)
	alice.converge(t, want)
	require.Equal(t, want, f.disk(t))
	result, err = f.registry.WriteFiles(t.Context(), f.branch, actor, []machined.FileChange{{Path: "retry.ts", BaseDigest: &before.Digest, Content: []byte("STALE-WRITE-MUST-NOT-LAND")}})
	require.NoError(t, err)
	require.NotNil(t, result.Stale)
	require.Empty(t, result.Applied)
	require.Equal(t, want, f.disk(t))
}

// Revocation is bounded even without a roster event or further inbound input.
// The unaffected member can continue editing the same real daemon document.
func TestLiveCodeDocumentRealRevocation(t *testing.T) {
	f := startRealDocumentInstall(t, "")
	ben, alice := f.browser(t, "ben-cookie"), f.browser(t, "alice-cookie")
	ben.sub(t, f.topic)
	client := ben.assigned(t)
	alice.sub(t, f.topic)
	alice.assigned(t)
	_, err := f.pool.Exec(t.Context(), `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, f.alice)
	require.NoError(t, err)
	removed := time.Now()
	alice.text(t, `{"t":"err","id":7,"code":"forbidden"}`)
	require.Less(t, time.Since(removed), 5*time.Second)
	ben.edit(t, codeInsert(client, "AUTHORIZED-AFTER-REVOCATION"))
	ben.saved(t, 1)
	require.Equal(t, "AUTHORIZED-AFTER-REVOCATION", f.disk(t))
	request, err := http.NewRequestWithContext(t.Context(), "GET", f.origin+"/api/live", nil)
	require.NoError(t, err)
	request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "alice-cookie"})
	response, err := http.DefaultClient.Do(request)
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, http.StatusUnauthorized, response.StatusCode, "suspension also refuses a new connection before upgrading")
	require.Equal(t, "AUTHORIZED-AFTER-REVOCATION", f.disk(t))
}

func TestLiveCodeDocumentRealForeignClient(t *testing.T) {
	f := startRealDocumentInstall(t, "")
	ben, alice := f.browser(t, "ben-cookie"), f.browser(t, "alice-cookie")
	ben.sub(t, f.topic)
	ben.assigned(t)
	alice.sub(t, f.topic)
	client := alice.assigned(t)
	alice.edit(t, codeInsert(client, "ALICE-SAVED"))
	alice.saved(t, 1)
	ben.converge(t, "ALICE-SAVED")
	// This extends Alice's actual client clock, under Ben's authenticated
	// envelope. The real daemon must refuse it, without poisoning Alice's
	// stream or persisting a character from the forged transaction.
	ben.edit(t, codeInsertAt(client, uint64(len("ALICE-SAVED")), "FORGED"))
	ben.text(t, `{"t":"err","id":7,"code":"forbidden"}`)
	require.Equal(t, "ALICE-SAVED", f.disk(t))
	alice.edit(t, codeInsertAt(client, uint64(len("ALICE-SAVED")), "ALICE-CONTINUES"))
	alice.saved(t, 2)
	text := f.disk(t)
	require.Contains(t, text, "ALICE-SAVED")
	require.Contains(t, text, "ALICE-CONTINUES")
	require.NotContains(t, text, "FORGED")
	alice.converge(t, text)
}

func TestLiveCodeDocumentDaemonKillPoints(t *testing.T) {
	for _, point := range []string{"K7a", "K7b", "K7c", "K7d"} {
		for run := 1; run <= 10; run++ {
			t.Run(fmt.Sprintf("%s/%d", point, run), func(t *testing.T) {
				armed := point
				if point == "K7d" {
					armed = ""
				}
				f := startRealDocumentInstall(t, armed)
				ben, alice := f.browser(t, "ben-cookie"), f.browser(t, "alice-cookie")
				ben.sub(t, f.topic)
				bc := ben.assigned(t)
				alice.sub(t, f.topic)
				ac := alice.assigned(t)
				// Establish a durable epoch/authors map before the fault. K7a
				// tests an unsaved update of an existing document, not missing state.
				require.Eventually(t, func() bool {
					entries, err := os.ReadDir(filepath.Join(f.restart.State, "documents"))
					return err == nil && len(entries) != 0
				}, time.Second, 10*time.Millisecond)
				epoch := ben.epoch

				// Only content is killed: ensure the new tab's author registration
				// is durable first, so its retained client id can be authenticated.
				require.Eventually(t, func() bool {
					key := sha256.Sum256([]byte("retry.ts"))
					data, err := os.ReadFile(filepath.Join(f.restart.State, "documents", hex.EncodeToString(key[:])))
					return err == nil && strings.Contains(string(data), fmt.Sprint(bc)) && strings.Contains(string(data), fmt.Sprint(ac))
				}, time.Second, 10*time.Millisecond)
				bu, au := codeInsert(bc, "BEN-RETAINED"), codeInsert(ac, "ALICE-RETAINED")
				f.documentEvidence(t, "before")
				ben.edit(t, bu)
				if point == "K7b" {
					ben.saved(t, 1) // the surviving client actually saw the sent receipt
				}
				// K7a can close the transport before Alice sends; her local replica
				// still retains this update, just as the production provider does.
				_, err := alice.doc.Peer(au)
				require.NoError(t, err)
				if point == "K7d" {
					ben.saved(t, 1)
					f.stopGuest()
					before := f.diskBytes(t)
					require.NoError(t, os.WriteFile(filepath.Join(f.root, "retry.ts"), []byte(before+"\nOUTSIDE-WHILE-DOWN"), 0640))
				} else {
					select {
					case err := <-f.restart.Exited:
						var exit *exec.ExitError
						require.ErrorAs(t, err, &exit)
						require.Equal(t, 73, exit.ExitCode())
					case <-time.After(10 * time.Second):
						t.Fatal("did not reach " + point)
					}
				}
				f.resume(t)
				b, a := f.browser(t, "ben-cookie"), f.browser(t, "alice-cookie")
				b.subClient(t, f.topic, bc)
				require.Equal(t, bc, b.assigned(t))
				a.subClient(t, f.topic, ac)
				require.Equal(t, ac, a.assigned(t))
				require.Equal(t, epoch, b.epoch, "K7a-d must retain item identities")
				require.Equal(t, epoch, a.epoch)
				// Replay twice: document identities make retransmission idempotent.
				b.edit(t, bu)
				b.edit(t, bu)
				a.edit(t, au)
				a.edit(t, au)
				b.savedClientClock(t, bc, uint64(len("BEN-RETAINED")))
				a.savedClientClock(t, ac, uint64(len("ALICE-RETAINED")))
				text := f.disk(t)
				require.Equal(t, 1, strings.Count(text, "BEN-RETAINED"))
				require.Equal(t, 1, strings.Count(text, "ALICE-RETAINED"))
				if point == "K7d" {
					require.Contains(t, text, "OUTSIDE-WHILE-DOWN")
				}
				b.converge(t, text)
				a.converge(t, text)
				f.documentEvidence(t, "after")
				sum := sha256.Sum256([]byte(text))
				t.Logf("point=%s run=%d sha256=%s broker=empty-census vm=false", point, run, hex.EncodeToString(sum[:]))
			})
		}
	}
}

// Duplicate replay need not create a new save. The durability contract is
// coverage of the client's Yjs clock by saved.sv, not acknowledgement of each
// retransmitted transport sequence. Decode the actual daemon receipt with an
// independent varuint reader instead of demanding a second save for the same
// update (which made K7 intermittently time out after a successful first save).
func (b *codeDocumentBrowser) savedClientClock(t *testing.T, client uint32, clock uint64) {
	t.Helper()
	for {
		kind, raw := b.read(t)
		if kind == websocket.MessageBinary {
			b.apply(t, raw)
			continue
		}
		var receipt struct{ T, SV string }
		require.NoError(t, json.Unmarshal(raw, &receipt))
		require.Equal(t, "saved", receipt.T, string(raw))
		vector, err := base64.StdEncoding.DecodeString(receipt.SV)
		require.NoError(t, err)
		read := func() uint64 {
			t.Helper()
			value, n := binary.Uvarint(vector)
			require.Greater(t, n, 0, "valid Yjs state-vector varuint")
			vector = vector[n:]
			return value
		}
		count := read()
		require.LessOrEqual(t, count, uint64(len(vector)/2))
		covered := false
		for n := uint64(0); n < count; n++ {
			id, through := read(), read()
			covered = covered || (id == uint64(client) && through >= clock)
		}
		require.Empty(t, vector)
		if covered {
			return
		}
	}
}

func (f *realDocumentInstall) diskBytes(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(f.root, "retry.ts"))
	require.NoError(t, err)
	return string(b)
}

func TestLiveCodeDocumentNewEpochRecovery(t *testing.T) {
	for run := 1; run <= 10; run++ {
		t.Run(fmt.Sprint(run), func(t *testing.T) {
			f := startRealDocumentInstall(t, "")
			script, err := filepath.Abs("../../../../apps/app/e2e/real/code-document-epoch.fixture.ts")
			require.NoError(t, err)
			ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, "bun", "run", script)
			command.Env = append(os.Environ(), "SMITHERS_CODE_DOCUMENT_ORIGIN="+f.origin, "SMITHERS_CODE_DOCUMENT_TOPIC="+f.topic)
			input, err := command.StdinPipe()
			require.NoError(t, err)
			output, err := command.StdoutPipe()
			require.NoError(t, err)
			stderr := &lockedBuffer{}
			command.Stderr = stderr
			require.NoError(t, command.Start())
			// Always reap this lane's child, including assertion failures.
			t.Cleanup(func() { cancel(); _ = command.Process.Kill() })
			scanner := bufio.NewScanner(output)
			var last string
			restarts := 0
			for scanner.Scan() {
				if scanner.Text() == "NEW_EPOCH" {
					f.stopGuest()
					entries, err := os.ReadDir(filepath.Join(f.restart.State, "documents"))
					require.NoError(t, err)
					require.NotEmpty(t, entries, "K7e must destroy real previously saved state")
					for _, entry := range entries {
						require.NoError(t, os.Remove(filepath.Join(f.restart.State, "documents", entry.Name())))
					}
					f.resume(t)
					restarts++
					_, err = io.WriteString(input, "RESTARTED\n")
					require.NoError(t, err)
					continue
				}
				last = scanner.Text()
			}
			require.NoError(t, scanner.Err())
			require.NoError(t, command.Wait(), stderr.String())
			require.Equal(t, 1, restarts)
			var result struct {
				Text, Copied string
				Retained     map[string]int
			}
			require.NoError(t, json.Unmarshal([]byte(last), &result))
			require.Equal(t, "BEN-REAPPLY", result.Text)
			require.Equal(t, "ALICE-COPY", result.Copied)
			require.Equal(t, map[string]int{"Ben": 1, "Alice": 1}, result.Retained)
			require.Equal(t, result.Text, f.disk(t))
		})
	}
}

// C-COL-03 uses the same admitted document and production mutation executor.
// This entry point does not count as complete provider qualification until
// the real freeze/thaw broker and member cgroups pass C-COL-04 on the mini.
func TestLiveCodeDocumentRealRewriteQualification(t *testing.T) {
	if os.Getenv("SMITHERS_CODE_DOCUMENT_PROVIDER_QUALIFICATION") != "1" {
		t.Skip("explicit real rewrite and capture provider qualification")
	}
	f := startRealDocumentInstall(t, "")
	ben := f.browser(t, "ben-cookie")
	ben.sub(t, f.topic)
	client := ben.assigned(t)
	before, err := f.registry.ReadFile(t.Context(), f.branch, "retry.ts", "")
	require.NoError(t, err)
	ben.edit(t, codeInsert(client, "DOCUMENT-BEFORE-REWRITE"))
	ben.saved(t, 1)
	tx, err := f.pool.Begin(t.Context())
	require.NoError(t, err)
	actor, err := machined.RecordActorInTx(t.Context(), tx, f.branch, f.branch, machined.ActorIdentity{Kind: "person", MemberID: f.ben, Via: "web"})
	require.NoError(t, err)
	require.NoError(t, tx.Commit(t.Context()))
	captured, err := f.registry.Capture(t.Context(), f.branch)
	require.NoError(t, err)
	require.Len(t, captured.Head, 40)
	// The current mutation provider correctly refuses rebasing a change onto
	// itself. Build a distinct root revision with the same tree so this driver
	// exercises an actual rewrite rather than that invalid no-op request.
	gitDir := filepath.Join(f.root, ".git")
	tree, err := exec.CommandContext(t.Context(), "git", "--git-dir", gitDir, "rev-parse", captured.Head+"^{tree}").Output()
	require.NoError(t, err)
	command := exec.CommandContext(t.Context(), "git", "--git-dir", gitDir, "-c", "user.name=Document qualification", "-c", "user.email=qualification@example.invalid", "commit-tree", strings.TrimSpace(string(tree)))
	command.Stdin = strings.NewReader("Independent rewrite target\n")
	onto, err := command.Output()
	require.NoError(t, err)
	_, err = f.registry.Rebase(t.Context(), f.branch, actor, strings.TrimSpace(string(onto)))
	require.NoError(t, err)
	// A pre-edit base remains stale after rewrite; it cannot overwrite the
	// saved document just because the file or subscription was reconstructed.
	result, err := f.registry.WriteFiles(t.Context(), f.branch, actor, []machined.FileChange{{Path: "retry.ts", BaseDigest: &before.Digest, Content: []byte("STALE-WRITER")}})
	require.NoError(t, err)
	require.NotNil(t, result.Stale)
	require.Empty(t, result.Applied)
	require.Equal(t, "DOCUMENT-BEFORE-REWRITE", f.disk(t))
	peer := f.browser(t, "alice-cookie")
	peer.sub(t, f.topic)
	peer.assigned(t)
	peer.converge(t, f.disk(t))
}

// Retain literal disk/state oracles, never boot secrets or synthetic receipts.
func (f *realDocumentInstall) documentEvidence(t *testing.T, stage string) {
	t.Helper()
	key := sha256.Sum256([]byte("retry.ts"))
	state, err := os.ReadFile(filepath.Join(f.restart.State, "documents", hex.EncodeToString(key[:])))
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(f.evidence, "state-"+stage+".bin"), state, 0600))
	text := f.diskBytes(t)
	require.NoError(t, os.WriteFile(filepath.Join(f.evidence, "retry-"+stage+".ts"), []byte(text), 0600))
	sum := sha256.Sum256([]byte(text))
	revision, err := exec.CommandContext(t.Context(), "git", "rev-parse", "HEAD").Output()
	require.NoError(t, err)
	env, err := json.Marshal(map[string]any{"test": t.Name(), "stage": stage, "commit": strings.TrimSpace(string(revision)), "sha256": hex.EncodeToString(sum[:]), "broker": "empty-census", "microvm": false, "activation": false})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(f.evidence, "env-"+stage+".json"), env, 0600))
	t.Logf("document evidence: %s", f.evidence)
}
