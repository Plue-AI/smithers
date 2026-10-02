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
	"sort"
	"strconv"
	"strings"
	"syscall"
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
	// until, when set, is a deadline no read may pass however steady the
	// transfer (receivePackLimit).
	until time.Time
}

func (b *idleDeadlineBody) Read(p []byte) (int, error) {
	deadline := time.Now().Add(gitRPCIdleTimeout)
	if !b.until.IsZero() && b.until.Before(deadline) {
		deadline = b.until
	}
	_ = b.rc.SetReadDeadline(deadline)
	return b.r.Read(p)
}

// receivePackLimit bounds a push that holds the repository's write lock to
// the configured wall-clock limit: git is stopped and the body's reads fail
// once it passes, so a trickling client cannot keep the lock. It returns the
// push's context, its deadline and the error to answer when the limit ended it.
func (s *Server) receivePackLimit(ctx context.Context) (context.Context, time.Time, context.CancelFunc, func(error) error) {
	limit := s.config.receivePackMaxDuration()
	deadline := time.Now().Add(limit)
	pushCtx, cancel := context.WithDeadline(ctx, deadline)
	exceeded := func(err error) error {
		// The socket's read deadline can fire before the context's timer.
		// Check the wall deadline too, even if git exited successfully before
		// its stdin copier finished: an expired push must still roll back.
		if errors.Is(pushCtx.Err(), context.DeadlineExceeded) || !time.Now().Before(deadline) {
			return &appError{StatusCode: http.StatusRequestTimeout, Code: repohost.PushTooSlowCode,
				Message: "push took longer than " + limit.String() + "; nothing was changed", Cause: err}
		}
		return err
	}
	return pushCtx, deadline, cancel, exceeded
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

// refViewer is the user whose own refs/smithers/users/<id>/ refs a git
// request may see and write: the X-Smithers-Pusher-Id the API sets from the
// credential it authenticated, on fetches as on pushes. A workspace
// credential (X-Smithers-Workspace-Id) writes no user ref and sees none, and
// without the header no user ref is visible.
func refViewer(r *http.Request) int64 {
	if strings.TrimSpace(r.Header.Get("X-Smithers-Workspace-Id")) != "" {
		return 0
	}
	id, err := strconv.ParseInt(strings.TrimSpace(r.Header.Get("X-Smithers-Pusher-Id")), 10, 64)
	if err != nil || id <= 0 {
		return 0
	}
	return id
}

// hiddenRefs are the refs no git client sees or writes (#2253): jj's own
// refs/jj/keep/* pins, the case-collision repair's backups, and every user's
// refs/smithers/users/<id>/ but the viewer's own. A `git clone --mirror`
// never carries them, and a `git push --mirror` never tries to prune them;
// git itself refuses an update to a hidden ref if one slips past the command
// peek. The later negated entry wins over the earlier prefix.
func hiddenRefs(viewer int64) []string {
	refs := []string{repohost.JJRefPrefix, repohost.RefCaseCollisionPrefix, repohost.UserRefPrefix}
	if viewer > 0 {
		refs = append(refs, "!"+repohost.UserRefPrefix+strconv.FormatInt(viewer, 10)+"/")
	}
	return refs
}

// gitServiceEnv is the environment for every git receive-pack or upload-pack
// process, advertisement included. Environment configuration keeps the
// subprocess arguments free of protocol-specific overrides. receive-pack's
// receive.maxInputSize is enforced by git before publishing refs, including
// identity-encoded streams that bypass the gzip decoder's cap. Both services
// hide the same refs, so a mirror clone pushes back only refs it can see.
// advertise enables the reachable-SHA capability for upload-pack discovery only.
func gitServiceEnv(command string, maxInputSize, viewer int64, advertise bool) []string {
	return gitServiceEnvWithCache(command, maxInputSize, viewer, advertise, nil)
}

// gitServiceEnvWithCache is gitServiceEnv with an upload-pack RPC's
// pack-objects routed through the clone pack cache (pack_objects_cache.go).
func gitServiceEnvWithCache(command string, maxInputSize, viewer int64, advertise bool, cache *packObjectsCache) []string {
	section := "uploadpack"
	var config []string
	if command == "upload-pack" && !advertise {
		config = append(config, cache.hookConfig()...)
	}
	if command == "upload-pack" && advertise {
		// Let v0 clients request a pinned commit after its branch advances.
		// Only advertise this capability: stateless upload-pack already accepts
		// ancestors of visible refs. Enabling it on the RPC would also accept
		// ancestors of hidden refs (jj pins and other users' private refs).
		config = append(config, "uploadpack.allowReachableSHA1InWant", "true")
	}
	if command == "receive-pack" {
		section = "receive"
		// Keep every pack whole, so the stored bytes track the pack bytes a
		// storage quota caps (smithersai/plue#593); maintenance repacks.
		config = append(config, "receive.maxInputSize", strconv.FormatInt(maxInputSize, 10), "receive.unpackLimit", "1")
	}
	for _, ref := range hiddenRefs(viewer) {
		config = append(config, section+".hideRefs", ref)
	}
	// v2 accepts existing objects without the v0 visible-ref reachability
	// check. Do not let an inherited process environment opt out of it.
	env := append(packObjectsChildEnv(os.Environ()), "GIT_PROTOCOL=version=0", "GIT_CONFIG_COUNT="+strconv.Itoa(len(config)/2))
	if command == "upload-pack" && !advertise {
		env = append(env, cache.hookEnv()...)
	}
	for i := 0; i < len(config); i += 2 {
		env = append(env, fmt.Sprintf("GIT_CONFIG_KEY_%d=%s", i/2, config[i]), fmt.Sprintf("GIT_CONFIG_VALUE_%d=%s", i/2, config[i+1]))
	}
	return env
}

// streamGitRPC runs a git smart-HTTP RPC and streams its stdout directly to dst
// using io.Copy with a 32 KB buffer so large packfiles are never accumulated in
// memory. The function returns once the git subprocess has exited.
func streamGitRPC(ctx context.Context, gitDir, command string, body io.Reader, dst io.Writer) error {
	return streamGitRPCCapped(ctx, gitDir, command, body, dst, maxDecompressedGitRequestSize, 0)
}

// streamGitRPCCapped is streamGitRPC with receive-pack's pack size capped at
// maxInputSize, for viewer (refViewer).
func streamGitRPCCapped(ctx context.Context, gitDir, command string, body io.Reader, dst io.Writer, maxInputSize, viewer int64) error {
	return streamGitRPCCached(ctx, gitDir, command, body, dst, maxInputSize, viewer, nil)
}

// streamGitRPCCached is streamGitRPCCapped with upload-pack's pack-objects
// served through cache when it is non-nil.
func streamGitRPCCached(ctx context.Context, gitDir, command string, body io.Reader, dst io.Writer, maxInputSize, viewer int64, cache *packObjectsCache) error {
	args := []string{command, "--stateless-rpc", gitDir}
	cmd := streamGitCommandContext(ctx, "git", args...)
	cmd.Env = gitServiceEnvWithCache(command, maxInputSize, viewer, false, cache)
	// git builds a fetch's pack in a pack-objects child and indexes a push in
	// an index-pack child. Ending the request ends its whole process group:
	// killing only git left a clone's pack-objects running for minutes,
	// holding its memory (smithersai/smithers#3070).
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	// A child that keeps git's stdout or stderr open after git exits (a
	// push's index-pack inherits stderr) would hold Wait, and so the group
	// kill below, until it exits: give it one idle interval.
	cmd.WaitDelay = gitRPCIdleTimeout

	// exec copies the body into git's stdin and Wait owns that pipe, so a git
	// that exits before the body ends is not a failure (#2266). A push past
	// its cap fails in the body (errPushTooLarge), not in git.
	var stdin *bodyReader
	if body != nil {
		stdin = &bodyReader{r: body}
		cmd.Stdin = stdin
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
	// A child that outlives git, as pack-objects does when git dies on a
	// closed connection, goes with it.
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	// Signal EOF to the drain goroutine.
	_ = pw.CloseWithError(waitErr)

	dstErr := <-dstErrCh

	if stdin != nil && stdin.err != nil {
		return fmt.Errorf("stream request body to git %s: %w", command, stdin.err)
	}
	if waitErr != nil {
		return fmt.Errorf("git-%s failed: %s", command, strings.TrimSpace(stderr.String()))
	}
	if dstErr != nil {
		return fmt.Errorf("stream git %s output: %w", command, dstErr)
	}
	return nil
}

// bodyReader records how the request body failed. Wait drops a read error
// when git exits non-zero, and the body's failure is the cause worth
// reporting.
type bodyReader struct {
	r   io.Reader
	err error
}

func (b *bodyReader) Read(p []byte) (int, error) {
	n, err := b.r.Read(p)
	if err != nil && err != io.EOF {
		b.err = err
	}
	return n, err
}

// errPushTooLarge reports a git request body past its cap: a receive-pack
// pack past maxInputSize, or a gzip body past Config.MaxGitRequestBytes.
var errPushTooLarge = errors.New("git request body exceeds its size cap")

// maxBytesReader is http.MaxBytesReader for a git request body: it passes at
// most n bytes, then fails with errPushTooLarge instead of truncating, so an
// over-cap push is decided by the bytes counted here and never by how far git
// read before refusing it.
type maxBytesReader struct {
	r   io.Reader
	n   int64
	err error
}

func (m *maxBytesReader) Read(p []byte) (int, error) {
	if m.err != nil {
		return 0, m.err
	}
	if len(p) == 0 {
		return 0, nil
	}
	// Read one byte past the cap to tell a body that ends there from one
	// that goes on.
	if int64(len(p))-1 > m.n {
		p = p[:m.n+1]
	}
	n, err := m.r.Read(p)
	if int64(n) <= m.n {
		m.n -= int64(n)
		m.err = err
		return n, err
	}
	n = int(m.n)
	m.n = 0
	m.err = errPushTooLarge
	return n, m.err
}

// capPack caps a peeked receive-pack body so no more than maxInputSize bytes
// follow its commandBytes-long command section: git's receive.maxInputSize
// counts the pack, not the commands.
func capPack(peeked io.Reader, commandBytes, maxInputSize int64) io.Reader {
	return &maxBytesReader{r: peeked, n: commandBytes + maxInputSize}
}

// pushTooLarge is the answer to a push past its cap (errPushTooLarge).
func pushTooLarge(userRefs bool, maxInputSize int64) *appError {
	if userRefs {
		return &appError{StatusCode: http.StatusRequestEntityTooLarge, Code: "user_ref_push_too_large",
			Message: fmt.Sprintf("a push to refs/smithers/users/ is capped at %d MiB", maxInputSize>>20)}
	}
	return &appError{StatusCode: http.StatusRequestEntityTooLarge, Code: "push_too_large",
		Message: fmt.Sprintf("a push is capped at %d MiB", maxInputSize>>20)}
}

// runGitRPCBuffered runs a git smart-HTTP RPC and accumulates the entire stdout
// into memory. Use this only when the caller needs the full response before it
// can send a reply (e.g. receive-pack, where jj ref import must happen first).
// For streaming responses prefer streamGitRPC.
func runGitRPCBuffered(ctx context.Context, gitDir, command string, body io.Reader) ([]byte, error) {
	return runRPCBuffered(ctx, gitDir, command, body, maxDecompressedGitRequestSize, 0)
}

// runReceivePackBuffered runs receive-pack buffered with its pack capped at
// maxInputSize.
func runReceivePackBuffered(ctx context.Context, gitDir string, body io.Reader, maxInputSize, viewer int64) ([]byte, error) {
	return runRPCBuffered(ctx, gitDir, "receive-pack", body, maxInputSize, viewer)
}

func runRPCBuffered(ctx context.Context, gitDir, command string, body io.Reader, maxInputSize, viewer int64) ([]byte, error) {
	var buf bytes.Buffer
	if err := streamGitRPCCapped(ctx, gitDir, command, body, &buf, maxInputSize, viewer); err != nil {
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

func listGitRefs(ctx context.Context, gitDir string, patterns ...string) (map[string]string, error) {
	cmdCtx, cancelCmd := context.WithCancel(ctx)
	defer cancelCmd()
	args := append([]string{"--git-dir", gitDir, "for-each-ref", "--format=%(refname)%00%(objectname)"}, patterns...)
	cmd := exec.CommandContext(cmdCtx, "git", args...)
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

// countCommitsSince counts the commits reachable from rev whose committer
// date is at or after since. --since-as-filter, unlike --since, keeps walking
// past an old commit instead of cutting the traversal, so a history whose
// commit dates do not follow ancestry is still counted completely: the window
// boundary is exact at any history length (#3000).
func countCommitsSince(ctx context.Context, gitDir, rev string, since time.Time) (int64, error) {
	output, err := exec.CommandContext(ctx, "git", "--git-dir", gitDir,
		"rev-list", "--count", "--since-as-filter="+since.UTC().Format(time.RFC3339), rev).CombinedOutput()
	if err != nil {
		detail := strings.TrimSpace(string(output))
		// A well-formed rev the repository does not hold is the caller's
		// error; anything else (a missing git, a corrupt store) is ours.
		if strings.Contains(detail, "bad object") || strings.Contains(detail, "unknown revision") {
			return 0, badRequest("unknown revision " + rev)
		}
		return 0, internalError("failed to count commits", fmt.Errorf("git rev-list: %w: %s", err, detail))
	}
	count, err := strconv.ParseInt(strings.TrimSpace(string(output)), 10, 64)
	if err != nil {
		return 0, internalError("failed to count commits", fmt.Errorf("parse rev-list count: %w", err))
	}
	return count, nil
}

// refuseAgentRunDefaultBookmark refuses a push the API attributed to an agent
// run when it writes the default bookmark. Bookmark writes fail closed when
// the default cannot be read; other refs do not depend on that choice.
func refuseAgentRunDefaultBookmark(ctx context.Context, gitDir string, commands []repohost.ReceivePackCommand) error {
	writesBookmark := false
	for _, command := range commands {
		if strings.HasPrefix(command.RefName, "refs/heads/") {
			writesBookmark = true
			break
		}
	}
	if !writesBookmark {
		return nil
	}
	defaultBookmark, err := gitDefaultBookmark(ctx, gitDir)
	if err != nil {
		return forbidden("an agent run's push is refused: the default bookmark cannot be read")
	}
	for _, command := range commands {
		if repohost.SameRef(command.RefName, "refs/heads/"+defaultBookmark) {
			return forbidden("an agent run cannot write the default bookmark; land its changes instead")
		}
	}
	return nil
}

// refuseDefaultBookmarkRewind refuses a published push that deleted the
// default bookmark or moved it to a commit that does not descend from its old
// one: main is append-only. It runs after git applied the refs, when the new
// objects exist. Only a bookmark the push deleted or moved backwards needs
// the default, and a default that cannot be read then refuses the push. The
// GitHub sync credential is exempt: it copies GitHub's refs as they are.
//
// It fails closed on a missing default: once the default bookmark has
// existed (lockRepo records it), a push cannot create it again. With no
// old value any commit would pass as its new one. A default that has never
// existed, as in a new repository, is created by a push as usual.
func refuseDefaultBookmarkRewind(ctx context.Context, gitDir string, before, after map[string]string) error {
	if defaultBookmark, err := gitDefaultBookmark(ctx, gitDir); err == nil {
		ref := "refs/heads/" + defaultBookmark
		if _, existed := before[ref]; !existed && after[ref] != "" && defaultBookmarkBorn(gitDir, defaultBookmark) {
			return forbidden("the default bookmark is missing; a push cannot recreate it")
		}
	}
	for ref, old := range before {
		current := after[ref]
		if current == old || !strings.HasPrefix(ref, "refs/heads/") {
			continue
		}
		if current != "" {
			err := exec.CommandContext(ctx, "git", "--git-dir", gitDir, "merge-base", "--is-ancestor", old, current).Run()
			var exit *exec.ExitError
			if err == nil {
				continue
			}
			if !errors.As(err, &exit) || exit.ExitCode() != 1 {
				return internalError("failed to compare bookmark history", err)
			}
		}
		defaultBookmark, err := gitDefaultBookmark(ctx, gitDir)
		if err != nil {
			return forbidden("the push is refused: the default bookmark cannot be read")
		}
		if ref == "refs/heads/"+defaultBookmark {
			return forbidden("the default bookmark only moves forward; its history is never rewritten")
		}
	}
	return nil
}

// defaultBookmarkBornFile lists, one per line, every bookmark that has
// existed while it was the default.
const defaultBookmarkBornFile = "smithers-default-bookmark-born"

// markDefaultBookmarkBorn records that bookmark, the default, exists.
func markDefaultBookmarkBorn(gitDir, bookmark string) error {
	if defaultBookmarkBorn(gitDir, bookmark) {
		return nil
	}
	marker := filepath.Join(gitDir, defaultBookmarkBornFile)
	raw, err := os.ReadFile(marker)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if len(raw) > 0 && raw[len(raw)-1] != '\n' {
		raw = append(raw, '\n')
	}
	if err := os.WriteFile(marker+".pending", append(raw, bookmark+"\n"...), 0o644); err != nil {
		return err
	}
	return os.Rename(marker+".pending", marker)
}

// defaultBookmarkBorn reports whether bookmark has existed while it was the
// default. A marker that cannot be read counts as born: the check fails
// closed.
func defaultBookmarkBorn(gitDir, bookmark string) bool {
	raw, err := os.ReadFile(filepath.Join(gitDir, defaultBookmarkBornFile))
	if errors.Is(err, os.ErrNotExist) {
		return false
	}
	if err != nil {
		return true
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) == bookmark {
			return true
		}
	}
	return false
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

// refuseCaseVariantRefs refuses writing a ref that differs only in case from
// an existing ref or ref directory (or from another ref of the same write).
// On a case-insensitive filesystem that write would land in the other ref's
// file, past every guard that named the ref it asked for.
func refuseCaseVariantRefs(existing map[string]string, refs ...string) error {
	for _, ref := range refs {
		if strings.IndexFunc(ref, repohost.IsIgnorableRune) >= 0 {
			return badRequest(fmt.Sprintf("ref %q contains an invisible character", ref))
		}
	}
	names := make([]string, 0, len(existing))
	for name := range existing {
		names = append(names, name)
	}
	sort.Strings(names)
	if variant := repohost.CaseVariantRefs(refs, names); variant != "" {
		return conflict(fmt.Sprintf("refs that differ only in case are refused: %s and existing %s", strings.Join(refs, ", "), variant))
	}
	return nil
}

// writtenRefNames names the refs a push creates or moves. A deletion writes
// nothing, so a legacy variant or invisible-character ref stays deletable.
func writtenRefNames(commands []repohost.ReceivePackCommand) []string {
	refs := make([]string, 0, len(commands))
	for _, command := range commands {
		if strings.Trim(command.NewOID, "0") != "" {
			refs = append(refs, command.RefName)
		}
	}
	return refs
}

// refuseCaseVariantBookmark applies refuseCaseVariantRefs to a bookmark the
// bookmark API, a landing or the default-bookmark choice would name, against
// Git's branches and jj's bookmarks; the caller holds the repository lock.
func (s *Server) refuseCaseVariantBookmark(ctx context.Context, repoID, bookmark string) error {
	owner, repo, err := parseRepoID(repoID)
	if err != nil {
		return err
	}
	gitDir := s.config.GitBackendPath(owner, repo)
	if _, err := os.Stat(gitDir); errors.Is(err, os.ErrNotExist) {
		return nil // no repository: the write itself reports it
	}
	refs, err := listGitRefs(ctx, gitDir, "refs/heads/")
	if err != nil {
		return internalError("failed to list refs", err)
	}
	// jj bookmarks reach git only on export, which may fail or skip a
	// conflicted bookmark, so jj's own list counts too.
	repoPath := s.config.RepoPath(owner, repo)
	for page := uint32(1); ; page++ {
		listed, err := s.ffi.ListBookmarks(repoPath, page, 100)
		if err != nil {
			return internalError("failed to list bookmarks", err)
		}
		for _, existing := range listed.Items {
			refs["refs/heads/"+existing.Name] = existing.TargetCommitID
		}
		if len(listed.Items) == 0 || int(page)*100 >= listed.TotalCount {
			break
		}
	}
	return refuseCaseVariantRefs(refs, "refs/heads/"+bookmark)
}
