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
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"golang.org/x/sync/singleflight"

	"github.com/smithersai/smithers/packages/backend/internal/subscriptiontoken"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

const workspaceArtifactRoot = "/var/lib/smithers/workspace-artifacts"
const workspaceArtifactCurrent = workspaceArtifactRoot + "/current"
const workspaceArtifactOwnerPath = workspaceArtifactRoot + "/owner"
const workspaceArtifactManifest = "bundle.sha256"

// Images may carry raw release artifacts here. Their bytes must match the
// source digest; an image tag or package version never proves compatibility.
const workspaceArtifactBakedRoot = "/usr/local/lib/smithers/workspace-artifacts"

// workspaceArtifactGuestPath is the PATH every artifact command and the
// bootstrap it launches run with. A NixOS guest keeps its tools in its system
// profile; a container guest image (Plue's agent VM, the node L0 image) keeps
// bun, jj, node and npm in /usr/local/bin. Without that directory the
// bootstrap finds no jj and fails every container workspace. It comes last so
// it never shadows a system tool.
const workspaceArtifactGuestPath = "PATH=/run/current-system/sw/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin; export PATH; "
const workspaceArtifactLock = workspaceArtifactRoot + "/bootstrap.lock"
const workspaceArtifactBootstrapLog = workspaceArtifactCurrent + "/bootstrap.log"

// workspaceArtifactLockBusy is the exit status of a publication that could
// not take the bootstrap lock within workspaceArtifactPublishLockWait. The
// caller retries until its own deadline, because an earlier install may hold
// the lock for many minutes.
const workspaceArtifactLockBusy = 75

// Variables so guest tests can shorten the waits they exercise.
var (
	workspaceArtifactPublishLockWait = 30 * time.Second
	// A staged attempt untouched this long is an orphan. Every transferred
	// chunk creates a file in its directory, so a live transfer keeps it fresh.
	workspaceArtifactOrphanAge = 30 * time.Minute
)

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
	vm, err := client.CreateSandbox(ctx, workspaceSandboxBootRequest(req))
	if err != nil {
		return vm, err
	}
	return vm, finishCreatedWorkspaceSandbox(ctx, client, vm.ID, req)
}

// workspaceSandboxBootRequest leaves the boot barrier in place while deferring
// the toolchain service until artifact transfer and any inherited-login scrub.
func workspaceSandboxBootRequest(req sandbox.CreateRequest) sandbox.CreateRequest {
	if _, workspace := req.Files[workspaceClaudeScriptPath]; !workspace {
		return req
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
	return req
}

func finishCreatedWorkspaceSandbox(ctx context.Context, client workspaceCreator, id string, req sandbox.CreateRequest) error {
	if _, workspace := req.Files[workspaceClaudeScriptPath]; !workspace {
		return nil
	}
	// The create's idempotency key belongs only to creation; follow-up mutations
	// take their own keys so their different request digests cannot conflict.
	ctx = sandbox.WithIdempotencyKey(ctx, "")
	if err := finishWorkspaceArtifacts(ctx, client, id, req.Files[workspaceClaudeScriptPath].Content); err != nil {
		return err
	}
	if artifacts, ok := client.(workspaceArtifactClient); ok {
		return waitForWorkspaceArtifactBootstrap(ctx, artifacts, id)
	}
	return nil
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
		digest, err := workspaceArtifactDigest(ctx, sources[i].source, file, info)
		closeErr := file.Close()
		if err := errors.Join(err, closeErr); err != nil {
			return "", err
		}
		sources[i].digest = digest
		_, _ = io.WriteString(key, sources[i].digest+"\n")
	}
	return hex.EncodeToString(key.Sum(nil)), nil
}

// workspaceArtifactDigests remembers each source's content digest by file
// identity, so a fork or resume does not rehash an unchanged release archive.
// An entry is reused only for the same file (device and inode), size,
// modification time and inode change time; any rewrite misses, including one
// that restores the modification time. The streamed transfer still verifies
// every byte against the digest before a bundle can be published.
var (
	workspaceArtifactDigests       sync.Map // source path -> workspaceArtifactDigestEntry
	workspaceArtifactDigestFlights singleflight.Group
)

type workspaceArtifactDigestEntry struct {
	info    os.FileInfo
	changed int64
	digest  string
}

