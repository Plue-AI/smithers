package microsandbox

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// These tests run the real Python installer against real filesystem entries.
// Only its protected base ("/" in a guest) and root UID are replaced for an
// unprivileged developer's temporary tree; the production CLI accepts
// neither override.
func runCodingBindingGuest(t *testing.T, base string, config map[string]any, after string) (string, error) {
	t.Helper()
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	body, err := json.Marshal(config)
	require.NoError(t, err)
	script := `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location("guest",sys.argv[1]); guest=importlib.util.module_from_spec(spec); spec.loader.exec_module(guest)
guest.ROOT_UID=os.geteuid()
guest.PROTECTED_BASE=sys.argv[2]
guest.install_coding_binding(json.loads(sys.argv[3]))
` + after
	command := exec.Command(python, "-B", "-c", script, filepath.Join("guest", "smithers-guest.py"), base, string(body))
	output, err := command.CombinedOutput()
	return string(output), err
}

// protectedGuestBase is a temporary guest root holding the fixed /etc and
// /usr/local/bin, owned by the test user that stands in for root.
func protectedGuestBase(t *testing.T) string {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	for _, directory := range []string{"etc", "usr/local/bin"} {
		require.NoError(t, os.MkdirAll(filepath.Join(base, filepath.FromSlash(directory)), 0o755))
	}
	return base
}

func guestCodingConfig() map[string]any {
	return map[string]any{"version": 1, "workspaceId": "coding-lane", "actorId": 9, "repositoryId": 77, "repositorySlug": "acme/widgets", "apiBaseUrl": "http://127.0.0.1:4000/api", "gitUrl": "http://127.0.0.1:4000/acme/widgets.git", "repositoryPath": guestRoot, "username": guestUser, "credentialSocket": guestHome + "/.cache/smithers/git-credential/socket"}
}

