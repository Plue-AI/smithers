package modelprice

import (
	"os/exec"
	"testing"
)

// TestPriceTablesAgree checks the generated view of every Go rate card and
// requires both consumers to import it rather than maintain local copies.
func TestPriceTablesAgree(t *testing.T) {
	cmd := exec.Command("go", "run", "./packages/backend/modelprice/cmd/generate", "-check")
	cmd.Dir = "../../.."
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("price tables drifted: %s: %v", out, err)
	}
}
