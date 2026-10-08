package compose

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"github.com/pkg/sftp"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"
)

// Sleep/wake uses the served owner action and the same installed gateway. It
// never substitutes a process runtime or injects an admission completion.
func exerciseSSHRetainedRootInputs(t *testing.T, h *rootLayerHarness, client *gossh.Client, address, login string, signer gossh.Signer, member int64, uid uint32) {
	t.Helper()
	var branch string
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT id FROM workspaces WHERE status='running' AND (target_bookmark=$1 OR target_bookmark='smithers/' || $1)`, login).Scan(&branch))
	run := func(c *gossh.Client, text string) []byte {
		t.Helper()
		s, err := c.NewSession()
		require.NoError(t, err)
		defer s.Close()
		output, err := s.CombinedOutput(text)
		require.NoError(t, err, string(output))
		return output
	}
	require.Equal(t, uint32(20000), uid)
	// Branch-owned startup candidates and escaping cwd survive on the
	// retained disk. Root must never resolve either as its executable/cwd.
	run(client, `mkdir -p /workspace/trm03-retained; printf '#!/bin/sh\nprintf root-canary > /etc/trm03-root-canary\n' > /workspace/trm03-retained/sh; chmod 755 /workspace/trm03-retained/sh; ln -s /etc /workspace/trm03-retained/cwd; printf retained > /workspace/trm03-retained/marker`)
	live, err := client.NewSession()
	require.NoError(t, err)
	defer live.Close()
	require.NoError(t, live.Start("exec sleep 120"))
	closed := make(chan error, 1)
	go func() { closed <- live.Wait() }()
	code, body := h.request("POST", "/api/branches/"+branch, `{"op":"sleep"}`, uuid.NewString())
	require.Equal(t, 202, code, string(body))
	require.Eventually(t, func() bool {
		machine, err := h.runtime.InspectWorkspace(t.Context(), branch)
		return err == nil && machine.State == workspaceapi.WorkspaceStopped
	}, 2*time.Minute, 100*time.Millisecond)
	select {
	case err := <-closed:
		require.Error(t, err, "sleep must terminate the old live guest session")
	case <-time.After(5 * time.Second):
		t.Fatal("sleep retained the old SSH process/channel")
	}
	retained, err := gossh.Dial("tcp", address, &gossh.ClientConfig{User: login, Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: 10 * time.Second})
	require.NoError(t, err)
	defer retained.Close()
	s, err := retained.NewSession()
	require.NoError(t, err)
	defer s.Close()
	for _, env := range [][2]string{{"PATH", "/workspace/trm03-retained"}, {"SHELL", "/workspace/trm03-retained/sh"}, {"HOME", "/workspace/trm03-retained/cwd"}, {"PWD", "/workspace/trm03-retained/cwd"}, {"LD_PRELOAD", "/workspace/trm03-retained/loader.so"}} {
		require.NoError(t, s.Setenv(env[0], env[1]))
	}
	output, err := s.CombinedOutput(`id -u; id -g; awk '/^Groups:/ {if (NF == 2) print $2}' /proc/$$/status; pwd; cat /workspace/trm03-retained/marker; test ! -e /etc/trm03-root-canary; test ! -e /workspace/trm03-root-canary; test ! -w /etc; cat /proc/self/cgroup`)
	require.NoError(t, err, string(output))
	require.Regexp(t, `^20000\n20000\n20000\n/workspace\nretained0::/smithers/sessions/s[1-9][0-9]*\n$`, string(output))
	// Repeat the authenticated envelopes and roster fence against this
	// retained boot, then exercise filesystem races with SSH positive controls.
	exerciseSSHInstalledInputValidation(t, retained)
	exerciseSSHRetainedChannels(t, retained)
	exerciseSSHBrokerSemanticInputs(t, h, retained, login, member, uid)
	exerciseSSHRetainedFilesystemRace(t, retained)
	exerciseSSHRetainedExecutableRace(t, retained)
	exerciseSSHRetainedCwdRace(t, retained)
	require.Equal(t, "20000\n/workspace\n", string(run(retained, "id -u; pwd")))
	run(retained, "rm -rf /workspace/trm03-retained")
	exerciseSSHQueuedWakeRevocation(t, h, branch, address, login, signer)
	t.Logf("C-J3-06 retained SSH wake: member=%d; private input validation runs on the approved installed debug testing image", member)
}

// A second real branch holds the single owner-configured slot. The revoked
// SSH request must never start when that slot is freed. Both the setting and
// revocation enter the served install router; no test-only admission gate.
func exerciseSSHQueuedWakeRevocation(t *testing.T, h *rootLayerHarness, branch, address, login string, survivor gossh.Signer) {
	t.Helper()
	q := db.New(h.pool)
	saved, err := q.GetInstallCapacity(t.Context())
	require.NoError(t, err)
	restore := func() {
		if len(saved.Capacity) > 0 && string(saved.Capacity) != "null" {
			h.expect("PUT", "/api/install", `{"capacity":`+string(saved.Capacity)+`}`, 200)
		} else {
			_, err := h.pool.Exec(t.Context(), `DELETE FROM install_settings WHERE key='capacity'`)
			require.NoError(t, err)
		}
	}
	defer restore()
	body := h.expect("POST", "/api/todos", `{"title":"SSH queue holder","prompt":"Add a greeting to JOURNEY.md","place":{"mode":"append"}}`, 202)
	var todo struct {
		N int64 `json:"n"`
	}
	require.NoError(t, json.Unmarshal(body, &todo))
	var holder string
	require.Eventually(t, func() bool {
		if err := h.pool.QueryRow(t.Context(), `SELECT workspace_id FROM mythical_items WHERE number=$1`, todo.N).Scan(&holder); err != nil || holder == "" || holder == branch {
			return false
		}
		machine, err := h.runtime.InspectWorkspace(t.Context(), holder)
		return err == nil && machine.State == workspaceapi.WorkspaceRunning
	}, 15*time.Minute, 250*time.Millisecond)
	observer := installedMemberTerminal(t, h, holder, h.jar)
	defer observer.close()
	h.expect("PUT", "/api/install", `{"capacity":1}`, 200)
	body = h.expect("POST", "/api/branches/"+branch, `{"op":"sleep"}`, 202)
	require.Eventually(t, func() bool {
		machine, err := h.runtime.InspectWorkspace(t.Context(), branch)
		return err == nil && machine.State == workspaceapi.WorkspaceStopped
	}, 2*time.Minute, 100*time.Millisecond)
	_, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	revoked, err := gossh.NewSignerFromKey(private)
	require.NoError(t, err)
	create, err := json.Marshal(map[string]string{"title": "SSH queued wake proof", "key": string(gossh.MarshalAuthorizedKey(revoked.PublicKey()))})
	require.NoError(t, err)
	var key struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, json.Unmarshal(h.expect("POST", "/api/user/keys", string(create), 201), &key))
	queued, err := gossh.Dial("tcp", address, &gossh.ClientConfig{User: login, Auth: []gossh.AuthMethod{gossh.PublicKeys(revoked)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: 10 * time.Second})
	require.NoError(t, err)
	defer queued.Close()
	session, err := queued.NewSession()
	require.NoError(t, err)
	defer session.Close()
	stderr, err := session.StderrPipe()
	require.NoError(t, err)
	position := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			if strings.Contains(scanner.Text(), "waiting for a machine") {
				position <- scanner.Text()
				return
			}
		}
		position <- ""
	}()
	finished := make(chan error, 1)
	go func() { finished <- session.Run("touch /workspace/trm03-revoked-wake-canary") }()
	select {
	case line := <-position:
		require.Contains(t, line, "waiting for a machine #1")
	case <-time.After(30 * time.Second):
		t.Fatal("SSH never reached the real capacity queue")
	}
	machine, err := h.runtime.InspectWorkspace(t.Context(), branch)
	require.NoError(t, err)
	require.Equal(t, workspaceapi.WorkspaceStopped, machine.State)
	h.expect("DELETE", fmt.Sprintf("/api/user/keys/%d", key.ID), "", 204)
	select {
	case err := <-finished:
		require.Error(t, err, "withdrawn queued key must never execute")
	case <-time.After(5 * time.Second):
		t.Fatal("key withdrawal retained the queued SSH connection")
	}
	h.expect("POST", "/api/branches/"+holder, `{"op":"sleep"}`, 202)
	require.Eventually(t, func() bool {
		machine, err := h.runtime.InspectWorkspace(t.Context(), holder)
		return err == nil && machine.State == workspaceapi.WorkspaceStopped
	}, 2*time.Minute, 100*time.Millisecond)
	restore()
	valid, err := gossh.Dial("tcp", address, &gossh.ClientConfig{User: login, Auth: []gossh.AuthMethod{gossh.PublicKeys(survivor)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: 10 * time.Second})
	require.NoError(t, err)
	defer valid.Close()
	positive, err := valid.NewSession()
	require.NoError(t, err)
	defer positive.Close()
	output, err := positive.CombinedOutput("id -u; pwd; test ! -e /workspace/trm03-revoked-wake-canary; test ! -e /etc/trm03-root-canary")
	require.NoError(t, err, string(output))
	require.Equal(t, "20000\n/workspace\n", string(output))
	refused, err := gossh.Dial("tcp", address, &gossh.ClientConfig{User: login, Auth: []gossh.AuthMethod{gossh.PublicKeys(revoked)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: time.Second})
	if refused != nil {
		refused.Close()
	}
	require.Error(t, err)
}

// Member removal commits through the installed owner router while the served
// SSH gateway is waiting on the real capacity queue. A surviving member then
// wakes the retained branch and checks both process and filesystem state.
func exerciseSSHQueuedMemberRemoval(t *testing.T, h *rootLayerHarness, branch, address, login string, survivor gossh.Signer) {
	t.Helper()
	r := &rehearsal{ctx: t.Context(), origin: h.origin, jar: h.jar, client: h.client, fake: h.github}
	browser, err := r.member("ssh-queued-member", 17, "write")
	require.NoError(t, err)
	var uid uint32
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT unix_uid FROM collaborators WHERE user_id=(SELECT id FROM users WHERE username='ssh-queued-member') AND repository_id=(SELECT repository_id FROM workspaces WHERE id=$1)`, branch).Scan(&uid))
	require.Equal(t, uint32(20005), uid, "member removal runs after the existing owner-watch fixtures")
	_, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	signer, err := gossh.NewSignerFromKey(private)
	require.NoError(t, err)
	body, err := json.Marshal(map[string]string{"title": "SSH queued member", "key": string(gossh.MarshalAuthorizedKey(signer.PublicKey()))})
	require.NoError(t, err)
	member := &rehearsal{ctx: t.Context(), origin: h.origin, jar: browser, client: &http.Client{Jar: browser}, fake: h.github}
	_, err = member.expect("POST", "/api/user/keys", string(body), 201)
	require.NoError(t, err)
	// Keep the current branch's owner session as the capacity holder. A second
	// branch is asleep before the member's request, so queueing is observable.
	raw := h.expect("POST", "/api/todos", `{"title":"SSH member queue","prompt":"Add a greeting to JOURNEY.md","place":{"mode":"append"}}`, 202)
	var todo struct {
		N int64 `json:"n"`
	}
	require.NoError(t, json.Unmarshal(raw, &todo))
	var target, targetLogin string
	require.Eventually(t, func() bool {
		err := h.pool.QueryRow(t.Context(), `SELECT w.id,w.target_bookmark FROM mythical_items i JOIN workspaces w ON w.id=i.workspace_id WHERE i.number=$1`, todo.N).Scan(&target, &targetLogin)
		if err != nil {
			return false
		}
		machine, err := h.runtime.InspectWorkspace(t.Context(), target)
		return err == nil && machine.State == workspaceapi.WorkspaceRunning
	}, 15*time.Minute, 250*time.Millisecond)
	targetLogin = strings.TrimPrefix(targetLogin, "smithers/")
	h.expect("POST", "/api/branches/"+target, `{"op":"sleep"}`, 202)
	require.Eventually(t, func() bool {
		m, e := h.runtime.InspectWorkspace(t.Context(), target)
		return e == nil && m.State == workspaceapi.WorkspaceStopped
	}, 2*time.Minute, 100*time.Millisecond)
	saved, err := db.New(h.pool).GetInstallCapacity(t.Context())
	require.NoError(t, err)
	defer func() {
		if len(saved.Capacity) > 0 && string(saved.Capacity) != "null" {
			h.expect("PUT", "/api/install", `{"capacity":`+string(saved.Capacity)+`}`, 200)
		} else {
			_, err := h.pool.Exec(t.Context(), `DELETE FROM install_settings WHERE key='capacity'`)
			require.NoError(t, err)
		}
	}()
	holder := installedMemberTerminal(t, h, branch, h.jar)
	defer holder.close()
	h.expect("PUT", "/api/install", `{"capacity":1}`, 200)
	queued, err := gossh.Dial("tcp", address, &gossh.ClientConfig{User: targetLogin, Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: 10 * time.Second})
	require.NoError(t, err)
	defer queued.Close()
	session, err := queued.NewSession()
	require.NoError(t, err)
	defer session.Close()
	stderr, err := session.StderrPipe()
	require.NoError(t, err)
	position := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			if strings.Contains(scanner.Text(), "waiting for a machine") {
				position <- scanner.Text()
				return
			}
		}
		position <- ""
	}()
	finished := make(chan error, 1)
	go func() { finished <- session.Run("touch /workspace/trm03-removed-member-canary") }()
	select {
	case line := <-position:
		require.Contains(t, line, "waiting for a machine #1")
	case <-time.After(30 * time.Second):
		t.Fatal("member SSH never reached capacity queue")
	}
	h.expect("DELETE", "/api/members/ssh-queued-member", "", 204)
	select {
	case err := <-finished:
		require.Error(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("member removal retained queued SSH connection")
	}
	m, err := h.runtime.InspectWorkspace(t.Context(), target)
	require.NoError(t, err)
	require.Equal(t, workspaceapi.WorkspaceStopped, m.State)
	holder.close()
	h.expect("POST", "/api/branches/"+branch, `{"op":"sleep"}`, 202)
	require.Eventually(t, func() bool {
		m, e := h.runtime.InspectWorkspace(t.Context(), branch)
		return e == nil && m.State == workspaceapi.WorkspaceStopped
	}, 2*time.Minute, 100*time.Millisecond)
	valid, err := gossh.Dial("tcp", address, &gossh.ClientConfig{User: targetLogin, Auth: []gossh.AuthMethod{gossh.PublicKeys(survivor)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: 10 * time.Second})
	require.NoError(t, err)
	defer valid.Close()
	positive, err := valid.NewSession()
	require.NoError(t, err)
	defer positive.Close()
	output, err := positive.CombinedOutput(fmt.Sprintf("id -u; pwd; test ! -e /workspace/trm03-removed-member-canary && ! pgrep -u %d", uid))
	require.NoError(t, err, string(output))
	require.Equal(t, "20000\n/workspace\n", string(output))
	refused, err := gossh.Dial("tcp", address, &gossh.ClientConfig{User: targetLogin, Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: time.Second})
	if refused != nil {
		refused.Close()
	}
	require.Error(t, err)
}

func exerciseSSHRetainedChannels(t *testing.T, client *gossh.Client) {
	t.Helper()
	// Drive the actual shell channel and PTY, rather than exec alone.
	shell, err := client.NewSession()
	require.NoError(t, err)
	defer shell.Close()
	require.NoError(t, shell.RequestPty("xterm", 24, 80, gossh.TerminalModes{gossh.ECHO: 0}))
	var output bytes.Buffer
	shell.Stdout = &output
	shell.Stdin = strings.NewReader("id -u; pwd; exit\n")
	require.NoError(t, shell.Shell())
	require.NoError(t, shell.Wait())
	require.Contains(t, strings.ReplaceAll(output.String(), "\r\n", "\n"), "20000\n/workspace\n")
	uid := uint32(20000)
	// VS Code uses the same admitted member channel for SFTP and loopback TCP.
	files, err := sftp.NewClient(client)
	require.NoError(t, err)
	defer files.Close()
	filename := "/tmp/smithers-member-proof-" + uuid.NewString()
	file, err := files.OpenFile(filename, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	require.NoError(t, err)
	_, err = file.Write([]byte("member-owned\n"))
	require.NoError(t, err)
	require.NoError(t, file.Close())
	defer files.Remove(filename)
	info, err := files.Stat(filename)
	require.NoError(t, err)
	require.Equal(t, uid, info.Sys().(*sftp.FileStat).UID)
	read, err := files.Open(filename)
	require.NoError(t, err)
	contents, err := io.ReadAll(read)
	require.NoError(t, err)
	require.NoError(t, read.Close())
	require.Equal(t, "member-owned\n", string(contents))

	// A guest listener chooses its own port; the gateway can reach only loopback.
	echo, err := client.NewSession()
	require.NoError(t, err)
	defer echo.Close()
	stdout, err := echo.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, echo.Start(`python3 -u -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen(1); print(s.getsockname()[1],flush=True); c,_=s.accept(); b=c.recv(128); c.sendall(b); c.close(); s.close()'`))
	portReady := make(chan string, 1)
	go func() { line, _ := bufio.NewReader(stdout).ReadString('\n'); portReady <- strings.TrimSpace(line) }()
	var port string
	select {
	case port = <-portReady:
	case <-time.After(30 * time.Second):
		t.Fatal("guest loopback listener did not start")
	}
	n, err := strconv.ParseUint(port, 10, 16)
	require.NoError(t, err)
	require.NotZero(t, n)
	forwarded, err := client.Dial("tcp", "127.0.0.1:"+port)
	require.NoError(t, err)
	defer forwarded.Close()
	_, err = forwarded.Write([]byte("member-forward"))
	require.NoError(t, err)
	response := make([]byte, len("member-forward"))
	readDone := make(chan error, 1)
	go func() { _, err := io.ReadFull(forwarded, response); readDone <- err }()
	select {
	case err = <-readDone:
		require.NoError(t, err)
	case <-time.After(30 * time.Second):
		_ = forwarded.Close()
		<-readDone
		t.Fatal("admitted loopback forwarding did not echo")
	}
	require.Equal(t, "member-forward", string(response))
	require.NoError(t, forwarded.Close())
	require.NoError(t, echo.Wait())
}

// Every member open in this image must finish the fixed raw cases on its
// existing private channel before the normal SSH reply succeeds. The build
// marker runs as the member and exposes no privileged operation or listener.
func exerciseSSHInstalledInputValidation(t *testing.T, client *gossh.Client) {
	t.Helper()
	session, err := client.NewSession()
	require.NoError(t, err)
	defer session.Close()
	output, err := session.CombinedOutput("/opt/smithers/bin/smithers-machined ssh-acceptance-image")
	require.NoError(t, err, string(output))
	require.Equal(t, "ssh-input-validation-v1\n", string(output), "reference acceptance needs the main-approved debug testing image")
}

// Fixed profiles use the same installed daemon/broker as served SSH, then
// observe recovery on the public gateway. Each failed boot must finish its
// session cleanup before the supervisor can admit the next member process.
func exerciseSSHInstalledFraming(t *testing.T, h *rootLayerHarness, address, login string, signer gossh.Signer) {
	t.Helper()
	for _, command := range []string{
		"/opt/smithers/bin/smithers-machined ssh-acceptance-framing-1",
		"/opt/smithers/bin/smithers-machined ssh-acceptance-framing-4",
		"/opt/smithers/bin/smithers-machined ssh-acceptance-framing-8",
		"/opt/smithers/bin/smithers-machined ssh-acceptance-framing-65537",
		"/opt/smithers/bin/smithers-machined ssh-acceptance-framing-65561",
		"/opt/smithers/bin/smithers-machined ssh-acceptance-framing-70000",
	} {
		t.Run(command, func(t *testing.T) {
			client, err := gossh.Dial("tcp", address, &gossh.ClientConfig{User: login, Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: 10 * time.Second})
			require.NoError(t, err)
			exerciseSSHInstalledInputValidation(t, client)
			before, err := client.NewSession()
			require.NoError(t, err)
			baseline, err := before.CombinedOutput("pgrep -u 19998 -x smithers-machin; nohup sleep 120 >/dev/null 2>&1 </dev/null & echo $!")
			before.Close()
			require.NoError(t, err, string(baseline))
			pids := strings.Fields(string(baseline))
			require.Len(t, pids, 2)
			for _, pid := range pids {
				require.Regexp(t, `^[1-9][0-9]*$`, pid)
			}
			session, err := client.NewSession()
			require.NoError(t, err)
			ended := make(chan error, 1)
			go func() { _, err := session.CombinedOutput(command); ended <- err }()
			select {
			case err := <-ended:
				require.Error(t, err, "fatal framing must end this launch")
			case <-time.After(5 * time.Second):
				client.Close()
				t.Fatal("fatal frame did not end the installed launch within 5 s")
			}
			session.Close()
			client.Close()
			require.Eventually(t, func() bool {
				next, err := gossh.Dial("tcp", address, &gossh.ClientConfig{User: login, Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: time.Second})
				if err != nil {
					return false
				}
				defer next.Close()
				positive, err := next.NewSession()
				if err != nil {
					return false
				}
				defer positive.Close()
				output, err := positive.CombinedOutput(fmt.Sprintf("id -u; pwd; test ! -e /etc/trm03-root-canary && test ! -d /proc/%s || exit 91; pgrep -u 19998 -x smithers-machin", pids[1]))
				lines := strings.Fields(string(output))
				return err == nil && len(lines) == 3 && lines[0] == "20000" && lines[1] == "/workspace" && lines[2] != pids[0]
			}, 30*time.Second, 250*time.Millisecond, "installed broker did not recover on served SSH")
		})
	}
}
