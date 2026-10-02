package services

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/stretchr/testify/require"
)

type artifactRecordingClient struct {
	*mockWorkspaceSandboxVMClient
	writes      []string
	content     map[string]string
	commands    []string
	failWrite   int
	createCalls []sandbox.CreateRequest
}

type artifactWaitStatusClient struct {
	*mockWorkspaceSandboxVMClient
	pending int
	calls   int
	empty   bool
}

func (c *artifactWaitStatusClient) Execute(ctx context.Context, _ string, _ sandbox.ExecRequest) (sandbox.ExecResult, error) {
	c.calls++
	status := "done"
	if c.calls <= c.pending {
		status = "pending"
	}
	if c.empty {
		status = ""
	}
	return sandbox.ExecResult{StatusCode: new(int32), Stdout: status}, ctx.Err()
}

func TestWorkspaceArtifactWaitUsesCallerDeadline(t *testing.T) {
	client := &artifactWaitStatusClient{mockWorkspaceSandboxVMClient: &mockWorkspaceSandboxVMClient{}, pending: 26}
	require.NoError(t, waitForWorkspaceArtifactBootstrap(t.Context(), client, "guest"))
	require.Equal(t, 27, client.calls, "a slow bootstrap must not hit a fixed attempt ceiling")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	require.ErrorIs(t, waitForWorkspaceArtifactBootstrap(ctx, client, "guest"), context.Canceled)
	empty := &artifactWaitStatusClient{mockWorkspaceSandboxVMClient: &mockWorkspaceSandboxVMClient{}, empty: true}
	require.ErrorContains(t, waitForWorkspaceArtifactBootstrap(t.Context(), empty, "guest"), "invalid workspace bootstrap status")
}

func (c *artifactRecordingClient) CreateSandbox(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
	c.createCalls = append(c.createCalls, req)
	return c.mockWorkspaceSandboxVMClient.CreateSandbox(ctx, req)
}

