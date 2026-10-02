package microsandbox

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// These tests run the real Python installer against real filesystem entries.
// Only its fixed /etc directory and root UID are replaced for an unprivileged
// developer's temporary tree; the production CLI accepts neither override.
func runCodingBindingGuest(t *testing.T, directory string, config map[string]any, after string) (string, error) {
	t.Helper()
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	body, err := json.Marshal(config)
	require.NoError(t, err)
	script := `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location("guest",sys.argv[1]); guest=importlib.util.module_from_spec(spec); spec.loader.exec_module(guest)
guest.ROOT_UID=os.geteuid()
guest.install_coding_binding(json.loads(sys.argv[3]),sys.argv[2])
` + after
	command := exec.Command(python, "-B", "-c", script, filepath.Join("guest", "smithers-guest.py"), directory, string(body))
	output, err := command.CombinedOutput()
	return string(output), err
}

func guestCodingConfig() map[string]any {
	return map[string]any{"version": 1, "workspaceId": "coding-lane", "actorId": 9, "repositoryId": 77, "repositorySlug": "acme/widgets", "apiBaseUrl": "http://127.0.0.1:4000/api", "gitUrl": "http://127.0.0.1:4000/acme/widgets.git", "repositoryPath": guestRoot, "username": guestUser, "credentialSocket": guestHome + "/.cache/smithers/git-credential/socket"}
}

func TestGuestCodingBindingWritesAndRepairsOneAtomicFile(t *testing.T) {
	directory := t.TempDir()
	config := guestCodingConfig()
	output, err := runCodingBindingGuest(t, directory, config, "")
	require.NoError(t, err, output)
	file := filepath.Join(directory, "smithers", "workspace-coding.json")
	body, err := os.ReadFile(file)
	require.NoError(t, err)
	var actual map[string]any
	require.NoError(t, json.Unmarshal(body, &actual))
	require.Equal(t, "coding-lane", actual["workspaceId"])
	info, err := os.Stat(file)
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0644), info.Mode().Perm())
	config["actorId"] = 10
	output, err = runCodingBindingGuest(t, directory, config, "")
	require.NoError(t, err, output)
	body, err = os.ReadFile(file)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(body, &actual))
	require.Equal(t, float64(10), actual["actorId"])
	entries, err := os.ReadDir(filepath.Dir(file))
	require.NoError(t, err)
	require.Len(t, entries, 1, "atomic temp files are cleaned")
}

func TestGuestCodingBindingRefusesPathAndAuthorityAttacks(t *testing.T) {
	for _, name := range []string{"parent symlink", "target symlink", "writable parent", "invalid fields", "runtime root", "runtime user", "runtime socket", "zero actor", "boolean repository", "invalid workspace"} {
		t.Run(name, func(t *testing.T) {
			directory := t.TempDir()
			outside := t.TempDir()
			sentinel := filepath.Join(outside, "sentinel")
			require.NoError(t, os.WriteFile(sentinel, []byte("unchanged"), 0600))
			config := guestCodingConfig()
			switch name {
			case "parent symlink":
				require.NoError(t, os.Symlink(outside, filepath.Join(directory, "smithers")))
			case "target symlink":
				require.NoError(t, os.Mkdir(filepath.Join(directory, "smithers"), 0755))
				require.NoError(t, os.Symlink(sentinel, filepath.Join(directory, "smithers", "workspace-coding.json")))
			case "writable parent":
				require.NoError(t, os.Mkdir(filepath.Join(directory, "smithers"), 0755))
				require.NoError(t, os.Chmod(filepath.Join(directory, "smithers"), 0777))
			case "invalid fields":
				config["destination"] = sentinel
			case "runtime root":
				config["repositoryPath"] = outside
			case "runtime user":
				config["username"] = "root"
			case "runtime socket":
				config["credentialSocket"] = sentinel
			case "zero actor":
				config["actorId"] = 0
			case "boolean repository":
				config["repositoryId"] = true
			case "invalid workspace":
				config["workspaceId"] = "../other"
			}
			output, err := runCodingBindingGuest(t, directory, config, "")
			require.Error(t, err, output)
			body, err := os.ReadFile(sentinel)
			require.NoError(t, err)
			require.Equal(t, "unchanged", string(body))
			if name != "parent symlink" {
				files, _ := filepath.Glob(filepath.Join(directory, "smithers", ".workspace-coding-*"))
				require.Empty(t, files)
			}
		})
	}
}

func TestGuestCodingBindingCLIRequiresPrivilegeBeforeWriting(t *testing.T) {
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	command := exec.Command(python, "-B", "-c", `import importlib.util,os,sys
spec=importlib.util.spec_from_file_location("guest",sys.argv[1]); guest=importlib.util.module_from_spec(spec); spec.loader.exec_module(guest)
guest.os.geteuid=lambda:1500
guest.main(["coding-binding"])
`, filepath.Join("guest", "smithers-guest.py"))
	body, err := json.Marshal(guestCodingConfig())
	require.NoError(t, err)
	command.Stdin = strings.NewReader(string(body))
	output, err := command.CombinedOutput()
	require.Error(t, err)
	require.Contains(t, string(output), "requires root")
}

