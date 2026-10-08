package compose

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	processruntime "github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Private host-owned configuration; never archived as qualification evidence.
type codeDocumentFaultHostConfig struct {
	Database, Storage, Branch, Endpoint, Head, Origin, Ready, Capture string
	Authority                                                         machined.BootAuthority
	Initial                                                           bool
}

// K7b's abrupt host variant: the parent owns the real guest separately from
// the composed host. SIGKILL cannot run the host's graceful shutdown handlers.
// Empty broker census limits this to Linux host/daemon evidence, not VM/security
// acceptance. LiveCodeDocuments is enabled only inside this disposable test.
func TestLiveCodeDocumentK7bHostKill(t *testing.T) {
	for run := 1; run <= 10; run++ {
		t.Run(fmt.Sprint(run), func(t *testing.T) {
			var config codeDocumentFaultHostConfig
			var child *exec.Cmd
			var exited <-chan error
			var launch func()
			f := startRealDocumentInstallWithHost(t, "", func(f *realDocumentInstall, storage string) {
				f.stop()
				require.NoError(t, f.registry.Close())
				f.registry = new(machined.Registry)
				t.Cleanup(func() { require.NoError(t, f.registry.Close()) })
				authority, err := f.registry.MintBoot(f.branch, f.branch)
				require.NoError(t, err)
				require.NoError(t, os.MkdirAll(filepath.Join(f.restart.Run, "machined"), 0700))
				boot, err := authority.FileForItem(0, machined.ItemBinding{})
				require.NoError(t, err)
				require.NoError(t, os.WriteFile(filepath.Join(f.restart.Run, "machined", "boot"), boot, 0400))
				// Host authority and controls never enter the guest state mount.
				hostState := t.TempDir()
				config = codeDocumentFaultHostConfig{Database: f.pool.Config().ConnString(), Storage: storage,
					Branch: f.branch, Head: f.restart.HostHead, Origin: f.origin, Authority: authority,
					Ready: filepath.Join(hostState, "host-ready"), Capture: filepath.Join(hostState, "host-capture"), Initial: true}
				launch = func() {
					t.Helper()
					private := filepath.Join(hostState, "host-authority.json")
					data, err := json.Marshal(config)
					require.NoError(t, err)
					require.NoError(t, os.WriteFile(private, data, 0600))
					_ = os.Remove(config.Ready)
					child = exec.CommandContext(t.Context(), os.Args[0], "-test.run=^TestLiveCodeDocumentHostProcessChild$", "-test.v")
					child.Env = append(os.Environ(), "SMITHERS_CODE_DOCUMENT_HOST_CONFIG="+private)
					log, err := os.OpenFile(filepath.Join(f.evidence, "host.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
					require.NoError(t, err)
					child.Stdout, child.Stderr = log, log
					require.NoError(t, child.Start())
					owned := child
					done := make(chan error, 1)
					go func() { done <- owned.Wait(); _ = log.Close(); close(done) }()
					exited = done
					t.Cleanup(func() {
						_ = owned.Process.Kill()
						select {
						case <-done:
						case <-time.After(5 * time.Second):
							t.Error("owned host was not reaped")
						}
					})
					var origin []byte
					require.Eventually(t, func() bool { origin, err = os.ReadFile(config.Ready); return err == nil }, 40*time.Second, 25*time.Millisecond)
					target, err := url.Parse(string(origin))
					require.NoError(t, err)
					proxy := httputil.NewSingleHostReverseProxy(target)
					f.handler.Store(http.HandlerFunc(proxy.ServeHTTP))
				}
				f.restart.Attach = func(_ context.Context, address string) error { config.Endpoint = address; launch(); return nil }
			})
			ben, alice := f.browser(t, "ben-cookie"), f.browser(t, "alice-cookie")
			ben.sub(t, f.topic)
			bc := ben.assigned(t)
			alice.sub(t, f.topic)
			ac := alice.assigned(t)
			bu, au := codeInsert(bc, "BEN-HOST-SAVED-🌍"), codeInsert(ac, "ALICE-HOST-SAVED-🧪")
			ben.edit(t, bu)
			alice.edit(t, au)
			ben.savedClientClock(t, bc, 17)
			alice.savedClientClock(t, ac, 19)
			want := f.diskBytes(t)
			ben.converge(t, want)
			alice.converge(t, want)
			require.Equal(t, 1, strings.Count(want, "BEN-HOST-SAVED-🌍"))
			require.Equal(t, 1, strings.Count(want, "ALICE-HOST-SAVED-🧪"))
			epoch := ben.epoch
			require.Equal(t, epoch, alice.epoch)
			pid := child.Process.Pid
			require.NoError(t, child.Process.Kill())
			select {
			case err := <-exited:
				var exit *exec.ExitError
				require.ErrorAs(t, err, &exit)
				status, ok := exit.Sys().(syscall.WaitStatus)
				require.True(t, ok)
				require.True(t, status.Signaled())
				require.Equal(t, syscall.SIGKILL, status.Signal())
			case <-time.After(5 * time.Second):
				t.Fatal("owned host did not die")
			}
			require.Equal(t, want, f.diskBytes(t))
			config.Initial = false
			launch() // same live guest, protected boot, DB and immutable host store
			peerBen, peerAlice := f.browser(t, "ben-cookie"), f.browser(t, "alice-cookie")
			peerBen.sub(t, f.topic)
			peerBen.assigned(t)
			peerAlice.sub(t, f.topic)
			peerAlice.assigned(t)
			require.Equal(t, epoch, peerBen.epoch)
			require.Equal(t, epoch, peerAlice.epoch)
			peerBen.converge(t, want)
			peerAlice.converge(t, want)
			// Retained original updates have old client ids. Replay must preserve
			// their authors and apply each exactly once, even across host death.
			peerBen.edit(t, bu)
			peerAlice.edit(t, au)
			peerBen.savedClientClock(t, bc, 17)
			peerAlice.savedClientClock(t, ac, 19)
			require.Equal(t, want, f.diskBytes(t))
			require.NoError(t, os.WriteFile(config.Capture+".request", nil, 0600))
			var data []byte
			require.Eventually(t, func() bool { var err error; data, err = os.ReadFile(config.Capture); return err == nil }, 10*time.Second, 25*time.Millisecond)
			var capture machined.CaptureResult
			require.NoError(t, json.Unmarshal(data, &capture))
			file, err := f.host.GetFileAtCommit(t.Context(), "ben", "demo", capture.Head, "retry.ts")
			require.NoError(t, err)
			content := []byte(file.Content)
			if file.Encoding == "base64" {
				content, err = base64.StdEncoding.DecodeString(file.Content)
				require.NoError(t, err)
			}
			require.Equal(t, want, string(content))
			require.NoError(t, os.WriteFile(filepath.Join(f.evidence, "host-capture.json"), data, 0600))
			proof, err := json.Marshal(map[string]any{"run": run, "signal": "SIGKILL", "pid": pid, "replacement_pid": child.Process.Pid, "epoch": epoch, "text": want, "head": capture.Head, "broker": "empty-census", "activation": false})
			require.NoError(t, err)
			require.NoError(t, os.WriteFile(filepath.Join(f.evidence, "k7b-host.json"), proof, 0600))
			f.documentEvidence(t, "host-recovered")
		})
	}
}

func TestLiveCodeDocumentHostProcessChild(t *testing.T) {
	private := os.Getenv("SMITHERS_CODE_DOCUMENT_HOST_CONFIG")
	if private == "" {
		return
	}
	data, err := os.ReadFile(private)
	require.NoError(t, err)
	var config codeDocumentFaultHostConfig
	require.NoError(t, json.Unmarshal(data, &config))
	pool, err := postgresfixture.Open(t.Context(), config.Database, 4)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	native := repohostffi.New(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NoError(t, native.Load())
	cfg := repohostserver.Config{StoragePath: config.Storage, AuthToken: "document-daemon"}
	server, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, server.Shutdown(context.Background())) })
	client := repohost.NewLocalClient(server.Handler(), cfg.AuthToken)
	client.BindMachineRepository(server.WithMachineRepository)
	registry := new(machined.Registry)
	require.NoError(t, registry.RegisterBoot(config.Branch, config.Branch, config.Authority))
	runtime, err := processruntime.New(processruntime.Config{Root: t.TempDir(), MaxConcurrent: 2, OutputLimit: 1 << 20})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	handler, _ := startCodeDocumentProcess(t, Options{Repository: client, ChatHost: unusedChatHost{}, Workspace: runtime, BranchMachines: rehearsalBranchMachines(pool), Machined: registry, LiveCodeDocuments: true, FlowHostProductAPIURL: config.Origin})
	stream, err := net.DialTimeout("tcp", config.Endpoint, 5*time.Second)
	require.NoError(t, err)
	require.NoError(t, stream.SetReadDeadline(time.Now().Add(30*time.Second)))
	reader := bufio.NewReader(stream)
	_, err = reader.Peek(1)
	require.NoError(t, err)
	link, err := registry.Connect(t.Context(), config.Branch, rehearsalReadyConn{stream, reader})
	require.NoError(t, err)
	if config.Initial {
		head, err := hex.DecodeString(config.Head)
		require.NoError(t, err)
		_, err = link.Request(t.Context(), config.Branch, wire.WakeReconcile, wire.Field(1, head))
		require.NoError(t, err)
	}
	_, err = link.Request(t.Context(), config.Branch, wire.SetRoster, wire.Field(1, wire.U16(0)))
	require.NoError(t, err)
	// A transport handshake is not wake/outbox completion. Use the daemon's
	// real status before publishing readiness, as the outside-host driver does.
	require.Eventually(t, func() bool {
		reply, err := link.Request(t.Context(), config.Branch, wire.Status)
		if err != nil {
			return false
		}
		fields, err := wire.Fields("response", reply.Payload[1:])
		if err != nil || len(fields[2]) < 2 || fields[2][0] != byte(wire.Status) {
			return false
		}
		status, err := wire.Fields("result1", fields[2][1:])
		return err == nil && len(status[1]) == 1 && status[1][0] == 3 && len(status[4]) == 4 && binary.BigEndian.Uint32(status[4]) == 0 && len(status[7]) == 1 && status[7][0] == 1 && len(status[8]) == 1 && status[8][0] == 1
	}, 30*time.Second, 25*time.Millisecond)
	require.NoError(t, link.Reconciled())
	http := httptest.NewServer(handler)
	t.Cleanup(http.Close)
	require.NoError(t, os.WriteFile(config.Ready, []byte(http.URL), 0600))
	for {
		if _, err := os.Stat(config.Capture + ".request"); err == nil {
			var capture machined.CaptureResult
			// Snapshot's metadata events can briefly invalidate idle safety.
			// Retry only that typed refusal, never a transport or capture failure.
			require.Eventually(t, func() bool {
				capture, err = registry.Capture(t.Context(), config.Branch)
				return !errors.Is(err, machined.ErrNotReady)
			}, 5*time.Second, 25*time.Millisecond)
			require.NoError(t, err)
			data, err := json.Marshal(capture)
			require.NoError(t, err)
			require.NoError(t, os.WriteFile(config.Capture, data, 0600))
			require.NoError(t, os.Remove(config.Capture+".request"))
		}
		time.Sleep(10 * time.Millisecond)
	}
}
