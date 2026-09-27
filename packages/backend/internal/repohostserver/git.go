package repohostserver

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

var streamGitCommandContext = exec.CommandContext

// gitRPCIdleTimeout bounds how long a git smart-HTTP RPC waits on a stalled
// peer. Every request-body read and response write arms a fresh connection
// deadline, so long transfers that keep moving bytes are unaffected while a
// wedged or malicious client is cut off after one idle interval instead of
// holding the repository lock and a git subprocess until TCP gives up.
// Variable so tests can shorten it.
var gitRPCIdleTimeout = 60 * time.Second

// idleDeadlineBody wraps a git RPC request body so each read arms a fresh
// connection read deadline. Deadline errors are deliberately ignored: writers
// that do not support deadlines (e.g. httptest recorders) degrade to the
// previous unbounded behavior instead of failing the request.
type idleDeadlineBody struct {
	rc *http.ResponseController
	r  io.Reader
}

func (b *idleDeadlineBody) Read(p []byte) (int, error) {
	_ = b.rc.SetReadDeadline(time.Now().Add(gitRPCIdleTimeout))
	return b.r.Read(p)
}

// idleDeadlineWriter is the response-side counterpart of idleDeadlineBody:
// each write arms a fresh connection write deadline so a client that stops
// draining a streamed packfile cannot pin the handler forever.
type idleDeadlineWriter struct {
	rc *http.ResponseController
	w  io.Writer
}

func (d *idleDeadlineWriter) Write(p []byte) (int, error) {
	_ = d.rc.SetWriteDeadline(time.Now().Add(gitRPCIdleTimeout))
	return d.w.Write(p)
}

// receivePackEnv is the environment for every git receive-pack process,
// advertisement included. Environment configuration keeps the subprocess
// arguments free of protocol-specific overrides.
//
//   - receive.maxInputSize: git enforces it before publishing refs, including
//     identity-encoded streams that bypass the gzip decoder's cap.
//   - receive.hideRefs=refs/jj/: jj's refs/jj/keep/* retention pins are not
//     advertised, so a `git push --mirror` never tries to prune them, and git
//     itself refuses an update to them if one slips past the command peek.
func receivePackEnv(maxInputSize int64) []string {
	return append(os.Environ(), "GIT_CONFIG_COUNT=2",
		"GIT_CONFIG_KEY_0=receive.maxInputSize",
		fmt.Sprintf("GIT_CONFIG_VALUE_0=%d", maxInputSize),
		"GIT_CONFIG_KEY_1=receive.hideRefs",
		"GIT_CONFIG_VALUE_1="+repohost.JJRefPrefix)
}

// streamGitRPC runs a git smart-HTTP RPC and streams its stdout directly to dst
// using io.Copy with a 32 KB buffer so large packfiles are never accumulated in
// memory. The function returns once the git subprocess has exited.
func streamGitRPC(ctx context.Context, gitDir, command string, body io.Reader, dst io.Writer) error {
	return streamGitRPCCapped(ctx, gitDir, command, body, dst, maxDecompressedGitRequestSize)
}

