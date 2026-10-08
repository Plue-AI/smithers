package compose

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/stretchr/testify/require"
)

// installModelHost is the install's own chat host type over the real packaged
// bundle, local launcher and trusted process runtime, on an install whose owner
// has configured no model. resolved counts every request that asked for one.
func installModelHost(t *testing.T, resolved *atomic.Int32) *modelhost.Host {
	t.Helper()
	node, err := exec.LookPath("node")
	require.NoError(t, err)
	node, err = filepath.EvalSymlinks(node)
	require.NoError(t, err)
	_, source, _, ok := goruntime.Caller(0)
	require.True(t, ok)
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	bundle := filepath.Join(t.TempDir(), "model-host.mjs")
	build := exec.CommandContext(t.Context(), node, filepath.Join(root, "apps/model-host/build.mjs"), bundle)
	build.Dir = root
	output, err := build.CombinedOutput()
	require.NoError(t, err, string(output))
	require.NoError(t, os.Chmod(bundle, 0o755))
	contents, err := os.ReadFile(bundle)
	require.NoError(t, err)
	digest := sha256.Sum256(contents)
	require.NoError(t, os.WriteFile(bundle+".sha256", []byte(hex.EncodeToString(digest[:])+"  model-host.mjs\n"), 0o644))
	trusted, err := process.New(process.Config{Root: filepath.Join(t.TempDir(), "runtime")})
	require.NoError(t, err)
	t.Cleanup(func() { _ = trusted.Close() })
	launcher, err := modelhost.NewLocalLauncher(modelhost.LocalConfig{Runtime: trusted, NodeBinary: node, BundlePath: bundle})
	require.NoError(t, err)
	host, err := modelhost.New(modelhost.ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (modelhost.Binding, error) {
		resolved.Add(1)
		return modelhost.Binding{}, ports.ErrModelCredentialMissing
	}), launcher)
	require.NoError(t, err)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = host.Close(ctx)
	})
	return host
}

// scriptedDaemon is the remote side of one authenticated machine link for a
// journey that boots no machine. It sends transcript records and reads their
// acknowledgements. The complete install also calls the daemon (roster,
// presence, reconciliation); this one answers every such call "unsupported",
// as a daemon without that feature would, and keeps reading so the link lives.
type scriptedDaemon struct {
	peer    net.Conn
	write   sync.Mutex
	send    sync.Mutex
	acks    chan wire.Frame
	seq     uint64
	offsets map[byte]uint64
	calls   atomic.Int32
}

func newScriptedDaemon(peer net.Conn) *scriptedDaemon {
	daemon := &scriptedDaemon{peer: peer, acks: make(chan wire.Frame, 1), offsets: map[byte]uint64{}}
	go func() {
		defer close(daemon.acks)
		for {
			frame, err := wire.Read(peer)
			if err != nil {
				return
			}
			switch {
			case frame.Kind == wire.Events && len(frame.Payload) > 0 && frame.Payload[0] == 3:
				daemon.acks <- frame
			case frame.Kind == wire.Control && len(frame.Payload) > 0 && frame.Payload[0] == 1:
				fields, err := wire.Fields("request", frame.Payload[1:])
				if err != nil {
					return
				}
				daemon.calls.Add(1)
				daemon.write.Lock()
				err = wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, fields[1]), wire.Field(2, wire.Union(255, wire.Field(1, []byte{2}))))})
				daemon.write.Unlock()
				if err != nil {
					return
				}
			}
		}
	}()
	return daemon
}

