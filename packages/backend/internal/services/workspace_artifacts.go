package services

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"log/slog"
	"os"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

const workspaceArtifactRoot = "/var/lib/smithers/workspace-artifacts"
const workspaceArtifactCurrent = workspaceArtifactRoot + "/current"
const workspaceArtifactOwnerPath = workspaceArtifactRoot + "/owner"
const workspaceArtifactManifest = "bundle.sha256"
const workspaceArtifactGuestPath = "PATH=/run/current-system/sw/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH; "

func workspaceArtifactOwner(workspaceID string) string {
	if workspaceID == "" {
		workspaceID = uuid.NewString()
	}
	return fmt.Sprintf("%x", sha256.Sum256([]byte(workspaceID)))
}

// One synchronous file RPC at a time: neither the create map nor the JSON
// encoder ever owns the full archive. This also bounds poorly compressible input.
const workspaceArtifactChunkBytes = 1 << 20

type workspaceArtifactClient interface {
	WriteFile(context.Context, string, string, sandbox.WriteFileRequest) error
	Execute(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error)
}

type workspaceCreator interface {
	CreateSandbox(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error)
}

// createWorkspaceSandbox is shared by workspaces, CI and golden builders. The
// boot barrier remains in Init; only the asynchronous toolchain bootstrap is
// deferred until its artifacts have been transferred completely.
func createWorkspaceSandbox(ctx context.Context, client workspaceCreator, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
	if _, workspace := req.Files[workspaceClaudeScriptPath]; !workspace {
		return client.CreateSandbox(ctx, req)
	}
	if req.Init != nil {
		init := *req.Init
		init.Services = nil
		for _, service := range req.Init.Services {
			if service.Name != workspaceClaudeService {
				init.Services = append(init.Services, service)
			}
		}
		req.Init = &init
	}
	vm, err := client.CreateSandbox(ctx, req)
	if err != nil {
		return vm, err
	}
	if err := finishWorkspaceArtifacts(ctx, client, vm.ID, req.Files[workspaceClaudeScriptPath].Content); err != nil {
		return vm, err
	}
	if artifacts, ok := client.(workspaceArtifactClient); ok {
		if err := waitForWorkspaceArtifactBootstrap(ctx, artifacts, vm.ID); err != nil {
			return vm, err
		}
	}
	return vm, nil
}

func artifactCommand(ctx context.Context, client workspaceArtifactClient, id, command string, timeoutMS ...int64) (sandbox.ExecResult, error) {
	req := sandbox.ExecRequest{Command: workspaceArtifactGuestPath + command}
	if len(timeoutMS) > 0 {
		req.TimeoutMS = &timeoutMS[0]
	}
	result, err := client.Execute(ctx, id, req)
	if err != nil {
		return result, err
	}
	if result.StatusCode == nil || *result.StatusCode != 0 {
		return result, fmt.Errorf("workspace artifact command failed: %s", strings.TrimSpace(result.Stderr))
	}
	return result, nil
}

type workspaceArtifactSource struct{ source, target, label, digest string }

func workspaceArtifactSources() []workspaceArtifactSource {
	host := strings.TrimSpace(os.Getenv(workspaceCodingHostBinaryEnv))
	if host == "" {
		host = workspaceCodingHostPath
	}
	return []workspaceArtifactSource{
		{source: workspaceCLIPackage(), target: path.Base(workspaceCLIPackageB64Path), label: "npm CLI package"},
		{source: host, target: path.Base(workspaceCodingHostB64Path), label: "coding host"},
		{source: workspaceJJExport(), target: path.Base(workspaceJJExportB64Path), label: "jj export helper"},
	}
}

func workspaceBootstrapScriptForKind(kind string) string {
	if sandboxKindForWorkspace(kind) == "container" {
		return buildWorkspaceClaudeBootstrapScript()
	}
	return buildWorkspaceNixBootstrapScript()
}