// streamGitRPCCapped is streamGitRPC with receive-pack's pack size capped at
// maxInputSize.
func streamGitRPCCapped(ctx context.Context, gitDir, command string, body io.Reader, dst io.Writer, maxInputSize int64) error {
	args := []string{command, "--stateless-rpc", gitDir}
	cmd := streamGitCommandContext(ctx, "git", args...)
	if command == "receive-pack" {
		cmd.Env = receivePackEnv(maxInputSize)
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("open git stdin: %w", err)
	}

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	// Pipe git stdout directly to dst; io.Copy uses a 32 KB internal buffer.
	pr, pw := io.Pipe()
	cmd.Stdout = pw

	if err := cmd.Start(); err != nil {
		_ = pw.Close()
		_ = pr.Close()
		return fmt.Errorf("start git %s: %w", command, err)
	}

	// Copy stdin in a goroutine so we can drain stdout concurrently.
	copyErrCh := make(chan error, 1)
	go func() {
		var copyErr error
		if body != nil {
			_, copyErr = io.Copy(stdin, body)
		}
		closeErr := stdin.Close()
		if copyErr == nil {
			copyErr = closeErr
		}
		copyErrCh <- copyErr
	}()

	// Drain git stdout into dst. We close the write end of the pipe once git
	// exits so that the io.Copy below terminates naturally.
	dstErrCh := make(chan error, 1)
	go func() {
		_, err := io.Copy(dst, pr)
		if err != nil {
			// The destination failed mid-stream (e.g. the HTTP client
			// disconnected). Close the read side so exec's internal stdout
			// copier is not left blocked writing into the pipe — otherwise
			// cmd.Wait() below never returns and the repository lock is held
			// until process restart.
			_ = pr.CloseWithError(err)
		}
		dstErrCh <- err
	}()

	waitErr := cmd.Wait()
	// Signal EOF to the drain goroutine.
	_ = pw.CloseWithError(waitErr)

	dstErr := <-dstErrCh
	copyErr := <-copyErrCh

	if copyErr != nil {
		return fmt.Errorf("stream request body to git %s: %w", command, copyErr)
	}
	if waitErr != nil {
		return fmt.Errorf("git-%s failed: %s", command, strings.TrimSpace(stderr.String()))
	}
	if dstErr != nil {
		return fmt.Errorf("stream git %s output: %w", command, dstErr)
	}
	return nil
}

// runGitRPCBuffered runs a git smart-HTTP RPC and accumulates the entire stdout
// into memory. Use this only when the caller needs the full response before it
// can send a reply (e.g. receive-pack, where jj ref import must happen first).
// For streaming responses prefer streamGitRPC.
func runGitRPCBuffered(ctx context.Context, gitDir, command string, body io.Reader) ([]byte, error) {
	return runRPCBuffered(ctx, gitDir, command, body, maxDecompressedGitRequestSize)
}

// runReceivePackBuffered runs receive-pack buffered with its pack capped at
// maxInputSize.
func runReceivePackBuffered(ctx context.Context, gitDir string, body io.Reader, maxInputSize int64) ([]byte, error) {
	return runRPCBuffered(ctx, gitDir, "receive-pack", body, maxInputSize)
}