func TestGuestCodingBindingWritesAndRepairsOneAtomicFile(t *testing.T) {
	base := protectedGuestBase(t)
	config := guestCodingConfig()
	output, err := runCodingBindingGuest(t, base, config, "")
	require.NoError(t, err, output)
	file := filepath.Join(base, "etc", "smithers", "workspace-coding.json")
	body, err := os.ReadFile(file)
	require.NoError(t, err)
	var actual map[string]any
	require.NoError(t, json.Unmarshal(body, &actual))
	require.Equal(t, "coding-lane", actual["workspaceId"])
	info, err := os.Stat(file)
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0644), info.Mode().Perm())
	config["actorId"] = 10
	output, err = runCodingBindingGuest(t, base, config, "")
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
	for _, name := range []string{"parent symlink", "ancestor symlink", "target symlink", "writable parent", "writable ancestor", "invalid fields", "runtime root", "runtime user", "runtime socket", "zero actor", "boolean repository", "invalid workspace"} {
		t.Run(name, func(t *testing.T) {
			base := protectedGuestBase(t)
			directory := filepath.Join(base, "etc")
			outside := t.TempDir()
			sentinel := filepath.Join(outside, "sentinel")
			require.NoError(t, os.WriteFile(sentinel, []byte("unchanged"), 0600))
			config := guestCodingConfig()
			switch name {
			case "parent symlink":
				require.NoError(t, os.Symlink(outside, filepath.Join(directory, "smithers")))
			case "ancestor symlink":
				// /etc itself is a link to a directory that passes every
				// ownership check: only the descriptor walk from / refuses it.
				require.NoError(t, os.Remove(directory))
				require.NoError(t, os.Symlink(outside, directory))
			case "target symlink":
				require.NoError(t, os.Mkdir(filepath.Join(directory, "smithers"), 0755))
				require.NoError(t, os.Symlink(sentinel, filepath.Join(directory, "smithers", "workspace-coding.json")))
			case "writable parent":
				require.NoError(t, os.Mkdir(filepath.Join(directory, "smithers"), 0755))
				require.NoError(t, os.Chmod(filepath.Join(directory, "smithers"), 0777))
			case "writable ancestor":
				require.NoError(t, os.Chmod(base, 0777))
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
			output, err := runCodingBindingGuest(t, base, config, "")
			require.Error(t, err, output)
			body, err := os.ReadFile(sentinel)
			require.NoError(t, err)
			require.Equal(t, "unchanged", string(body))
			entries, err := os.ReadDir(outside)
			require.NoError(t, err)
			require.Len(t, entries, 1, "nothing was written through a link")
			if name != "parent symlink" && name != "ancestor symlink" {
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

// T-SEC-01 R5 / Astra round 1: the helper's destination is reached by the
// same descriptor walk from / as a managed artifact. Every ancestor, /usr
// and /usr/local included, is root-owned, not group or world writable and
// never followed, and the bytes must hash to the digest sent with them.
func TestGuestCodingHelperInstallsOnlyFixedExecutable(t *testing.T) {
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	for _, name := range []string{"install", "repair", "invalid ELF", "digest mismatch", "invalid digest", "target symlink", "writable directory", "ancestor symlink", "writable ancestor", "non-root"} {
		t.Run(name, func(t *testing.T) {
			base := protectedGuestBase(t)
			directory := filepath.Join(base, "usr", "local", "bin")
			body := make([]byte, 64)
			copy(body, []byte("\x7fELF"))
			body[4], body[5], body[18] = 2, 1, 183
			sum := sha256.Sum256(body)
			digest := hex.EncodeToString(sum[:])
			outside := t.TempDir()
			sentinel := filepath.Join(outside, "sentinel")
			require.NoError(t, os.WriteFile(sentinel, []byte("untouched"), 0600))
			file := filepath.Join(directory, "smithers-jj-export")
			switch name {
			case "repair":
				require.NoError(t, os.WriteFile(file, []byte("old"), 0755))
			case "invalid ELF":
				body[18] = 62
				sum = sha256.Sum256(body)
				digest = hex.EncodeToString(sum[:])
			case "digest mismatch":
				body[63] = 1
			case "invalid digest":
				digest = strings.ToUpper(digest)
			case "target symlink":
				require.NoError(t, os.Symlink(sentinel, file))
			case "writable directory":
				require.NoError(t, os.Chmod(directory, 0777))
			case "ancestor symlink":
				// A retained /usr/local that is a link to a tree with a
				// root-owned 0755 bin: the old final-directory check accepted it.
				require.NoError(t, os.MkdirAll(filepath.Join(outside, "bin"), 0o755))
				require.NoError(t, os.RemoveAll(filepath.Join(base, "usr", "local")))
				require.NoError(t, os.Symlink(outside, filepath.Join(base, "usr", "local")))
			case "writable ancestor":
				require.NoError(t, os.Chmod(filepath.Join(base, "usr"), 0777))
			}
			script := `import base64,importlib.util,os,sys
spec=importlib.util.spec_from_file_location("guest",sys.argv[1]); guest=importlib.util.module_from_spec(spec); spec.loader.exec_module(guest)
guest.ROOT_UID=os.geteuid()
guest.PROTECTED_BASE=sys.argv[2]
if sys.argv[5]=="non-root": guest.os.geteuid=lambda:guest.ROOT_UID+1
guest.install_coding_helper(sys.argv[4],base64.b64decode(sys.argv[3]))
`
			command := exec.Command(python, "-B", "-c", script, filepath.Join("guest", "smithers-guest.py"), base, base64.StdEncoding.EncodeToString(body), digest, name)
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
				require.Contains(t, string(output), "smithers-guest:")
			}
			contents, err := os.ReadFile(sentinel)
			require.NoError(t, err)
			require.Equal(t, "untouched", string(contents))
			entries, err := os.ReadDir(outside)
			require.NoError(t, err)
			require.LessOrEqual(t, len(entries), 2, "nothing was written through a link")
			_, err = os.Stat(filepath.Join(outside, "bin", "smithers-jj-export"))
			require.ErrorIs(t, err, os.ErrNotExist, "nothing was installed through a linked ancestor")
			temporary, _ := filepath.Glob(filepath.Join(directory, ".install-*"))
			require.Empty(t, temporary)
		})
	}
}

func TestGuestCodingHelperChecksDigestAndPrivileges(t *testing.T) {
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	for _, name := range []string{"current", "missing", "missing directory", "changed", "writable file", "non-executable", "target symlink", "writable directory", "ancestor symlink", "writable ancestor", "non-root", "wrong owner", "invalid digest"} {
		t.Run(name, func(t *testing.T) {
			base := protectedGuestBase(t)
			directory := filepath.Join(base, "usr", "local", "bin")
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
			case "missing directory":
				require.NoError(t, os.RemoveAll(filepath.Join(base, "usr", "local")))
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
			case "ancestor symlink":
				// The linked tree holds the exact approved bytes: only the walk
				// refuses it, so the check cannot report it current.
				outside := t.TempDir()
				require.NoError(t, os.Rename(filepath.Join(base, "usr", "local"), filepath.Join(outside, "local")))
				require.NoError(t, os.Symlink(filepath.Join(outside, "local"), filepath.Join(base, "usr", "local")))
			case "writable ancestor":
				require.NoError(t, os.Chmod(filepath.Join(base, "usr", "local"), 0777))
			case "invalid digest":
				digest = "invalid"
			}
			script := `import importlib.util,os,sys
spec=importlib.util.spec_from_file_location("guest",sys.argv[1]); guest=importlib.util.module_from_spec(spec); spec.loader.exec_module(guest)
guest.ROOT_UID=os.geteuid()
guest.PROTECTED_BASE=sys.argv[2]
if sys.argv[4]=="non-root": guest.os.geteuid=lambda:guest.ROOT_UID+1
if sys.argv[4]=="wrong owner":
    original=guest.os.fstat
    def wrong_owner(fd):
        info=original(fd)
        if guest.stat.S_ISREG(info.st_mode):
            values=list(info); values[4]=guest.ROOT_UID+1; return os.stat_result(values)
        return info
    guest.os.fstat=wrong_owner
print("current" if guest.coding_helper_current(sys.argv[3]) else "replace")
`
			command := exec.Command(python, "-B", "-c", script, filepath.Join("guest", "smithers-guest.py"), base, digest, name)
			output, err := command.CombinedOutput()
			switch name {
			case "current":
				require.NoError(t, err, string(output))
				require.Equal(t, "current\n", string(output))
			case "missing", "missing directory", "changed", "writable file", "non-executable":
				require.NoError(t, err, string(output))
				require.Equal(t, "replace\n", string(output))
			default:
				require.Error(t, err, string(output))
				require.Contains(t, string(output), "smithers-guest:")
			}
		})
	}
}

// An ancestor swapped for a link after it was created but before it is
// opened is refused: the walk opens every directory without following.
func TestGuestCodingHelperRefusesARacedAncestor(t *testing.T) {
	body := make([]byte, 64)
	copy(body, []byte("\x7fELF"))
	body[4], body[5], body[18] = 2, 1, 183
	sum := sha256.Sum256(body)
	boundaryPython(t, fmt.Sprintf(`
with tempfile.TemporaryDirectory() as directory:
 directory=os.path.realpath(directory)
 g.ROOT_UID=os.geteuid(); g.PROTECTED_BASE=directory
 os.makedirs(directory+'/usr/local/bin',0o755)
 outside=directory+'/outside'; os.makedirs(outside+'/bin',0o755)
 real_open=os.open
 def racing_open(path,flags,*args,**kwargs):
  if path=='local' and kwargs.get('dir_fd') is not None:
   os.rename(directory+'/usr/local',directory+'/usr/old-local')
   os.symlink(outside,directory+'/usr/local')
  return real_open(path,flags,*args,**kwargs)
 g.os.open=racing_open
 try: g.install_coding_helper(%q, bytes.fromhex(%q))
 except SystemExit as exit: assert exit.code==3, exit.code
 else: raise AssertionError('followed a raced ancestor')
 finally: g.os.open=real_open
 assert os.listdir(outside+'/bin')==[], os.listdir(outside+'/bin')
`, hex.EncodeToString(sum[:]), hex.EncodeToString(body)))
}
