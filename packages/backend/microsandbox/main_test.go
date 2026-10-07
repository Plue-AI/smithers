package microsandbox

import (
	"os"
	"syscall"
	"testing"
)

// Match the installed guest bootstrap even on group-writable lane hosts.
func TestMain(m *testing.M) {
	previous := syscall.Umask(0o022)
	code := m.Run()
	syscall.Umask(previous)
	os.Exit(code)
}
