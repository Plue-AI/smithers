package compose

import (
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

	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/stretchr/testify/require"
)

// T-COL-03 / C-DUR-04 K6 uses the existing composed install harness here,
// rather than importing compose from machined (which would create a cycle).
// The approved bundle must contain a debug daemon built with killpoints. No
// checkout binary, helper, script or interpreter is planted or executed as root.
// This campaign never substitutes a process kill for msb force-stop.
func TestMachinedK6VMStop(t *testing.T) {
	testMachinedGuestFaults(t, true, false, false)
}

// Uses the same installed watcher/member cgroups/object store as K6. Guest
// init, rather than the driver, replaces the daemon and cleans up sessions.
func TestMachinedDaemonSessionFaultRecovery(t *testing.T) {
	testMachinedGuestFaults(t, false, false, false)
}

func TestMachinedMemberHostOutageRecovery(t *testing.T) {
	testMachinedGuestFaults(t, false, true, false)
}

func TestMachinedMemberHostCrashRecovery(t *testing.T) {
	testMachinedGuestFaults(t, false, false, true)
}

func testMachinedGuestFaults(t *testing.T, vmStop, hostOutage, hostCrash bool) {
	flag := "SMITHERS_MACHINED_K6_REFERENCE"
	if !vmStop {
		flag = "SMITHERS_MACHINED_SESSION_FAULT_REFERENCE"
	}
	if hostOutage || hostCrash {
		flag = "SMITHERS_MACHINED_HOST_SESSION_REFERENCE"
	}
	if os.Getenv(flag) != "1" {
		t.Skip("reference Mac and approved killpoints qualification bundle required")
	}
	require.Equal(t, "darwin", runtime.GOOS)
	require.Equal(t, "arm64", runtime.GOARCH)
	bundle, err := installbundle.Open(os.Getenv("SMITHERS_CHECK_BUNDLE"))
	require.NoError(t, err)
	if commit := os.Getenv("SMITHERS_REHEARSAL_COMMIT"); commit != "" {
		require.Equal(t, commit, bundle.Revision(), "guest qualification bundle must match the campaign revision")
	}
	t.Setenv(pinnedMicroVMRehearsal, "1")
	r := newRehearsal(t, pinnedMicroVMRehearsal, "C-DUR-04", "k6-")
	if directory := os.Getenv("SMITHERS_REHEARSAL_FAULT_EVIDENCE"); directory != "" {
		require.True(t, filepath.IsAbs(directory))
		data, err := json.Marshal(map[string]string{"directory": r.evidence, "bundle_revision": bundle.Revision(), "bundle_manifest": bundle.ManifestSHA256()})
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(directory, strings.ReplaceAll(t.Name(), "/", "-")+"-guest-evidence.json"), data, 0600))
	}
	vm, ok := r.workspaceRuntime.(*microsandbox.Runtime)
	require.True(t, ok, "K6 must use production CreateWorkspace/StartWorkspace, planting and relay")
	require.True(t, r.install("Install through Machine ready"))
	number, err := r.file("K6 capture canary", "Add a greeting to JOURNEY.md")
	require.NoError(t, err)
	_, err = r.waitTodoWithin(number, 15*time.Minute, "in_review")
	require.NoError(t, err)
	branch, _, err := r.todoHostBinding(number)
	require.NoError(t, err)
	machine, err := vm.WorkspaceMachineIdentity(t.Context(), branch)
	require.NoError(t, err)
	registry := vm.MachinedRegistry()
	msb := bundle.Program("bin/msb")
	msbCall := func(args ...string) ([]byte, error) {
		if err := msb.Check(); err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, msb.Path(), args...)
		command.Env = []string{"HOME=" + os.Getenv("HOME"), "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "MSB_BACKEND=local", "NO_COLOR=1"}
		out, err := command.CombinedOutput()
		if err != nil {
			return out, fmt.Errorf("msb: %w: %s", err, out)
		}
		return out, nil
	}
	// Only the approved base image's setpriv executes privileged. Python and
	// every test-provided byte execute after its fixed machined UID/GID drop.
	control := func(script string) ([]byte, error) {
		return msbCall("exec", machine, "--", "/usr/bin/setpriv", "--reuid=19998", "--regid=20000", "--clear-groups", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "/usr/bin/python3", "-I", "-S", "-c", script)
	}
	evidence := func(name string, value any) {
		t.Helper()
		data, err := json.MarshalIndent(value, "", "  ")
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(r.evidence, name), append(data, '\n'), 0600))
	}
	evidence("k6-env.json", map[string]any{"bundle_revision": bundle.Revision(), "bundle_manifest": bundle.ManifestSHA256(), "host": runtime.GOOS + "/" + runtime.GOARCH, "branch": branch, "machine": machine})
	hostGit := func(args ...string) []byte {
		t.Helper()
		var data []byte
		err := r.options.Repository.WithMachineRepository(t.Context(), "rehearsal-owner", "app", func(store string) error {
			command := hostexec.Git(t.Context(), append([]string{"-C", store}, args...)...)
			var err error
			data, err = command.CombinedOutput()
			return err
		})
		require.NoError(t, err, "%s", data)
		return data
	}
	points := []string{"K1", "K5b"}
	campaign := "k6"
	if !vmStop {
		points = []string{"K1", "K2", "K3", "K3b", "K5a", "K5b", "K5c"}
		campaign = "session"
	}
	if hostOutage || hostCrash {
		points = []string{"K4b"}
		if hostCrash {
			points = []string{"K4"}
		}
		campaign = "host-session"
	}
	for _, point := range points {
		for run := 1; run <= 10; run++ {
			t.Run(fmt.Sprintf("%s/%02d", point, run), func(t *testing.T) {
				if hostOutage || hostCrash {
					if hostCrash {
						testMemberHostCrash(t, r, vm, branch, machine, run, control, evidence, hostGit)
					} else {
						testMemberHostOutage(t, r, vm, branch, run, control, evidence, hostGit)
					}
					return
				}
				prefix := fmt.Sprintf("%s-%s-%02d", campaign, point, run)
				before, err := registry.Capture(t.Context(), branch)
				require.NoError(t, err)
				session, err := r.openBranchTerminal(r.keyed, branch)
				require.NoError(t, err)
				terminal, err := r.openTerminal(session)
				require.NoError(t, err)
				defer terminal.close()
				arm := fmt.Sprintf("/var/lib/smithers-machined/qualification-%s.arm", point)
				hit := fmt.Sprintf("/var/lib/smithers-machined/qualification-%s.hit", point)
				armFault := func() {
					t.Helper()
					out, err := control(fmt.Sprintf("import os\np=%q\ntry: os.unlink(%q)\nexcept FileNotFoundError: pass\nf=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)\nos.fsync(f)\nos.close(f)", arm, hit))
					require.NoError(t, err, "%s", out)
				}
				if !strings.HasPrefix(point, "K5") {
					armFault()
				}
				// Each acknowledgement is printed only after write+fsync+close. The
				// terminal is a real member session in the broker's session cgroup.
				script := fmt.Sprintf("import os,hashlib,json\nfor i in range(20):\n p=%q+'-%%02d.txt'%%i\n b=('acknowledged '+p+'\\n').encode()\n f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)\n assert os.write(f,b)==len(b)\n os.fsync(f)\n os.close(f)\n print(json.dumps({'seq':i,'path':p,'sha256':hashlib.sha256(b).hexdigest()}),flush=True)", prefix)
				quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
				status, writerLog, err := terminal.capture("python3 -I -S -c "+quote(script), "K6DONE", 30*time.Second)
				require.NoError(t, err)
				require.Equal(t, "0", status, "%s", writerLog)
				type written struct {
					Seq    int    `json:"seq"`
					Path   string `json:"path"`
					SHA256 string `json:"sha256"`
				}
				var writes []written
				for _, line := range strings.Split(strings.TrimSpace(string(writerLog)), "\n") {
					var w written
					require.NoError(t, json.Unmarshal([]byte(line), &w))
					writes = append(writes, w)
				}
				require.Len(t, writes, 20)
				evidence(prefix+"-writer.json", writes)
				var captureDone chan error
				if strings.HasPrefix(point, "K5") {
					require.Eventually(t, func() bool {
						var count int
						return r.pool.QueryRow(t.Context(), `SELECT count(*) FROM burst_files WHERE path LIKE $1`, prefix+"-%").Scan(&count) == nil && count == 20
					}, 20*time.Second, 50*time.Millisecond)
					armFault()
					captureDone = make(chan error, 1)
					go func() { _, err := registry.Capture(t.Context(), branch); captureDone <- err }()
				}
				require.Eventually(t, func() bool {
					out, err := control(fmt.Sprintf("from pathlib import Path\np=Path(%q)\nprint(p.read_text() if p.exists() else '')", hit))
					return err == nil && strings.TrimSpace(string(out)) == point
				}, 30*time.Second, 20*time.Millisecond, "approved daemon did not reach %s; release bundles have no qualification holds", point)
				outbox, err := control("import os,json,base64\np='/var/lib/smithers-machined/outbox'\nprint(json.dumps({n:base64.b64encode(open(p+'/'+n,'rb').read()).decode() for n in os.listdir(p) if n.endswith('.ev')}))")
				require.NoError(t, err)
				var queued map[string]string
				require.NoError(t, json.Unmarshal(outbox, &queued))
				evidence(prefix+"-outbox-at-stop.json", queued)
				killedLink, err := registry.Current(branch)
				require.NoError(t, err)
				if vmStop {
					out, err := msbCall("stop", "-t", "0", "-q", machine)
					require.NoError(t, err, "%s", out)
				} else {
					out, err := control(fmt.Sprintf("import os\np=%q\nf=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)\nos.fsync(f)\nos.close(f)", "/var/lib/smithers-machined/qualification-"+point+".exit"))
					require.NoError(t, err, "%s", out)
				}
				if captureDone != nil {
					select {
					case err := <-captureDone:
						require.Error(t, err)
					case <-time.After(35 * time.Second):
						t.Fatal("capture did not observe VM stop")
					}
				}
				// A published head must name a real host object even before reconciliation.
				atStop := strings.TrimSpace(string(hostGit("rev-parse", "refs/smithers/branches/"+branch+"/head")))
				hostGit("cat-file", "-e", atStop+"^{commit}")
				if vmStop {
					_, err = vm.StartWorkspace(t.Context(), branch)
					require.NoError(t, err)
					require.NoError(t, vm.EnsureMachined(t.Context(), branch))
				} else {
					require.Eventually(t, func() bool {
						link, err := registry.Current(branch)
						return err == nil && link != killedLink && link.RequireReady(branch) == nil
					}, 10*time.Second, 25*time.Millisecond, "guest init and host reconnect must recover without manual wake")
					select {
					case <-terminal.closed:
					case <-time.After(5 * time.Second):
						t.Fatal("old member terminal survived daemon replacement")
					}
					// Opening a new terminal proves admission after automatic
					// cleanup/reconciliation, rather than only a status bit.
					next, err := r.openBranchTerminal(r.keyed, branch)
					require.NoError(t, err)
					probe, err := r.openTerminal(next)
					require.NoError(t, err)
					status, output, err := probe.capture("id -u", "RECOVERED", 10*time.Second)
					probe.close()
					require.NoError(t, err)
					require.Equal(t, "0", status)
					require.NotEqual(t, "0", strings.TrimSpace(string(output)))
					require.NotEqual(t, "19998", strings.TrimSpace(string(output)))
					evidence(prefix+"-recovered-member.json", map[string]any{"uid": strings.TrimSpace(string(output))})
				}
				// Capture waits for ready and an empty outbox outside the mutation lock.
				after, err := registry.Capture(t.Context(), branch)
				require.NoError(t, err)
				require.True(t, atStop == before.Head || atStop == after.Head, "VM stop exposed an unrelated head")
				drained, err := control("import os,json\nprint(json.dumps([n for n in os.listdir('/var/lib/smithers-machined/outbox') if n.endswith('.ev')]))")
				require.NoError(t, err)
				var remaining []string
				require.NoError(t, json.Unmarshal(drained, &remaining))
				require.Empty(t, remaining)
				evidence(prefix+"-outbox-after-wake.json", remaining)
				require.Equal(t, after.Head, strings.TrimSpace(string(hostGit("rev-parse", "refs/smithers/branches/"+branch+"/head"))))
				for i, w := range writes {
					require.Equal(t, i, w.Seq)
					require.Equal(t, fmt.Sprintf("%s-%02d.txt", prefix, i), w.Path)
					expected := []byte("acknowledged " + w.Path + "\n")
					digest := sha256.Sum256(expected)
					require.Equal(t, hex.EncodeToString(digest[:]), w.SHA256)
					require.Equal(t, expected, hostGit("show", after.Head+":"+w.Path))
					code, raw, err := r.request("GET", "/api/repos/rehearsal-owner/app/workspaces/"+branch+"/files/content?path="+url.QueryEscape(w.Path), "")
					require.NoError(t, err)
					require.Equal(t, 200, code, "%s", raw)
					var file struct{ Content, Digest string }
					require.NoError(t, json.Unmarshal(raw, &file))
					require.Equal(t, string(expected), file.Content)
					require.Equal(t, w.SHA256, file.Digest)
					var count int
					var post string
					require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT count(*),min(post_digest) FROM burst_files WHERE path=$1`, w.Path).Scan(&count, &post))
					require.Equal(t, 1, count, "one activity file across restart/replay")
					require.Equal(t, w.SHA256, post)
					var versions, burst, afterBlob string
					require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT e.data->>'versions',e.data->>'id',f.after_blob FROM burst_files f JOIN product_job_events e ON e.event_id=f.event_id WHERE f.path=$1`, w.Path).Scan(&versions, &burst, &afterBlob))
					require.Equal(t, versions, strings.TrimSpace(string(hostGit("rev-parse", "refs/smithers/branches/"+branch+"/bursts/"+burst))))
					require.Equal(t, expected, hostGit("show", versions+":b/"+w.Path))
					require.Equal(t, expected, hostGit("cat-file", "blob", afterBlob))
				}
				var receipts []byte
				require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]') FROM machine_event_receipts r WHERE workspace_id=$1`, branch).Scan(&receipts))
				evidence(prefix+"-receipts.json", json.RawMessage(receipts))
				var activity []byte
				require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT COALESCE(jsonb_agg(to_jsonb(f)),'[]') FROM burst_files f WHERE path LIKE $1`, prefix+"-%").Scan(&activity))
				evidence(prefix+"-files.json", json.RawMessage(activity))
				var facts []byte
				require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT COALESCE(jsonb_agg(to_jsonb(e)),'[]') FROM product_job_events e WHERE e.data->>'branch'=$1`, branch).Scan(&facts))
				evidence(prefix+"-activity.json", json.RawMessage(facts))
				evidence(prefix+"-heads.json", map[string]any{"before": before, "at_stop": atStop, "after": after})
			})
		}
	}
}
