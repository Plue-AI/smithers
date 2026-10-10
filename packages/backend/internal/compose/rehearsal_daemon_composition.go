package compose

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	"github.com/smithersai/smithers/packages/backend/process"
)

func validateRehearsalDaemon(options Options) error {
	if options.RehearsalDaemon == "" {
		return nil
	}
	if !options.TrustedProcessMachines {
		return errors.New("rehearsal daemon requires trusted-process test machines")
	}
	if err := validateTrustedProcessMachines(options); err != nil {
		return err
	}
	if _, ok := options.Workspace.(*process.Runtime); !ok {
		return errors.New("rehearsal daemon requires the concrete test process runtime")
	}
	if options.Machined != nil {
		return errors.New("rehearsal daemon owns its test registry")
	}
	if !filepath.IsAbs(options.RehearsalDaemon) {
		return errors.New("rehearsal daemon requires an absolute executable")
	}
	info, err := os.Stat(options.RehearsalDaemon)
	if err != nil {
		return err
	}
	if info.IsDir() || info.Mode()&0111 == 0 {
		return errors.New("rehearsal daemon is not executable")
	}
	return nil
}

// Own exactly the child processes started by this composition and retire them
// before its database closes. The production binary never selects this owner.
type ownedRehearsalLifecycle struct {
	ctx      context.Context
	mu       sync.Mutex
	cleanups []func()
}

func (*ownedRehearsalLifecycle) Helper()                    {}
func (l *ownedRehearsalLifecycle) Context() context.Context { return l.ctx }
func (*ownedRehearsalLifecycle) Logf(format string, args ...any) {
	slog.Info(fmt.Sprintf(format, args...))
}
func (l *ownedRehearsalLifecycle) Cleanup(fn func()) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.cleanups = append(l.cleanups, fn)
}
func (l *ownedRehearsalLifecycle) TempDir() string {
	path, err := os.MkdirTemp("", "rehearsal-")
	if err != nil {
		panic(fmt.Errorf("rehearsal scratch directory: %w", err))
	}
	l.Cleanup(func() { _ = os.RemoveAll(path) })
	return path
}
func (l *ownedRehearsalLifecycle) close() {
	l.mu.Lock()
	cleanups := l.cleanups
	l.cleanups = nil
	l.mu.Unlock()
	for i := len(cleanups) - 1; i >= 0; i-- {
		cleanups[i]()
	}
}