// The key is based on bytes and the current bootstrap recipe, never the workspace
// owner. A forked disk can reuse an identical installed bundle without another
// transfer or install. Hashing streams each source; it retains no archive copy.
func workspaceArtifactKey(ctx context.Context, scriptDigest string, sources []workspaceArtifactSource) (string, error) {
	key := sha256.New()
	_, _ = io.WriteString(key, "workspace-artifacts-v1\n"+scriptDigest+"\n")
	for i := range sources {
		_, _ = io.WriteString(key, sources[i].target+"\x00")
		file, err := os.Open(sources[i].source)
		if errors.Is(err, os.ErrNotExist) {
			sources[i].digest = "absent"
			_, _ = io.WriteString(key, "absent\n")
			continue
		}
		if err != nil {
			return "", err
		}
		info, statErr := file.Stat()
		if statErr != nil || !info.Mode().IsRegular() {
			_ = file.Close()
			if statErr != nil {
				return "", statErr
			}
			return "", errors.New("workspace artifact is not a regular file")
		}
		if info.Size() == 0 {
			sources[i].digest = "empty"
			_, _ = io.WriteString(key, "empty\n")
			_ = file.Close()
			continue
		}
		content := sha256.New()
		_, copyErr := io.CopyBuffer(content, &workspaceArtifactReader{ctx: ctx, reader: file}, make([]byte, 32<<10))
		closeErr := file.Close()
		if err := errors.Join(copyErr, closeErr); err != nil {
			return "", err
		}
		sources[i].digest = hex.EncodeToString(content.Sum(nil))
		_, _ = io.WriteString(key, sources[i].digest+"\n")
	}
	return hex.EncodeToString(key.Sum(nil)), nil
}

