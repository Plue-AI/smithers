package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The parent owns the approved VM and HTTP install. The child owns the actual
// authenticated event consumer and transaction: exit cannot run its cleanup or
// send an ACK. No synthetic frames, roster or member processes are supplied.
func testMemberHostCrash(t *testing.T, r *rehearsal, vm *microsandbox.Runtime, branch, machine string, run int,
	control func(string) ([]byte, error), evidence func(string, any), hostGit func(...string) []byte) {
	registry := vm.MachinedRegistry()
	prefix := fmt.Sprintf("host-session-K4-%02d", run)
	before, err := registry.Capture(t.Context(), branch)
	require.NoError(t, err)
	session, err := r.openBranchTerminal(r.keyed, branch)
	require.NoError(t, err)
	terminal, err := r.openTerminal(session)
	require.NoError(t, err)
	defer terminal.close()
	logPath, gate := "/tmp/"+prefix+"-writer.jsonl", "/tmp/"+prefix+"-go"
	script := fmt.Sprintf(`import os,time,json,hashlib
with open(%q+'.process','x') as f: f.write(json.dumps({'pid':os.getpid(),'uid':os.getuid(),'cgroup':open('/proc/self/cgroup').read()}))
with open(%q,'x') as log:
 while not os.path.exists(%q): time.sleep(.01)
 for i in range(20):
  p=%q+'-%%02d.txt'%%i
  b=('acknowledged '+p+'\n').encode()
  f=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o644)
  assert os.write(f,b)==len(b)
  os.fsync(f); os.close(f)
  log.write(json.dumps({'seq':i,'path':p,'sha256':hashlib.sha256(b).hexdigest()})+'\n')
  log.flush(); os.fsync(log.fileno())
 while not os.path.exists(%q+'.done'): time.sleep(.01)
`, logPath, logPath, gate, prefix, gate)
	done := make(chan error, 1)
	go func() {
		_, _, err := terminal.capture("python3 -I -S -c '"+strings.ReplaceAll(script, "'", "'\"'\"'")+"'", "K4DONE", 180*time.Second)
		done <- err
	}()
	require.Eventually(t, func() bool {
		out, err := control(fmt.Sprintf("import os\nprint(os.path.exists(%q))", logPath))
		return err == nil && strings.TrimSpace(string(out)) == "True"
	}, 10*time.Second, 25*time.Millisecond)
	raw, err := control(fmt.Sprintf("print(open(%q+'.process').read(),end='')", logPath))
	require.NoError(t, err)
	var member struct {
		PID, UID int
		Cgroup   string
	}
	require.NoError(t, json.Unmarshal(raw, &member))
	require.GreaterOrEqual(t, member.UID, 20000)
	require.Contains(t, member.Cgroup, "/smithers/sessions/")
	evidence(prefix+"-member.json", member)
	// Read only the protected runtime boot, as machined, never a branch path.
	raw, err = control("print(open('/run/smithers/machined/boot').read(),end='')")
	require.NoError(t, err)
	var authority machined.BootAuthority
	for _, line := range strings.Split(string(raw), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch key {
		case "boot_id":
			b, e := hex.DecodeString(value)
			require.NoError(t, e)
			require.Len(t, b, 16)
			copy(authority.ID[:], b)
		case "relay_secret":
			b, e := hex.DecodeString(value)
			require.NoError(t, e)
			require.Len(t, b, 32)
			copy(authority.Secret[:], b)
		case "credential":
			authority.Credential = value
		}
	}
	private := t.TempDir()
	config := outsideFaultHostConfig{Database: r.pool.Config().ConnString(), Branch: branch, Machine: machine, Owner: "rehearsal-owner", Authority: authority, Head: before.Head, Ready: filepath.Join(private, "ready"), Crash: true, RetainSessions: true, Evidence: r.evidence}
	require.NoError(t, r.options.Repository.WithMachineRepository(t.Context(), "rehearsal-owner", "app", func(store string) error {
		// store = <storage>/<owner>/<repo>/.jj/repo/store/git
		config.Storage = filepath.Clean(filepath.Join(store, "../../../../../.."))
		return nil
	}))
	reconnect := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(reconnect) }) }
	defer release()
	head := machineBranchHead(r.pool, r.options.Repository)
	vm.BindMachinedHost(func(ctx context.Context, id string) (string, error) {
		if id == branch {
			select {
			case <-reconnect:
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}
		return head(ctx, id)
	})
	defer vm.BindMachinedHost(head)
	link, err := registry.Current(branch)
	require.NoError(t, err)
	require.NoError(t, link.Close())
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer listener.Close()
	config.Endpoint = listener.Addr().String()
	relayDone := make(chan error, 1)
	go func() {
		host, e := listener.Accept()
		if e != nil {
			relayDone <- e
			return
		}
		defer host.Close()
		guest, e := vm.DialWorkspacePort(t.Context(), branch, workspaceapi.PortRequest{Port: 970, Purpose: workspaceapi.PortPurposeFlowRuntime})
		if e != nil {
			relayDone <- e
			return
		}
		defer guest.Close()
		copied := make(chan struct{})
		go func() { _, _ = io.Copy(guest, host); _ = guest.Close(); close(copied) }()
		_, e = io.Copy(host, guest)
		_ = host.Close()
		<-copied
		relayDone <- e
	}()
	data, err := json.Marshal(config)
	require.NoError(t, err)
	cfg := filepath.Join(private, "authority.json")
	require.NoError(t, os.WriteFile(cfg, data, 0600))
	child := exec.CommandContext(t.Context(), os.Args[0], "-test.run=^TestOutsideWatcherHostProcessChild$", "-test.v")
	child.Env = append(os.Environ(), "SMITHERS_OUTSIDE_HOST_CONFIG="+cfg)
	log, err := os.OpenFile(filepath.Join(r.evidence, prefix+"-host.log"), os.O_CREATE|os.O_WRONLY, 0600)
	require.NoError(t, err)
	defer log.Close()
	child.Stdout, child.Stderr = log, log
	require.NoError(t, child.Start())
	exited := make(chan error, 1)
	go func() { exited <- child.Wait(); close(exited) }()
	defer func() {
		_ = child.Process.Kill()
		select {
		case <-exited:
		case <-time.After(5 * time.Second):
			t.Error("host child was not reaped")
		}
	}()
	require.Eventually(t, func() bool { _, e := os.Stat(config.Ready); return e == nil }, 40*time.Second, 25*time.Millisecond)
	out, err := control(fmt.Sprintf("import os\nf=os.open(%q,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o644)\nos.close(f)", gate))
	require.NoError(t, err, "%s", out)
	require.Eventually(t, func() bool {
		out, e := control(fmt.Sprintf("print(len(open(%q).read().splitlines()))", logPath))
		return e == nil && strings.TrimSpace(string(out)) == "20"
	}, 15*time.Second, 25*time.Millisecond)
	select {
	case err := <-exited:
		var exit *exec.ExitError
		require.ErrorAs(t, err, &exit)
		require.Equal(t, 73, exit.ExitCode())
	case <-time.After(30 * time.Second):
		t.Fatal("host never exited after commit before ACK")
	}
	var rows int
	require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT count(*) FROM burst_files WHERE path LIKE $1`, prefix+"-%").Scan(&rows))
	require.Positive(t, rows)
	require.LessOrEqual(t, rows, 20)
	out, err = control(fmt.Sprintf("import os,json,base64\nassert os.path.exists('/proc/%%d'%%%d)\np='/var/lib/smithers-machined/outbox'\nprint(json.dumps({n:base64.b64encode(open(p+'/'+n,'rb').read()).decode() for n in os.listdir(p) if n.endswith('.ev')}))", member.PID))
	require.NoError(t, err)
	var queued map[string]string
	require.NoError(t, json.Unmarshal(out, &queued))
	require.NotEmpty(t, queued)
	evidence(prefix+"-outbox-at-crash.json", queued)
	evidence(prefix+"-crash.json", map[string]any{"host_pid": child.Process.Pid, "exit_code": 73, "committed_files_before_ack": rows, "member_pid": member.PID})
	release()
	require.Eventually(t, func() bool {
		next, e := registry.Current(branch)
		return e == nil && next != link && next.RequireReady(branch) == nil
	}, 45*time.Second, 25*time.Millisecond)
	after, err := registry.Capture(t.Context(), branch)
	require.NoError(t, err)
	terminal.close()
	resumed, err := r.openTerminal(session)
	require.NoError(t, err)
	out, err = control(fmt.Sprintf("import os\nf=os.open(%q+'.done',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o644)\nos.close(f)", gate))
	require.NoError(t, err, "%s", out)
	status, output, err := resumed.capture("id -u", "K4READY", 15*time.Second)
	resumed.close()
	require.NoError(t, err)
	require.Equal(t, "0", status)
	require.Equal(t, fmt.Sprint(member.UID), strings.TrimSpace(string(output)))
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("old terminal consumer did not finish")
	}
	raw, err = control(fmt.Sprintf("print(open(%q).read(),end='')", logPath))
	require.NoError(t, err)
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	require.Len(t, lines, 20)
	for i, line := range lines {
		var written struct {
			Seq          int
			Path, SHA256 string
		}
		require.NoError(t, json.Unmarshal([]byte(line), &written))
		path := fmt.Sprintf("%s-%02d.txt", prefix, i)
		bytes := []byte("acknowledged " + path + "\n")
		digest := sha256.Sum256(bytes)
		require.Equal(t, i, written.Seq)
		require.Equal(t, path, written.Path)
		require.Equal(t, hex.EncodeToString(digest[:]), written.SHA256)
		require.Equal(t, bytes, hostGit("show", after.Head+":"+path))
		code, body, e := r.request("GET", "/api/repos/rehearsal-owner/app/workspaces/"+branch+"/files/content?path="+url.QueryEscape(path), "")
		require.NoError(t, e)
		require.Equal(t, 200, code)
		var file struct{ Content, Digest string }
		require.NoError(t, json.Unmarshal(body, &file))
		require.Equal(t, string(bytes), file.Content)
		require.Equal(t, written.SHA256, file.Digest)
		var count int
		var post, versions, burst, blob string
		require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT count(*),min(post_digest) FROM burst_files WHERE path=$1`, path).Scan(&count, &post))
		require.Equal(t, 1, count)
		require.Equal(t, written.SHA256, post)
		require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT e.data->>'versions',e.data->>'id',f.after_blob FROM burst_files f JOIN product_job_events e ON e.event_id=f.event_id WHERE f.path=$1`, path).Scan(&versions, &burst, &blob))
		require.Equal(t, bytes, hostGit("show", versions+":b/"+path))
		require.Equal(t, bytes, hostGit("cat-file", "blob", blob))
		require.Equal(t, versions, strings.TrimSpace(string(hostGit("rev-parse", "refs/smithers/branches/"+branch+"/bursts/"+burst))))
	}
	out, err = control("import os,json\nprint(json.dumps([n for n in os.listdir('/var/lib/smithers-machined/outbox') if n.endswith('.ev')]))")
	require.NoError(t, err)
	var remaining []string
	require.NoError(t, json.Unmarshal(out, &remaining))
	require.Empty(t, remaining)
	for _, table := range []string{"machine_event_receipts", "product_job_events", "burst_files"} {
		var rows []byte
		require.NoError(t, r.pool.QueryRow(t.Context(), "SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]') FROM "+table+" r").Scan(&rows))
		evidence(prefix+"-"+table+".json", json.RawMessage(rows))
	}
	evidence(prefix+"-writer.jsonl", string(raw))
	evidence(prefix+"-heads.json", map[string]any{"before": before, "after": after})
	evidence(prefix+"-outbox-after.json", remaining)
}
