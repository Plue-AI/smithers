package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/installbundle/bundletest"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/faultprocess"
	"github.com/stretchr/testify/require"
)

// Acceptance lives beside the install harness: importing compose from machined
// would create a cycle. There is no empty broker or process-runtime fallback.
func TestRebaseCrashThroughDispatcher(t *testing.T) { rebaseReferenceFaults(t, false) }
func TestRebaseFaultRootInputsValidatedBeforeUse(t *testing.T) {
	if os.Getenv("SMITHERS_REBASE_FAULT_REFERENCE") != "1" {
		if os.Getenv("SMITHERS_REBASE_FAULT_REQUIRED") == "1" {
			t.Fatal("C-DUR-04 root qualification requires the approved reference bundle")
		}
		t.Skip("approved reference bundle required")
	}
	require.Equal(t, "darwin", runtime.GOOS)
	require.Equal(t, "arm64", runtime.GOARCH)
	rebaseReferenceRootPrerequisites(t)
	rebaseReferenceFault(t, true, "rebase-post-capture", true)
}
func TestRebaseVMCrashThroughDispatcher(t *testing.T) { rebaseReferenceFaults(t, true) }

func rebaseReferenceFaults(t *testing.T, killVM bool) {
	if os.Getenv("SMITHERS_REBASE_FAULT_REFERENCE") != "1" {
		if os.Getenv("SMITHERS_REBASE_FAULT_REQUIRED") == "1" {
			t.Fatal("C-DUR-04 requires approved reference bundle and real member cgroups")
		}
		t.Skip("approved reference bundle and real microVM required")
	}
	require.Equal(t, "darwin", runtime.GOOS)
	require.Equal(t, "arm64", runtime.GOARCH)
	require.NotZero(t, os.Geteuid(), "repository harness must be unprivileged")
	rebaseReferenceRootPrerequisites(t)
	for _, people := range []bool{true, false} {
		presence := "people-absent"
		if people {
			presence = "people-present"
		}
		for _, point := range []string{"rebase-post-capture", "rebase-mid", "rebase-post-apply"} {
			for run := 1; run <= 10; run++ {
				t.Run(fmt.Sprintf("%s/%s/%02d", presence, point, run), func(t *testing.T) { rebaseReferenceFault(t, people, point, killVM) })
			}
		}
	}
}