func workspaceArtifactDigest(ctx context.Context, source string, file *os.File, info os.FileInfo) (string, error) {
	changed, trusted := workspaceArtifactChangeTime(info)
	if cached, ok := workspaceArtifactDigests.Load(source); ok && trusted {
		entry := cached.(workspaceArtifactDigestEntry)
		if os.SameFile(entry.info, info) && entry.info.Size() == info.Size() && entry.info.ModTime().Equal(info.ModTime()) && entry.changed == changed {
			return entry.digest, nil
		}
	}
	hash := func() (any, error) {
		content := sha256.New()
		if _, err := io.CopyBuffer(content, &workspaceArtifactReader{ctx: ctx, reader: file}, make([]byte, 32<<10)); err != nil {
			return "", err
		}
		sum := hex.EncodeToString(content.Sum(nil))
		// A write during hashing changes the modification time; that digest
		// describes no single version of the file and is not remembered.
		if after, err := file.Stat(); err == nil && trusted && after.ModTime().Equal(info.ModTime()) && after.Size() == info.Size() {
			if afterChanged, ok := workspaceArtifactChangeTime(after); ok && afterChanged == changed {
				workspaceArtifactDigests.Store(source, workspaceArtifactDigestEntry{info: info, changed: changed, digest: sum})
			}
		}
		return sum, nil
	}
	// Concurrent starts of one unchanged archive share a single read.
	flight := fmt.Sprintf("%s\x00%d\x00%d\x00%d", source, info.Size(), info.ModTime().UnixNano(), changed)
	digest, err, shared := workspaceArtifactDigestFlights.Do(flight, hash)
	if err != nil && shared && ctx.Err() == nil && (errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)) {
		// The caller that led the shared read gave up; this one has not.
		digest, err = hash()
	}
	if err != nil {
		return "", err
	}
	return digest.(string), nil
}

