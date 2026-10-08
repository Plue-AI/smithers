package compose

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/pkg/sftp"
	"github.com/smithersai/smithers/packages/backend/egressrelay"
	"github.com/smithersai/smithers/packages/backend/flowmanifest"
	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// This body has no process-runtime substitute. Its preflight refuses before VM
// creation unless the source and packaged helper match the approved artifact.
// C-J3-02/C-COL-04/C-J3-06 remain pending until this runs on the approved bundle.
func TestInstalledMemberTerminalAndSSHChain(t *testing.T) {
	if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") != "1" {
		t.Skip("reference host: approved native install required")
	}
	require.Equal(t, "1", os.Getenv("SMITHERS_GUEST_ROOT_BOUNDARY_CHECK"), "approved reference-host mode is required; digest equality alone does not authorize root execution")
	approved := os.Getenv("SMITHERS_APPROVED_GUEST_HELPER")
	require.NotEmpty(t, approved)
	approvedBytes, err := os.ReadFile(approved)
	require.NoError(t, err)
	sourceBytes, err := os.ReadFile(filepath.Join("..", "..", "microsandbox", "guest", "smithers-guest.py"))
	require.NoError(t, err)
	approvedSum, sourceSum := sha256.Sum256(approvedBytes), sha256.Sum256(sourceBytes)
	require.Equal(t, hex.EncodeToString(approvedSum[:]), hex.EncodeToString(sourceSum[:]), "source helper must be approved before VM creation")
	bundle, err := installbundle.Open(os.Getenv("SMITHERS_CHECK_BUNDLE"))
	require.NoError(t, err)
	helper, err := bundle.Expect("SMITHERS_MICROSANDBOX_HELPER", "", "share/microsandbox/smithers-guest.py", false)
	require.NoError(t, err)
	packaged, err := os.ReadFile(helper)
	require.NoError(t, err)
	require.Equal(t, approvedBytes, packaged)
	manifest, err := bundle.Expect("SMITHERS_FLOW_HOST_MANIFEST", "", "bin/flow-hosts.json", false)
	require.NoError(t, err)
	registry, err := flowmanifest.Load(manifest)
	require.NoError(t, err)
	msb, err := bundle.Expect("SMITHERS_MICROSANDBOX_BIN", os.Getenv("SMITHERS_MICROSANDBOX_BIN"), "bin/msb", true)
	require.NoError(t, err)
	t.Setenv("SMITHERS_MICROSANDBOX_BIN", msb)
	profile, err := microsandbox.Detect(t.TempDir())
	require.NoError(t, err)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	sshAddress := listener.Addr().String()
	require.NoError(t, listener.Close())
	t.Setenv("SMITHERS_SSH_ADDR", sshAddress)
	t.Setenv("SMITHERS_SSH_HOST_KEY_DIR", t.TempDir())
	providerRequests := make(chan string, 8)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		select {
		case providerRequests <- request.Header.Get("x-api-key"):
		default:
		}
		_, _ = io.WriteString(w, "provider-fixture-ok")
	}))
	defer provider.Close()
	relayListener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	relay, err := egressrelay.New(egressrelay.Config{Listener: relayListener, Local: []string{provider.Listener.Addr().String()}})
	require.NoError(t, err)
	defer relay.Close()
	h := startRootLayerHarnessRuntime(t, true, rootLayerCodingFixture{bundle: bundle, registry: registry, profile: profile, relay: relay})
	h.commitMain(map[string]string{"go.mod": "module example.com/terminalproof\n\ngo 1.26.8\n", "x.go": "package terminalproof\n", "JOURNEY.md": "Add a greeting to JOURNEY.md\n"})
	h.runSetupThroughSource()
	seedInstalledSecretFiles(t, h)
	h.expect("POST", installedSecretsURL, `{"name":"MCH_RELAY_KEY","value":"mch-relay-real-fixture","path":"~/.config/mch/relay","hosts":["127.0.0.1"],"match_headers":["x-api-key"]}`, 201)
	memberFixture := &rehearsal{ctx: t.Context(), origin: h.origin, jar: h.jar, client: h.client, fake: h.github}
	benBrowser, err := memberFixture.member("ben", 8, "write")
	require.NoError(t, err)
	aliceBrowser, err := memberFixture.member("alice", 9, "write")
	require.NoError(t, err)
	state, message := h.runMachine(t, "terminal-chain")
	require.Equal(t, "done", state, message)
	accepted := h.expect("POST", "/api/todos", `{"title":"Terminal proof","prompt":"Add a greeting to JOURNEY.md","place":{"mode":"append"}}`, 202)
	var todo struct {
		N int64 `json:"n"`
	}
	require.NoError(t, json.Unmarshal(accepted, &todo))
	var branch string
	require.Eventually(t, func() bool {
		var item services.MythicalItemView
		err := json.Unmarshal(h.expect("GET", fmt.Sprintf("/api/todos/%d", todo.N), "", 200), &item)
		if err != nil {
			return false
		}
		return h.pool.QueryRow(t.Context(), `SELECT workspace_id FROM mythical_items WHERE number=$1`, todo.N).Scan(&branch) == nil && branch != "" && (item.State == "working" || item.State == "in_review")
	}, 15*time.Minute, 250*time.Millisecond, "native branch never became usable: %s", h.logs.String())
	requestKey := uuid.NewString()
	code, raw := h.request("POST", "/api/terminals", `{"branch":"`+branch+`"}`, requestKey)
	require.Equal(t, 202, code, string(raw))
	var receipt services.WorkspaceSessionResponse
	require.NoError(t, json.Unmarshal(raw, &receipt))
	q := db.New(h.pool)
	require.Eventually(t, func() bool {
		status, raw := h.request("POST", "/api/terminals", `{"branch":"`+branch+`"}`, requestKey)
		var current services.WorkspaceSessionResponse
		return status == 202 && json.Unmarshal(raw, &current) == nil && current.ID == receipt.ID && current.Status == "running"
	}, 2*time.Minute, 100*time.Millisecond)
	var uid uint32
	var bookmark string
	member := receipt.UserID
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT c.unix_uid,w.target_bookmark FROM workspaces w JOIN collaborators c ON c.repository_id=w.repository_id AND c.user_id=$2 WHERE w.id=$1`, branch, member).Scan(&uid, &bookmark))
	var terminalRows int
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM workspace_sessions WHERE id=$1`, receipt.ID).Scan(&terminalRows))
	require.Zero(t, terminalRows, "owner PTYs live in the existing manager")
	require.GreaterOrEqual(t, uid, uint32(20000))
	r := &rehearsal{ctx: t.Context(), origin: h.origin, jar: h.jar}
	term, err := r.openTerminal(receipt.ID)
	require.NoError(t, err)
	defer term.close()
	_, err = term.run(`printf 'TRM''UID=%s\n' "$(id -u)"`, regexp.MustCompile(fmt.Sprintf(`TRMUID=%d`, uid)), 30*time.Second)
	require.NoError(t, err)
	_, err = term.run(`test -r "$SMITHERS_TOKEN_FILE" && test "${SMITHERS_TOKEN-unset}" = unset && test "$(stat -c %a "$SMITHERS_TOKEN_FILE")" = 600 && printf 'TRM''TOKEN=private\n'`, regexp.MustCompile(`TRMTOKEN=private`), 30*time.Second)
	require.NoError(t, err)
	// Fixed guest contracts, observed through the retained production socket.
	// These execute only on the approved microVM, never a host shell fixture.
	_, err = term.run(`test "$(pwd)" = /workspace && test "$(umask)" = 0002 && test "$HOME" = "/home/$(id -un)" && test "$(id -g)" = "$(id -u)" && test "$(awk '/^Groups:/ {if (NF == 2) print $2}' /proc/$$/status)" = 20000 && printf 'TRM''IDENTITY=confined\n'`, regexp.MustCompile(`TRMIDENTITY=confined`), 30*time.Second)
	require.NoError(t, err)
	expectedToken := fmt.Sprintf("/run/smithers/%d/token/sessions/%s/token", uid, receipt.ID)
	_, err = term.run(fmt.Sprintf(`test "$SMITHERS_TOKEN_FILE" = %q && test "$(stat -c %%u "$SMITHERS_TOKEN_FILE")" = "$(id -u)" && test "$(stat -c %%a /run/smithers/$(id -u)/token)" = 700 && printf 'TRM''BINDING=private\n'`, expectedToken), regexp.MustCompile(`TRMBINDING=private`), 30*time.Second)
	require.NoError(t, err)

	testInstalledUsers(t, h, branch, term, benBrowser, aliceBrowser)
	testInstalledSecretFiles(t, h, branch, term)
	installedShell(t, term, fmt.Sprintf(`test "$(cat "$HOME/.config/mch/relay")" = MCH_RELAY_KEY && test "$(curl --silent --show-error --fail --noproxy '' --proxy "$http_proxy" -H "x-api-key: $(cat "$HOME/.config/mch/relay")" %q)" = provider-fixture-ok`, provider.URL))
	select {
	case received := <-providerRequests:
		require.Equal(t, "mch-relay-real-fixture", received)
	case <-time.After(10 * time.Second):
		t.Fatal("guest request never reached the provider fixture through the production relay")
	}

	// A second live session must have a distinct credential file. Closing the
	// first shell revokes only its file, without breaking the second terminal.
	secondKey := uuid.NewString()
	code, raw = h.request("POST", "/api/terminals", `{"branch":"`+branch+`"}`, secondKey)
	require.Equal(t, 202, code, string(raw))
	var second services.WorkspaceSessionResponse
	require.NoError(t, json.Unmarshal(raw, &second))
	require.NotEqual(t, receipt.ID, second.ID)
	require.Eventually(t, func() bool {
		status, raw := h.request("POST", "/api/terminals", `{"branch":"`+branch+`"}`, secondKey)
		var current services.WorkspaceSessionResponse
		return status == 202 && json.Unmarshal(raw, &current) == nil && current.ID == second.ID && current.Status == "running"
	}, 2*time.Minute, 100*time.Millisecond)
	other, err := r.openTerminal(second.ID)
	require.NoError(t, err)
	defer other.close()
	secondToken := fmt.Sprintf("/run/smithers/%d/token/sessions/%s/token", uid, second.ID)
	_, err = other.run(fmt.Sprintf(`test "$SMITHERS_TOKEN_FILE" = %q && test -r %q && test -r "$SMITHERS_TOKEN_FILE" && ! cmp -s %q "$SMITHERS_TOKEN_FILE" && printf 'TRM''SESSIONS=separate\n'`, secondToken, expectedToken, expectedToken), regexp.MustCompile(`TRMSESSIONS=separate`), 30*time.Second)
	require.NoError(t, err)
	closeCtx, closeCancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer closeCancel()
	require.NoError(t, term.conn.Write(closeCtx, websocket.MessageText, []byte(`{"type":"close"}`)))
	select {
	case <-term.closed:
	case <-closeCtx.Done():
		t.Fatal("owner close did not end the first terminal")
	}
	_, err = other.run(fmt.Sprintf(`for i in $(seq 1 50); do test ! -e %q && break; sleep .1; done; test ! -e %q && test -r "$SMITHERS_TOKEN_FILE" && printf 'TRM''SURVIVOR=private\n'`, expectedToken, expectedToken), regexp.MustCompile(`TRMSURVIVOR=private`), 30*time.Second)
	require.NoError(t, err)
	_, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	signer, err := gossh.NewSignerFromKey(private)
	require.NoError(t, err)
	_, err = q.CreateSSHKey(t.Context(), db.CreateSSHKeyParams{UserID: member, Name: "installed-terminal-proof", PublicKey: string(gossh.MarshalAuthorizedKey(signer.PublicKey())), Fingerprint: gossh.FingerprintSHA256(signer.PublicKey()), KeyType: "ssh-ed25519"})
	require.NoError(t, err)
	login := bookmark
	if strings.HasPrefix(login, "smithers/") {
		login = strings.TrimPrefix(login, "smithers/")
	}
	_, unknownPrivate, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	unknownSigner, err := gossh.NewSignerFromKey(unknownPrivate)
	require.NoError(t, err)
	unknown, err := gossh.Dial("tcp", sshAddress, &gossh.ClientConfig{User: login, Auth: []gossh.AuthMethod{gossh.PublicKeys(unknownSigner)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: 10 * time.Second})
	if unknown != nil {
		_ = unknown.Close()
	}
	require.Error(t, err, "a key belonging to no member must not open a guest session")
	client, err := gossh.Dial("tcp", sshAddress, &gossh.ClientConfig{User: login, Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: 10 * time.Second})
	require.NoError(t, err)
	defer client.Close()
	session, err := client.NewSession()
	require.NoError(t, err)
	defer session.Close()
	output, err := session.CombinedOutput("id -u")
	require.NoError(t, err, string(output))
	require.Equal(t, fmt.Sprintf("%d\n", uid), string(output))

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
	testInstalledCredentials(t, h, branch, installedMemberTerminal(t, h, branch, benBrowser), benBrowser)
	t.Logf("installed member terminal and SSH: bundle=%s branch=%s uid=%d", bundle.Revision(), branch, uid)
}