func rebaseReferenceFault(t *testing.T, people bool, point string, killVM bool) {
	bundle, err := installbundle.Open(os.Getenv("SMITHERS_CHECK_BUNDLE"))
	require.NoError(t, err)
	t.Setenv(pinnedMicroVMRehearsal, "1")
	r := newRehearsal(t, pinnedMicroVMRehearsal, "C-DUR-04", "rebase-fault-")
	vm, ok := r.workspaceRuntime.(*microsandbox.Runtime)
	require.True(t, ok)
	require.True(t, r.install("Install through Machine ready"))
	n, err := r.file("Rebase recovery", "Add a greeting to JOURNEY.md")
	require.NoError(t, err)
	before, err := r.waitTodoWithin(n, 15*time.Minute, "in_review")
	require.NoError(t, err)
	branch, _, err := r.todoHostBinding(n)
	require.NoError(t, err)
	machine, err := vm.WorkspaceMachineIdentity(t.Context(), branch)
	require.NoError(t, err)
	registry := vm.MachinedRegistry()
	t.Run("crossing", func(t *testing.T) {

		// Refuse member executable substitutions against the actual approved bundle
		// before any msb call. The already composed machine is the trusted positive
		// control; the approved install is never modified to manufacture an attack.
		for _, artifact := range []string{"interpreter", "guest-helper", "daemon", "jj", "image"} {
			memberPath := filepath.Join(t.TempDir(), artifact)
			require.NoError(t, os.WriteFile(memberPath, []byte("#!/bin/sh\nexit 99\n"), 0755))
			state := filepath.Join(bundletest.ProtectedTempDir(t), "refused-machine")
			config := microsandbox.Config{Root: state, CPUs: 1, MemoryMiB: 1024, DiskMiB: 1024, MaxRunningVMs: 1, Bundle: bundle, BundlePrograms: []string{memberPath}}
			refused, err := microsandbox.New(t.Context(), config)
			require.ErrorIs(t, err, microsandbox.ErrUnapprovedArtifact)
			require.Nil(t, refused)
			_, err = os.Lstat(state)
			require.ErrorIs(t, err, os.ErrNotExist)
		}
		substituted := microsandbox.Config{Root: filepath.Join(bundletest.ProtectedTempDir(t), "refused-msb"), CPUs: 1, MemoryMiB: 1024, DiskMiB: 1024, MaxRunningVMs: 1, Bundle: bundle, Binary: "/workspace/member-msb"}
		refused, err := microsandbox.New(t.Context(), substituted)
		require.ErrorIs(t, err, microsandbox.ErrUnapprovedArtifact)
		require.Nil(t, refused)
		msb := bundle.Program("bin/msb")
		call := func(args ...string) ([]byte, error) {
			if err := msb.Check(); err != nil {
				return nil, err
			}
			ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, msb.Path(), args...)
			cmd.Env = []string{"HOME=" + os.Getenv("HOME"), "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "MSB_BACKEND=local", "NO_COLOR=1"}
			return cmd.CombinedOutput()
		}
		// Only the installed image's fixed setpriv runs privileged. Branch-authored
		// Python and control bytes execute after the daemon UID/GID/groups drop.
		control := func(script string) []byte {
			t.Helper()
			out, err := call("exec", machine, "--", "/usr/bin/setpriv", "--reuid=19998", "--regid=20000", "--clear-groups", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "/usr/bin/python3", "-I", "-S", "-c", script)
			require.NoError(t, err, "%s", out)
			return out
		}
		evidence := func(name string, value any) {
			t.Helper()
			data, err := json.MarshalIndent(value, "", "  ")
			require.NoError(t, err)
			require.NoError(t, os.WriteFile(filepath.Join(r.evidence, name), append(data, '\n'), 0600))
		}
		var controlIdentity struct {
			UID, GID int
			Groups   []int
		}
		require.NoError(t, json.Unmarshal(control("import os,json\nprint(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'groups':os.getgroups()}))"), &controlIdentity))
		require.Equal(t, 19998, controlIdentity.UID)
		require.Equal(t, 20000, controlIdentity.GID)
		require.Empty(t, controlIdentity.Groups)
		prefix := "writer-" + point
		session, err := r.openBranchTerminal(r.keyed, branch)
		require.NoError(t, err)
		terminal, err := r.openTerminal(session)
		require.NoError(t, err)
		defer terminal.close()
		quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
		script := fmt.Sprintf(`import os,json,hashlib
print(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'groups':os.getgroups(),'cgroup':open('/proc/self/cgroup').read()}))
for i in range(20):
 p=%q+'-%%02d.txt'%%i
 b=('acknowledged '+p+'\n').encode()
 f=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o664)
 assert os.write(f,b)==len(b)
 os.fsync(f);os.close(f)
 print(json.dumps({'seq':i,'path':p,'sha256':hashlib.sha256(b).hexdigest()}),flush=True)
`, prefix)
		status, output, err := terminal.capture("python3 -I -S -c "+quote(script), "WRITERDONE", 30*time.Second)
		require.NoError(t, err)
		require.Equal(t, "0", status, "%s", output)
		lines := strings.Split(strings.TrimSpace(string(output)), "\n")
		require.Len(t, lines, 21)
		var identity struct {
			UID, GID int
			Groups   []int
			Cgroup   string
		}
		require.NoError(t, json.Unmarshal([]byte(lines[0]), &identity))
		require.GreaterOrEqual(t, identity.UID, 20000)
		require.Contains(t, identity.Groups, 20000)
		require.Contains(t, identity.Cgroup, "/smithers/sessions/")
		type write struct {
			Seq    int
			Path   string
			SHA256 string
		}
		writes := make([]write, 20)
		for i, line := range lines[1:] {
			require.NoError(t, json.Unmarshal([]byte(line), &writes[i]))
			require.Equal(t, i, writes[i].Seq)
			require.Equal(t, fmt.Sprintf("%s-%02d.txt", prefix, i), writes[i].Path)
			sum := sha256.Sum256([]byte("acknowledged " + writes[i].Path + "\n"))
			require.Equal(t, hex.EncodeToString(sum[:]), writes[i].SHA256)
		}
		evidence("writer.json", map[string]any{"identity": identity, "writes": writes})

		// Member-controlled retained paths and target fields enter the actual install
		// reader/writer and rebase transport. Refusals must preserve the canary and
		// the subsequent trusted operation, not merely disconnect a socket fixture.
		canary := "/tmp/rebase-outside-canary"
		hostile := fmt.Sprintf("import os\nopen(%q,'w').write('outside preserved\\n')\nos.symlink(%q,'hostile-file')\nos.symlink('/tmp','hostile-directory')", canary, canary)
		status, output, err = terminal.capture("python3 -I -S -c "+quote(hostile), "ROOTCONTROLS", 15*time.Second)
		require.NoError(t, err)
		require.Equal(t, "0", status, "%s", output)
		for _, path := range []string{"hostile-file", "hostile-directory/rebase-outside-canary", "../rebase-outside-canary", "/root/rebase-canary"} {
			for _, method := range []string{"GET", "PUT"} {
				body := ""
				if method == "PUT" {
					body = `{"content":"must not write","base_digest":"absent"}`
				}
				code, raw, err := r.request(method, "/api/repos/rehearsal-owner/app/workspaces/"+branch+"/files/content?path="+url.QueryEscape(path), body)
				require.NoError(t, err)
				require.GreaterOrEqual(t, code, 400, "%s %s: %s", method, path, raw)
			}
		}
		for _, target := range []string{"../../root-canary", "--config=alias.rebase=!touch /root/canary", "LD_PRELOAD=/workspace/evil.so", "SMITHERS_MACHINED_KILL_AT=rebase-mid"} {
			result, err := registry.Rebase(t.Context(), branch, []byte("stack"), target)
			require.Error(t, err)
			require.Zero(t, result)
		}
		require.Equal(t, "outside preserved\n", string(control(fmt.Sprintf("print(open(%q).read(),end='')", canary))))
		status, output, err = terminal.capture("python3 -I -S -c "+quote("import os\nassert os.getuid()>=20000 and os.getgid()>=20000\ntry: open('/root/rebase-canary','w')\nexcept PermissionError: print('root refused')\nelse: raise AssertionError('member reached root')\nos.unlink('hostile-file');os.unlink('hostile-directory')"), "ROOTPOSITIVE", 15*time.Second)
		require.NoError(t, err)
		require.Equal(t, "0", status)
		require.Equal(t, "root refused", strings.TrimSpace(string(output)))
		evidence("root-inputs.json", map[string]any{"bundle_revision": bundle.Revision(), "bundle_manifest": bundle.ManifestSHA256(), "member": identity, "outside_canary": "outside preserved", "root_canary_refused": true, "selector_source": "main-built host harness private daemon state", "transport_source": "production host boot authority", "control_identity": controlIdentity, "cgroup": "/sys/fs/cgroup/smithers/sessions", "interpreter": "approved image /usr/bin/python3 -I -S after setpriv", "path": "/usr/bin:/bin"})

		captured, err := registry.Capture(t.Context(), branch)
		require.NoError(t, err)
		if !people {
			terminal.close()
		}
		tab, err := r.openLive(r.jar)
		require.NoError(t, err)
		defer tab.stop()
		_, err = tab.subscribe("branch:" + branch)
		require.NoError(t, err)
		require.NoError(t, tab.presence(map[string]any{"branch": branch}))
		onto, err := r.pushMain("REBASE-FAULT-MAIN.md", "new main bytes\n", "Rebase fault target")
		require.NoError(t, err)
		require.Eventually(t, func() bool {
			if tab.presence(map[string]any{"branch": branch}) != nil {
				return false
			}
			card, err := r.j10Card(n)
			return err == nil && card.RebasePending != nil
		}, 2*time.Minute, time.Second)

		var writerDone chan error
		if people {
			gate := "/tmp/rebase-writer-go"
			ready := "/tmp/rebase-writer-ready"
			blocked := fmt.Sprintf("import os,time\nopen(%q,'w').close()\nwhile not os.path.exists(%q): time.sleep(.005)\nf=os.open('freeze-probe.txt',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o664)\nos.write(f,b'late write\\n');os.fsync(f);os.close(f)\nprint('late acknowledged')", ready, gate)
			writerDone = make(chan error, 1)
			go func() {
				_, _, err := terminal.capture("python3 -I -S -c "+quote(blocked), "FREEZEPROBE", 90*time.Second)
				writerDone <- err
			}()
			require.Eventually(t, func() bool {
				return strings.TrimSpace(string(control(fmt.Sprintf("import os\nprint(os.path.exists(%q))", ready)))) == "True"
			}, 10*time.Second, 50*time.Millisecond)
		}
		arm := "/var/lib/smithers-machined/qualification-" + point
		control(fmt.Sprintf("import os\np=%q\nf=os.open(p+'.arm',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)\nos.fsync(f);os.close(f)", arm))
		if people {
			require.NotNil(t, before.Branch)
			for range 2 {
				code, data, err := r.keyed("POST", "/api/branches/"+url.PathEscape(before.Branch.Name), `{"rebase":true}`, r.keyPrefix+"rebase-press")
				require.NoError(t, err)
				require.Equal(t, 202, code, "%s", data)
			}
		} else {
			require.NoError(t, tab.presence(nil))
		}
		require.Eventually(t, func() bool {
			out := control(fmt.Sprintf("from pathlib import Path\np=Path(%q+'.hit')\nprint(p.read_text() if p.exists() else '')", arm))
			return strings.TrimSpace(string(out)) == point
		}, 45*time.Second, 100*time.Millisecond, "no exact rebase kill marker")
		// Observe the kernel, never infer a freeze from an empty broker's success.
		frozen := strings.TrimSpace(string(control("print(open('/sys/fs/cgroup/smithers/sessions/cgroup.events').read(),end='')")))
		require.Contains(t, frozen, "frozen 1")
		if people {
			control("open('/tmp/rebase-writer-go','w').close()")
			// The kernel has frozen this admitted member, so even with its gate open
			// it cannot reach write/fsync/close or acknowledge a write mid-rewrite.
			time.Sleep(200 * time.Millisecond)
			require.Equal(t, "False", strings.TrimSpace(string(control("import os\nprint(os.path.exists('/workspace/freeze-probe.txt'))"))))
		}

		evidence("at-kill.json", map[string]any{"point": point, "frozen": frozen, "capture": captured, "onto": onto, "bundle_revision": bundle.Revision(), "bundle_manifest": bundle.ManifestSHA256(), "machine": machine, "branch": branch, "kill_vm": killVM})

		var headAtKill string
		require.NoError(t, r.options.Repository.WithMachineRepository(t.Context(), "rehearsal-owner", "app", func(store string) error {
			cmd := exec.CommandContext(t.Context(), "/usr/bin/git", "-C", store, "rev-parse", "refs/smithers/branches/"+branch+"/head")
			out, err := cmd.Output()
			headAtKill = strings.TrimSpace(string(out))
			return err
		}))
		old, err := registry.Current(branch)
		require.NoError(t, err)
		if killVM {
			// The owned controller selects the retained workspace metadata and
			// takes msb's SIGKILL path, without a clean guest shutdown.
			faultprocess.KillMachine(t, r.workspaceStateRoot, branch, os.Getenv("SMITHERS_CHECK_BUNDLE"))
			_, err = vm.StartWorkspace(t.Context(), branch)
			require.NoError(t, err)
			require.NoError(t, vm.EnsureMachined(t.Context(), branch))
		} else {
			control(fmt.Sprintf("import os\nf=os.open(%q+'.exit',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)\nos.fsync(f);os.close(f)", arm))
		}
		t.Logf("CRASH-POINT %s subject %s", point, machine)
		require.Eventually(t, func() bool {
			link, err := registry.Current(branch)
			return err == nil && link != old && link.RequireReady(branch) == nil
		}, 45*time.Second, 100*time.Millisecond)
		require.Eventually(t, func() bool {
			card, err := r.todo(n)
			if err != nil {
				return false
			}
			return card.State == "in_review" && card.PR.Number == before.PR.Number && card.PR.Head != before.PR.Head && card.Merge.State == "ready"
		}, 5*time.Minute, time.Second)

		if writerDone != nil {
			select {
			case err := <-writerDone:
				require.Error(t, err, "old member session must die with its supervised daemon")
			case <-time.After(10 * time.Second):
				t.Fatal("old terminal writer survived daemon replacement")
			}
			require.Equal(t, "False", strings.TrimSpace(string(control("import os\nprint(os.path.exists('/workspace/freeze-probe.txt'))"))))
		}
		after, err := registry.Capture(t.Context(), branch)
		require.NoError(t, err)
		require.True(t, headAtKill == captured.Head || headAtKill == after.Head, "kill published a mixed or unrelated capture")
		require.Equal(t, "frozen 0", strings.TrimSpace(string(control("print(next(line.strip() for line in open('/sys/fs/cgroup/smithers/sessions/cgroup.events') if line.startswith('frozen ')))"))))
		for _, w := range writes {
			code, data, err := r.request("GET", "/api/repos/rehearsal-owner/app/workspaces/"+branch+"/files/content?path="+url.QueryEscape(w.Path), "")
			require.NoError(t, err)
			require.Equal(t, 200, code, "%s", data)
			var file struct{ Content, Digest string }
			require.NoError(t, json.Unmarshal(data, &file))
			require.Equal(t, "acknowledged "+w.Path+"\n", file.Content)
			require.Equal(t, w.SHA256, file.Digest)
			err = r.options.Repository.WithMachineRepository(t.Context(), "rehearsal-owner", "app", func(store string) error {
				cmd := exec.CommandContext(t.Context(), "/usr/bin/git", "-C", store, "show", after.Head+":"+w.Path)
				out, err := cmd.Output()
				if err != nil {
					return err
				}
				if string(out) != file.Content {
					return fmt.Errorf("capture lost %s", w.Path)
				}
				return nil
			})
			require.NoError(t, err)
		}

		code, activityRaw, err := r.request("GET", "/api/branches/"+branch+"/activity", "")
		require.NoError(t, err)
		require.Equal(t, 200, code, "%s", activityRaw)
		var activity []map[string]any
		require.NoError(t, json.Unmarshal(activityRaw, &activity))
		var rebaseEntries []map[string]any
		for _, entry := range activity {
			if entry["kind"] == "rebase" {
				rebaseEntries = append(rebaseEntries, entry)
			}
		}
		require.Len(t, rebaseEntries, 1)
		require.Equal(t, onto, rebaseEntries[0]["onto_revision"])
		require.Equal(t, true, rebaseEntries[0]["approvals_cleared"])
		evidence("activity.json", activity)
		var completions int
		require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.rebased' AND (data->>'n')::bigint=$1 AND data->>'onto'=$2`, n, onto).Scan(&completions))
		require.Equal(t, 1, completions)
		remaining := strings.TrimSpace(string(control("import os\nprint(len([n for n in os.listdir('/var/lib/smithers-machined/outbox') if n.endswith('.ev')]))")))
		require.Equal(t, "0", remaining)
		evidence("recovery.json", map[string]any{"point": point, "writes_acknowledged": 20, "writes_found": 20, "rebase_entries": completions, "before": captured, "after": after, "outbox_depth": 0})
		t.Logf(`CRASH-OBSERVATION {"point":%q,"subject":"branch","writesAcknowledged":20,"writesFound":20,"rebaseEntries":1,"outboxDepth":0}`, point)
	})
}

