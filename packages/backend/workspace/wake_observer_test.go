package workspace

import (
	"context"
	"testing"
)

func TestWakeObserverContext(t *testing.T) {
	ObserveWake(context.Background(), "warm", false)
	ObserveWake(WithWakeObserver(context.Background(), nil), "warm", true)
	var kinds []string
	var failures []bool
	ctx := WithWakeObserver(context.Background(), func(kind string, failed bool) {
		kinds = append(kinds, kind)
		failures = append(failures, failed)
	})
	ObserveWake(WithOperation(ctx, Operation{OperationID: "read"}), "warm", false)
	ObserveWake(ctx, "cold", true)
	if len(kinds) != 2 || kinds[0] != "warm" || kinds[1] != "cold" || failures[0] || !failures[1] {
		t.Fatalf("observations did not survive operation context: %v %v", kinds, failures)
	}
}
