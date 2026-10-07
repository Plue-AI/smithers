package machined

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Filesystem-only proof at the invoking uid. The reference-host check must
// separately prove broker uid drop and root-owned /run ancestry.
func TestOwnerCredentialFilesCASAndSymlinks(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(root, "smithers"), 0700))
	uid := strconv.Itoa(os.Getuid())
	member := filepath.Join(root, "smithers", uid)
	require.NoError(t, os.Mkdir(member, 0700))
	program := strings.Replace(ownerTokenProgram, "assert 20000 <= uid <= 2147483647 and os.getuid() == os.geteuid() == uid", "assert os.getuid() == os.geteuid() == uid", 1)
	program = strings.Replace(program, "os.open('/run', flags)", fmt.Sprintf("os.open(%q, flags)", root), 1)
	program = strings.Replace(program, "('smithers', 0)", "('smithers', uid)", 1)
	run := func(op, id, token, expected string) error {
		cmd := exec.Command("python3", "-I", "-S", "-c", program, op, uid, id, expected)
		cmd.Stdin = strings.NewReader(token)
		_, err := cmd.CombinedOutput()
		return err
	}
	require.NoError(t, run("put", "session-a", "smithers_a", "absent"))
	require.NoError(t, run("put", "session-b", "smithers_b", "absent"))
	a := filepath.Join(member, "token/sessions/session-a/token")
	b := filepath.Join(member, "token/sessions/session-b/token")
	info, err := os.Stat(a)
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0600), info.Mode().Perm())
	require.Error(t, run("put", "session-a", "replacement", "absent"))
	require.Error(t, run("delete", "session-a", "", workspaceapi.SessionCredentialIdentity([]byte("smithers_b"))))
	require.NoError(t, run("delete", "session-a", "", workspaceapi.SessionCredentialIdentity([]byte("smithers_a"))))
	body, err := os.ReadFile(b)
	require.NoError(t, err)
	require.Equal(t, "smithers_b\n", string(body))
	require.NoFileExists(t, a)
	require.NoError(t, os.Symlink(b, a))
	require.Error(t, run("put", "session-a", "replacement", "absent"))
	require.Error(t, run("delete", "session-a", "", workspaceapi.SessionCredentialIdentity([]byte("smithers_b"))))
	require.NoError(t, os.Remove(a))
	require.NoError(t, run("put", "session-a", "smithers_new", "absent"))
	require.Error(t, run("put", "../session-b", "foreign", "absent"))
	require.NoError(t, os.Rename(filepath.Join(member, "token/sessions/session-a"), filepath.Join(member, "token/sessions/retained")))
	require.NoError(t, os.Symlink("session-b", filepath.Join(member, "token/sessions/session-a")))
	require.Error(t, run("put", "session-a", "replacement", "absent"))
	body, err = os.ReadFile(b)
	require.NoError(t, err)
	require.Equal(t, "smithers_b\n", string(body))
}
