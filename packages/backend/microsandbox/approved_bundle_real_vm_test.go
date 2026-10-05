package microsandbox

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/installbundle/bundletest"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// fixtureHost is a managed host planted from the bundle: it reports the
// identity it runs as and the environment value it received.
const fixtureHost = `#!/usr/bin/python3
import http.server, json, os, sys
port = int(sys.argv[1])
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"uid": os.getuid(), "euid": os.geteuid(), "gid": os.getgid(), "groups": os.getgroups(),
                           "argv0": sys.argv[0], "agentVariable": os.environ.get("AGENT_VARIABLE")}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
`

// installedBundleCopy clones the real assembled bundle SMITHERS_INSTALLED_BUNDLE
// names (with its msb, libkrunfw, Linux helper and coding host) into a
// protected temporary directory, adds the fixture host and declares it.
func installedBundleCopy(t *testing.T) string {
	t.Helper()
	source := os.Getenv("SMITHERS_INSTALLED_BUNDLE")
	if source == "" {
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
			t.Fatal("SMITHERS_INSTALLED_BUNDLE is required for the approved-bundle microVM receipts")
		}
		t.Skip("SMITHERS_INSTALLED_BUNDLE is not set")
	}
	bundle := filepath.Join(bundletest.ProtectedTempDir(t), "bundle")
	output, err := exec.Command("/bin/cp", "-cR", source, bundle).CombinedOutput()
	require.NoError(t, err, string(output))
	data, err := os.ReadFile(filepath.Join(bundle, "manifest.json"))
	require.NoError(t, err)
	var manifest map[string]any
	require.NoError(t, json.Unmarshal(data, &manifest))
	require.NoError(t, os.WriteFile(filepath.Join(bundle, "bin", "fixture-host"), []byte(fixtureHost), 0o755))
	sum := sha256.Sum256([]byte(fixtureHost))
	manifest["files"] = append(manifest["files"].([]any), map[string]any{"path": "bin/fixture-host", "sha256": hex.EncodeToString(sum[:]), "stage": "fixture", "mode": 0o755})
	data, err = json.Marshal(manifest)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(bundle, "manifest.json"), data, 0o644))
	return bundle
}

// rootExec runs a fixture command as guest root in a disposable test
// machine: it builds the hostile retained states a machine user or an older
// release could leave. Production never runs a shell as root.
func rootExec(t *testing.T, r *Runtime, machine, script string) string {
	t.Helper()
	output, err := r.cli.run(context.Background(), nil, "exec", machine, "--", "/bin/sh", "-c", script)
	require.NoError(t, err, string(output))
	return string(output)
}

type guestFileFact struct {
	UID, Mode int
	SHA256    string
	Inode     uint64
}

func guestFile(t *testing.T, r *Runtime, machine, path string) (guestFileFact, bool) {
	t.Helper()
	output, err := r.cli.run(context.Background(), nil, "exec", machine, "--", "/usr/bin/python3", "-I", "-S", "-c", `import hashlib,json,os,stat,sys
try: info=os.lstat(sys.argv[1])
except FileNotFoundError: print("null"); raise SystemExit
digest=hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest() if stat.S_ISREG(info.st_mode) else ""
print(json.dumps({"UID":info.st_uid,"Mode":stat.S_IMODE(info.st_mode),"SHA256":digest,"Inode":info.st_ino}))`, path)
	require.NoError(t, err, string(output))
	if strings.TrimSpace(string(output)) == "null" {
		return guestFileFact{}, false
	}
	var fact guestFileFact
	require.NoError(t, json.Unmarshal(output, &fact))
	return fact, true
}

