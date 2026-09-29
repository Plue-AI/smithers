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
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// mythicalRefUpdate is one exact ref command a stack write may push.
type mythicalRefUpdate struct {
	Ref string `json:"ref"`
	Old string `json:"old"`
	New string `json:"new"`
}

// mythicalBridge serves one repository over smart HTTP on loopback for one
// stack run, like the main pull's bridge. Fetches are free; a receive-pack is
// accepted only when its commands are exactly the prepared set, once, and it
// is forwarded with the metadata the prepared write names (the control-plane
// flag for the stack's refs, a workspace for a lane's source ref).
type mythicalBridge struct {
	host     gitHubMainPullRepoHost
	owner    string
	repo     string
	mu       sync.Mutex
	allowed  []mythicalRefUpdate
	meta     repohost.ReceivePackMetadata
	secret   string
	listener net.Listener
	server   *http.Server
	// heldFor is repo-host's Retry-After when it refused a write because it
	// holds the repository (repohost.HeldRetryAfter).
	heldFor time.Duration
}

// refused notes err's hold, if it is one, and answers the git client.
func (b *mythicalBridge) refused(w http.ResponseWriter, err error) {
	if delay, held := repohost.HeldRetryAfter(err); held {
		b.mu.Lock()
		b.heldFor = delay
		b.mu.Unlock()
		http.Error(w, "repository is busy", http.StatusServiceUnavailable)
		return
	}
	http.Error(w, "repository unavailable", http.StatusBadGateway)
}

// held reports the hold a write through the bridge met, if any.
func (b *mythicalBridge) held() (time.Duration, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.heldFor, b.heldFor > 0
}

const mythicalBridgePath = "/repository.git"

var errMythicalBridgeRefused = errors.New("only the prepared mythical stack update is accepted")

func startMythicalBridge(ctx context.Context, host gitHubMainPullRepoHost, owner, repo string) (*mythicalBridge, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return nil, fmt.Errorf("create bridge credential: %w", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen on loopback: %w", err)
	}
	bridge := &mythicalBridge{host: host, owner: owner, repo: repo, secret: hex.EncodeToString(raw[:]), listener: listener}
	bridge.server = &http.Server{Handler: bridge, ReadHeaderTimeout: 10 * time.Second,
		BaseContext: func(net.Listener) context.Context { return ctx }}
	go func() { _ = bridge.server.Serve(listener) }()
	return bridge, nil
}

// permit arms exactly one receive-pack carrying exactly updates.
func (b *mythicalBridge) permit(updates []mythicalRefUpdate, meta repohost.ReceivePackMetadata) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.allowed = append([]mythicalRefUpdate(nil), updates...)
	b.meta = meta
}

func (b *mythicalBridge) URL() string {
	return (&url.URL{Scheme: "http", Host: b.listener.Addr().String(), Path: mythicalBridgePath,
		User: url.UserPassword("x-access-token", b.secret)}).String()
}

func (b *mythicalBridge) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := b.server.Shutdown(ctx); err != nil {
		_ = b.server.Close()
	}
}

// take returns and disarms the prepared set when commands are exactly it.
func (b *mythicalBridge) take(commands []repohost.ReceivePackCommand) (repohost.ReceivePackMetadata, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.allowed) == 0 || len(commands) != len(b.allowed) {
		return repohost.ReceivePackMetadata{}, errMythicalBridgeRefused
	}
	got := make([]mythicalRefUpdate, len(commands))
	for i, command := range commands {
		got[i] = mythicalRefUpdate{Ref: command.RefName, Old: command.OldOID, New: command.NewOID}
	}
	want := append([]mythicalRefUpdate(nil), b.allowed...)
	byRef := func(values []mythicalRefUpdate) {
		sort.Slice(values, func(i, j int) bool { return values[i].Ref < values[j].Ref })
	}
	byRef(got)
	byRef(want)
	for i := range want {
		if got[i] != want[i] {
			return repohost.ReceivePackMetadata{}, errMythicalBridgeRefused
		}
	}
	meta := b.meta
	b.allowed = nil
	return meta, nil
}

func (b *mythicalBridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	_, password, ok := r.BasicAuth()
	if !ok || subtle.ConstantTimeCompare([]byte(password), []byte(b.secret)) != 1 {
		w.Header().Set("WWW-Authenticate", `Basic realm="smithers"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	rest, found := strings.CutPrefix(r.URL.Path, mythicalBridgePath+"/")
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
			b.refused(w, err)
			return
		}
		if contentType == "" {
			contentType = "application/x-" + service + "-advertisement"
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(body.Bytes())
	case r.Method == http.MethodPost && rest == "git-upload-pack":
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
		// git's probe before a pack larger than http.postBuffer: a lone flush
		// packet with no command. It writes nothing and consumes no allowance.
		if len(commands) == 0 {
			w.Header().Set("Content-Type", "application/x-git-receive-pack-result")
			w.Header().Set("Cache-Control", "no-cache")
			return
		}
		meta, err := b.take(commands)
		if err != nil {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		var body bytes.Buffer
		if err := b.host.ProxyReceivePack(ctx, b.owner, b.repo, rebuilt, &body, meta); err != nil {
			b.refused(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/x-git-receive-pack-result")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = io.Copy(w, &body)
	default:
		http.NotFound(w, r)
	}
}
