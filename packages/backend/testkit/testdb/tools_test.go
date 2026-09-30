package testdb

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

// outcome records how Tools ended a test without ending this one.
type outcome struct {
	testing.TB
	skipped, failed string
}

func (o *outcome) Helper() {}
func (o *outcome) Skipf(format string, args ...any) {
	o.skipped = fmt.Sprintf(format, args...)
	runtime.Goexit()
}
func (o *outcome) Fatalf(format string, args ...any) {
	o.failed = fmt.Sprintf(format, args...)
	runtime.Goexit()
}

func runTools(t *testing.T) (bin string, major int, result *outcome) {
	result = &outcome{TB: t}
	done := make(chan struct{})
	go func() {
		defer close(done)
		bin, major = Tools(result)
	}()
	<-done
	return bin, major, result
}

func fakePgCtl(t *testing.T, output string) string {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "pg_ctl"), []byte("#!/bin/sh\necho '"+output+"'\n"), 0o755))
	return dir
}

func TestToolsSkipsOrFailsWithoutPrograms(t *testing.T) {
	t.Setenv(ToolsEnv, "  ")
	t.Setenv(RequireEnv, "")
	_, _, result := runTools(t)
	require.Contains(t, result.skipped, ToolsEnv+" is not set")
	require.Empty(t, result.failed)

	t.Setenv(RequireEnv, "1")
	_, _, result = runTools(t)
	require.Contains(t, result.failed, "PostgreSQL tests are required: "+ToolsEnv)
	require.Empty(t, result.skipped)
}

func TestToolsReadsTheMajorReleaseFromPgCtl(t *testing.T) {
	t.Setenv(ToolsMajorEnv, "")
	dir := fakePgCtl(t, "pg_ctl (PostgreSQL) 18.6 (Homebrew)")
	t.Setenv(ToolsEnv, dir)
	bin, major, result := runTools(t)
	require.Empty(t, result.failed)
	require.Equal(t, dir, bin)
	require.Equal(t, 18, major)

	t.Setenv(ToolsEnv, fakePgCtl(t, "not postgres"))
	_, _, result = runTools(t)
	require.Contains(t, result.failed, "reports no PostgreSQL release")

	t.Setenv(ToolsEnv, t.TempDir())
	_, _, result = runTools(t)
	require.Contains(t, result.failed, "holds no usable pg_ctl")
}

func TestToolsMajorOverride(t *testing.T) {
	dir := t.TempDir() // no pg_ctl: the override is trusted
	t.Setenv(ToolsEnv, dir)
	t.Setenv(ToolsMajorEnv, "17")
	bin, major, result := runTools(t)
	require.Empty(t, result.failed)
	require.Equal(t, dir, bin)
	require.Equal(t, 17, major)
	for _, value := range []string{"x", "0", "-3"} {
		t.Setenv(ToolsMajorEnv, value)
		_, _, result = runTools(t)
		require.Contains(t, result.failed, "is not a PostgreSQL major release", value)
	}
}
