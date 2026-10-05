package native

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// startingPage answers the install's address while the owned PostgreSQL
// starts and migrates, before the app listens there. GET /readyz is 503
// with the phase and the migration count, so the launcher's readiness
// deadline follows progress (NativeBackendProcess.ts) instead of failing a
// first boot on a loaded Mac; any other request is a 503 page that reloads
// itself until the app answers.
type startingPage struct {
	mu     sync.Mutex
	status startingStatus
	server *http.Server
	done   chan struct{}
}

// startingStatus is GET /readyz's body while the install starts.
type startingStatus struct {
	Status  string `json:"status"`
	Phase   string `json:"phase"`
	Applied int    `json:"applied"`
	Total   int    `json:"total"`
}

// serveStartingPage listens on addr until close. An empty addr, or one that
// cannot listen, serves nothing: the app's own listener reports that.
func serveStartingPage(addr string) *startingPage {
	page := &startingPage{status: startingStatus{Status: "starting", Phase: "database"}}
	if strings.TrimSpace(addr) == "" {
		return page
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		slog.Warn("starting page: not serving", "addr", addr, "error", err)
		return page
	}
	page.server = &http.Server{Handler: page, ReadHeaderTimeout: 5 * time.Second}
	page.done = make(chan struct{})
	go func() {
		defer close(page.done)
		_ = page.server.Serve(listener)
	}()
	return page
}

// migrating records Apply's progress (product.WithMigrationProgress).
func (p *startingPage) migrating(done, total int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.status = startingStatus{Status: "starting", Phase: "migrating", Applied: done, Total: total}
}

// close stops serving so the app can listen on the address.
func (p *startingPage) close() {
	if p.server == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := p.server.Shutdown(ctx); err != nil {
		_ = p.server.Close()
	}
	<-p.done
	p.server = nil
}

func (p *startingPage) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	status := p.status
	p.mu.Unlock()
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Retry-After", "2")
	if r.URL.Path == "/readyz" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(status)
		return
	}
	line := "Starting the database"
	if status.Phase == "migrating" {
		line = fmt.Sprintf("Updating the database · %d of %d", status.Applied, status.Total)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="2"><title>Smithers</title><p>%s</p>`+"\n", line)
}
