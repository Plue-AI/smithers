package testdb

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

const (
	// ToolsEnv names the directory of PostgreSQL programs (initdb, pg_ctl,
	// pg_dump, psql) for tests that run their own server or the packaged
	// backup scripts.
	ToolsEnv = "SMITHERS_POSTGRES_TEST_BIN"
	// ToolsMajorEnv overrides the major release the programs report.
	ToolsMajorEnv = "SMITHERS_POSTGRES_TEST_MAJOR"
)

var pgCtlVersion = regexp.MustCompile(`^pg_ctl \(PostgreSQL\) ([0-9]+)`)

// Tools returns the PostgreSQL program directory and its major release. With
// none named it skips the test, or fails it when database tests are required,
// so a CI job that expects the programs never passes by skipping.
func Tools(t testing.TB) (string, int) {
	t.Helper()
	bin := strings.TrimSpace(os.Getenv(ToolsEnv))
	if bin == "" {
		if Required() {
			t.Fatalf("PostgreSQL tests are required: %s names no PostgreSQL programs", ToolsEnv)
		}
		t.Skipf("PostgreSQL tests skipped: %s is not set", ToolsEnv)
	}
	if value := strings.TrimSpace(os.Getenv(ToolsMajorEnv)); value != "" {
		major, err := strconv.Atoi(value)
		if err != nil || major <= 0 {
			t.Fatalf("%s=%q is not a PostgreSQL major release", ToolsMajorEnv, value)
		}
		return bin, major
	}
	output, err := exec.Command(filepath.Join(bin, "pg_ctl"), "--version").Output()
	if err != nil {
		t.Fatalf("%s=%q holds no usable pg_ctl: %v", ToolsEnv, bin, err)
	}
	match := pgCtlVersion.FindStringSubmatch(strings.TrimSpace(string(output)))
	if match == nil {
		t.Fatalf("pg_ctl in %s reports no PostgreSQL release: %q", bin, strings.TrimSpace(string(output)))
	}
	major, _ := strconv.Atoi(match[1])
	return bin, major
}