// workspaceArtifactOrphanSweep removes staged attempts that nothing will
// publish: every directory (or leftover publication link) under an owner that
// is not the current bundle and has not been touched for
// workspaceArtifactOrphanAge. It runs under the bootstrap lock, where no
// publication can be swapping current, so an active transfer (fresh) and the
// published winner (current, even after a lost publish response) both stay.
func workspaceArtifactOrphanSweep() string {
	minutes := max(1, int(workspaceArtifactOrphanAge/time.Minute))
	return "cur=$(readlink " + shellQuote(workspaceArtifactCurrent) + " || true); for o in " + shellQuote(workspaceArtifactRoot) + "/*; do test -L \"$o\" && continue; test -d \"$o\" || continue; for d in \"$o\"/*; do test -e \"$d\" || test -L \"$d\" || continue; test \"$d\" = \"$cur\" && continue; test -n \"$(find \"$d\" -maxdepth 0 -mmin +" + fmt.Sprint(minutes) + " 2>/dev/null)\" || continue; rm -rf -- \"$d\"; done; rmdir -- \"$o\" 2>/dev/null || true; done; "
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
			// Preserve the winner, including an ambiguous publish whose response
			// was lost. A long install can hold the lock past this bounded wait;
			// the orphan sweep in every later bootstrap then reclaims the attempt.
			_, _ = artifactCommand(cleanup, client, id, "if test \"$(readlink "+shellQuote(workspaceArtifactCurrent)+")\" != "+shellQuote(directory)+"; then exec 9>"+shellQuote(workspaceArtifactLock)+"; flock -w 2 9 || exit 1; if test \"$(readlink "+shellQuote(workspaceArtifactCurrent)+")\" != "+shellQuote(directory)+"; then rm -rf -- "+shellQuote(directory)+" "+shellQuote(directory+".publish")+"; rmdir -- "+shellQuote(path.Dir(directory))+" 2>/dev/null || true; fi; fi")
		}()
		for _, artifact := range sources {
			started := time.Now()
			reused, err := stageBakedWorkspaceArtifact(ctx, client, id, directory, artifact)
			if err != nil {
				return fmt.Errorf("stage baked workspace %s: %w", artifact.label, err)
			}
			if reused {
				slog.Info("workspace artifact staged", "sandbox_id", id, "artifact", artifact.label, "baked", true, "duration_ms", time.Since(started).Milliseconds())
				continue
			}
			if err := streamWorkspaceArtifactChecked(ctx, client, id, artifact.source, directory+"/"+artifact.target, artifact.digest); err != nil {
				return fmt.Errorf("stage workspace %s: %w", artifact.label, err)
			}
			slog.Info("workspace artifact staged", "sandbox_id", id, "artifact", artifact.label, "baked", false, "duration_ms", time.Since(started).Milliseconds())
		}
		if err := client.WriteFile(ctx, id, directory+"/bootstrap.sh", sandbox.WriteFileRequest{Content: script}); err != nil {
			return fmt.Errorf("stage workspace bootstrap script: %w", err)
		}
		if err := client.WriteFile(ctx, id, directory+"/"+workspaceArtifactManifest, sandbox.WriteFileRequest{Content: key}); err != nil {
			return fmt.Errorf("stage workspace artifact manifest: %w", err)
		}
		// Publication and bootstrap share a lock. One complete attempt wins for
		// this workspace; inherited snapshot data can only be replaced while no
		// bootstrap is reading it. Atomic rename never exposes a partial bundle,
		// and only a directory still holding this attempt's manifest is linked,
		// so a cleanup that removed it can never be undone into an empty bundle.
		publish := "exec 9>" + shellQuote(workspaceArtifactLock) + "; flock -w " + fmt.Sprint(max(1, int(workspaceArtifactPublishLockWait/time.Second))) + " 9 || exit " + fmt.Sprint(workspaceArtifactLockBusy) + "; test \"$(cat " + shellQuote(directory+"/"+workspaceArtifactManifest) + " 2>/dev/null)\" = " + shellQuote(key) + " || exit 1; old=$(readlink " + shellQuote(workspaceArtifactCurrent) + " || true); if test \"$(cat " + shellQuote(workspaceArtifactCurrent+"/"+workspaceArtifactManifest) + " 2>/dev/null)\" != " + shellQuote(key) + "; then ln -sT -- " + shellQuote(directory) + " " + shellQuote(directory+".publish") + " && mv -Tf -- " + shellQuote(directory+".publish") + " " + shellQuote(workspaceArtifactCurrent) + " || exit 1; case \"$old\" in " + shellQuote(workspaceArtifactRoot) + "/*/*) if test \"$old\" != " + shellQuote(directory) + "; then rm -rf -- \"$old\"; rmdir -- \"${old%/*}\" 2>/dev/null || true; fi;; esac; fi"
		for {
			result, err := artifactCommand(ctx, client, id, publish)
			if err == nil {
				break
			}
			// An earlier install still holds the lock: keep waiting within the
			// caller's deadline rather than failing after one bounded wait.
			if result.StatusCode == nil || *result.StatusCode != workspaceArtifactLockBusy || ctx.Err() != nil {
				return err
			}
		}
	}
	// flock lives in the guest, so an old detached bootstrap and a recovered
	// provisioner serialize too. Completed bootstrap is never launched twice.
	token := uuid.NewString()
	// The attempt's own output replaces the previous attempt's log beside the
	// bundle, where a failed wait reads its tail.
	bootstrap := "exec 9>" + shellQuote(workspaceArtifactLock) + "; flock -w 120 9 || exit 1; " + workspaceArtifactOrphanSweep() + "test ! -f " + shellQuote(workspaceArtifactCurrent+"/bootstrap.done") + " || exit 0; rm -f -- " + shellQuote(workspaceArtifactCurrent+"/bootstrap.failed") + "; if /bin/bash " + shellQuote(workspaceArtifactCurrent+"/bootstrap.sh") + " 9>&- >" + shellQuote(workspaceArtifactBootstrapLog) + " 2>&1 && touch " + shellQuote(workspaceArtifactCurrent+"/bootstrap.done") + "; then exit 0; else status=$?; printf '%s:%s\\n' " + shellQuote(token) + " \"$status\" >" + shellQuote(workspaceArtifactCurrent+"/bootstrap.failed") + "; exit \"$status\"; fi"
	command := "mkdir -p -- " + shellQuote(workspaceArtifactRoot) + " || exit 1; command -v flock >/dev/null || exit 1; command -v setsid >/dev/null || exit 1; printf '%s\\n' " + shellQuote(token) + " >" + shellQuote(workspaceArtifactCurrent+"/bootstrap.pending") + "; setsid /bin/sh -c " + shellQuote(bootstrap) + " >>/tmp/smithers-workspace-bootstrap.log 2>&1 </dev/null &"
	_, err = artifactCommand(ctx, client, id, command)
	return err
}

