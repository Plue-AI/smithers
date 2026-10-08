package compose

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/stretchr/testify/require"
)

// The W1-W4 preservation campaign enters the composed browser file door and
// authenticated broker sessions on a production-created microVM. It covers the
// fifty rewrites and ten Return cycles, including a real kernel frozen barrier. It also queues W1/W2 stale and fresh saves. Freeze timeout, swap races and
// ACK delay remain separate requirements; this test does not claim them.
// The bundle is install-controlled; no checkout program executes as root.
func TestMachinedMutationWriterPreservation(t *testing.T) {
	if os.Getenv("SMITHERS_MACHINED_WRITER_REFERENCE") != "1" {
		t.Skip("reference Mac and approved installed bundle required for W1-W4")
	}
	require.Equal(t, "darwin", runtime.GOOS)
	require.Equal(t, "arm64", runtime.GOARCH)
	bundle, err := installbundle.Open(os.Getenv("SMITHERS_CHECK_BUNDLE"))
	require.NoError(t, err)
	t.Setenv(pinnedMicroVMRehearsal, "1")
	r := newRehearsal(t, pinnedMicroVMRehearsal, "C-COL-03", "writers-")
	require.False(t, r.options.LiveCodeDocuments, "reference drivers never activate product documents")
	vm, ok := r.workspaceRuntime.(*microsandbox.Runtime)
	require.True(t, ok)
	require.True(t, r.install("Install through Machine ready"))
	number, err := r.file("Concurrent writer canary", "Add a greeting to JOURNEY.md")
	require.NoError(t, err)
	_, err = r.waitTodoWithin(number, 15*time.Minute, "in_review")
	require.NoError(t, err)
	branch, _, err := r.todoHostBinding(number)
	require.NoError(t, err)
	registry := vm.MachinedRegistry()
	link, err := registry.Current(branch)
	require.NoError(t, err)
	row, err := db.New(r.pool).GetWorkspace(t.Context(), branch)
	require.NoError(t, err)
	member, err := db.New(r.pool).GetSelfHostOwner(t.Context())
	require.NoError(t, err)
	var user machined.SessionUser
	require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT unix_login,unix_uid FROM collaborators WHERE repository_id=$1 AND user_id=$2`, row.RepositoryID, member.ID).Scan(&user.Login, &user.UID))
	person, err := machined.CommitActor(t.Context(), r.pool, branch, link.Machine(), func(context.Context, pgx.Tx) (machined.ActorIdentity, error) {
		return machined.ActorIdentity{Kind: "person", MemberID: member.ID, Via: "terminal"}, nil
	})
	require.NoError(t, err)
	run := uuid.NewString()
	agent, err := machined.CommitActor(t.Context(), r.pool, branch, link.Machine(), func(context.Context, pgx.Tx) (machined.ActorIdentity, error) {
		return machined.ActorIdentity{Kind: "agent", MemberID: member.ID, Via: "agent", AgentKind: "coding", Run: run}, nil
	})
	require.NoError(t, err)
	sessions := machined.NewSessions(link.Connection, branch, registry.Sessions(branch)).WithActor(person, "")
	coding := sessions.WithActor(agent, run)
	type logged struct{ Writer, Path, SHA256 string }
	var mu sync.Mutex
	var writes []logged
	var failures []error
	appendWrite := func(w logged) { mu.Lock(); writes = append(writes, w); mu.Unlock() }
	fail := func(err error) { mu.Lock(); failures = append(failures, err); mu.Unlock() }
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Minute)
	defer cancel()
	// One stream per writer, kept alive across all rebase cycles. Agent input is
	// held until register_run commits its production broker admission.
	script := func(writer string) string {
		return fmt.Sprintf(`import os,sys,time,json,hashlib,subprocess,select
sys.stdin.buffer.readline()
i=0
while i<20000:
 if select.select([sys.stdin],[],[],0)[0]:
  sys.stdin.buffer.readline();break
 p='col03-%%s-%%04d.txt'%%(%q,i)
 b=('acknowledged '+p+'\n').encode()
 if %q=='W2':
  c=subprocess.run(['/opt/smithers/bin/smithers-machined','client','write-file',p,'--base','absent'],input=b,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  if c.returncode:
   failure=json.loads(c.stdout)
   if failure.get('error',{}).get('code')=='moved_off':
    time.sleep(.1);continue
   raise RuntimeError(c.stdout.decode()+c.stderr.decode())
 else:
  temp=p+'.swap' if %q=='W4' else p
  f=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o664)
  assert os.write(f,b)==len(b)
  os.fsync(f)
  os.close(f)
  if temp!=p:
   os.replace(temp,p)
   d=os.open('.',os.O_RDONLY|os.O_DIRECTORY);os.fsync(d);os.close(d)
 print(json.dumps({'Writer':%q,'Path':p,'SHA256':hashlib.sha256(b).hexdigest()}),flush=True)
 i+=1
 time.sleep(.1)
`, writer, writer, writer, writer)
	}
	var executions []*machined.Exec
	var readers sync.WaitGroup
	startWriter := func(writer string, s *machined.Sessions, identity machined.SessionUser) {
		t.Helper()
		e, err := s.OpenExec(ctx, identity, []string{"/usr/bin/python3", "-I", "-S", "-c", script(writer)})
		require.NoError(t, err)
		executions = append(executions, e)
		t.Cleanup(func() {
			cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			_ = e.Kill(cleanup)
		})
		readers.Add(2)
		go func() {
			defer readers.Done()
			scanner := bufio.NewScanner(e.Stdout())
			for scanner.Scan() {
				var w logged
				if err := json.Unmarshal(scanner.Bytes(), &w); err != nil {
					fail(err)
					continue
				}
				expected := sha256.Sum256([]byte("acknowledged " + w.Path + "\n"))
				if w.Writer != writer || w.SHA256 != hex.EncodeToString(expected[:]) {
					fail(fmt.Errorf("invalid %s writer log: %s", writer, scanner.Text()))
					continue
				}
				appendWrite(w)
			}
			if err := scanner.Err(); err != nil {
				fail(err)
			}
		}()
		go func() {
			defer readers.Done()
			b, err := io.ReadAll(e.Stderr())
			if err != nil {
				fail(err)
			}
			if len(b) > 0 {
				fail(fmt.Errorf("%s stderr: %s", writer, b))
			}
		}()
		if writer == "W2" {
			require.NoError(t, coding.RegisterRun(ctx, run, e.ID()))
		}
		_, err = e.Write([]byte("start\n"))
		require.NoError(t, err)
	}
	// The composed canary starts with JOURNEY.md, not README.md. Establish
	// a fixed stale-save fixture through the browser door before the writers.
	const originalReadme = "col03 original README\n"
	initialBody, err := json.Marshal(map[string]string{"content": originalReadme, "base_digest": "absent"})
	require.NoError(t, err)
	initialCode, initialData, err := r.keyed("PUT", "/api/repos/rehearsal-owner/app/workspaces/"+branch+"/files/content?path=README.md", string(initialBody), uuid.NewString())
	require.NoError(t, err)
	require.Equal(t, 200, initialCode, "%s", initialData)
	_, err = registry.Capture(ctx, branch)
	if err == machined.ErrNotReady {
		require.Eventually(t, func() bool {
			bursts, docs, err := registry.IdleSafety(ctx, branch)
			return err == nil && bursts && docs
		}, 10*time.Second, 10*time.Millisecond)
		_, err = registry.Capture(ctx, branch)
	}
	require.NoError(t, err)
	// Qualify all four existing production write doors against the same open
	// document before the concurrent file campaign. The reader stays open
	// throughout fifty rewrites and ten Returns; no product flag is enabled.
	livePath := "col03-live.ts"
	liveText := "LIVE 🧑🏽‍💻 e\u0301 漢字\n"
	putLive := func(base, content string, status int) {
		t.Helper()
		body, err := json.Marshal(map[string]string{"content": content, "base_digest": base})
		require.NoError(t, err)
		code, data, err := r.keyed("PUT", "/api/repos/rehearsal-owner/app/workspaces/"+branch+"/files/content?path="+livePath, string(body), uuid.NewString())
		require.NoError(t, err)
		require.Equal(t, status, code, "%s", data)
	}
	putLive("absent", liveText, 200)
	live := openLiveWriterProbe(t, registry, branch, livePath, person)
	live.converge(t, liveText)
	logLive := func(writer string) {
		t.Helper()
		live.converge(t, liveText)
		file, err := registry.ReadFile(ctx, branch, livePath, "")
		require.NoError(t, err)
		require.Equal(t, liveText, string(file.Content))
		sum := sha256.Sum256([]byte(liveText))
		appendWrite(logged{writer, livePath, hex.EncodeToString(sum[:])})
	}
	base, err := registry.ReadFile(ctx, branch, livePath, "")
	require.NoError(t, err)
	liveText += "W1 browser\n"
	putLive(base.Digest, liveText, 200)
	logLive("W1")
	putLive(base.Digest, "STALE OPEN DOCUMENT MUST NOT LAND", 409)
	// W2 uses the installed local client after real register_run admission.
	// W3/W4 use real member broker sessions and in-place/atomic disk writes.
	for _, writer := range []string{"W2", "W3", "W4"} {
		base, err := registry.ReadFile(ctx, branch, livePath, "")
		require.NoError(t, err)
		liveText += writer + " registered writer\n"
		payload := fmt.Sprintf(`import os,sys,subprocess
sys.stdin.buffer.readline()
p=%q
b=%q.encode()
`, livePath, liveText)
		identity, provider := user, sessions
		if writer == "W2" {
			identity, provider = machined.SessionUser{Login: "agent", UID: 19999}, coding
			payload += fmt.Sprintf(`c=subprocess.run(['/opt/smithers/bin/smithers-machined','client','write-file',p,'--base',%q],input=b,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
assert c.returncode==0,(c.stdout,c.stderr)
`, base.Digest)
		} else {
			if writer == "W4" {
				provider = sessions.WithPresenceVia("ssh")
			}
			payload += fmt.Sprintf(`target=p+'.swap' if %q=='W4' else p
f=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o664)
assert os.write(f,b)==len(b)
os.fsync(f);os.close(f)
if target!=p:
 os.replace(target,p)
 d=os.open('.',os.O_RDONLY|os.O_DIRECTORY);os.fsync(d);os.close(d)
`, writer)
		}
		payload += "print('WRITTEN',flush=True)\n"
		process, err := provider.OpenExec(ctx, identity, []string{"/usr/bin/python3", "-I", "-S", "-c", payload})
		require.NoError(t, err)
		t.Cleanup(func() { _ = process.Close() })
		if writer == "W2" {
			require.NoError(t, coding.RegisterRun(ctx, run, process.ID()))
		}
		_, err = process.Write([]byte("write\n"))
		require.NoError(t, err)
		require.NoError(t, process.CloseWrite())
		stdout, err := io.ReadAll(process.Stdout())
		require.NoError(t, err)
		require.NoError(t, process.Wait())
		stderr, err := io.ReadAll(process.Stderr())
		require.NoError(t, err)
		require.Empty(t, stderr)
		require.Equal(t, "WRITTEN\n", string(stdout))
		require.NoError(t, process.Close())
		logLive(writer)
	}
	startWriter("W2", coding, machined.SessionUser{Login: "agent", UID: 19999})
	// SessionExec is the same broker cgroup used by a member terminal/SSH
	// process. W3 uses direct writes and W4 the editor's atomic replacement.
	startWriter("W3", sessions, user)
	startWriter("W4", sessions.WithPresenceVia("ssh"), user)
	var browserOnItem sync.Mutex
	stopWriters := make(chan struct{})
	var httpWriters sync.WaitGroup
	httpWriters.Add(1)
	go func() {
		defer httpWriters.Done()
		for i := 0; i < 20000; i++ {
			select {
			case <-stopWriters:
				return
			default:
			}
			p := fmt.Sprintf("col03-W1-%04d.txt", i)
			content := "acknowledged " + p + "\n"
			body, _ := json.Marshal(map[string]string{"content": content, "base_digest": "absent"})
			browserOnItem.Lock()
			code, data, err := r.keyed("PUT", "/api/repos/rehearsal-owner/app/workspaces/"+branch+"/files/content?path="+url.QueryEscape(p), string(body), uuid.NewString())
			browserOnItem.Unlock()
			if err != nil || code != 200 {
				fail(fmt.Errorf("W1 HTTP %d: %v %s", code, err, data))
				return
			}
			sum := sha256.Sum256([]byte(content))
			appendWrite(logged{"W1", p, hex.EncodeToString(sum[:])})
			select {
			case <-ctx.Done():
				return
			case <-stopWriters:
				return
			case <-time.After(100 * time.Millisecond):
			}
		}
	}()
	// Ensure every writer has acknowledged data before the first rewrite.
	require.Eventually(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		seen := map[string]bool{}
		for _, w := range writes {
			seen[w.Writer] = true
		}
		return len(seen) == 4
	}, 30*time.Second, 10*time.Millisecond)
	machine, err := vm.WorkspaceMachineIdentity(ctx, branch)
	require.NoError(t, err)
	// The observer stays outside the member-session parent. Only the approved
	// base-image setpriv runs privileged; all qualification bytes run as machined.
	control := func(script string) []byte {
		t.Helper()
		msb := bundle.Program("bin/msb")
		require.NoError(t, msb.Check())
		command := exec.CommandContext(ctx, msb.Path(), "exec", machine, "--", "/usr/bin/setpriv", "--reuid=19998", "--regid=20000", "--clear-groups", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "/usr/bin/python3", "-I", "-S", "-c", script)
		command.Env = []string{"HOME=" + os.Getenv("HOME"), "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "MSB_BACKEND=local", "NO_COLOR=1"}
		out, err := command.CombinedOutput()
		require.NoError(t, err, "%s", out)
		return out
	}
	// A registered local W2 sender must enqueue before its cgroup freezes.
	// The pre-freeze barrier keeps rebase at the head of the same production FIFO.
	readme, err := registry.ReadFile(ctx, branch, "README.md", "")
	require.NoError(t, err)
	require.Equal(t, originalReadme, string(readme.Content))
	originalDigest := sha256.Sum256([]byte(originalReadme))
	require.Equal(t, hex.EncodeToString(originalDigest[:]), readme.Digest)
	newReadme := "col03 changed README before rewrite\n"
	body, err := json.Marshal(map[string]string{"content": newReadme, "base_digest": readme.Digest})
	require.NoError(t, err)
	code, data, err := r.keyed("PUT", "/api/repos/rehearsal-owner/app/workspaces/"+branch+"/files/content?path=README.md", string(body), uuid.NewString())
	require.NoError(t, err)
	require.Equal(t, 200, code, "%s", data)
	localFrame := func(path, base, content string) string {
		t.Helper()
		digest := wire.Union(2)
		if base != "absent" {
			bytes, err := hex.DecodeString(base)
			require.NoError(t, err)
			digest = wire.Union(1, wire.Field(1, bytes))
		}
		bytes, err := wire.EncodeLocal(wire.Frame{Kind: wire.Control, Payload: wire.Union(1,
			wire.Field(1, wire.U32(1)), wire.Field(2, wire.Union(3,
				wire.Field(1, wire.String(path)), wire.Field(2, digest), wire.Field(3, wire.Bytes([]byte(content))))))})
		require.NoError(t, err)
		return hex.EncodeToString(bytes)
	}
	queuedScript := fmt.Sprintf(`import sys,socket,struct
sys.stdin.buffer.readline()
sockets=[]
for packet in [%q,%q]:
 s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
 s.connect('/run/smithers/machined.sock')
 s.sendall(bytes.fromhex(packet));sockets.append(s)
print('sent',flush=True)
def read(s,n):
 b=b''
 while len(b)<n:
  part=s.recv(n-len(b))
  if not part: raise RuntimeError('closed local response')
  b+=part
 return b
for s in sockets:
 header=read(s,9)
 packet=header+read(s,struct.unpack('>I',header[:4])[0])
 print(packet.hex(),flush=True)
 s.close()
`, localFrame("README.md", readme.Digest, "stale must never land\n"), localFrame("col03-queued-W2.txt", "absent", "queued W2 fresh\n"))
	queued, err := coding.OpenExec(ctx, machined.SessionUser{Login: "agent", UID: 19999}, []string{"/usr/bin/python3", "-I", "-S", "-c", queuedScript})
	require.NoError(t, err)
	require.NoError(t, coding.RegisterRun(ctx, run, queued.ID()))
	t.Cleanup(func() { _ = queued.Close() })
	queuedReplies := make(chan string, 4)
	go func() {
		defer close(queuedReplies)
		scanner := bufio.NewScanner(queued.Stdout())
		for scanner.Scan() {
			queuedReplies <- scanner.Text()
		}
	}()
	control(`from pathlib import Path
Path('/var/lib/smithers-machined/mutation-holds.jsonl').unlink(missing_ok=True)`)
	control(`import os
p='/var/lib/smithers-machined/qualification-freeze-start.arm'
f=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
os.fsync(f);os.close(f)`)
	control(`import os
p='/var/lib/smithers-machined/qualification-frozen.arm'
f=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
os.fsync(f);os.close(f)`)
	type queuedHTTPReply struct {
		status int
		data   []byte
		err    error
	}
	queuedHTTP := make(chan queuedHTTPReply, 2)
	var freezeEvidence json.RawMessage
	var rewriteTimes []int64
	for i := 0; i < 50; i++ {
		began := time.Now()
		done := make(chan error, 1)
		go func() { _, err := registry.Rebase(ctx, branch, person, r.mainCommit); done <- err }()
		if i == 0 {
			require.Eventually(t, func() bool {
				return strings.TrimSpace(string(control(`from pathlib import Path
p=Path('/var/lib/smithers-machined/qualification-freeze-start.hit')
print(p.read_text() if p.exists() else '')`))) == "freeze-start"
			}, 20*time.Second, 20*time.Millisecond)
			_, err = queued.Write([]byte("send\n"))
			require.NoError(t, err)
			select {
			case reply := <-queuedHTTP:
				t.Fatalf("W1 returned during frozen hold: HTTP %d %s %v", reply.status, reply.data, reply.err)
			default:
			}
			select {
			case line := <-queuedReplies:
				require.Equal(t, "sent", line)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			control(`import os
os.unlink('/var/lib/smithers-machined/qualification-freeze-start.hit')`)
			require.Eventually(t, func() bool {
				out := control(`from pathlib import Path
p=Path('/var/lib/smithers-machined/qualification-frozen.hit')
print(p.read_text() if p.exists() else '')`)
				return strings.TrimSpace(string(out)) == "frozen"
			}, 20*time.Second, 20*time.Millisecond)
			// Browser saves enter the authenticated production file route while
			// frozen. The local W2 sender entered before the kernel stopped it.
			for _, save := range []struct{ path, base, content string }{
				{"README.md", readme.Digest, "stale browser must never land\n"},
				{"col03-queued-W1.txt", "absent", "queued W1 fresh\n"},
			} {
				go func(path, base, content string) {
					body, err := json.Marshal(map[string]string{"content": content, "base_digest": base})
					if err != nil {
						queuedHTTP <- queuedHTTPReply{err: err}
						return
					}
					code, data, err := r.keyed("PUT", "/api/repos/rehearsal-owner/app/workspaces/"+branch+"/files/content?path="+url.QueryEscape(path), string(body), uuid.NewString())
					queuedHTTP <- queuedHTTPReply{code, data, err}
				}(save.path, save.base, save.content)
			}
			// Observe actual inotify while W1 continues sending authenticated
			// requests and the registered W2/W3/W4 processes remain alive. The
			// observer is not frozen, so silence cannot be a frozen-reader artifact.
			freezeEvidence = control(`import ctypes,os,select,struct,time,json
assert 'frozen 1' in open('/sys/fs/cgroup/smithers/sessions/cgroup.events').read().splitlines()
lib=ctypes.CDLL(None,use_errno=True)
fd=lib.inotify_init1(os.O_NONBLOCK|os.O_CLOEXEC)
assert fd>=0
watches={}
for directory,children,files in os.walk('/workspace',followlinks=False):
 children[:]=[name for name in children if name not in ('.git','.jj') and not os.path.islink(os.path.join(directory,name))]
 wd=lib.inotify_add_watch(fd,os.fsencode(directory),0x100|0x2|0x4|0x8|0x40|0x80|0x200|0x400|0x800|0x1000000|0x2000000)
 assert wd>=0
 watches[wd]=os.path.relpath(directory,'/workspace')
start=time.monotonic_ns();events=[]
while time.monotonic_ns()-start<500000000:
 if not select.select([fd],[],[],.02)[0]: continue
 data=os.read(fd,65536);offset=0
 while offset<len(data):
  wd,mask,cookie,n=struct.unpack_from('iIII',data,offset)
  name=data[offset+16:offset+16+n].split(b'\0',1)[0].decode()
  offset+=16+n
  events.append({'directory':watches.get(wd,'unknown'),'name':name,'mask':mask})
assert 'frozen 1' in open('/sys/fs/cgroup/smithers/sessions/cgroup.events').read().splitlines()
print(json.dumps({'start_ns':start,'end_ns':time.monotonic_ns(),'events':events}))
os.close(fd)`)
			var observed struct {
				Events []json.RawMessage `json:"events"`
			}
			require.NoError(t, json.Unmarshal(freezeEvidence, &observed))
			require.Empty(t, observed.Events, "a real session wrote during frozen 1")
			select {
			case reply := <-queuedHTTP:
				t.Fatalf("W1 returned during frozen hold: HTTP %d %s %v", reply.status, reply.data, reply.err)
			default:
			}
			select {
			case line := <-queuedReplies:
				t.Fatalf("W2 returned during frozen hold: %s", line)
			default:
			}
			select {
			case err := <-done:
				t.Fatalf("rewrite completed inside frozen hold: %v", err)
			default:
			}
			control(`import os
os.unlink('/var/lib/smithers-machined/qualification-frozen.hit')`)
		}
		require.NoError(t, <-done, "rebase %d", i)
		if i == 0 {
			statuses := map[int]int{}
			for n := 0; n < 2; n++ {
				select {
				case reply := <-queuedHTTP:
					require.NoError(t, reply.err)
					statuses[reply.status]++
					if reply.status == 409 {
						require.Contains(t, string(reply.data), `"stale"`)
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			}
			require.Equal(t, map[int]int{200: 1, 409: 1}, statuses)
			browser, err := registry.ReadFile(ctx, branch, "col03-queued-W1.txt", "")
			require.NoError(t, err)
			require.Equal(t, "queued W1 fresh\n", string(browser.Content))
			for _, expected := range []byte{255, 3} {
				var line string
				select {
				case line = <-queuedReplies:
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				bytes, err := hex.DecodeString(line)
				require.NoError(t, err)
				frame, err := wire.Decode(bytes)
				require.NoError(t, err)
				fields, err := wire.Fields("response", frame.Payload[1:])
				require.NoError(t, err)
				require.Equal(t, expected, fields[2][0])
				if expected == 255 {
					refusal, err := wire.Fields("error", fields[2][1:])
					require.NoError(t, err)
					require.Equal(t, []byte{4}, refusal[1], "local stale README save")
					sum := sha256.Sum256([]byte(newReadme))
					require.Equal(t, sum[:], refusal[3])
				}
			}
			require.NoError(t, queued.CloseWrite())
			require.NoError(t, queued.Wait())
			stderr, err := io.ReadAll(queued.Stderr())
			require.NoError(t, err)
			require.Empty(t, stderr)
			fresh, err := registry.ReadFile(ctx, branch, "col03-queued-W2.txt", "")
			require.NoError(t, err)
			require.Equal(t, "queued W2 fresh\n", string(fresh.Content))
			stale, err := registry.ReadFile(ctx, branch, "README.md", "")
			require.NoError(t, err)
			require.Equal(t, newReadme, string(stale.Content))
		}

		// The open document must receive rewrite reconciliation and keep its
		// literal bytes; a direct write receipt alone does not prove fan-out.
		live.converge(t, liveText)
		file, err := registry.ReadFile(ctx, branch, livePath, "")
		require.NoError(t, err)
		require.Equal(t, liveText, string(file.Content))
		rewriteTimes = append(rewriteTimes, time.Since(began).Nanoseconds())
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(2 * time.Second):
		}
	}
	// Return is driven through the host registry after a real member jj move.
	terminalID, err := r.openBranchTerminal(r.keyed, branch)
	require.NoError(t, err)
	terminal, err := r.openTerminal(terminalID)
	require.NoError(t, err)
	defer terminal.close()
	for i := 0; i < 10; i++ {
		func() {
			// The browser writer remains alive, but saves on the item only.
			// Drain its last acknowledged save before the explicit off-item
			// move. W2 still receives moved_off; W3/W4 continue outside writes.
			browserOnItem.Lock()
			defer browserOnItem.Unlock()
			status, out, err := terminal.capture("jj new main", "COL03MOVE", 30*time.Second)
			require.NoError(t, err)
			require.Equal(t, "0", status, "%s", out)
			_, err = registry.ReturnToItem(ctx, branch, person)
			require.NoError(t, err, "Return %d", i)
			file, err := registry.ReadFile(ctx, branch, livePath, "")
			require.NoError(t, err)
			live.converge(t, string(file.Content))
		}()
	}
	close(stopWriters)
	httpWriters.Wait()
	for _, e := range executions {
		_, err := e.Write([]byte("stop\n"))
		require.NoError(t, err)
		require.NoError(t, e.CloseWrite())
		require.NoError(t, e.Wait())
		require.NoError(t, e.Close())
	}
	readers.Wait()
	mu.Lock()
	acknowledged := append([]logged(nil), writes...)
	errs := append([]error(nil), failures...)
	mu.Unlock()
	require.Empty(t, errs)
	counts := map[string]int{}
	for _, w := range acknowledged {
		counts[w.Writer]++
	}
	for _, writer := range []string{"W1", "W2", "W3", "W4"} {
		require.GreaterOrEqual(t, counts[writer], 60, writer)
	}
	// Include the explicit queued saves and the acknowledged README base in
	// the same independent host-object preservation oracle after all Returns.
	for _, save := range []struct{ writer, path, content string }{
		{"W1", "README.md", originalReadme},
		{"W1", "README.md", newReadme},
		{"W1", "col03-queued-W1.txt", "queued W1 fresh\n"},
		{"W2", "col03-queued-W2.txt", "queued W2 fresh\n"},
	} {
		sum := sha256.Sum256([]byte(save.content))
		acknowledged = append(acknowledged, logged{save.writer, save.path, hex.EncodeToString(sum[:])})
	}
	captured, err := registry.Capture(ctx, branch)
	require.NoError(t, err)
	// Every acknowledged version is independently hashed from real host objects.
	// A Return can remove files from the working tree, but not their versions.
	require.NoError(t, r.options.Repository.WithMachineRepository(ctx, "rehearsal-owner", "app", func(store string) error {
		for _, w := range acknowledged {
			out, err := hostexec.Git(ctx, "-C", store, "show", captured.Head+":"+w.Path).Output()
			if err == nil {
				sum := sha256.Sum256(out)
				if hex.EncodeToString(sum[:]) == w.SHA256 {
					continue
				}
			}
			rows, err := r.pool.Query(ctx, `SELECT after_blob FROM burst_files WHERE path=$1 AND post_digest=$2`, w.Path, w.SHA256)
			if err != nil {
				return err
			}
			found := false
			for rows.Next() {
				var blob string
				if err = rows.Scan(&blob); err != nil {
					rows.Close()
					return err
				}
				out, err = hostexec.Git(ctx, "-C", store, "cat-file", "blob", blob).Output()
				if err == nil {
					sum := sha256.Sum256(out)
					found = found || hex.EncodeToString(sum[:]) == w.SHA256
				}
			}
			rows.Close()
			if err = rows.Err(); err != nil {
				return err
			}
			if !found {
				return fmt.Errorf("lost acknowledged %s %s %s", w.Writer, w.Path, w.SHA256)
			}
		}
		return nil
	}))
	// Read the installed daemon's own guest-clock samples. Never substitute
	// host request duration for lock hold, or claim a reference p95 from compile.
	holdLog := control(`from pathlib import Path
print(Path('/var/lib/smithers-machined/mutation-holds.jsonl').read_text(),end='')`)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "mutation-holds.jsonl"), holdLog, 0600))
	var rebaseHolds, returnHolds int
	for _, line := range strings.Split(strings.TrimSpace(string(holdLog)), "\n") {
		var sample struct {
			Event, Operation string
			Start, End, Hold uint64
		}
		var fields map[string]json.RawMessage
		require.NoError(t, json.Unmarshal([]byte(line), &fields))
		require.NoError(t, json.Unmarshal(fields["event"], &sample.Event))
		require.NoError(t, json.Unmarshal(fields["operation"], &sample.Operation))
		require.NoError(t, json.Unmarshal(fields["start_ns"], &sample.Start))
		require.NoError(t, json.Unmarshal(fields["end_ns"], &sample.End))
		require.NoError(t, json.Unmarshal(fields["hold_ns"], &sample.Hold))
		require.Equal(t, "mutation_hold", sample.Event)
		require.GreaterOrEqual(t, sample.End, sample.Start)
		require.Equal(t, sample.End-sample.Start, sample.Hold)
		if sample.Operation == "rebase" {
			rebaseHolds++
		}
		if sample.Operation == "return_to_item" {
			returnHolds++
		}
	}
	require.GreaterOrEqual(t, rebaseHolds, 50)
	require.GreaterOrEqual(t, returnHolds, 10)
	for name, value := range map[string]any{"writers.json": acknowledged, "rewrite-rpc-nanoseconds.json": rewriteTimes, "captured.json": captured, "frozen-inotify.json": freezeEvidence} {
		bytes, err := json.MarshalIndent(value, "", "  ")
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(r.evidence, name), append(bytes, '\n'), 0600))
	}
	// Submit a final document edit without consuming its saved frame, then
	// request sleep through the person's production command door. The final
	// capture must reach the host before the install reports suspended.
	terminal.close()
	beforeSleep, err := registry.ReadFile(ctx, branch, livePath, "")
	require.NoError(t, err)
	const sleepEdit = "FINAL-CAPTURE 🧑🏽‍💻 e\u0301 漢字\n"
	live.converge(t, string(beforeSleep.Content))
	sleepUpdate := codeInsert(live.client, sleepEdit)
	_, err = live.replica.Peer(sleepUpdate)
	require.NoError(t, err)
	wantSleep, err := live.replica.Text("content")
	require.NoError(t, err)
	require.Equal(t, 1, strings.Count(wantSleep, sleepEdit))
	require.Equal(t, string(beforeSleep.Content), strings.Replace(wantSleep, sleepEdit, "", 1))
	live.send(t, codeSync(2, sleepUpdate))
	code, data, err = r.keyed("POST", "/api/branches/"+branch, `{"op":"sleep"}`, uuid.NewString())
	require.NoError(t, err)
	require.Equal(t, 202, code, "%s", data)
	var sleepingHead string
	require.Eventually(t, func() bool {
		var status string
		err := r.pool.QueryRow(ctx, `SELECT status,head_commit_id FROM workspaces WHERE id=$1`, branch).Scan(&status, &sleepingHead)
		return err == nil && status == "suspended"
	}, 30*time.Second, 20*time.Millisecond)
	require.NoError(t, r.options.Repository.WithMachineRepository(ctx, "rehearsal-owner", "app", func(store string) error {
		bytes, err := hostexec.Git(ctx, "-C", store, "show", sleepingHead+":"+livePath).Output()
		if err != nil {
			return err
		}
		if string(bytes) != wantSleep {
			return fmt.Errorf("final live document capture: got %q want %q", bytes, wantSleep)
		}
		return nil
	}))
	// A person's terminal request wakes the retained machine. Root still uses
	// only the approved installed bundle; the branch provides no startup code.
	wakeTerminalID, err := r.openBranchTerminal(r.keyed, branch)
	require.NoError(t, err)
	wakeTerminal, err := r.openTerminal(wakeTerminalID)
	require.NoError(t, err)
	defer wakeTerminal.close()
	status, output, err := wakeTerminal.capture("cat "+livePath, "COL08WAKE", 30*time.Second)
	require.NoError(t, err)
	require.Equal(t, "0", status, "%s", output)
	require.Contains(t, output, sleepEdit)
	awake, err := registry.ReadFile(ctx, branch, livePath, "")
	require.NoError(t, err)
	require.Equal(t, wantSleep, string(awake.Content))
	link, err = registry.Current(branch)
	require.NoError(t, err)
	// Actor references bind to the admitted machine: use the current binding
	// after wake rather than assuming a private runtime identity is unchanged.
	wakeActor, err := machined.CommitActor(ctx, r.pool, branch, link.Machine(), func(context.Context, pgx.Tx) (machined.ActorIdentity, error) {
		return machined.ActorIdentity{Kind: "person", MemberID: member.ID, Via: "web"}, nil
	})
	require.NoError(t, err)
	reopened := openLiveWriterProbe(t, registry, branch, livePath, wakeActor)
	require.Equal(t, live.epoch, reopened.epoch)
	reopened.converge(t, wantSleep)
	sleepEvidence, err := json.Marshal(map[string]any{"head": sleepingHead, "text": wantSleep, "epoch": hex.EncodeToString(live.epoch[:]), "activation": false, "bundle_revision": bundle.Revision()})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "live-document-final-sleep.json"), sleepEvidence, 0600))
	// These are end-to-end RPC durations, deliberately not freeze p95 receipts.
	t.Logf("50 native rebases, 10 Return cycles, %d independently verified writes", len(acknowledged))
}
