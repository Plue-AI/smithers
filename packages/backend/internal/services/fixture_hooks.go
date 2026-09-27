package services

import (
	"context"
	"sync"
)

// FixtureHelper is the minimal testing.TB capability needed by the external
// adapter test facade. It avoids linking the testing package into the API.
type FixtureHelper interface{ Helper() }

// ObserveWorkspaceFixtureCleanup preserves the actual asynchronous launcher and
// reports completion after the real cleanup returns. Await after the initiating
// request has returned, so all of that request's cleanup jobs are registered.
func ObserveWorkspaceFixtureCleanup(t FixtureHelper, service *WorkspaceService) func(context.Context) error {
	t.Helper()
	var active sync.WaitGroup
	launch := service.launchSessionCleanup
	if launch == nil {
		launch = SafeGo
	}
	service.launchSessionCleanup = func(name string, cleanup func()) {
		active.Add(1)
		launch(name, func() { defer active.Done(); cleanup() })
	}
	return func(ctx context.Context) error {
		complete := make(chan struct{})
		go func() { active.Wait(); close(complete) }()
		select {
		case <-complete:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
