package services

import (
	"log/slog"
	"runtime/debug"
)

// SafeGo runs fn on a new goroutine and converts a panic into a logged error
// instead of a process-wide crash. An unrecovered panic in any goroutine
// terminates the whole multi-tenant server — chi's Recoverer middleware only
// guards the request goroutine that invoked it, not detached background
// goroutines spawned to keep a request handler non-blocking (push-hook
// workflow sync, agent-run dispatch, etc.).
func SafeGo(name string, fn func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("background goroutine panic", "goroutine", name,
					"panic", r, "stack", string(debug.Stack()))
			}
		}()
		fn()
	}()
}