// C-SEC-02 receipts for the round-2 root paths, in real microVMs booted by
// the real msb of a real assembled bundle copy: managed-artifact and the
// coding helper as real guest root on fresh and retained machines, the
// planted host running as the unprivileged agent with its environment
// unplanted, a retained machine with the old /opt/smithers/hosts layout and
// an older helper, and hostile retained ancestors refused without writing.
func TestRealMicroVMApprovedBundleRootPaths(t *testing.T) {
	bundle := installedBundleCopy(t)
	evidence := os.Getenv("SMITHERS_FLOW_ISOLATION_EVIDENCE_DIR")
	record := func(name string, value any) {
		t.Helper()
		if evidence == "" {
			return
		}
		body, err := json.MarshalIndent(value, "", "  ")
		require.NoError(t, err)
		require.NoError(t, os.MkdirAll(evidence, 0o700))
		require.NoError(t, os.WriteFile(filepath.Join(evidence, name+".json"), body, 0o600))
	}
	host := filepath.Join(bundle, "bin", "fixture-host")
	codingHost := filepath.Join(bundle, "bin", "smithers-coding-host")
	installed, err := installbundle.OpenRunning(filepath.Join(bundle, "bin", "smithers-backend"))
	require.NoError(t, err)
	runtime, err := New(context.Background(), Config{Bundle: installed,
		BundlePrograms: []string{host, codingHost},
		Root:           t.TempDir(), CPUs: 2, MemoryMiB: 2048, DiskMiB: 8192, MaxRunningVMs: 2})
	require.NoError(t, err, "the real assembled bundle passes startup")
	t.Cleanup(func() { sweepOwner(t, runtime) })
	require.Equal(t, filepath.Join(bundle, "bin", "msb"), runtime.cli.binary, "msb is the bundle's own")
	record("startup", map[string]any{"bundle": installed.Root(), "revision": installed.Revision(), "manifestSHA256": installed.ManifestSHA256(),
		"msb": runtime.cli.binary, "guestHelperSHA256": guestHelperDigest})

	ctx := operation("bundle-root")
	const workspaceID = "bundle-root"
	_, err = runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: workspaceID})
	require.NoError(t, err)
	machine := runtime.machineName(workspaceID)

	// Fable round 2, N2: setup's sanitizer end state in a real guest: no
	// file under /usr keeps a set-id bit or security.capability, and sudo,
	// su and sshd are gone. Read as root, after setup ran.
	scan, err := runtime.cli.run(ctx, nil, "exec", machine, "--", "/usr/bin/python3", "-I", "-S", "-c", `import json,os,stat
setid,caps,found,files=[],[],[],0
for top,dirs,names in os.walk("/usr"):
    for name in names+dirs:
        if name in ("sudo","su","sshd"): found.append(os.path.join(top,name))
    for name in names:
        path=os.path.join(top,name)
        info=os.lstat(path)
        if not stat.S_ISREG(info.st_mode): continue
        files+=1
        if info.st_mode & 0o6000: setid.append(path)
        try:
            if "security.capability" in os.listxattr(path, follow_symlinks=False): caps.append(path)
        except OSError: pass
for path in ("/bin/sudo","/bin/su","/sbin/sshd","/usr/bin/sudo","/usr/bin/su","/usr/sbin/sshd"):
    if os.path.lexists(path) and path not in found: found.append(path)
print(json.dumps({"regularFiles":files,"setid":setid,"capabilities":caps,"sudoSuSshd":found}))`)
	require.NoError(t, err, string(scan))
	var sanitized struct {
		RegularFiles int      `json:"regularFiles"`
		SetID        []string `json:"setid"`
		Capabilities []string `json:"capabilities"`
		SudoSuSshd   []string `json:"sudoSuSshd"`
	}
	require.NoError(t, json.Unmarshal(scan, &sanitized))
	require.Greater(t, sanitized.RegularFiles, 1000, "the scan walked the image's /usr")
	require.Empty(t, sanitized.SetID, "no set-id bit remains under /usr")
	require.Empty(t, sanitized.Capabilities, "no security.capability remains under /usr")
	require.Empty(t, sanitized.SudoSuSshd, "sudo, su and sshd are removed")
	record("sanitizer-end-state", sanitized)

	// Fable round 2, B2 and N2: the real msb and the guest kernel it loads are
	// verified before every run. A replaced file (a new inode, so running
	// microVMs keep theirs) refuses the next run; the approved bytes put back
	// are accepted again.
	perRun := map[string]string{}
	for _, relative := range []string{"bin/msb", "lib/libkrunfw.5.dylib"} {
		target := filepath.Join(bundle, filepath.FromSlash(relative))
		info, err := os.Stat(target)
		require.NoError(t, err)
		original := filepath.Join(t.TempDir(), "original")
		output, err := exec.Command("/bin/cp", "-c", target, original).CombinedOutput()
		require.NoError(t, err, string(output))
		tampered := filepath.Join(filepath.Dir(target), ".tampered")
		output, err = exec.Command("/bin/cp", "-c", target, tampered).CombinedOutput()
		require.NoError(t, err, string(output))
		file, err := os.OpenFile(tampered, os.O_WRONLY|os.O_APPEND, 0)
		require.NoError(t, err)
		_, err = file.Write([]byte{0})
		require.NoError(t, err)
		require.NoError(t, file.Close())
		require.NoError(t, os.Chmod(tampered, info.Mode().Perm()))
		require.NoError(t, os.Rename(tampered, target))
		_, err = runtime.ExecuteCommand(ctx, workspaceID, workspaceapi.Command{Args: []string{"/bin/true"}})
		require.ErrorIs(t, err, ErrUnapprovedArtifact, relative)
		perRun[relative] = err.Error()
		require.NoError(t, os.Rename(original, target))
		result, err := runtime.ExecuteCommand(ctx, workspaceID, workspaceapi.Command{Args: []string{"/bin/true"}})
		require.NoError(t, err, relative)
		require.Zero(t, result.ExitCode)
	}
	// msb loads the first libkrunfw.5.dylib it finds beside itself, then in
	// ../lib: a kernel placed beside msb refuses the next run.
	shadow := filepath.Join(bundle, "bin", "libkrunfw.5.dylib")
	output, err := exec.Command("/bin/cp", "-c", filepath.Join(bundle, "lib", "libkrunfw.5.dylib"), shadow).CombinedOutput()
	require.NoError(t, err, string(output))
	_, err = runtime.ExecuteCommand(ctx, workspaceID, workspaceapi.Command{Args: []string{"/bin/true"}})
	require.ErrorIs(t, err, ErrUnapprovedArtifact, "a kernel beside msb")
	perRun["bin/libkrunfw.5.dylib"] = err.Error()
	require.NoError(t, os.Remove(shadow))
	result, err := runtime.ExecuteCommand(ctx, workspaceID, workspaceapi.Command{Args: []string{"/bin/true"}})
	require.NoError(t, err)
	require.Zero(t, result.ExitCode)
	record("per-run-check", perRun)

	// The kernel msb resolves, in the environment every msb run gets, is the
	// verified lib/ file.
	doctor, err := runtime.cli.command("doctor").CombinedOutput()
	require.NoError(t, err, string(doctor))
	want, err := filepath.EvalSymlinks(filepath.Join(bundle, "lib", "libkrunfw.5.dylib"))
	require.NoError(t, err)
	var resolved string
	for _, line := range strings.Split(string(doctor), "\n") {
		if fields := strings.Fields(line); len(fields) > 0 && strings.Contains(line, "libkrunfw") {
			resolved, _ = filepath.EvalSymlinks(fields[len(fields)-1])
		}
	}
	require.Equal(t, want, resolved, "msb doctor: %s", doctor)
	record("kernel-lookup", map[string]string{"msbDoctor": strings.TrimSpace(string(doctor)), "loaded": resolved})

	sum := func(path string) string {
		body, err := os.ReadFile(path)
		require.NoError(t, err)
		digest := sha256.Sum256(body)
		return hex.EncodeToString(digest[:])
	}

	// Fresh machine: the guest helper's walk from / accepts the image's root
	// chain, and real root plants the real coding host and the fixture host.
	for _, program := range []string{codingHost, host} {
		planted, err := runtime.plantArtifact(ctx, machine, program)
		require.NoError(t, err)
		fact, present := guestFile(t, runtime, machine, planted)
		require.True(t, present)
		require.Equal(t, guestFileFact{UID: 0, Mode: 0o755, SHA256: sum(program), Inode: fact.Inode}, fact, planted)
	}
	for _, directory := range []string{"/", "/opt", "/opt/smithers", "/opt/smithers/bundle", "/opt/smithers/bundle/bin"} {
		fact, present := guestFile(t, runtime, machine, directory)
		require.True(t, present)
		require.Zero(t, fact.UID, directory)
		require.Zero(t, fact.Mode&0o022, directory)
	}
	require.NoError(t, runtime.InstallWorkspaceCodingBinding(ctx, workspaceID, codingBindingFixture()))
	helperFact, present := guestFile(t, runtime, machine, "/usr/local/bin/smithers-jj-export")
	require.True(t, present)
	require.Equal(t, guestFileFact{UID: 0, Mode: 0o755, SHA256: sum(filepath.Join(bundle, filepath.FromSlash(codingHelperBundlePath))), Inode: helperFact.Inode}, helperFact)
	fresh, _ := guestFile(t, runtime, machine, "/opt/smithers/bundle/bin/fixture-host")
	record("fresh-plant", map[string]any{"fixtureHost": fresh, "codingHelper": helperFact})

	// The planted host runs as the unprivileged agent; an agent variable that
	// names a bundle file reaches it unchanged and is never planted.
	observed := map[string]any{}
	expected := workspaceapi.ManagedHostIdentity{Protocol: "test/v1", ArtifactDigest: strings.Repeat("a", 64), SourceRevision: strings.Repeat("b", 40), OwnerGeneration: 1}
	agentVariable := filepath.Join(bundle, filepath.FromSlash(codingHelperBundlePath))
	spec := workspaceapi.ManagedHostSpec{ID: "bundle-host", Name: "bundle-host", Identity: "bundle-host-1", Expected: expected, ReadyTimeout: 30 * time.Second,
		Builder: workspaceapi.ManagedHostBuilderFunc(func(_ context.Context, placement workspaceapi.ManagedHostPlacement) (workspaceapi.Command, error) {
			return workspaceapi.Command{Args: []string{host, fmt.Sprint(placement.Port)}, Environment: map[string]string{"AGENT_VARIABLE": agentVariable}}, nil
		}),
		Probe: workspaceapi.ManagedHostProbeFunc(func(ctx context.Context, connection workspaceapi.ManagedHostConnection) (workspaceapi.ManagedHostIdentity, error) {
			request, _ := http.NewRequestWithContext(ctx, http.MethodGet, connection.Endpoint+"/", nil)
			response, err := connection.HTTPClient.Do(request)
			if err != nil {
				return workspaceapi.ManagedHostIdentity{}, err
			}
			defer response.Body.Close()
			body, _ := io.ReadAll(response.Body)
			if err := json.Unmarshal(body, &observed); err != nil {
				return workspaceapi.ManagedHostIdentity{}, err
			}
			return expected, nil
		}),
	}
	_, err = runtime.StartManagedHost(ctx, workspaceID, spec)
	require.NoError(t, err)
	require.EqualValues(t, guestUID, observed["uid"])
	require.EqualValues(t, guestUID, observed["euid"])
	require.EqualValues(t, guestUID, observed["gid"])
	require.Equal(t, "/opt/smithers/bundle/bin/fixture-host", observed["argv0"])
	require.Equal(t, agentVariable, observed["agentVariable"], "the variable reached the host unchanged")
	_, planted := guestFile(t, runtime, machine, "/opt/smithers/bundle/bin/linux-arm64")
	require.False(t, planted, "the variable's file was never planted")
	record("planted-host", observed)
	require.NoError(t, runtime.StopService(ctx, workspaceID, "bundle-host"))

	// Retained machine, current: checked, never rewritten.
	require.NoError(t, runtime.StopWorkspace(ctx, workspaceID))
	_, err = runtime.StartWorkspace(ctx, workspaceID)
	require.NoError(t, err)
	_, err = runtime.plantArtifact(ctx, machine, host)
	require.NoError(t, err)
	retained, _ := guestFile(t, runtime, machine, "/opt/smithers/bundle/bin/fixture-host")
	require.Equal(t, fresh, retained, "a current retained file is not rewritten")
	// Retained with drift: the approved bytes return as root-owned 0755.
	rootExec(t, runtime, machine, "printf tampered > /opt/smithers/bundle/bin/fixture-host; chmod 0700 /opt/smithers/bundle/bin/fixture-host")
	_, err = runtime.plantArtifact(ctx, machine, host)
	require.NoError(t, err)
	repaired, _ := guestFile(t, runtime, machine, "/opt/smithers/bundle/bin/fixture-host")
	require.Equal(t, guestFileFact{UID: 0, Mode: 0o755, SHA256: sum(host), Inode: repaired.Inode}, repaired)
	record("retained-plant", map[string]any{"current": retained, "repaired": repaired})

	// Retained machine with the old /opt/smithers/hosts layout and an older
	// guest helper: the wake installs this release's helper first, the new
	// layout is planted, and the old files stay inert and untouched.
	rootExec(t, runtime, machine, "mkdir -p /opt/smithers/hosts && printf old-host > /opt/smithers/hosts/smithers-coding-host && chmod 0755 /opt/smithers/hosts/smithers-coding-host && printf '# older release\\n' >> /opt/smithers/guest/smithers-guest.py")
	oldHost, _ := guestFile(t, runtime, machine, "/opt/smithers/hosts/smithers-coding-host")
	_, err = runtime.guest(ctx, machine, nil, "managed-artifact-check", "bin/fixture-host", sum(host))
	require.ErrorContains(t, err, "helper digest mismatch", "an older helper never runs as root")
	require.NoError(t, runtime.StopWorkspace(ctx, workspaceID))
	_, err = runtime.StartWorkspace(ctx, workspaceID)
	require.NoError(t, err)
	helper, _ := guestFile(t, runtime, machine, guestHelperPath)
	require.Equal(t, guestHelperDigest, helper.SHA256, "the wake installed this release's helper")
	rootExec(t, runtime, machine, "rm -rf /opt/smithers/bundle")
	_, err = runtime.plantArtifact(ctx, machine, codingHost)
	require.NoError(t, err)
	planted2, _ := guestFile(t, runtime, machine, "/opt/smithers/bundle/bin/smithers-coding-host")
	require.Equal(t, sum(codingHost), planted2.SHA256)
	untouched, _ := guestFile(t, runtime, machine, "/opt/smithers/hosts/smithers-coding-host")
	require.Equal(t, oldHost, untouched)
	record("retained-old-layout", map[string]any{"helper": helper, "planted": planted2, "oldHost": untouched})

	// Hostile retained ancestors refuse in the real guest, writing nothing.
	passwd, _ := guestFile(t, runtime, machine, "/etc/passwd")
	refusals := map[string]string{}
	for _, test := range []struct {
		name, setup, restore, program, probe, want string
		coding                                     bool
	}{
		{name: "usr-local-symlink", coding: true,
			setup:   "rm -f /usr/local/bin/smithers-jj-export && mv /usr/local /usr/local.real && ln -s /usr/local.real /usr/local",
			restore: "rm /usr/local && mv /usr/local.real /usr/local", probe: "/usr/local.real/bin/smithers-jj-export"},
		{name: "bundle-bin-symlink", program: host,
			setup:   "rm -rf /opt/smithers/bundle/bin && mkdir -p /tmp/outside && ln -s /tmp/outside /opt/smithers/bundle/bin",
			restore: "rm /opt/smithers/bundle/bin && rm -rf /tmp/outside", probe: "/tmp/outside/fixture-host"},
		{name: "group-writable-ancestor", program: host,
			setup: "chmod 0775 /opt/smithers/bundle", restore: "chmod 0755 /opt/smithers/bundle"},
		{name: "agent-owned-ancestor", program: host,
			setup: "chown 19999 /opt/smithers/bundle/bin", restore: "chown 0 /opt/smithers/bundle/bin"},
		// /opt/smithers is also the helper's own ancestor: the pinned bootstrap
		// refuses before the helper runs at all.
		{name: "writable-shared-ancestor", program: host, want: "untrusted helper ancestor",
			setup: "chmod 0775 /opt/smithers", restore: "chmod 0755 /opt/smithers"},
		{name: "target-symlink", program: host,
			setup:   "rm -f /opt/smithers/bundle/bin/fixture-host && ln -s /etc/passwd /opt/smithers/bundle/bin/fixture-host",
			restore: "rm -f /opt/smithers/bundle/bin/fixture-host"},
	} {
		rootExec(t, runtime, machine, "mkdir -p /opt/smithers/bundle/bin && "+test.setup)
		if test.coding {
			err = runtime.InstallWorkspaceCodingBinding(ctx, workspaceID, codingBindingFixture())
		} else {
			_, err = runtime.plantArtifact(ctx, machine, test.program)
		}
		require.Error(t, err, test.name)
		if test.want == "" {
			test.want = "smithers-guest: protected"
		}
		require.Contains(t, err.Error(), test.want, test.name)
		refusals[test.name] = err.Error()
		if test.probe != "" {
			_, written := guestFile(t, runtime, machine, test.probe)
			require.False(t, written, "%s: nothing was written through the link", test.name)
		}
		now, _ := guestFile(t, runtime, machine, "/etc/passwd")
		require.Equal(t, passwd, now, test.name)
		rootExec(t, runtime, machine, test.restore)
	}
	record("hostile-ancestors", refusals)
	_, err = runtime.plantArtifact(ctx, machine, host)
	require.NoError(t, err, "the restored machine plants again")
	require.NoError(t, runtime.DeleteWorkspace(ctx, workspaceID))
}