func runRPCBuffered(ctx context.Context, gitDir, command string, body io.Reader, maxInputSize int64) ([]byte, error) {
	var buf bytes.Buffer
	if err := streamGitRPCCapped(ctx, gitDir, command, body, &buf, maxInputSize); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// validGitObjectID reports whether s is a bare SHA-1 or SHA-256 object id.
//
// Every value listed here is handed straight back to git as a revision
// (`git log ^<oid>`) or as an update-ref target, so a ref whose stored value is
// not an object id must stop the push inspection rather than turn into argv. In
// run 11748 a jj panic (cli/src/cleanup_guard.rs, triggered by the runner
// image's git 2.39.5 being older than the 2.41 jj requires) left a ref holding
// the panic text, and it reached git as `git log '^thread ...panicked at...'`.
func validGitObjectID(s string) bool {
	if len(s) != 40 && len(s) != 64 {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// maxRefListingBytes caps the for-each-ref output listGitRefs buffers. Every
// receive-pack snapshots refs while holding the repository write lock, so a
// pathological ref set must fail closed instead of growing memory without
// bound. Matches maxRefAdvertisementBytes. Variable so tests can lower it.
var maxRefListingBytes int64 = 64 * 1024 * 1024

// errRefListingTooLarge reports a ref listing past maxRefListingBytes.
var errRefListingTooLarge = errors.New("git ref listing exceeds maximum size")

func listGitRefs(ctx context.Context, gitDir string) (map[string]string, error) {
	cmdCtx, cancelCmd := context.WithCancel(ctx)
	defer cancelCmd()
	cmd := exec.CommandContext(cmdCtx, "git", "--git-dir", gitDir, "for-each-ref", "--format=%(refname)%00%(objectname)")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("list git refs: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("list git refs: %w", err)
	}
	output, readErr := io.ReadAll(io.LimitReader(stdout, maxRefListingBytes+1))
	tooLarge := int64(len(output)) > maxRefListingBytes
	if tooLarge {
		// Kill git instead of draining an arbitrarily large listing.
		cancelCmd()
	}
	_, _ = io.Copy(io.Discard, stdout)
	waitErr := cmd.Wait()
	if tooLarge {
		return nil, fmt.Errorf("list git refs: %w", errRefListingTooLarge)
	}
	if readErr != nil {
		return nil, fmt.Errorf("list git refs: %w", readErr)
	}
	if waitErr != nil {
		return nil, fmt.Errorf("list git refs: %w", waitErr)
	}

	refs := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.SplitN(line, "\x00", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("parse git ref listing: malformed line %q", line)
		}
		refName := strings.TrimSpace(parts[0])
		objectID := strings.TrimSpace(parts[1])
		if refName == "" || !validGitObjectID(objectID) {
			return nil, fmt.Errorf("parse git ref listing: malformed line %q", line)
		}
		refs[refName] = objectID
	}
	return refs, nil
}

// gitDefaultBookmark returns the repository's default bookmark: the owner's
// persisted choice (setGitDefaultBookmark), else the bookmark HEAD names.
func gitDefaultBookmark(ctx context.Context, gitDir string) (string, error) {
	if raw, err := os.ReadFile(filepath.Join(gitDir, "smithers-default-bookmark")); err == nil {
		if name := strings.TrimSpace(string(raw)); name != "" {
			return name, nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("read default Git bookmark: %w", err)
	}
	output, err := exec.CommandContext(ctx, "git", "--git-dir", gitDir, "symbolic-ref", "--quiet", "HEAD").Output()
	if err != nil {
		return "", fmt.Errorf("read git HEAD: %w", err)
	}
	name, ok := strings.CutPrefix(strings.TrimSpace(string(output)), "refs/heads/")
	if !ok || name == "" {
		return "", fmt.Errorf("git HEAD names no bookmark")
	}
	return name, nil
}

// refuseAgentRunDefaultBookmark refuses a push the API attributed to an agent
// run when it writes the default bookmark. It fails closed: a default that
// cannot be read refuses the push.
func refuseAgentRunDefaultBookmark(ctx context.Context, gitDir string, commands []repohost.ReceivePackCommand) error {
	defaultBookmark, err := gitDefaultBookmark(ctx, gitDir)
	if err != nil {
		return forbidden("an agent run's push is refused: the default bookmark cannot be read")
	}
	for _, command := range commands {
		// Case-insensitive: on a case-insensitive filesystem a loose ref
		// differing only in case is the same file.
		if strings.EqualFold(strings.TrimSpace(command.RefName), "refs/heads/"+defaultBookmark) {
			return forbidden("an agent run cannot write the default bookmark; land its changes instead")
		}
	}
	return nil
}

// setGitDefaultBookmark updates the bare repository's HEAD symref. Git permits
// an unborn target, which is useful while configuring an empty repository; as
// soon as refs/heads/<bookmark> exists, upload-pack advertises both HEAD and
// symref=HEAD:refs/heads/<bookmark>.
func setGitDefaultBookmark(ctx context.Context, gitDir, bookmark string) error {
	// jj export may detach Git HEAD while synchronizing the working-copy
	// commit. Persist the owner's default before changing HEAD so a later
	// export, including one retried after a crash, can restore its symref.
	marker := filepath.Join(gitDir, "smithers-default-bookmark")
	pending := marker + ".pending"
	if err := os.WriteFile(pending, []byte(bookmark+"\n"), 0o644); err != nil {
		return fmt.Errorf("persist default Git bookmark: %w", err)
	}
	if err := os.Rename(pending, marker); err != nil {
		return fmt.Errorf("persist default Git bookmark: %w", err)
	}
	ref := "refs/heads/" + bookmark
	output, err := exec.CommandContext(ctx, "git", "--git-dir", gitDir, "symbolic-ref", "HEAD", ref).CombinedOutput()
	if err != nil {
		detail := strings.TrimSpace(string(output))
		if detail == "" {
			detail = err.Error()
		}
		return fmt.Errorf("set git HEAD to %s: %s", ref, detail)
	}
	return nil
}
