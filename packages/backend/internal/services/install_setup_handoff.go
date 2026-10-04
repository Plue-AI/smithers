package services

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// StartInstallSetupHandoff exposes the owner authority's committed in-memory
// URLs on the private service socket. emit must hold installSetupOwnerLockID
// through its write, exactly as terminal emission does; it never mints here.
// A repeated read must replay the authority’s committed URLs without rotation.
// There is no transport cache or token file. The owner authority determines
// setup_closed, including claim-first reads, and clears its URLs during claim.
func StartInstallSetupHandoff(ctx context.Context, stateDir string, emit func(context.Context, io.Writer) error) (func() error, error) {
	if emit == nil {
		return nil, errors.New("setup URL authority unavailable")
	}
	if os.Getuid() == 0 {
		return nil, errors.New("setup handoff requires an unprivileged user")
	}
	run := filepath.Join(stateDir, "run")
	if err := privateSetupDirectory(stateDir); err != nil {
		return nil, err
	}
	if err := os.Mkdir(run, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	if err := privateSetupDirectory(run); err != nil {
		return nil, err
	}
	path := filepath.Join(run, "host.sock")
	if info, err := os.Lstat(path); err == nil {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != uint32(os.Getuid()) || info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0600 {
			return nil, errors.New("unsafe existing setup socket")
		}
		conn, dialErr := net.DialTimeout("unix", path, 250*time.Millisecond)
		if dialErr == nil {
			_ = conn.Close()
			return nil, errors.New("setup socket is already serving")
		}
		// Only ECONNREFUSED proves a dead listener; timeout or permissions do not.
		if !errors.Is(dialErr, syscall.ECONNREFUSED) {
			return nil, errors.New("setup socket state unavailable")
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0600); err != nil {
		_ = listener.Close()
		return nil, err
	}
	server := &http.Server{
		ReadHeaderTimeout: time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 2 * time.Second,
		// The generic HTTP panic logger must never log owner-authority token bytes.
		ErrorLog:    log.New(io.Discard, "", 0),
		BaseContext: func(net.Listener) context.Context { return ctx },
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Content-Type", "application/json")
			if r.URL.Path != "/setup-urls" {
				http.NotFound(w, r)
				return
			}
			if r.Method != http.MethodGet {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			output := &setupHandoffWriter{ResponseWriter: w}
			if err := emit(r.Context(), output); !output.wrote {
				var refusal *pkgerrors.APIError
				if errors.As(err, &refusal) && refusal.Code == pkgerrors.CodeSetupClosed {
					w.WriteHeader(http.StatusUnauthorized)
					_, _ = io.WriteString(w, "{\"error\":\"setup_closed\"}\n")
				} else {
					w.WriteHeader(http.StatusServiceUnavailable)
					_, _ = io.WriteString(w, "{\"error\":\"setup_mint_failed\"}\n")
				}
			}
		}),
	}
	done := make(chan struct{})
	var once sync.Once
	var closeErr error
	closeServer := func() error { once.Do(func() { closeErr = server.Close() }); return closeErr }
	go func() { defer close(done); _ = server.Serve(listener) }()
	go func() {
		select {
		case <-ctx.Done():
			_ = closeServer()
		case <-done:
		}
	}()
	return closeServer, nil
}

func privateSetupDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || stat.Uid != uint32(os.Getuid()) || info.Mode().Perm() != 0700 {
		return errors.New("setup handoff directory must be user-owned mode 0700")
	}
	return nil
}

type setupHandoffWriter struct {
	http.ResponseWriter
	wrote bool
}

func (w *setupHandoffWriter) Write(body []byte) (int, error) {
	if len(body) == 0 {
		return 0, nil
	}
	w.wrote = true
	n, err := w.ResponseWriter.Write(body)
	if err == nil {
		err = http.NewResponseController(w.ResponseWriter).Flush()
	}
	return n, err
}