// A successful exit with skipped C-SEC-02 cells is not authority to start the
// rebase campaign. Inherited root tests must run on the same approved bundle.
func rebaseReferenceRootPrerequisites(t *testing.T) {
	t.Helper()
	require.NotZero(t, os.Geteuid())
	cmd := exec.CommandContext(t.Context(), "go", "test", "-json", "-p", "4", "../../microsandbox", "-count=1", "-run", "^(TestGuestHelperInstallPinsInterpreterAndEnv|TestRootSetupNeverFollowsMemberSymlinks|TestRootPreflightParsesOnlyEnvelope|TestRebaseApprovedRootArtifactSubstitutionRefused)$", "-timeout", "25m")
	// go test executes with the package directory as cwd: ../../microsandbox is
	// the existing package, not an alternate security implementation.
	cmd.Env = append(os.Environ(), "SMITHERS_GUEST_ROOT_BOUNDARY_CHECK=1")
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, "C-SEC-02 prerequisite: %s", out)
	dec := json.NewDecoder(bytes.NewReader(out))
	passed := map[string]bool{}
	for dec.More() {
		var event struct{ Action, Test string }
		require.NoError(t, dec.Decode(&event))
		require.NotEqual(t, "skip", event.Action, "C-SEC-02 skipped %s", event.Test)
		require.NotEqual(t, "fail", event.Action, "C-SEC-02 failed %s", event.Test)
		if event.Action == "pass" {
			passed[event.Test] = true
		}
	}
	for _, name := range []string{"TestGuestHelperInstallPinsInterpreterAndEnv", "TestRootSetupNeverFollowsMemberSymlinks", "TestRootPreflightParsesOnlyEnvelope", "TestRebaseApprovedRootArtifactSubstitutionRefused"} {
		require.True(t, passed[name], "missing C-SEC-02 prerequisite %s", name)
	}
}
