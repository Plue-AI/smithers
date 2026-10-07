package app

import (
	"os"
	"os/exec"
	"testing"
)

// Smithers Cloud builds the product with CGO_ENABLED=0 for linux/amd64. Code
// that only a cgo build defines breaks that build while every cgo build stays
// green (#3753), so compile the product the way it builds.
func TestProductBuildsWithoutCgo(t *testing.T) {
	if testing.Short() {
		t.Skip("compiles every product dependency without cgo")
	}
	cmd := exec.Command("go", "build", ".")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS=linux", "GOARCH=amd64", "GOWORK=off")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build without cgo failed: %v\n%s", err, output)
	}
}