// deliver sends the next record of agent process n in terminal session 1 and
// returns the outcome the daemon reads.
func (d *scriptedDaemon) deliver(n byte, profile, record string) (machined.AckOutcome, error) {
	d.send.Lock()
	defer d.send.Unlock()
	start := d.offsets[n]
	end := start + uint64(len(record)) + 1
	payload, err := wire.EncodeTranscript(wire.Transcript{Version: 1, Session: 1, Participant: [16]byte{0xb0, n}, Source: [16]byte{0xc0, n}, Profile: profile, Generation: 1, Start: start, End: end, Record: record})
	if err != nil {
		return 0, err
	}
	d.seq++
	d.write.Lock()
	frame := transcriptEventFrame(machined.Event{Seq: d.seq, EventID: [16]byte(uuid.New()), Payload: payload})
	err = wire.Write(d.peer, frame)
	d.write.Unlock()
	if err != nil {
		return 0, err
	}
	// The daemon outbox replays an unacknowledged event with its original
	// identity. Transient receipt failures must not strand this scripted link.
	replay := time.NewTicker(time.Second)
	defer replay.Stop()
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case frame, ok := <-d.acks:
			if !ok {
				return 0, errors.New("the host closed the link instead of settling the record")
			}
			fields, err := wire.Fields("ack", frame.Payload[1:])
			if err != nil {
				return 0, err
			}
			if !bytes.Equal(fields[1], wire.U64(d.seq)) || len(fields[2]) != 1 {
				return 0, errors.New("the host acknowledged another event")
			}
			outcome := machined.AckOutcome(fields[2][0])
			if outcome == machined.AckApplied {
				d.offsets[n] = end
			}
			return outcome, nil
		case <-replay.C:
			d.write.Lock()
			err = wire.Write(d.peer, frame)
			d.write.Unlock()
			if err != nil {
				return 0, err
			}
		case <-deadline.C:
			return 0, errors.New("the host did not settle the record in 30 s")
		}
	}
}