func (c *artifactRecordingClient) WriteFile(ctx context.Context, _ string, p string, r sandbox.WriteFileRequest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.writes = append(c.writes, p)
	if c.failWrite == len(c.writes) {
		return errors.New("transfer interrupted")
	}
	// Exercise the existing JSON transport shape, including its transient copy.
	body, err := json.Marshal(r)
	if err != nil {
		return err
	}
	if len(body) > workspaceArtifactChunkBytes+64 {
		return errors.New("unbounded file RPC")
	}
	var decoded sandbox.WriteFileRequest
	if err := json.Unmarshal(body, &decoded); err != nil {
		return err
	}
	c.content[p] = decoded.Content
	return nil
}
func (c *artifactRecordingClient) Execute(ctx context.Context, _ string, r sandbox.ExecRequest) (sandbox.ExecResult, error) {
	c.commands = append(c.commands, r.Command)
	stdout := ""
	if strings.HasPrefix(strings.TrimPrefix(r.Command, workspaceArtifactGuestPath), "if ! test -L ") {
		stdout = "done"
	}
	return sandbox.ExecResult{StatusCode: new(int32), Stdout: stdout}, ctx.Err()
}
func newArtifactRecordingClient() *artifactRecordingClient {
	return &artifactRecordingClient{mockWorkspaceSandboxVMClient: &mockWorkspaceSandboxVMClient{}, content: map[string]string{}}
}
func TestWorkspaceArtifactStreamingIntegrityAndBoundaries(t *testing.T) {
	for _, size := range []int{0, 1, workspaceArtifactChunkBytes - 1, workspaceArtifactChunkBytes, 3*workspaceArtifactChunkBytes + 17} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			raw := make([]byte, size)
			_, err := rand.NewChaCha8([32]byte{7}).Read(raw)
			require.NoError(t, err)
			source := filepath.Join(t.TempDir(), "artifact")
			require.NoError(t, os.WriteFile(source, raw, 0600))
			client := newArtifactRecordingClient()
			require.NoError(t, streamWorkspaceArtifact(t.Context(), client, "guest", source, "/payload"))
			if size == 0 {
				require.Empty(t, client.writes)
				return
			}
			var joined strings.Builder
			for _, p := range client.writes {
				require.LessOrEqual(t, len(client.content[p]), workspaceArtifactChunkBytes)
				joined.WriteString(client.content[p])
			}
			compressed := base64.NewDecoder(base64.StdEncoding, strings.NewReader(joined.String()))
			decoder, err := gzip.NewReader(compressed)
			require.NoError(t, err)
			actual, err := io.ReadAll(decoder)
			require.NoError(t, err)
			require.NoError(t, decoder.Close())
			require.Equal(t, raw, actual)
		})
	}
}
func TestWorkspaceArtifactTransferFailureNeverPublishesOrStarts(t *testing.T) {
	source := filepath.Join(t.TempDir(), "artifact")
	raw := make([]byte, 3<<20)
	_, err := rand.NewChaCha8([32]byte{1}).Read(raw)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(source, raw, 0600))
	t.Setenv(workspaceCLIPackageEnv, source)
	client := newArtifactRecordingClient()
	client.failWrite = 2
	err = finishWorkspaceArtifacts(t.Context(), client, "guest", "#!/bin/bash\ntrue\n")
	require.ErrorContains(t, err, "transfer interrupted")
	require.Len(t, client.writes, 2)
	require.Len(t, client.commands, 3, "readiness probe, baked-content probe and bounded attempt cleanup")
	require.Contains(t, client.commands[1], workspaceArtifactBakedRoot)
	require.Contains(t, client.commands[2], "rm -rf")
	require.NotContains(t, strings.Join(client.commands, "\n"), "setsid")
	require.NotContains(t, strings.Join(client.commands, "\n"), "ln -s")
}
func TestWorkspaceArtifactCancellationAndSourceErrors(t *testing.T) {
	client := newArtifactRecordingClient()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	source := filepath.Join(t.TempDir(), "artifact")
	require.NoError(t, os.WriteFile(source, []byte("content"), 0600))
	require.ErrorIs(t, streamWorkspaceArtifact(ctx, client, "guest", source, "/payload"), context.Canceled)
	require.Empty(t, client.writes)
	require.NoError(t, streamWorkspaceArtifact(t.Context(), client, "guest", source+"-missing", "/payload"))
	require.ErrorContains(t, streamWorkspaceArtifact(t.Context(), client, "guest", filepath.Dir(source), "/payload"), "not a regular file")
	require.ErrorContains(t, finishWorkspaceArtifacts(t.Context(), struct{}{}, "guest", "#!/bin/bash\ntrue\n"), "lacks artifact")
	require.ErrorContains(t, finishWorkspaceArtifacts(t.Context(), client, "", "#!/bin/bash\ntrue\n"), "empty sandbox")
}
func TestWorkspaceCreateDefersBootstrapButKeepsBootBarrier(t *testing.T) {
	source := filepath.Join(t.TempDir(), "cli")
	require.NoError(t, os.WriteFile(source, []byte("payload"), 0600))
	t.Setenv(workspaceCLIPackageEnv, source)
	req, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}).buildWorkspaceVMRequest(t.Context(), "", nil, 0, "", "container")
	require.NoError(t, err)
	client := newArtifactRecordingClient()
	client.createVMFn = func(_ context.Context, got sandbox.CreateRequest) (sandbox.CreateResult, error) {
		require.Empty(t, client.writes)
		for _, service := range got.Init.Services {
			require.NotEqual(t, workspaceClaudeService, service.Name)
		}
		require.Len(t, got.Init.Services, 1)
		require.Equal(t, workspaceReadyService, got.Init.Services[0].Name)
		require.True(t, *got.Init.Services[0].ReadySignal)
		return sandbox.CreateResult{ID: "guest"}, nil
	}
	_, err = createWorkspaceSandbox(t.Context(), client, req)
	require.NoError(t, err)
	require.NotEmpty(t, client.writes)
	require.Contains(t, client.commands[1], workspaceArtifactBakedRoot)
	require.Contains(t, client.commands[1], "sha256sum")
	require.Contains(t, client.commands[1], "gzip -1c")
	require.Contains(t, client.commands[1], "base64")
	require.NotContains(t, client.commands[1], "ln -s")
	publication, bootstrap := -1, -1
	for index, command := range client.commands {
		if strings.Contains(command, "ln -sT") {
			publication = index
		}
		if strings.Contains(command, "setsid /bin/sh") {
			bootstrap = index
		}
	}
	require.Positive(t, publication, "artifacts publish before bootstrap starts")
	require.Greater(t, bootstrap, publication, "bootstrap never sees an unpublished bundle")
	require.Equal(t, workspaceClaudeService, req.Init.Services[0].Name, "caller request remains unchanged")
}

