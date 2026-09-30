package services

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// gitHubMainPullRepoHost is the in-process repo-host surface the pull writes
// through. The public git endpoint is not used: it needs a user credential and
// applies landing-only bookmark protection, while this writer is the declared
// policy itself.
type gitHubMainPullRepoHost interface {
	InfoRefs(ctx context.Context, owner, repo, service string, stdout io.Writer) (string, error)
	ProxyUploadPack(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer) error
	ProxyReceivePack(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error
	ListBookmarks(ctx context.Context, owner, repo string, cursor string, limit int) ([]repohost.Bookmark, string, error)
}

// gitHubMainPullUpdate is the only ref update the bridge accepts.
type gitHubMainPullUpdate struct {
	repositoryID int64
	ref          string
	old          string
	new          string
}

// gitHubMainPullBridge serves one repository over smart HTTP on loopback for
// one git-sync run. Its credential is random per run and never leaves the
// process environment of that run.
type gitHubMainPullBridge struct {
	ctx      context.Context
	verify   func(context.Context) error
	host     gitHubMainPullRepoHost
	owner    string
	repo     string
	mu       sync.Mutex
	update   gitHubMainPullUpdate
	secret   string
	listener net.Listener
	server   *http.Server
}

const gitHubMainPullBridgePath = "/repository.git"

// Every request is bound to the run's context, so nothing it started can
// outlive the run. verify, when set, is the write's
// ReceivePackMetadata.VerifyLocked: repo-host runs it once it holds the
// repository lock, before any byte of the pack reaches storage.
func startGitHubMainPullBridge(ctx context.Context, host gitHubMainPullRepoHost, owner, repo string, update gitHubMainPullUpdate, verify func(context.Context) error) (*gitHubMainPullBridge, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return nil, fmt.Errorf("create bridge credential: %w", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen on loopback: %w", err)
	}
	bridge := &gitHubMainPullBridge{ctx: ctx, verify: verify, host: host, owner: owner, repo: repo, update: update,
		secret: hex.EncodeToString(raw[:]), listener: listener}
	bridge.server = &http.Server{Handler: bridge, ReadHeaderTimeout: 10 * time.Second,
		BaseContext: func(net.Listener) context.Context { return ctx }}
	go func() { _ = bridge.server.Serve(listener) }()
	return bridge, nil
}

// allow names the commit the one permitted update may write, once the
// fast-forward has been verified. Until then every receive-pack is refused.
func (b *gitHubMainPullBridge) allow(commit string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.update.new = commit
}

// URL carries the per-run credential as userinfo; mirrorCommand moves it into
// git-sync's environment before the process starts.
func (b *gitHubMainPullBridge) URL() string {
	return (&url.URL{Scheme: "http", Host: b.listener.Addr().String(), Path: gitHubMainPullBridgePath,
		User: url.UserPassword("x-access-token", b.secret)}).String()
}

// Close stops accepting, waits briefly for in-flight requests, then closes
// every connection.
func (b *gitHubMainPullBridge) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := b.server.Shutdown(ctx); err != nil {
		_ = b.server.Close()
	}
}

func (b *gitHubMainPullBridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	_, password, ok := r.BasicAuth()
	if !ok || subtle.ConstantTimeCompare([]byte(password), []byte(b.secret)) != 1 {
		w.Header().Set("WWW-Authenticate", `Basic realm="smithers"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	rest, found := strings.CutPrefix(r.URL.Path, gitHubMainPullBridgePath+"/")
	if !found {
		http.NotFound(w, r)
		return
	}
	ctx := r.Context()
	switch {
	case r.Method == http.MethodGet && rest == "info/refs":
		service := r.URL.Query().Get("service")
		if service != "git-upload-pack" && service != "git-receive-pack" {
			http.Error(w, "unsupported service", http.StatusForbidden)
			return
		}
		var body bytes.Buffer
		contentType, err := b.host.InfoRefs(ctx, b.owner, b.repo, service, &body)
		if err != nil {
			http.Error(w, "repository unavailable", http.StatusBadGateway)
			return
		}
		if contentType == "" {
			contentType = "application/x-" + service + "-advertisement"
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(body.Bytes())
	case r.Method == http.MethodPost && rest == "git-upload-pack":
		// Streamed: the depth-1 base snapshot is the one large transfer.
		// A failure after the first byte truncates the response, which git
		// reports as a failed fetch.
		w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
		w.Header().Set("Cache-Control", "no-cache")
		counted := &countingWriter{w: w}
		if err := b.host.ProxyUploadPack(ctx, b.owner, b.repo, r.Body, counted); err != nil {
			if counted.n == 0 {
				http.Error(w, "repository unavailable", http.StatusBadGateway)
				return
			}
			panic(http.ErrAbortHandler)
		}
	case r.Method == http.MethodPost && rest == "git-receive-pack":
		commands, rebuilt, err := repohost.PeekReceivePackCommands(r.Body)
		if err != nil {
			http.Error(w, "malformed receive-pack request", http.StatusBadRequest)
			return
		}
		// A pack larger than http.postBuffer makes git probe first with a
		// lone flush packet. It carries no command, so it writes nothing and
		// is answered here without reaching the repo host.
		if len(commands) == 0 {
			w.Header().Set("Content-Type", "application/x-git-receive-pack-result")
			w.Header().Set("Cache-Control", "no-cache")
			return
		}
		b.mu.Lock()
		update := b.update
		b.mu.Unlock()
		if err := update.permits(commands); err != nil {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		meta := repohost.ReceivePackMetadata{RepositoryID: update.repositoryID, RefName: update.ref, CommitSHA: update.new, PusherLogin: "github",
			PusherCredential: middleware.CredentialPlatform, VerifyLocked: b.verify}
		b.proxy(w, "application/x-git-receive-pack-result", func(out io.Writer) error {
			return b.host.ProxyReceivePack(ctx, b.owner, b.repo, rebuilt, out, meta)
		})
	default:
		http.NotFound(w, r)
	}
}

// proxy buffers the RPC result so a repo-host failure is an HTTP error, not a
// truncated 200 that git-sync could misread.
func (b *gitHubMainPullBridge) proxy(w http.ResponseWriter, contentType string, run func(io.Writer) error) {
	var body bytes.Buffer
	if err := run(&body); err != nil {
		if errors.Is(err, repohost.ErrRepositoryReplaced) {
			// Deleted, transferred or renamed away while the write waited
			// for the repository lock; nothing reached storage.
			http.Error(w, "repository changed during the pull", http.StatusConflict)
			return
		}
		http.Error(w, "repository unavailable", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(body.Bytes())
}

var errGitHubMainPullRefused = errors.New("only a fast-forward of the default bookmark to GitHub's tip is accepted")

// permits accepts exactly one command: ref from the observed Smithers tip to
// the observed GitHub tip. Deletes, other refs, and a stale old value refuse.
func (u gitHubMainPullUpdate) permits(commands []repohost.ReceivePackCommand) error {
	if len(commands) != 1 {
		return errGitHubMainPullRefused
	}
	command := commands[0]
	if u.new == "" || command.RefName != u.ref || command.NewOID != u.new || command.OldOID != u.old {
		return errGitHubMainPullRefused
	}
	return nil
}

type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}
