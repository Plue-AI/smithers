package errors

import (
	"context"
	"sync"
)

// A dependency's refusal can be the truest answer to a request whatever the
// code between them made of it: a repository host that holds a repository
// refuses its writes with a verdict of its own (503, retry after N seconds),
// and every call site that turned that into a generic failure would
// otherwise hide it. The dependency's client records the refusal on the
// request context; the product's error layer (middleware.DependencyRefusals)
// answers a server error with it.

type refusalKey struct{}

type refusalRecorder struct {
	mu      sync.Mutex
	refusal *APIError
}

// WithRefusalRecorder returns ctx able to record a dependency's refusal.
func WithRefusalRecorder(ctx context.Context) context.Context {
	return context.WithValue(ctx, refusalKey{}, &refusalRecorder{})
}

// RecordRefusal records refusal as a dependency's verdict on the request ctx
// belongs to; without a recorder it does nothing. The first one stands.
func RecordRefusal(ctx context.Context, refusal *APIError) {
	recorder, ok := ctx.Value(refusalKey{}).(*refusalRecorder)
	if !ok || refusal == nil {
		return
	}
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	if recorder.refusal == nil {
		recorder.refusal = refusal
	}
}

// RecordedRefusal is the refusal recorded on ctx, or nil.
func RecordedRefusal(ctx context.Context) *APIError {
	recorder, ok := ctx.Value(refusalKey{}).(*refusalRecorder)
	if !ok {
		return nil
	}
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return recorder.refusal
}
