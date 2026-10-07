package workspace

import "context"

type wakeObserverKey struct{}

// WithWakeObserver attaches a trusted host observer, never a member payload.
// Only an attempted runtime boot reports; already-running requests do not.
func WithWakeObserver(ctx context.Context, observer func(kind string, failed bool)) context.Context {
	return context.WithValue(ctx, wakeObserverKey{}, observer)
}

func ObserveWake(ctx context.Context, kind string, failed bool) {
	if observer, ok := ctx.Value(wakeObserverKey{}).(func(string, bool)); ok && observer != nil {
		observer(kind, failed)
	}
}
