package distribution_test

import (
	"os"
	"strings"
	"testing"
)

func executable(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("#!/bin/sh\nset -eu\n"+body+"\n"), 0755); err != nil {
		t.Fatal(err)
	}
}
func TestContainerContract(t *testing.T) {
	b, err := os.ReadFile("Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	text := string(b)
	for _, required := range []string{"FROM postgres:18.6-bookworm", "sh scripts/build-backend.sh", "flows/coding/build.mjs", "rust:1.98.0-bookworm", "node:26.5.0-bookworm", "libsmithers_ffi.so", "USER smithers", "CMD []"} {
		if !strings.Contains(text, required) {
			t.Errorf("missing %q", required)
		}
	}
	// A base image is pinned by digest so a moved upstream tag cannot change the image.
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "FROM ") && !strings.Contains(line, "@sha256:") {
			t.Errorf("base image not pinned by digest: %q", line)
		}
	}
	for _, forbidden := range []string{"/var/run/docker.sock", "--privileged", "/dev/kvm", "dockerd", "postgres -D"} {
		if strings.Contains(text, forbidden) {
			t.Errorf("forbidden %q", forbidden)
		}
	}
}
