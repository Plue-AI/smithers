//go:build unix

package compose

import (
	"os"
	"path/filepath"
	"testing"
)

// Native capture, authenticated daemon rewrite, verification admission and
// installed card supply accepted receipts. Other sources reach the same real
// stack worker but cannot bypass their phase to create a rebase completion.
func TestTodoRebasedGuardPairAccountingComposedInstall(t *testing.T) {
	if os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY") == "" {
		root, err := filepath.Abs("../../../..")
		if err != nil {
			t.Fatal(err)
		}
		t.Setenv("SMITHERS_REHEARSAL_MACHINED_BINARY", buildRehearsalMachined(t, root))
	}
	for _, c := range []struct{ source, engine string }{
		{"draft", "queued"}, {"queued", "queued"}, {"starting", "integrating"}, {"working", "integrating"}, {"needs_you", "integrating"},
		{"paused", "integrating"}, {"failed", "blocked"}, {"in_review", "integrating"}, {"merged", "landed"}, {"dropped", "cancelled"},
	} {
		t.Run(c.source, func(t *testing.T) {
			testBranchRebaseNative(t, false, "", rebaseNativeOptions{PairSource: c.source, PairEngine: c.engine})
		})
	}
}

func TestTodoConflictDoneGuardPairAccountingComposedInstall(t *testing.T) {
	if os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY") == "" {
		root, err := filepath.Abs("../../../..")
		if err != nil {
			t.Fatal(err)
		}
		t.Setenv("SMITHERS_REHEARSAL_MACHINED_BINARY", buildRehearsalMachined(t, root))
	}
	conflictDoneAwakeNativeComposedInstall(t, false, true)
}