func finishWorkspaceArtifacts(ctx context.Context, provider any, id, script string) error {
	client, ok := provider.(workspaceArtifactClient)
	if !ok {
		return errors.New("workspace provider lacks artifact file transfer")
	}
	if id == "" {
		return errors.New("workspace provider returned an empty sandbox ID")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if script == "" {
		return errors.New("workspace bootstrap script is empty")
	}
	// Published directories are immutable. A cloned disk may reuse the same
	// installed bundle even when its owner marker changes. Stage the recipe in
	// that bundle so concurrent deploy attempts cannot execute each other's script.
	probe := "owner=$(cat " + shellQuote(workspaceArtifactOwnerPath) + " 2>/dev/null || printf legacy); manifest=$(cat " + shellQuote(workspaceArtifactCurrent+"/"+workspaceArtifactManifest) + " 2>/dev/null || true); printf '%s\\n%s\\n' \"$owner\" \"$manifest\""
	result, err := artifactCommand(ctx, client, id, probe)
	if err != nil {
		return err
	}
	parts := strings.Split(result.Stdout, "\n")
	owner := strings.TrimSpace(parts[0])
	if owner == "" { // Older adopted guests have no owner marker.
		owner = "legacy"
	}
	if owner != "legacy" {
		if _, err := hex.DecodeString(owner); err != nil || len(owner) != 64 {
			return errors.New("invalid workspace artifact owner")
		}
	}
	scriptDigest := fmt.Sprintf("%x", sha256.Sum256([]byte(script)))
	currentManifest := ""
	if len(parts) > 1 {
		currentManifest = strings.TrimSpace(parts[1])
	}
	sources := workspaceArtifactSources()
	key, err := workspaceArtifactKey(ctx, scriptDigest, sources)
	if err != nil {
		return err
	}
	if currentManifest != key {
		directory := workspaceArtifactRoot + "/" + owner + "/" + uuid.NewString()
		defer func() {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			// Preserve the winner, including an ambiguous publish whose response was lost.
			_, _ = artifactCommand(cleanup, client, id, "if test \"$(readlink "+shellQuote(workspaceArtifactCurrent)+")\" != "+shellQuote(directory)+"; then exec 9>"+shellQuote(workspaceArtifactRoot+"/bootstrap.lock")+"; flock -w 2 9 || exit 1; if test \"$(readlink "+shellQuote(workspaceArtifactCurrent)+")\" != "+shellQuote(directory)+"; then rm -rf -- "+shellQuote(directory)+" "+shellQuote(directory+".publish")+"; rmdir -- "+shellQuote(path.Dir(directory))+" 2>/dev/null || true; fi; fi")
		}()
		for _, artifact := range sources {
			if err := streamWorkspaceArtifactChecked(ctx, client, id, artifact.source, directory+"/"+artifact.target, artifact.digest); err != nil {
				return fmt.Errorf("stage workspace %s: %w", artifact.label, err)
			}
		}
		if err := client.WriteFile(ctx, id, directory+"/bootstrap.sh", sandbox.WriteFileRequest{Content: script}); err != nil {
			return fmt.Errorf("stage workspace bootstrap script: %w", err)
		}
		if err := client.WriteFile(ctx, id, directory+"/"+workspaceArtifactManifest, sandbox.WriteFileRequest{Content: key}); err != nil {
			return fmt.Errorf("stage workspace artifact manifest: %w", err)
		}
		// Ensure even an installation with no optional artifacts has a directory.
		// Publication and bootstrap share a lock. One complete attempt wins for
		// this workspace; inherited snapshot data can only be replaced while no
		// bootstrap is reading it. Atomic rename never exposes a partial bundle.
		publish := "mkdir -p -- " + shellQuote(directory) + " || exit 1; exec 9>" + shellQuote(workspaceArtifactRoot+"/bootstrap.lock") + "; flock -w 30 9 || exit 1; old=$(readlink " + shellQuote(workspaceArtifactCurrent) + " || true); if test \"$(cat " + shellQuote(workspaceArtifactCurrent+"/"+workspaceArtifactManifest) + " 2>/dev/null)\" != " + shellQuote(key) + "; then ln -sT -- " + shellQuote(directory) + " " + shellQuote(directory+".publish") + " && mv -Tf -- " + shellQuote(directory+".publish") + " " + shellQuote(workspaceArtifactCurrent) + " || exit 1; case \"$old\" in " + shellQuote(workspaceArtifactRoot) + "/*/*) if test \"$old\" != " + shellQuote(directory) + "; then rm -rf -- \"$old\"; rmdir -- \"${old%/*}\" 2>/dev/null || true; fi;; esac; fi"
		if _, err := artifactCommand(ctx, client, id, publish); err != nil {
			return err
		}
	}
	// flock lives in the guest, so an old detached bootstrap and a recovered
	// provisioner serialize too. Completed bootstrap is never launched twice.
	token := uuid.NewString()
	bootstrap := "exec 9>" + shellQuote(workspaceArtifactRoot+"/bootstrap.lock") + "; flock -w 120 9 || exit 1; test ! -f " + shellQuote(workspaceArtifactCurrent+"/bootstrap.done") + " || exit 0; rm -f -- " + shellQuote(workspaceArtifactCurrent+"/bootstrap.failed") + "; if /bin/bash " + shellQuote(workspaceArtifactCurrent+"/bootstrap.sh") + " 9>&- && touch " + shellQuote(workspaceArtifactCurrent+"/bootstrap.done") + "; then exit 0; else status=$?; printf '%s:%s\\n' " + shellQuote(token) + " \"$status\" >" + shellQuote(workspaceArtifactCurrent+"/bootstrap.failed") + "; exit \"$status\"; fi"
	command := "mkdir -p -- " + shellQuote(workspaceArtifactRoot) + " || exit 1; command -v flock >/dev/null || exit 1; command -v setsid >/dev/null || exit 1; printf '%s\\n' " + shellQuote(token) + " >" + shellQuote(workspaceArtifactCurrent+"/bootstrap.pending") + "; setsid /bin/sh -c " + shellQuote(bootstrap) + " >>/tmp/smithers-workspace-bootstrap.log 2>&1 </dev/null &"
	_, err = artifactCommand(ctx, client, id, command)
	return err
}

// Every foreground provisioning path must observe a completed bootstrap, not
// merely the detached launch. Resume calls finishWorkspaceArtifacts first to
// retry a failed or interrupted bootstrap before waiting here again.
func waitForWorkspaceArtifactBootstrap(ctx context.Context, client workspaceArtifactClient, id string) error {
	command := "if ! test -L " + shellQuote(workspaceArtifactCurrent) + "; then printf done; exit 0; fi; for attempt in $(seq 1 5); do " +
		"if test -f " + shellQuote(workspaceArtifactCurrent+"/bootstrap.done") + "; then printf done; exit 0; fi; " +
		"failed=$(cat " + shellQuote(workspaceArtifactCurrent+"/bootstrap.failed") + " 2>/dev/null || true); pending=$(cat " + shellQuote(workspaceArtifactCurrent+"/bootstrap.pending") + " 2>/dev/null || true); if test -n \"$failed\" && test \"${failed%%:*}\" = \"$pending\"; then printf 'failed:%s' \"${failed#*:}\"; exit 0; fi; sleep 1; done; printf pending"
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		result, err := artifactCommand(ctx, client, id, command, 10_000)
		if err != nil {
			return err
		}
		switch strings.TrimSpace(result.Stdout) {
		case "done":
			return nil
		case "pending":
		default:
			if status, ok := strings.CutPrefix(strings.TrimSpace(result.Stdout), "failed:"); ok {
				return fmt.Errorf("workspace bootstrap failed (exit %s)", status)
			}
			return fmt.Errorf("invalid workspace bootstrap status: %q", strings.TrimSpace(result.Stdout))
		}
	}
}