// Run separately in a 1GiB Linux container. One realistic low-compressibility
// fixture is read by four concurrent transfers; gzip/base64/JSON copies are
// included, and the receiver hashes a streaming decode instead of retaining it.
func TestWorkspaceArtifactMemory632MiBFourTransfers(t *testing.T) {
	if os.Getenv("SMITHERS_ARTIFACT_MEMORY_PROBE") != "1" {
		t.Skip("explicit 632MiB/4-transfer memory campaign")
	}
	source := filepath.Join(t.TempDir(), "cli.tar")
	file, err := os.Create(source)
	require.NoError(t, err)
	h := sha256.New()
	random := rand.NewChaCha8([32]byte{19})
	size := int64(662231040)
	archive := tar.NewWriter(io.MultiWriter(file, h))
	require.NoError(t, archive.WriteHeader(&tar.Header{Name: "node_modules/test/payload.bin", Mode: 0644, Size: size - 1536}))
	_, err = io.CopyN(archive, random, size-1536)
	require.NoError(t, err)
	require.NoError(t, archive.Close())
	require.NoError(t, file.Close())
	want := h.Sum(nil)
	var wg sync.WaitGroup
	failures := make(chan error, 4)
	started := make(chan struct{})
	for i := 0; i < 4; i++ {
		wg.Go(func() {
			<-started
			pipeReader, pipeWriter := io.Pipe()
			verified := make(chan error, 1)
			go func() {
				defer pipeReader.Close()
				decoder, e := gzip.NewReader(base64.NewDecoder(base64.StdEncoding, pipeReader))
				if e != nil {
					verified <- e
					return
				}
				digest := sha256.New()
				n, e := io.Copy(digest, decoder)
				if e == nil {
					e = decoder.Close()
				}
				if e == nil && (n != size || !bytes.Equal(want, digest.Sum(nil))) {
					e = errors.New("archive digest/length mismatch")
				}
				verified <- e
			}()
			client := &artifactMemoryClient{sink: pipeWriter}
			e := streamWorkspaceArtifact(t.Context(), client, "guest", source, "/payload")
			pipeWriter.CloseWithError(e)
			decodeErr := <-verified
			failures <- errors.Join(e, decodeErr)
		})
	}
	runtime.GC()
	close(started)
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	var peak uint64
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			var m runtime.MemStats
			runtime.ReadMemStats(&m)
			peak = max(peak, m.Sys)
		case <-done:
			goto complete
		}
	}
complete:
	for i := 0; i < 4; i++ {
		require.NoError(t, <-failures)
	}
	t.Logf("fixture_bytes=%d concurrent_transfers=4 peak_go_sys_bytes=%d", size, peak)
	if raw, e := os.ReadFile("/sys/fs/cgroup/memory.peak"); e == nil {
		t.Logf("cgroup_memory_peak_bytes=%s", strings.TrimSpace(string(raw)))
	}
	require.Less(t, peak, uint64(512<<20), "live transfer state must remain bounded independently of archive size")
}

type artifactMemoryClient struct {
	*mockWorkspaceSandboxVMClient
	sink io.Writer
}

func (c *artifactMemoryClient) WriteFile(ctx context.Context, _ string, _ string, r sandbox.WriteFileRequest) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	if len(r.Content) > workspaceArtifactChunkBytes {
		return errors.New("oversized file RPC")
	}
	body, e := json.Marshal(r)
	if e != nil {
		return e
	}
	var decoded sandbox.WriteFileRequest
	if e = json.Unmarshal(body, &decoded); e != nil {
		return e
	}
	_, e = io.WriteString(c.sink, decoded.Content)
	return e
}