// Use the same encoded staging and publication path for baked and transferred
// artifacts. Verify the encoded bytes as well as the input, so a changed input
// or an unsuccessful compression cannot publish a misleading bundle receipt.
func stageBakedWorkspaceArtifact(ctx context.Context, client workspaceArtifactClient, id, directory string, artifact workspaceArtifactSource) (bool, error) {
	if len(artifact.digest) != 64 {
		return false, nil
	}
	source := workspaceArtifactBakedRoot + "/" + artifact.target + ".source"
	target := directory + "/" + artifact.target + ".part00000000"
	command := "source=" + shellQuote(source) + "; target=" + shellQuote(target) + "; expected=" + shellQuote(artifact.digest) + "; " +
		"if test -f \"$source\" && test \"$(sha256sum \"$source\" | cut -d ' ' -f 1)\" = \"$expected\"; then " +
		"mkdir -p -- " + shellQuote(directory) + " || exit 1; gzip -1c \"$source\" | base64 > \"$target\"; " +
		"if test \"$(base64 -d < \"$target\" | gzip -dc | sha256sum | cut -d ' ' -f 1)\" != \"$expected\"; then rm -f -- \"$target\"; exit 1; fi; printf reused; " +
		"else printf fallback; fi"
	result, err := artifactCommand(ctx, client, id, command)
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(result.Stdout) == "reused", nil
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
				return workspaceBootstrapFailure(ctx, client, id, status)
			}
			return fmt.Errorf("invalid workspace bootstrap status: %q", strings.TrimSpace(result.Stdout))
		}
	}
}

// workspaceBootstrapFailure reports a failed toolchain bootstrap with the
// tail of that attempt's log, redacted, so the failure is actionable without
// a shell in the guest. A log that cannot be read leaves the exit code alone.
func workspaceBootstrapFailure(ctx context.Context, client workspaceArtifactClient, id, status string) error {
	failure := fmt.Sprintf("workspace bootstrap failed (exit %s)", status)
	result, err := artifactCommand(ctx, client, id, "tail -c 4096 "+shellQuote(workspaceArtifactBootstrapLog)+" 2>/dev/null || true", 10_000)
	if err != nil {
		return errors.New(failure)
	}
	if diagnostic := workspaceBootstrapDiagnostic(result.Stdout); diagnostic != "" {
		return errors.New(failure + ": " + diagnostic)
	}
	return errors.New(failure)
}

const (
	workspaceBootstrapDiagnosticLines = 6
	workspaceBootstrapDiagnosticBytes = 600
)

var workspaceBootstrapSecretPatterns = []struct {
	pattern     *regexp.Regexp
	replacement string
}{
	// URL credentials: scheme://user:secret@host.
	{regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@`), "${1}[redacted]@"},
	// Authorization headers and bare bearer credentials.
	{regexp.MustCompile(`(?i)\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}`), "${1} [redacted]"},
	// NAME=value / NAME: value for any secret-looking name.
	{regexp.MustCompile(`(?i)([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)`), "${1}[redacted]"},
	// Well-known credential prefixes and long opaque strings.
	{regexp.MustCompile(`\b(?:gh[pousr]_|github_pat_|glpat-|sk-|xox[abprs]-|AKIA)[A-Za-z0-9_-]{6,}`), "[redacted]"},
	{regexp.MustCompile(`[A-Za-z0-9_+/=-]{32,}`), "[redacted]"},
}

// workspaceBootstrapDiagnostic keeps the last few non-empty lines of a
// bootstrap log, printable only, with anything credential-shaped replaced.
// The toolchain bootstrap runs before any repository setup secret is written,
// and these rules are a second line against a tool echoing one anyway.
func workspaceBootstrapDiagnostic(log string) string {
	lines := strings.Split(strings.ToValidUTF8(log, ""), "\n")
	kept := make([]string, 0, workspaceBootstrapDiagnosticLines)
	for i := len(lines) - 1; i >= 0 && len(kept) < workspaceBootstrapDiagnosticLines; i-- {
		line := strings.Map(func(r rune) rune {
			if r == '\t' {
				return ' '
			}
			if r < 0x20 || r == 0x7f {
				return -1
			}
			return r
		}, lines[i])
		if line = strings.TrimSpace(line); line != "" {
			kept = append(kept, line)
		}
	}
	slices.Reverse(kept)
	text := strings.Join(kept, " | ")
	if subscriptiontoken.Holds("", text) {
		text = subscriptiontoken.Redact(text)
		if text == "" {
			return "[log withheld: it holds a credential]"
		}
	}
	for _, rule := range workspaceBootstrapSecretPatterns {
		text = rule.pattern.ReplaceAllString(text, rule.replacement)
	}
	if len(text) > workspaceBootstrapDiagnosticBytes {
		cut := len(text) - workspaceBootstrapDiagnosticBytes
		for cut < len(text) && !utf8.RuneStart(text[cut]) {
			cut++
		}
		text = "…" + text[cut:]
	}
	return text
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
