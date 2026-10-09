package workspace

import (
	"context"
	"errors"
	"strings"
	"sync"
)

// CleanupCapture is install-owned capture and retained-object verification.
type CleanupCapture func(context.Context, CleanupWorkspace, func(DiskReclaimCapture) error) error

var ErrCleanupBusy = errors.New("workspace capture excludes writers")

// ErrCaptureWritersActive retains the machine until its remaining sessions end.
var ErrCaptureWritersActive = errors.New("active writer blocks final capture")

// CleanupGate is shared by runtime mutation and lifecycle entry points. Its
// context permit allows only the fenced lifecycle to stop and remove a machine.
// Zero value refuses final capture until the install binds its authority.
type CleanupGate struct {
	mu      sync.Mutex
	locks   map[string]*sync.RWMutex
	capture CleanupCapture
}

type cleanupPermit struct {
	gate    *CleanupGate
	id      string
	mu      sync.Mutex
	active  bool
	writers sync.WaitGroup
}
type cleanupPermitKey struct{}

func (g *CleanupGate) permitted(ctx context.Context, id string) (func(), bool) {
	permit, ok := ctx.Value(cleanupPermitKey{}).(*cleanupPermit)
	if !ok || permit.gate != g || permit.id != id {
		return nil, false
	}
	permit.mu.Lock()
	defer permit.mu.Unlock()
	if !permit.active {
		return nil, false
	}
	permit.writers.Add(1)
	return permit.writers.Done, true
}

func (g *CleanupGate) lock(id string) *sync.RWMutex {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.locks == nil {
		g.locks = make(map[string]*sync.RWMutex)
	}
	if g.locks[id] == nil {
		g.locks[id] = new(sync.RWMutex)
	}
	return g.locks[id]
}

func (g *CleanupGate) BindCleanupCapture(capture CleanupCapture) {
	g.mu.Lock()
	g.capture = capture
	g.mu.Unlock()
}

// Enter holds admission across a complete mutation, including filesystem I/O.
func (g *CleanupGate) Enter(ctx context.Context, id string) (context.Context, func(), error) {
	id = strings.TrimSpace(id)
	if err := ctx.Err(); err != nil {
		return ctx, nil, err
	}
	if release, ok := g.permitted(ctx, id); ok {
		return ctx, release, nil
	}
	lock := g.lock(id)
	if !lock.TryRLock() {
		return ctx, nil, ErrCleanupBusy
	}
	return ctx, lock.RUnlock, nil
}

func (g *CleanupGate) Exclude(ctx context.Context, id string, visit func(context.Context) error) error {
	id = strings.TrimSpace(id)
	if err := ctx.Err(); err != nil {
		return err
	}
	if release, ok := g.permitted(ctx, id); ok {
		defer release()
		return visit(ctx)
	}
	lock := g.lock(id)
	if !lock.TryLock() {
		return ErrCleanupBusy
	}
	defer lock.Unlock()
	permit := &cleanupPermit{gate: g, id: id, active: true}
	defer func() { permit.mu.Lock(); permit.active = false; permit.mu.Unlock(); permit.writers.Wait() }()
	return visit(context.WithValue(ctx, cleanupPermitKey{}, permit))
}

func (g *CleanupGate) WithFinalCapture(ctx context.Context, row CleanupWorkspace, consume func(DiskReclaimCapture) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if row.ID == "" || consume == nil {
		return errors.New("cleanup binding unavailable")
	}
	g.mu.Lock()
	capture := g.capture
	g.mu.Unlock()
	if capture == nil {
		return errors.New("cleanup capture authority unavailable")
	}
	return g.Exclude(ctx, row.ID, func(ctx context.Context) error { return capture(ctx, row, consume) })
}