// streamWorkspaceArtifact compresses and encodes incrementally, with the
// synchronous WriteFile call providing backpressure. An absent optional helper
// keeps self-hosting's existing behavior; any attempted transfer failure fails
// provisioning rather than publishing a partially installed toolchain.
func streamWorkspaceArtifact(ctx context.Context, client workspaceArtifactClient, id, source, target string) error {
	return streamWorkspaceArtifactChecked(ctx, client, id, source, target, "")
}

func streamWorkspaceArtifactChecked(ctx context.Context, client workspaceArtifactClient, id, source, target, expectedDigest string) error {
	file, err := os.Open(source)
	if errors.Is(err, os.ErrNotExist) {
		if expectedDigest != "" && expectedDigest != "absent" {
			return errors.New("workspace artifact disappeared during transfer")
		}
		slog.Warn("workspace artifact unavailable", "path", source)
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()
	if expectedDigest == "absent" {
		return errors.New("workspace artifact appeared during transfer")
	}
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("workspace artifact is not a regular file")
	}
	if info.Size() == 0 {
		if expectedDigest != "" && expectedDigest != "empty" {
			return errors.New("workspace artifact emptied during transfer")
		}
		return nil
	}
	chunks := &workspaceArtifactWriter{ctx: ctx, client: client, id: id, target: target, buffer: make([]byte, 0, workspaceArtifactChunkBytes)}
	encoder := base64.NewEncoder(base64.StdEncoding, chunks)
	compressor := newWorkspaceGzipWriter(encoder)
	var content hash.Hash = sha256.New()
	_, copyErr := io.CopyBuffer(compressor, io.TeeReader(&workspaceArtifactReader{ctx: ctx, reader: file}, content), make([]byte, 32<<10))
	closeErr := compressor.Close()
	encodeErr := encoder.Close()
	if err := errors.Join(copyErr, closeErr, encodeErr); err != nil {
		return err
	}
	if expectedDigest != "" && hex.EncodeToString(content.Sum(nil)) != expectedDigest {
		return errors.New("workspace artifact changed during transfer")
	}
	return chunks.flush()
}

type workspaceArtifactReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *workspaceArtifactReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

type workspaceArtifactWriter struct {
	ctx        context.Context
	client     workspaceArtifactClient
	id, target string
	buffer     []byte
	index      int
}

func (w *workspaceArtifactWriter) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 {
		if err := w.ctx.Err(); err != nil {
			return written, err
		}
		n := min(len(p), workspaceArtifactChunkBytes-len(w.buffer))
		w.buffer = append(w.buffer, p[:n]...)
		p = p[n:]
		written += n
		if len(w.buffer) == workspaceArtifactChunkBytes {
			if err := w.flush(); err != nil {
				return written, err
			}
		}
	}
	return written, nil
}
func (w *workspaceArtifactWriter) flush() error {
	if len(w.buffer) == 0 {
		return nil
	}
	if err := w.ctx.Err(); err != nil {
		return err
	}
	if err := w.client.WriteFile(w.ctx, w.id, fmt.Sprintf("%s.part%08d", w.target, w.index), sandbox.WriteFileRequest{Content: string(w.buffer)}); err != nil {
		return err
	}
	w.index++
	w.buffer = w.buffer[:0]
	return nil
}