func TestGuestCodingHelperInstallsOnlyFixedExecutable(t *testing.T) {
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	for _, name := range []string{"install", "repair", "invalid ELF", "target symlink", "writable directory", "non-root"} {
		t.Run(name, func(t *testing.T) {
			directory := t.TempDir()
			body := make([]byte, 64)
			copy(body, []byte("\x7fELF"))
			body[4], body[5], body[18] = 2, 1, 183
			outside := filepath.Join(t.TempDir(), "sentinel")
			require.NoError(t, os.WriteFile(outside, []byte("untouched"), 0600))
			file := filepath.Join(directory, "smithers-jj-export")
			switch name {
			case "repair":
				require.NoError(t, os.WriteFile(file, []byte("old"), 0755))
			case "invalid ELF":
				body[18] = 62
			case "target symlink":
				require.NoError(t, os.Symlink(outside, file))
			case "writable directory":
				require.NoError(t, os.Chmod(directory, 0777))
			}
			script := `import base64,importlib.util,os,sys
spec=importlib.util.spec_from_file_location("guest",sys.argv[1]); guest=importlib.util.module_from_spec(spec); spec.loader.exec_module(guest)
guest.ROOT_UID=os.geteuid()
if sys.argv[4]=="non-root": guest.os.geteuid=lambda:guest.ROOT_UID+1
guest.install_coding_helper(base64.b64decode(sys.argv[3]),sys.argv[2])
`
			command := exec.Command(python, "-B", "-c", script, filepath.Join("guest", "smithers-guest.py"), directory, base64.StdEncoding.EncodeToString(body), name)
			output, err := command.CombinedOutput()
			if name == "install" || name == "repair" {
				require.NoError(t, err, string(output))
				installed, err := os.ReadFile(file)
				require.NoError(t, err)
				require.Equal(t, body, installed)
				info, err := os.Stat(file)
				require.NoError(t, err)
				require.Equal(t, os.FileMode(0755), info.Mode().Perm())
			} else {
				require.Error(t, err, string(output))
			}
			contents, err := os.ReadFile(outside)
			require.NoError(t, err)
			require.Equal(t, "untouched", string(contents))
			temporary, _ := filepath.Glob(filepath.Join(directory, ".smithers-jj-export-*"))
			require.Empty(t, temporary)
		})
	}
}

func TestGuestCodingHelperChecksDigestAndPrivileges(t *testing.T) {
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	for _, name := range []string{"current", "missing", "changed", "writable file", "non-executable", "target symlink", "writable directory", "non-root", "wrong owner", "invalid digest"} {
		t.Run(name, func(t *testing.T) {
			directory := t.TempDir()
			file := filepath.Join(directory, "smithers-jj-export")
			body := make([]byte, 64)
			copy(body, []byte("\x7fELF"))
			body[4], body[5], body[18] = 2, 1, 183
			sum := sha256.Sum256(body)
			digest := hex.EncodeToString(sum[:])
			require.NoError(t, os.WriteFile(file, body, 0755))
			switch name {
			case "missing":
				require.NoError(t, os.Remove(file))
			case "changed":
				require.NoError(t, os.WriteFile(file, []byte("changed"), 0755))
			case "writable file":
				require.NoError(t, os.Chmod(file, 0777))
			case "non-executable":
				require.NoError(t, os.Chmod(file, 0644))
			case "target symlink":
				require.NoError(t, os.Remove(file))
				require.NoError(t, os.Symlink(filepath.Join(t.TempDir(), "outside"), file))
			case "writable directory":
				require.NoError(t, os.Chmod(directory, 0777))
			case "invalid digest":
				digest = "invalid"
			}
			script := `import importlib.util,os,sys
spec=importlib.util.spec_from_file_location("guest",sys.argv[1]); guest=importlib.util.module_from_spec(spec); spec.loader.exec_module(guest)
guest.ROOT_UID=os.geteuid()
if sys.argv[4]=="non-root": guest.os.geteuid=lambda:guest.ROOT_UID+1
if sys.argv[4]=="wrong owner":
    original=guest.os.fstat
    def wrong_owner(fd):
        info=original(fd)
        if guest.stat.S_ISREG(info.st_mode):
            values=list(info); values[4]=guest.ROOT_UID+1; return os.stat_result(values)
        return info
    guest.os.fstat=wrong_owner
print("current" if guest.coding_helper_current(sys.argv[3],sys.argv[2]) else "replace")
`
			command := exec.Command(python, "-B", "-c", script, filepath.Join("guest", "smithers-guest.py"), directory, digest, name)
			output, err := command.CombinedOutput()
			switch name {
			case "current":
				require.NoError(t, err, string(output))
				require.Equal(t, "current\n", string(output))
			case "missing", "changed", "writable file", "non-executable":
				require.NoError(t, err, string(output))
				require.Equal(t, "replace\n", string(output))
			default:
				require.Error(t, err, string(output))
				require.Contains(t, string(output), "smithers-guest:")
			}
		})
	}
}