// Opt-in browser journey over the complete install composition (C-AGT-01's
// browser projection, and C-AGT-02's host half).
//
// Real: StartWithOptions (the composition main.go runs), its own event pump
// and transcript import, the install's model host type over the packaged
// adapters, PostgreSQL, daemon authentication and framing, the host's session
// receipts, the member's browser session, the conversation and live routes, a
// Chromium browser and the built app. No browser request is intercepted.
//
// Scripted: the daemon's side of the link, which sends the records real CLIs
// wrote. No machine boots here; discovery and the owner-uid reader in a real
// machine are the Mac mini's receipts.
func TestExternalTranscriptBrowserPostgres(t *testing.T) {
	if os.Getenv("SMITHERS_LIVE_BROWSER") != "1" {
		t.Skip("set SMITHERS_LIVE_BROWSER=1 for the composed external transcript browser journey")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Minute)
	defer cancel()
	_, _, pool := splitProcessDatabase(t)
	q := db.New(pool)
	ben, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben", DisplayName: "Ben"})
	require.NoError(t, err)
	maya, err := q.CreateUser(ctx, db.CreateUserParams{Username: "maya", LowerUsername: "maya", DisplayName: "Maya"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: ben.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	for _, person := range []db.User{ben, maya} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login) VALUES($1,$2,'admin',$3)`, repo.ID, person.ID, person.Username)
		require.NoError(t, err)
		sum := sha256.Sum256([]byte(person.Username + "-browser-session"))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: person.ID, Username: person.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, ben.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, repo.ID, ben.ID)
	require.NoError(t, err)
	binding := []byte(fmt.Sprintf(`{"owner_login":"ben","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339Nano)))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: binding}))
	}
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	t.Setenv("SMITHERS_AUTH_SESSION_COOKIE_NAME", "session")
	t.Setenv("SMITHERS_PUBLIC_URL", origin)
	t.Setenv("SMITHERS_SERVER_ALLOWED_ORIGINS", origin)
	registry := new(machined.Registry)
	var resolved atomic.Int32
	api := startSplitProcess(t, Options{ChatHost: installModelHost(t, &resolved), Machined: registry})

	// The machine on main, its boot, and the terminal session the host opened
	// there for Ben: the facts a transcript record is placed by.
	var machines int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM users WHERE username='smithers-machines'`).Scan(&machines))
	branch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: machines, Name: "main-machine", TargetBookmark: "main", Kind: "vm", Status: "stopped"})
	require.NoError(t, err)
	authority, err := registry.MintBoot(branch.ID, "vm-main")
	require.NoError(t, err)
	link, peer := externalTranscriptLink(t, registry, branch.ID, authority)
	var uid uint32
	require.NoError(t, pool.QueryRow(ctx, `SELECT unix_uid FROM collaborators WHERE user_id=$1`, ben.ID).Scan(&uid))
	require.NoError(t, newMachineHost(pool, nil).Record(ctx, branch.ID, link.BootID(), 1, machined.SessionUser{Login: "ben", UID: uid}, "terminal"))

	daemon := newScriptedDaemon(peer)
	deliver := daemon.deliver
	for index, capture := range []struct{ directory, file, profile string }{
		{"codex-0.160", "rollout.jsonl", "codex-rollout/0.160"},
		{"claude-code-2.1", "session.jsonl", "claude-code/2.1"},
		{"codex-machine-0.160", "rollout.jsonl", "codex-rollout/0.160"},
	} {
		for line, record := range recordedTranscript(t, capture.directory, capture.file) {
			outcome, err := deliver(byte(index+1), capture.profile, record)
			require.NoError(t, err, "%s line %d", capture.directory, line+1)
			require.Equal(t, machined.AckApplied, outcome, "%s line %d", capture.directory, line+1)
		}
	}
	// A Codex release line the adapters do not read: the import stops at its first record.
	outcome, err := deliver(4, "codex-rollout/0.160", `{"timestamp":"2026-10-08T05:06:10.615Z","type":"session_meta","payload":{"id":"01a119e7-0000-7000-8000-000000000161","cwd":"/workspace","cli_version":"0.161.0"}}`)
	require.NoError(t, err)
	require.Equal(t, machined.AckRejected, outcome)
	// Importing 200 records of four agent processes asked for no model.
	require.Zero(t, resolved.Load(), "importing a transcript asked for an owner's model")

	app, err := filepath.Abs("../../../../apps/app")
	require.NoError(t, err)
	command := exec.CommandContext(ctx, "bun", "e2e/real/external-transcript.browser.ts")
	command.Dir = app
	command.Env = append(os.Environ(), "SMITHERS_LIVE_ORIGIN="+origin)
	stdout, err := command.StdoutPipe()
	require.NoError(t, err)
	stdin, err := command.StdinPipe()
	require.NoError(t, err)
	command.Stderr = os.Stderr
	require.NoError(t, command.Start())
	t.Cleanup(func() { cancel(); _ = command.Process.Kill() })
	scanner := bufio.NewScanner(stdout)
	var vite *url.URL
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "LIVE_BROWSER_READY ") {
			vite, err = url.Parse(strings.TrimPrefix(line, "LIVE_BROWSER_READY "))
			require.NoError(t, err)
			break
		}
		t.Log(line)
	}
	require.NotNil(t, vite, "browser fixture did not start")
	proxy := httputil.NewSingleHostReverseProxy(vite)
	live := []string{
		// Ben types a new prompt in his terminal while both members watch.
		`{"timestamp":"2026-10-08T06:00:00.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"01a1149c-ffff-7000-8000-000000000001","item":{"type":"UserMessage","id":"live-prompt","content":[{"type":"text","text":"Print the word gamma while they watch."}]},"started_at_ms":1791439200000,"completed_at_ms":1791439200000}}`,
		`{"timestamp":"2026-10-08T06:00:01.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"01a1149c-ffff-7000-8000-000000000001","item":{"type":"AgentMessage","id":"live-answer","content":[{"type":"Text","text":"gamma, printed live."}],"phase":"final_answer"},"started_at_ms":1791439201000,"completed_at_ms":1791439201000}}`,
	}
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The one test-only door: it makes the scripted daemon send the next
		// records, as a machine would when the agent writes them. Everything
		// under /api/ is the production handler, untouched.
		if r.Method == http.MethodPost && r.URL.Path == "/__agt_test/append" {
			for _, record := range live {
				outcome, err := deliver(3, "codex-rollout/0.160", record)
				if err != nil || outcome != machined.AckApplied {
					http.Error(w, fmt.Sprintf("append refused: %v %v", outcome, err), http.StatusConflict)
					return
				}
			}
			live = nil
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			api.ServeHTTP(w, r)
		} else {
			proxy.ServeHTTP(w, r)
		}
	})
	server.Start()
	defer server.Close()
	_, err = fmt.Fprintln(stdin, "ready")
	require.NoError(t, err)
	_ = stdin.Close()
	for scanner.Scan() {
		t.Log(scanner.Text())
	}
	require.NoError(t, scanner.Err())
	require.NoError(t, command.Wait())

	// The journey imported 83 entries and two live ones, launched no turn and
	// left nothing unfinished.
	var entries, open int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE NOT terminal) FROM chat_turns WHERE request_payload->>'origin'='external'`).Scan(&entries, &open))
	require.Equal(t, 85, entries)
	require.Zero(t, open)
	var ordinary int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns WHERE request_payload->>'origin' IS DISTINCT FROM 'external'`).Scan(&ordinary))
	require.Zero(t, ordinary, "importing a transcript queued an app-agent turn")
	// The only model requests of the journey are the two browsers' own: the
	// timeline asks the fast model to title the stretches it folds (#3732),
	// with no tools, and on an install without a model each settles untitled.
	t.Logf("the members' browsers asked the fast model for %d timeline titles while reading", resolved.Load())
}
