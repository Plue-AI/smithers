package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The real Playwright CLI must load the same pinned package as the specs;
// two copies produce a describe.configure error before any measurement runs.
func TestPlaywrightLauncherLoadsAllThreeWorkloads(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := playwrightCommand(ctx, "test", "--config", "scripts/spikes/col-01/playwright.config.ts", "--list")
	root, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	cmd.Dir = root
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("real Playwright list: %v\n%s", err, output)
	}
	// C-SPK-07 steps 1, 3, 4 require all three independent workloads.
	for _, expected := range []string{"10hz applies exact", "30hz applies exact", "concurrent-10hz applies exact", "Total: 3 tests in 1 file"} {
		if !strings.Contains(string(output), expected) {
			t.Fatalf("missing %q: %s", expected, output)
		}
	}
}
