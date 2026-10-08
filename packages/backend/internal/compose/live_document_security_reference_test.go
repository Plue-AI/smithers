package compose

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// C-COL-04: run on the reference Mac from the approved installed revision.
// The composed install owns admission, broker bytes, boot, credentials and
// machine startup. GitHub/model dependencies are local; guest execution and
// session/cgroup providers are real. This does not set LiveCodeDocuments.
type liveDocumentReference struct {
	r          *rehearsal
	vm         *microsandbox.Runtime
	registry   *machined.Registry
	branch     string
	actor      []byte
	ben        machined.SessionUser
	aliceToken string
}

func liveDocumentReferenceMachine(t *testing.T) *liveDocumentReference {
	t.Helper()
	if os.Getenv("SMITHERS_LIVE_DOCUMENT_SECURITY_REFERENCE") != "1" {
		t.Skip("C-COL-04 requires reference Mac, approved main-pinned bundle and real member broker")
	}
	require.Equal(t, "darwin", runtime.GOOS)
	t.Setenv(pinnedMicroVMRehearsal, "1")
	r := newRehearsal(t, pinnedMicroVMRehearsal, "C-COL-04", "live-document-security-")
	require.False(t, r.options.LiveCodeDocuments, "qualification never activates the product flag")
	require.True(t, r.install("Install through Machine ready"))
	_, err := r.member("ben", 201, "write")
	require.NoError(t, err)
	_, err = r.member("alice", 202, "write")
	require.NoError(t, err)
	data, err := r.expect("POST", "/api/branches", `{"from":"main","name":"live-document-security"}`, 201)
	require.NoError(t, err)
	var card j7Branch
	require.NoError(t, json.Unmarshal(data, &card))
	f := &liveDocumentReference{r: r, vm: r.workspaceRuntime.(*microsandbox.Runtime)}
	f.registry = f.vm.MachinedRegistry()
	var member int64
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT id FROM workspaces WHERE target_bookmark=$1 AND deleted_at IS NULL`, card.Name).Scan(&f.branch))
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT u.id,c.unix_login,c.unix_uid FROM users u JOIN collaborators c ON c.user_id=u.id WHERE u.lower_username='ben'`).Scan(&member, &f.ben.Login, &f.ben.UID))
	_, err = f.vm.EnsureMember(r.ctx, f.branch, microsandbox.MemberIdentity{Login: f.ben.Login, UID: int(f.ben.UID), Active: true})
	require.NoError(t, err)
	var alice microsandbox.MemberIdentity
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT c.unix_login,c.unix_uid FROM users u JOIN collaborators c ON c.user_id=u.id WHERE u.lower_username='alice'`).Scan(&alice.Login, &alice.UID))
	alice.Active = true
	credentials, err := f.vm.SessionCredentialsForMember(r.ctx, f.branch, alice)
	require.NoError(t, err)
	f.aliceToken, err = credentials.PutSessionToken(r.ctx, f.branch, "col08-security", []byte("ALICE-LOCAL-FIXTURE-TOKEN"), "absent")
	require.NoError(t, err)
	require.Equal(t, fmt.Sprintf("/run/smithers/%d/token/sessions/col08-security/token", alice.UID), f.aliceToken)
	require.NoError(t, f.vm.EnsureMachined(r.ctx, f.branch))
	// Select an immutable actor only after the install's real membership and
	// machine provisioning. No browser or branch supplies this reference.
	tx, err := r.pool.Begin(r.ctx)
	require.NoError(t, err)
	var machine string
	require.NoError(t, tx.QueryRow(r.ctx, `SELECT vm_id FROM workspaces WHERE id=$1 AND status='running' FOR SHARE`, f.branch).Scan(&machine))
	f.actor, err = machined.RecordActorInTx(r.ctx, tx, f.branch, machine, machined.ActorIdentity{Kind: "person", MemberID: member, Via: "web"})
	require.NoError(t, err)
	require.NoError(t, tx.Commit(r.ctx))
	return f
}

func (f *liveDocumentReference) command(t *testing.T, script string) string {
	t.Helper()
	result, err := f.vm.ExecuteCommand(f.r.ctx, f.branch, workspaceapi.Command{Args: []string{"/bin/sh", "-c", script}})
	require.NoError(t, err)
	require.Equal(t, 0, result.ExitCode, result.Stderr)
	return result.Stdout
}

func TestLiveDocumentConfinement(t *testing.T) {
	f := liveDocumentReferenceMachine(t)
	// Payload resolution happens inside the existing unprivileged machine door.
	f.command(t, strings.ReplaceAll(`test "$(id -u)" != 0 && printf 'safe document\n' > retry.ts && mkdir directory && mkfifo fifo && ln -s /etc/passwd leaf && ln -s /home/alice other-home && ln -s /run/smithers/0/token other-token && /usr/bin/python3 -I -S -c 'import socket; s=socket.socket(socket.AF_UNIX); s.bind("socket")'`, "/run/smithers/0/token", f.aliceToken))
	stream, err := f.registry.OpenDocument(f.r.ctx, f.branch, "retry.ts", f.actor)
	require.NoError(t, err)
	require.NoError(t, stream.Close())
	for _, path := range []string{"../etc/passwd", "/etc/passwd", "src/../../etc/smithers-sentinel", "leaf", "other-home/x", "other-token", "directory", "fifo", "socket"} {
		t.Run(path, func(t *testing.T) {
			started := time.Now()
			_, readErr := f.registry.ReadFile(f.r.ctx, f.branch, path, "")
			require.Error(t, readErr)
			require.Less(t, time.Since(started), 100*time.Millisecond)
			started = time.Now()
			doc, err := f.registry.OpenDocument(f.r.ctx, f.branch, path, f.actor)
			require.Error(t, err)
			require.Nil(t, doc)
			require.Less(t, time.Since(started), 100*time.Millisecond)
			_, err = f.registry.WriteFiles(f.r.ctx, f.branch, f.actor, []machined.FileChange{{Path: path, Content: []byte("forbidden")}})
			require.Error(t, err)
		})
	}
	// Exercise descriptor confinement while another real unprivileged process
	// swaps a parent between a directory and a link to the protected filesystem.
	before := f.command(t, `sha256sum /etc/passwd; mkdir d`)
	raceCtx, cancel := context.WithTimeout(f.r.ctx, 10*time.Minute)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		result, err := f.vm.ExecuteCommand(raceCtx, f.branch, workspaceapi.Command{Args: []string{"/bin/sh", "-c", `test "$(id -u)" != 0 || exit 1; while test ! -e race-done; do mv d parked && ln -s /etc d && rm d && mv parked d || exit 1; done`}})
		if err == nil && result.ExitCode != 0 {
			err = fmt.Errorf("swap process: %s", result.Stderr)
		}
		done <- err
	}()
	for n := 0; n < 10000; n++ {
		_, err := f.registry.WriteFiles(raceCtx, f.branch, f.actor, []machined.FileChange{{Path: "d/passwd", Content: []byte("confined write\n")}})
		if err != nil {
			var refusal *machined.SessionError
			require.ErrorAs(t, err, &refusal)
		}
	}
	f.command(t, `touch race-done`)
	require.NoError(t, <-done)
	require.Equal(t, before, f.command(t, `sha256sum /etc/passwd`))
	for _, actor := range [][]byte{nil, make([]byte, 16), []byte("root"), []byte("alice")} {
		_, err := f.registry.OpenDocument(f.r.ctx, f.branch, "retry.ts", actor)
		require.Error(t, err)
	}
	file, err := f.registry.ReadFile(f.r.ctx, f.branch, "retry.ts", "")
	require.NoError(t, err)
	require.Equal(t, "safe document\n", string(file.Content))
	_, err = f.registry.Capture(f.r.ctx, f.branch)
	require.NoError(t, err)
}

func TestLiveDocumentBrokerInputs(t *testing.T) {
	f := liveDocumentReferenceMachine(t)
	f.command(t, `printf 'live broker document\n' > retry.ts`)
	document, err := f.registry.OpenDocument(f.r.ctx, f.branch, "retry.ts", f.actor)
	require.NoError(t, err)
	t.Cleanup(func() { _ = document.Close() })
	link, err := f.registry.Current(f.branch)
	require.NoError(t, err)
	sessions := machined.NewSessions(link.Connection, f.branch, f.registry.Sessions(f.branch)).WithActor(f.actor, "").WithPresenceVia("terminal")
	for _, user := range []machined.SessionUser{{Login: "root", UID: 0}, {Login: "ben", UID: 0}, {Login: "../ben", UID: f.ben.UID}, {Login: "alice", UID: f.ben.UID}, {Login: "agent", UID: f.ben.UID}} {
		_, err := sessions.OpenExec(f.r.ctx, user, []string{"/bin/sh", "-c", "touch /workspace/root-input-canary"})
		require.Error(t, err)
	}
	for _, id := range []uint32{0, 0x80000000, 0xffffffff} {
		_, err := sessions.KillSession(f.r.ctx, id)
		require.Error(t, err)
		require.Error(t, sessions.CloseSession(f.r.ctx, id))
	}
	process, err := sessions.OpenExec(f.r.ctx, f.ben, []string{"/bin/sh", "-c", strings.ReplaceAll(`id -u; id -g; id -G; test ! -e /workspace/root-input-canary; test ! -r /run/smithers/20002/token; PATH=/workspace/hostile LD_PRELOAD=/workspace/hostile.so PYTHONPATH=/workspace /usr/bin/python3 -I -S -c 'import os; assert os.getuid()!=0 and os.getgid()!=0 and 0 not in os.getgroups(); os.chdir("/workspace"); assert not os.path.exists("root-input-canary")'`, "/run/smithers/20002/token", f.aliceToken)})
	require.NoError(t, err)
	var stdout, stderr []byte
	done := make(chan struct{})
	go func() { defer close(done); stderr, _ = io.ReadAll(process.Stderr()) }()
	stdout, err = io.ReadAll(process.Stdout())
	require.NoError(t, err)
	require.NoError(t, process.Wait())
	<-done
	require.NoError(t, process.Close())
	lines := strings.Split(strings.TrimSpace(string(stdout)), "\n")
	require.GreaterOrEqual(t, len(lines), 3, string(stderr))
	require.Equal(t, fmt.Sprint(f.ben.UID), lines[0])
	require.NotEqual(t, "0", lines[1])
	for _, group := range strings.Fields(lines[2]) {
		require.NotEqual(t, "0", group)
	}
	// Keep an authorized member process alive through the real freeze/thaw,
	// rather than qualifying a broker whose session census is already empty.
	probe, err := sessions.OpenExec(f.r.ctx, f.ben, []string{"/bin/sh", "-c", `printf 'READY\n'; IFS= read -r word; test "$word" = THAWED || exit 1; printf 'THAWED\n'`})
	require.NoError(t, err)
	t.Cleanup(func() { _ = probe.Close() })
	reader := bufio.NewReader(probe.Stdout())
	ready, err := reader.ReadString('\n')
	require.NoError(t, err)
	require.Equal(t, "READY\n", ready)
	// Capture/rewrite drives the installed freeze/thaw dispatch, with its fixed
	// cgroup subtree; no caller-controlled cgroup path is accepted by the API.
	capture, err := f.registry.Capture(f.r.ctx, f.branch)
	require.NoError(t, err)
	// A change cannot rebase onto itself. Make an independent target from
	// the captured tree inside the unprivileged guest, preserving its bytes.
	onto := strings.TrimSpace(f.command(t, fmt.Sprintf(`tree=$(git rev-parse '%s^{tree}') && printf 'Independent document security target\n' | git -c user.name=Qualification -c user.email=qualification@example.invalid commit-tree "$tree"`, capture.Head)))
	require.Len(t, onto, 40)
	require.NotEqual(t, capture.Head, onto)
	_, err = f.registry.Rebase(f.r.ctx, f.branch, f.actor, onto)
	require.NoError(t, err)
	written, err := probe.Write([]byte("THAWED\n"))
	require.NoError(t, err)
	require.Equal(t, 7, written)
	require.NoError(t, probe.CloseWrite())
	thawed, err := reader.ReadString('\n')
	require.NoError(t, err)
	require.Equal(t, "THAWED\n", thawed)
	require.NoError(t, probe.Wait())
	require.NoError(t, probe.Close())
}

func TestLiveDocumentTrustedStartup(t *testing.T) {
	f := liveDocumentReferenceMachine(t)
	// These bytes are written only through the unprivileged workspace API.
	// Fresh and retained startup must continue using the installed broker and
	// isolated interpreter rather than PATH/import candidates in this branch.
	f.command(t, `test "$(id -u)" != 0 && mkdir -p hostile && printf '#!/bin/sh\nprintf root-executed > /workspace/root-canary\n' > hostile/smithers-machined && chmod 755 hostile/smithers-machined && printf 'import pathlib; pathlib.Path("/workspace/root-canary").write_text("imported")\n' > sitecustomize.py`)
	bundle, err := installbundle.Open(os.Getenv("SMITHERS_CHECK_BUNDLE"))
	require.NoError(t, err)
	_, entry, err := bundle.Read("bin/linux-arm64/smithers-machined", 128<<20)
	require.NoError(t, err)
	before := f.command(t, `sha256sum /opt/smithers/bin/smithers-machined; test ! -e /workspace/root-canary`)
	require.Equal(t, entry.SHA256+"  /opt/smithers/bin/smithers-machined\n", before, "guest daemon and broker bytes equal the approved main bundle")
	require.NoError(t, f.vm.StopWorkspace(f.r.ctx, f.branch))
	_, err = f.vm.StartWorkspace(f.r.ctx, f.branch)
	require.NoError(t, err)
	require.NoError(t, f.vm.EnsureMachined(f.r.ctx, f.branch))
	after := f.command(t, `sha256sum /opt/smithers/bin/smithers-machined; test ! -e /workspace/root-canary; test ! -w /opt/smithers/bin/smithers-machined; test ! -w /opt/smithers/bin; test ! -w /usr/bin/python3`)
	require.Equal(t, before, after)
	// Retained startup must expose the same real document RPC after validation.
	f.command(t, `printf 'retained startup\n' > retry.ts`)
	stream, err := f.registry.OpenDocument(f.r.ctx, f.branch, "retry.ts", f.actor)
	require.NoError(t, err)
	require.NoError(t, stream.Close())
	file, err := f.registry.ReadFile(context.Background(), f.branch, "retry.ts", "")
	require.NoError(t, err)
	require.Equal(t, hex.EncodeToString([]byte("retained startup\n")), hex.EncodeToString(file.Content))
}

// C-DUR-04 K7b: kill the install-owned VM after two real saved receipts,
// then recover its retained disk through production StartWorkspace. This is
// separate from daemon-only K7b; a graceful sleep cannot qualify a VM kill.
func TestLiveCodeDocumentK7bVMReference(t *testing.T) {
	if os.Getenv("SMITHERS_LIVE_DOCUMENT_K7_VM_REFERENCE") != "1" {
		t.Skip("K7b VM requires reference Mac and approved main-pinned installed bundle")
	}
	t.Setenv("SMITHERS_LIVE_DOCUMENT_SECURITY_REFERENCE", "1")
	for run := 1; run <= 10; run++ {
		t.Run(fmt.Sprint(run), func(t *testing.T) {
			f := liveDocumentReferenceMachine(t)
			f.command(t, `printf '' > retry.ts`)
			bundle, err := installbundle.Open(os.Getenv("SMITHERS_CHECK_BUNDLE"))
			require.NoError(t, err)
			machine, err := f.vm.WorkspaceMachineIdentity(t.Context(), f.branch)
			require.NoError(t, err)
			var alice int64
			require.NoError(t, f.r.pool.QueryRow(t.Context(), `SELECT id FROM users WHERE lower_username='alice'`).Scan(&alice))
			tx, err := f.r.pool.Begin(t.Context())
			require.NoError(t, err)
			actor, err := machined.RecordActorInTx(t.Context(), tx, f.branch, machine, machined.ActorIdentity{Kind: "person", MemberID: alice, Via: "web"})
			require.NoError(t, err)
			require.NoError(t, tx.Commit(t.Context()))
			open := func(actor []byte) (machined.DocumentStream, wire.Document) {
				t.Helper()
				stream, err := f.registry.OpenDocument(t.Context(), f.branch, "retry.ts", actor)
				require.NoError(t, err)
				t.Cleanup(func() { _ = stream.Close() })
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				for {
					raw, err := stream.Receive(ctx)
					require.NoError(t, err)
					frame, err := wire.DecodeDocumentV2(raw)
					require.NoError(t, err)
					if frame.Msg == wire.DocumentEpoch {
						return stream, frame
					}
				}
			}
			edit := func(stream machined.DocumentStream, actor, update []byte, saved bool) {
				t.Helper()
				raw, err := wire.EncodeDocumentV2(wire.Document{Msg: wire.DocumentInput, Actor: actor, Seq: 1, Data: codeSync(2, update)})
				require.NoError(t, err)
				require.NoError(t, stream.Send(t.Context(), raw))
				ctx, cancel := context.WithTimeout(t.Context(), time.Second)
				defer cancel()
				for {
					raw, err := stream.Receive(ctx)
					require.NoError(t, err)
					frame, err := wire.DecodeDocumentV2(raw)
					require.NoError(t, err)
					if (saved && frame.Msg == wire.DocumentSaved && frame.ThroughSeq >= 1) || (!saved && frame.Msg == wire.DocumentSync && bytes.Equal(frame.Data, codeSync(2, update))) {
						return
					}
				}
			}
			ben, initial := open(f.actor)
			aliceStream, peer := open(actor)
			require.Equal(t, initial.Epoch, peer.Epoch)
			require.NotEqual(t, initial.ClientID, peer.ClientID)
			bu, au := codeInsert(initial.ClientID, "BEN-VM-SAVED"), codeInsert(peer.ClientID, "ALICE-VM-SAVED")
			edit(ben, f.actor, bu, true)
			edit(aliceStream, actor, au, true)
			before := f.command(t, `cat retry.ts`)
			require.Equal(t, 1, strings.Count(before, "BEN-VM-SAVED"))
			require.Equal(t, 1, strings.Count(before, "ALICE-VM-SAVED"))
			msb := bundle.Program("bin/msb")
			require.NoError(t, msb.Check())
			ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
			command := exec.CommandContext(ctx, msb.Path(), "stop", "-t", "0", "-q", machine)
			command.Env = []string{"HOME=" + os.Getenv("HOME"), "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "MSB_BACKEND=local", "NO_COLOR=1"}
			output, err := command.CombinedOutput()
			cancel()
			require.NoError(t, err, "%s", output)
			_, err = f.vm.StartWorkspace(t.Context(), f.branch)
			require.NoError(t, err)
			require.NoError(t, f.vm.EnsureMachined(t.Context(), f.branch))
			require.Equal(t, before, f.command(t, `cat retry.ts`))
			ben, recovered := open(f.actor)
			aliceStream, recoveredPeer := open(actor)
			require.Equal(t, initial.Epoch, recovered.Epoch)
			require.Equal(t, initial.Epoch, recoveredPeer.Epoch)
			// Replay the retained original updates, not updates with freshly
			// assigned IDs. Durable authors must authorize them exactly once.
			edit(ben, f.actor, bu, false)
			edit(aliceStream, actor, au, false)
			_, err = f.registry.Capture(t.Context(), f.branch)
			require.NoError(t, err)
			require.Equal(t, before, f.command(t, `cat retry.ts`))
			evidence, err := json.Marshal(map[string]any{"run": run, "bundle_revision": bundle.Revision(), "bundle_manifest": bundle.ManifestSHA256(), "machine": machine, "epoch": hex.EncodeToString(initial.Epoch[:]), "text": before, "fault": "msb stop -t 0", "broker": "installed", "activation": false})
			require.NoError(t, err)
			require.NoError(t, os.WriteFile(f.r.evidence+"/k7b-vm.json", evidence, 0600))
		})
	}
}
