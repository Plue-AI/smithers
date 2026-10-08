package compose

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/livedocument"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	processruntime "github.com/smithersai/smithers/packages/backend/process"
	"github.com/stretchr/testify/require"
)

// The composed install, PostgreSQL, member admission, /api/live, the relay and
// the authenticated daemon link are production code. The guest end of the
// link is a scripted daemon on the native core with immediate receipts: this
// proves routing, attribution and receipts through the install, not the
// daemon's checks, disk durability or latency (C-DUR-04 K7, C-J3-04 and
// C-PERF-03 run on the reference host).
func TestLiveCodeDocumentsComposedInstall(t *testing.T) {
	t.Run("dark without activation", func(t *testing.T) {
		install := startCodeDocumentInstall(t, false)
		ben := install.browser(t, "ben-cookie")
		ben.sub(t, install.topic)
		ben.text(t, `{"t":"err","id":7,"code":"unsupported"}`)
		require.Zero(t, install.daemon.opened(), "a dark install never opens a daemon document")
	})
	t.Run("two members co-edit one file", func(t *testing.T) {
		install := startCodeDocumentInstall(t, true)
		ben, alice := install.browser(t, "ben-cookie"), install.browser(t, "alice-cookie")
		ben.sub(t, install.topic)
		benClient := ben.assigned(t)
		alice.sub(t, install.topic)
		aliceClient := alice.assigned(t)
		require.NotEqual(t, benClient, aliceClient)
		require.Equal(t, 1, install.daemon.opened(), "one daemon stream serves every subscriber")

		started := time.Now()
		ben.edit(t, codeInsert(benClient, "ben types "))
		ben.saved(t, 1)
		alice.converge(t, "ben types ")
		require.Less(t, time.Since(started), time.Second, "a keystroke reaches the other member within 1 s")
		alice.edit(t, codeInsert(aliceClient, "alice types "))
		alice.saved(t, 1)
		ben.converge(t, install.daemon.text(t))
		alice.converge(t, install.daemon.text(t))
		require.Contains(t, install.daemon.text(t), "ben types ")
		require.Contains(t, install.daemon.text(t), "alice types ")

		// Each edit reaches the daemon under its author's committed actor, never
		// an identity the browser chose.
		authors := install.daemon.authors(t, install)
		require.Contains(t, authors, "ben types ")
		require.Equal(t, install.ben, authors["ben types "])
		require.Equal(t, install.alice, authors["alice types "])

		// Ben's socket cannot speak as Alice: the host stamps Ben's actor on a
		// frame that extends Alice's client, so the daemon's check refuses it.
		ben.edit(t, codeInsertAt(aliceClient, uint64(len("alice types ")), "forged"))
		ben.saved(t, 2)
		forged := install.daemon.authors(t, install)
		require.Equal(t, install.ben, forged["forged"])

		// Suspending Alice without any revocation event: her cached admission
		// expires and her frames stop within 5 s while she keeps typing.
		_, err := install.pool.Exec(t.Context(), `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, install.alice)
		require.NoError(t, err)
		removed := time.Now()
		typing, stop := context.WithCancel(t.Context())
		defer stop()
		go func() {
			ticker := time.NewTicker(100 * time.Millisecond)
			defer ticker.Stop()
			for clock := uint64(len("alice types ")); typing.Err() == nil; clock++ {
				frame := append([]byte{1, 0, 0, 0, 7}, codeSync(2, codeInsertAt(aliceClient, clock, "z"))...)
				if alice.conn.Write(typing, websocket.MessageBinary, frame) != nil {
					return
				}
				<-ticker.C
			}
		}()
		alice.text(t, `{"t":"err","id":7,"code":"forbidden"}`)
		require.Less(t, time.Since(removed), 5*time.Second)
		time.Sleep(200 * time.Millisecond) // a frame already past admission may land
		refusedAt := install.daemon.inputsFrom(t, install, install.alice)
		time.Sleep(500 * time.Millisecond)
		stop()
		require.Equal(t, refusedAt, install.daemon.inputsFrom(t, install, install.alice), "no frame of hers reaches the daemon after the refusal")
	})
	t.Run("production clients co-edit", func(t *testing.T) {
		install := startCodeDocumentInstall(t, true)
		script, err := filepath.Abs("../../../../apps/app/e2e/real/code-document-install.fixture.ts")
		require.NoError(t, err)
		run, cancel := context.WithTimeout(t.Context(), 3*time.Minute)
		defer cancel()
		command := exec.CommandContext(run, "bun", "run", script)
		command.Env = append(os.Environ(), "SMITHERS_CODE_DOCUMENT_ORIGIN="+install.origin, "SMITHERS_CODE_DOCUMENT_TOPIC="+install.topic)
		stdin, err := command.StdinPipe()
		require.NoError(t, err)
		stdout, err := command.StdoutPipe()
		require.NoError(t, err)
		stderr := &lockedBuffer{}
		command.Stderr = stderr
		require.NoError(t, command.Start())
		// The fixture asks for a host restart while Ben is typing.
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 1<<20), 1<<20)
		var last string
		restarts := 0
		for scanner.Scan() {
			if scanner.Text() == "RESTART" {
				install.restart(t)
				restarts++
				_, err = io.WriteString(stdin, "RESTARTED\n")
				require.NoError(t, err)
				require.NoError(t, stdin.Close())
				continue
			}
			last = scanner.Text()
		}
		require.NoError(t, command.Wait(), stderr.String())
		require.Equal(t, 1, restarts)
		var result struct {
			Text       string
			Ben, Alice uint32
			Samples    int
			P95        float64
		}
		require.NoError(t, json.Unmarshal([]byte(last), &result), last)
		t.Logf("%d keystrokes, p95 %.1f ms", result.Samples, result.P95)
		require.Equal(t, 41, result.Samples)
		require.Equal(t, result.Text, install.daemon.text(t), "the daemon holds what both pages show")
		members := install.daemon.clientMembers(t, install)
		require.Equal(t, map[int64]bool{install.ben: true}, members[result.Ben], "Ben's characters carry only Ben's actor")
		require.Equal(t, map[int64]bool{install.alice: true}, members[result.Alice], "Alice's characters carry only Alice's actor")
	})
}

// Development campaign only: the authenticated composed router, installed Linux
// daemon and production Chromium editor run for five minutes per flag. This
// never qualifies the reference Mac or activates production live documents.
func TestCodeDocumentLatencyCampaign(t *testing.T) {
	if os.Getenv("SMITHERS_CODE_LATENCY_CAMPAIGN") != "1" {
		t.Skip("opt-in ten-minute C-UI-14 development campaign")
	}
	require.NotEmpty(t, os.Getenv("SMITHERS_REHEARSAL_MACHINED_FAULT_BINARY"), "the campaign requires the installed daemon, not scripted receipts")
	real := startRealDocumentInstall(t, "")
	install := real.codeDocumentInstall
	guestEnvironment := []string{"SMITHERS_CODE_DOCUMENT_GUEST=installed-linux-daemon", "SMITHERS_CODE_DOCUMENT_DISK=" + filepath.Join(real.root, "retry.ts")}
	script, err := filepath.Abs("../../../../apps/app/e2e/real/code-document-latency.campaign.ts")
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, "bun", "run", script)
	command.Env = append(os.Environ(), "SMITHERS_CODE_DOCUMENT_ORIGIN="+install.origin, "SMITHERS_CODE_DOCUMENT_TOPIC="+install.topic)
	command.Env = append(command.Env, guestEnvironment...)
	output, err := command.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		var state, machine string
		queryErr := install.pool.QueryRow(t.Context(), `SELECT status,vm_id FROM workspaces WHERE id=$1`, install.branch).Scan(&state, &machine)
		t.Logf("campaign machine state=%s machine=%s query=%v", state, machine, queryErr)
		link, linkErr := install.options.Machined.Current(install.branch)
		if linkErr == nil {
			t.Logf("campaign admission readiness: %v", link.Connection.RequireReady(install.branch))
		} else {
			t.Logf("campaign daemon link: %v", linkErr)
		}
	}
	require.NoError(t, err)
}

type codeDocumentInstall struct {
	origin, branch, topic string
	ben, alice            int64
	pool                  *pgxpool.Pool
	daemon                *scriptedDocumentDaemon
	options               Options
	handler               atomic.Value
	stop                  func()
}

// restart stops the composed host and starts a new one on the same database
// with a fresh link registry, as an install restart does. The daemon keeps
// running with its documents and authors map; the browsers reconnect.
func (install *codeDocumentInstall) restart(t *testing.T) {
	t.Helper()
	install.handler.Store(http.Handler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "restarting", http.StatusServiceUnavailable)
	})))
	install.stop()
	registry := new(machined.Registry)
	options := install.options
	options.Machined = registry
	handler, stop := startCodeDocumentProcess(t, options)
	install.stop = stop
	link, guest := presenceTestLink(t, registry, install.branch)
	require.NoError(t, link.Connection.Reconciled())
	install.daemon.serve(t, guest)
	install.handler.Store(handler)
}

func startCodeDocumentInstall(t *testing.T, activate bool) *codeDocumentInstall {
	return startCodeDocumentInstallWithRepository(t, activate, nil, nil)
}

// A guest callback replaces only the scripted peer, before any document opens.
// Both variants use the same install router, authorization and relay.
func startCodeDocumentInstallWithRepository(t *testing.T, activate bool, repository *repohost.Client, guest func(*codeDocumentInstall, *machined.Registry)) *codeDocumentInstall {
	t.Helper()
	libraryPath := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	require.NotEmpty(t, libraryPath, "the native document library is required")
	repositoryURL, _, pool := splitProcessDatabase(t)
	q, ctx := db.New(pool), t.Context()
	t.Setenv("SMITHERS_FEATURE_FLAGS_WORKSPACES", "true")
	t.Setenv("SMITHERS_FEATURE_FLAGS_SANDBOXES", "true")
	user := func(login string) int64 {
		created, err := q.CreateUser(ctx, db.CreateUserParams{Username: login, LowerUsername: login, DisplayName: strings.ToUpper(login[:1]) + login[1:]})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, created.ID)
		require.NoError(t, err)
		digest := sha256.Sum256([]byte(login + "-cookie"))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: created.ID, Username: login, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return created.ID
	}
	ben, alice := user("ben"), user("alice")
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, ben)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: ben, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"ben","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login) VALUES($1,$2,'admin','ben')`, repo.ID, ben)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,github_id,github_login,unix_login) VALUES($1,$2,'write',102,'alice','alice')`, repo.ID, alice)
	require.NoError(t, err)
	machineOwner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	branch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: machineOwner, TargetBookmark: "scratch/ben/retry", Kind: "container", Status: "running"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id='machine' WHERE id=$1`, branch.ID)
	require.NoError(t, err)
	for _, member := range []int64{ben, alice} {
		_, err = q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: branch.ID, OwnerUserID: machineOwner, GranteeUserID: member, Level: "write"})
		require.NoError(t, err)
	}

	runtime, err := processruntime.New(processruntime.Config{Root: t.TempDir(), MaxConcurrent: 2, OutputLimit: 1 << 20})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	registry := new(machined.Registry)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	t.Setenv("SMITHERS_PUBLIC_URL", origin)
	options := Options{
		Repository:        repohost.NewClient(&repohost.StaticStorageSetResolver{URL: repositoryURL}, "split-process-repo"),
		ChatHost:          unusedChatHost{},
		Workspace:         runtime,
		BranchMachines:    rehearsalBranchMachines(pool),
		Machined:          registry,
		LiveCodeDocuments: activate,
		// The install requires a product origin for Flow hosts; none run here.
		FlowHostProductAPIURL: origin,
	}
	if repository != nil {
		options.Repository = repository
	}
	handler, stop := startCodeDocumentProcess(t, options)
	install := &codeDocumentInstall{origin: origin, branch: branch.ID, topic: "doc:code:" + branch.ID + ":retry.ts", ben: ben, alice: alice, pool: pool, options: options, stop: stop}
	install.handler.Store(handler)
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		install.handler.Load().(http.Handler).ServeHTTP(w, r)
	})
	server.Start()
	t.Cleanup(server.Close)

	if guest != nil {
		guest(install, registry)
		return install
	}
	link, peer := presenceTestLink(t, registry, branch.ID)
	require.NoError(t, link.Connection.Reconciled())
	install.daemon = newScriptedDocumentDaemon(t)
	install.daemon.serve(t, peer)
	return install
}

// startCodeDocumentProcess is startSplitProcess with the product's log kept
// for a failing test's report.
func startCodeDocumentProcess(t *testing.T, options Options) (http.Handler, func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan http.Handler, 1)
	finished := make(chan struct{})
	logs := &lockedBuffer{}
	var runErr error
	go func() {
		runErr = StartWithOptions(ctx, nil, logs, logs, options, func(handler http.Handler) { ready <- handler })
		close(finished)
	}()
	var once sync.Once
	stop := func() {
		once.Do(func() {
			cancel()
			select {
			case <-finished:
				require.NoError(t, runErr)
			case <-time.After(30 * time.Second):
				t.Error("composition did not stop")
			}
			if t.Failed() {
				for _, line := range strings.Split(logs.String(), "\n") {
					if !strings.Contains(line, "INFO") {
						t.Log(line)
					}
				}
			}
		})
	}
	t.Cleanup(stop)
	select {
	case handler := <-ready:
		return handler, stop
	case <-finished:
		t.Fatalf("composition stopped before ready: %v", runErr)
	case <-time.After(60 * time.Second):
		t.Fatal("composition did not become ready")
	}
	return nil, stop
}

type codeDocumentBrowser struct {
	conn  *websocket.Conn
	doc   *livedocument.Document
	epoch string
}

func (install *codeDocumentInstall) browser(t *testing.T, cookie string) *codeDocumentBrowser {
	t.Helper()
	conn, response, err := websocket.Dial(t.Context(), "ws"+strings.TrimPrefix(install.origin, "http")+"/api/live", &websocket.DialOptions{
		Subprotocols: []string{live.Protocol},
		HTTPHeader:   http.Header{"Origin": {install.origin}, "Cookie": {"smithers_session=" + cookie}},
	})
	if response != nil && response.Body != nil {
		defer response.Body.Close()
	}
	require.NoError(t, err)
	conn.SetReadLimit(4 << 20)
	t.Cleanup(func() { conn.CloseNow() })
	library, err := livedocument.Load(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NoError(t, err)
	doc, err := library.Open(livedocument.Code, nil)
	require.NoError(t, err)
	t.Cleanup(func() { doc.Close(); library.Close() })
	return &codeDocumentBrowser{conn: conn, doc: doc}
}

func (b *codeDocumentBrowser) sub(t *testing.T, topic string) {
	b.subClient(t, topic, 0)
}

func (b *codeDocumentBrowser) subClient(t *testing.T, topic string, client uint32) {
	t.Helper()
	frame := map[string]any{"t": "sub", "id": 7, "topic": topic}
	if client != 0 {
		frame["client_id"] = client
	}
	raw, err := json.Marshal(frame)
	require.NoError(t, err)
	require.NoError(t, b.conn.Write(t.Context(), websocket.MessageText, raw))
}

func (b *codeDocumentBrowser) read(t *testing.T) (websocket.MessageType, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	for {
		kind, raw, err := b.conn.Read(ctx)
		require.NoError(t, err)
		if kind == websocket.MessageText && strings.Contains(string(raw), `"t":"authors"`) {
			var projection struct {
				Data map[string]struct {
					Kind, Login, Name string
					Color             int `json:"color_index"`
				}
			}
			require.NoError(t, json.Unmarshal(raw, &projection))
			require.NotEmpty(t, projection.Data)
			for reference, actor := range projection.Data {
				if reference == "outside" {
					require.Equal(t, "outside", actor.Kind)
					require.Equal(t, 7, actor.Color)
					continue
				}
				require.Len(t, reference, 32)
				require.Equal(t, "person", actor.Kind)
				require.Contains(t, []string{"ben", "alice"}, actor.Login)
				require.Contains(t, []string{"Ben", "Alice"}, actor.Name)
				require.GreaterOrEqual(t, actor.Color, 0)
			}
			continue
		}
		return kind, raw
	}
}

// text skips document sync frames and receipts until the next text frame that
// is neither, so refusals are asserted exactly.
func (b *codeDocumentBrowser) text(t *testing.T, want string) {
	t.Helper()
	for {
		kind, raw := b.read(t)
		if kind == websocket.MessageBinary {
			b.apply(t, raw)
			continue
		}
		if strings.Contains(string(raw), `"t":"saved"`) {
			continue
		}
		require.Equal(t, want, string(raw))
		return
	}
}

func (b *codeDocumentBrowser) assigned(t *testing.T) uint32 {
	t.Helper()
	kind, raw := b.read(t)
	require.Equal(t, websocket.MessageText, kind, string(raw))
	var snap struct {
		T    string
		Data struct {
			Epoch    string
			ClientID uint32 `json:"client_id"`
		}
	}
	require.NoError(t, json.Unmarshal(raw, &snap))
	require.Equal(t, "snap", snap.T, string(raw))
	require.Len(t, snap.Data.Epoch, 32)
	b.epoch = snap.Data.Epoch
	require.NotZero(t, snap.Data.ClientID)
	// Like the browser provider, ask the daemon for its state (sync step 1).
	require.NoError(t, b.conn.Write(t.Context(), websocket.MessageBinary, append([]byte{1, 0, 0, 0, 7}, codeSync(0, []byte{0})...)))
	for {
		kind, raw = b.read(t)
		if kind == websocket.MessageText {
			require.Contains(t, string(raw), `"t":"saved"`, "only receipts for earlier inputs may precede sync step 2")
			continue
		}
		if b.apply(t, raw) == 1 {
			return snap.Data.ClientID
		}
	}
}

func (b *codeDocumentBrowser) apply(t *testing.T, raw []byte) byte {
	t.Helper()
	require.Equal(t, []byte{1, 0, 0, 0, 7}, raw[:5])
	kind, update := codeDecode(t, raw[5:])
	_, err := b.doc.Peer(update)
	require.NoError(t, err)
	return kind
}

func (b *codeDocumentBrowser) edit(t *testing.T, update []byte) {
	t.Helper()
	_, err := b.doc.Peer(update)
	require.NoError(t, err)
	require.NoError(t, b.conn.Write(t.Context(), websocket.MessageBinary, append([]byte{1, 0, 0, 0, 7}, codeSync(2, update)...)))
}

// saved waits for the daemon receipt that covers this browser's seq.
func (b *codeDocumentBrowser) saved(t *testing.T, seq uint64) {
	t.Helper()
	for {
		kind, raw := b.read(t)
		if kind == websocket.MessageBinary {
			b.apply(t, raw)
			continue
		}
		var receipt struct {
			T   string
			ID  uint32
			SV  string
			Seq uint64
		}
		require.NoError(t, json.Unmarshal(raw, &receipt), string(raw))
		require.Equal(t, "saved", receipt.T, string(raw))
		require.Equal(t, uint32(7), receipt.ID)
		require.NotEmpty(t, receipt.SV)
		require.LessOrEqual(t, receipt.Seq, seq)
		if receipt.Seq == seq {
			return
		}
	}
}

// converge reads frames until this browser's replica holds want.
func (b *codeDocumentBrowser) converge(t *testing.T, want string) {
	t.Helper()
	for {
		text, err := b.doc.Text("content")
		require.NoError(t, err)
		if text == want {
			return
		}
		kind, raw := b.read(t)
		if kind == websocket.MessageBinary {
			b.apply(t, raw)
		}
	}
}

// scriptedDocumentDaemon stands in for the branch daemon on the guest end of
// the authenticated link. Like its document dispatcher it answers each input
// with exactly one frame, in order: sync step 2, or the update's echo followed
// by an immediate receipt. It does not enforce the daemon's actor checks.
type scriptedDocumentDaemon struct {
	mu      sync.Mutex
	doc     *livedocument.Document
	guest   net.Conn
	next    uint32
	streams map[uint32]*scriptedStream
	// owners mirrors the document's durable authors map: client → actor key.
	owners  map[uint32]string
	serving sync.WaitGroup
	opens   int
	inputs  []scriptedDocumentInput
	// unhandled records other control requests for a failing run's report.
	unhandled []string
	failed    error
}

type scriptedStream struct {
	actor  []byte
	client uint32
}

type scriptedDocumentInput struct {
	actor  []byte
	seq    uint64
	update []byte
}

func newScriptedDocumentDaemon(t *testing.T) *scriptedDocumentDaemon {
	t.Helper()
	library, err := livedocument.Load(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NoError(t, err)
	doc, err := library.Open(livedocument.Code, nil)
	require.NoError(t, err)
	d := &scriptedDocumentDaemon{doc: doc, streams: map[uint32]*scriptedStream{}, owners: map[uint32]string{}, next: 5}
	t.Cleanup(func() {
		d.mu.Lock()
		guest := d.guest
		d.mu.Unlock()
		if guest != nil {
			guest.Close()
		}
		d.serving.Wait()
		d.mu.Lock()
		defer d.mu.Unlock()
		if t.Failed() {
			t.Log("daemon requests without a scripted reply:", d.unhandled)
		}
		require.NoError(t, d.failed)
		doc.Close()
		library.Close()
	})
	return d
}

// serve answers one authenticated host link. A new link (a host restart)
// starts with no open streams; documents and authors persist.
func (d *scriptedDocumentDaemon) serve(t *testing.T, guest net.Conn) {
	t.Helper()
	d.mu.Lock()
	if d.guest != nil {
		// The previous host is gone; its connection ends with it.
		d.guest.Close()
	}
	d.guest = guest
	d.streams = map[uint32]*scriptedStream{}
	d.mu.Unlock()
	d.serving.Add(1)
	go func() {
		defer d.serving.Done()
		for {
			frame, err := wire.Read(guest)
			if err != nil {
				return
			}
			d.mu.Lock()
			if d.guest != guest {
				d.mu.Unlock()
				return
			}
			err = d.handle(frame)
			d.mu.Unlock()
			if errors.Is(err, io.ErrClosedPipe) {
				// The host closed this link mid-reply (its shutdown or restart).
				return
			}
			if err != nil {
				d.fail(err)
				return
			}
		}
	}()
}

func (d *scriptedDocumentDaemon) write(stream uint32, msg wire.Document) error {
	payload, err := wire.EncodeDocumentV2(msg)
	if err != nil {
		return err
	}
	return wire.Write(d.guest, wire.Frame{Kind: wire.Documents, Stream: stream, Payload: payload})
}

func (d *scriptedDocumentDaemon) handle(frame wire.Frame) error {
	if frame.Kind == wire.Control {
		id, method, args, err := frame.Request()
		if err != nil {
			return err
		}
		result := wire.Union(method)
		switch method {
		case byte(wire.OpenDoc):
			fields, err := wire.Fields("args13", args)
			if err != nil {
				return err
			}
			// principal: variant 1, struct length, field 1, actor length, actor.
			principal := fields[2]
			if len(principal) < 10 || principal[0] != 1 || principal[5] != 1 || int(binary.BigEndian.Uint32(principal[6:10])) != len(principal)-10 {
				return wire.BadValue
			}
			actor := append([]byte(nil), principal[10:]...)
			stream, client := d.next, 7000+d.next
			d.next += 2
			d.opens++
			result = wire.Union(13, wire.Field(1, wire.U32(stream)))
			if err := wire.Write(d.guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, result))}); err != nil {
				return err
			}
			if err := d.write(stream, wire.Document{Msg: wire.DocumentEpoch, Epoch: [16]byte{0x0c, 0x0d, 0xe0, 0x08}, ClientID: client}); err != nil {
				return err
			}
			d.streams[stream] = &scriptedStream{actor: actor, client: client}
			d.owners[client] = hex.EncodeToString(actor)
			_, err = d.doc.SetAuthor(uint64(client), hex.EncodeToString(actor))
			return err
		case byte(wire.CloseDoc):
			fields, err := wire.Fields("args14", args)
			if err == nil && len(fields[1]) == 4 {
				delete(d.streams, binary.BigEndian.Uint32(fields[1]))
			}
		case byte(wire.SetRoster):
		default:
			d.unhandled = append(d.unhandled, fmt.Sprintf("%s method %d", time.Now().Format("15:04:05.000"), method))
			return nil
		}
		return wire.Write(d.guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, result))})
	}
	if frame.Kind != wire.Documents {
		return nil
	}
	if d.streams[frame.Stream] == nil {
		return fmt.Errorf("input on unopened stream %d", frame.Stream)
	}
	msg, err := wire.DecodeDocumentV2(frame.Payload)
	if err != nil {
		return err
	}
	if msg.Msg == wire.DocumentAwarenessInput {
		// Like peer_awareness: a client's notice is echoed only when the
		// authors map assigns that client to the envelope's actor.
		client, n := binary.Uvarint(msg.Data[1:])
		if n <= 0 || d.owners[uint32(client)] != hex.EncodeToString(msg.Actor) {
			return d.write(frame.Stream, wire.Document{Msg: 255, Refusal: 11})
		}
		return d.write(frame.Stream, wire.Document{Msg: wire.DocumentAwareness, Data: msg.Data})
	}
	if msg.Msg != wire.DocumentInput {
		return fmt.Errorf("unexpected document message %d", msg.Msg)
	}
	kind, payload, err := codeSyncParts(msg.Data)
	if err != nil {
		return err
	}
	if kind == 0 {
		state, err := d.doc.Sync2(payload)
		if err != nil {
			return err
		}
		return d.write(frame.Stream, wire.Document{Msg: wire.DocumentSync, Data: codeSync(1, state)})
	}
	if _, err := d.doc.Peer(payload); err != nil {
		return err
	}
	if client, key, ok := parseRegistration(payload); ok && key == hex.EncodeToString(msg.Actor) {
		d.owners[client] = key
	}
	d.inputs = append(d.inputs, scriptedDocumentInput{actor: append([]byte(nil), msg.Actor...), seq: msg.Seq, update: append([]byte(nil), payload...)})
	if err := d.write(frame.Stream, wire.Document{Msg: wire.DocumentSync, Data: codeSync(2, payload)}); err != nil {
		return err
	}
	sv, err := d.doc.Sync1()
	if err != nil {
		return err
	}
	return d.write(frame.Stream, wire.Document{Msg: wire.DocumentSaved, AtMS: uint64(time.Now().UnixMilli()), ThroughSeq: msg.Seq, Data: sv})
}

func (d *scriptedDocumentDaemon) fail(err error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.failed == nil {
		d.failed = err
	}
}

func (d *scriptedDocumentDaemon) opened() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.opens
}

func (d *scriptedDocumentDaemon) text(t *testing.T) string {
	t.Helper()
	d.mu.Lock()
	defer d.mu.Unlock()
	text, err := d.doc.Text("content")
	require.NoError(t, err)
	return text
}

// authors maps each inserted literal string to the member its daemon actor
// resolves to through the committed actor reference.
func (d *scriptedDocumentDaemon) authors(t *testing.T, install *codeDocumentInstall) map[string]int64 {
	t.Helper()
	d.mu.Lock()
	inputs := append([]scriptedDocumentInput(nil), d.inputs...)
	d.mu.Unlock()
	out := map[string]int64{}
	tx, err := install.pool.Begin(t.Context())
	require.NoError(t, err)
	defer tx.Rollback(t.Context())
	for _, input := range inputs {
		actor, err := machined.ResolveActorInTx(t.Context(), tx, install.branch, "machine", input.actor)
		require.NoError(t, err)
		require.Equal(t, "person", actor.Kind)
		for _, literal := range []string{"ben types ", "alice types ", "forged"} {
			if strings.Contains(string(input.update), literal) {
				out[literal] = actor.MemberID
			}
		}
	}
	return out
}

// inputsFrom counts the daemon inputs stamped with member's actor.
func (d *scriptedDocumentDaemon) inputsFrom(t *testing.T, install *codeDocumentInstall, member int64) int {
	t.Helper()
	d.mu.Lock()
	inputs := append([]scriptedDocumentInput(nil), d.inputs...)
	d.mu.Unlock()
	tx, err := install.pool.Begin(t.Context())
	require.NoError(t, err)
	defer tx.Rollback(t.Context())
	n := 0
	for _, input := range inputs {
		actor, err := machined.ResolveActorInTx(t.Context(), tx, install.branch, "machine", input.actor)
		require.NoError(t, err)
		if actor.MemberID == member {
			n++
		}
	}
	return n
}

// clientMembers resolves the actor of every single-client update the daemon
// received, by Yjs client id. Host author registrations share one client.
func (d *scriptedDocumentDaemon) clientMembers(t *testing.T, install *codeDocumentInstall) map[uint32]map[int64]bool {
	t.Helper()
	d.mu.Lock()
	inputs := append([]scriptedDocumentInput(nil), d.inputs...)
	d.mu.Unlock()
	tx, err := install.pool.Begin(t.Context())
	require.NoError(t, err)
	defer tx.Rollback(t.Context())
	out := map[uint32]map[int64]bool{}
	for _, input := range inputs {
		clients, n := binary.Uvarint(input.update)
		if n <= 0 || clients != 1 {
			continue
		}
		rest := input.update[n:]
		if _, n = binary.Uvarint(rest); n <= 0 {
			continue
		}
		client, n := binary.Uvarint(rest[n:])
		require.Positive(t, n)
		actor, err := machined.ResolveActorInTx(t.Context(), tx, install.branch, "machine", input.actor)
		require.NoError(t, err)
		if out[uint32(client)] == nil {
			out[uint32(client)] = map[int64]bool{}
		}
		out[uint32(client)][actor.MemberID] = true
	}
	return out
}

// codeInsertAt is codeInsert at a literal clock: a client's next struct.
func codeInsertAt(client uint32, clock uint64, text string) []byte {
	b := binary.AppendUvarint([]byte{1, 1}, uint64(client))
	b = binary.AppendUvarint(b, clock)
	b = append(b, 4, 1, 7)
	b = append(b, []byte("content")...)
	b = binary.AppendUvarint(b, uint64(len(text)))
	b = append(b, []byte(text)...)
	return append(b, 0)
}

// parseRegistration reads the host's one-item authors registration:
// authors[client] = key, as ADR 0004 S3 describes.
func parseRegistration(update []byte) (uint32, string, bool) {
	read := func() (uint64, bool) {
		v, n := binary.Uvarint(update)
		if n <= 0 {
			return 0, false
		}
		update = update[n:]
		return v, true
	}
	str := func() (string, bool) {
		n, ok := read()
		if !ok || n > uint64(len(update)) {
			return "", false
		}
		v := string(update[:n])
		update = update[n:]
		return v, true
	}
	for _, want := range []uint64{1, 1} {
		if v, ok := read(); !ok || v != want {
			return 0, "", false
		}
	}
	if _, ok := read(); !ok || len(update) < 3 || update[0] != 0 || update[1] != 0x28 || update[2] != 1 {
		return 0, "", false
	}
	update = update[3:]
	if root, ok := str(); !ok || root != "authors" {
		return 0, "", false
	}
	id, ok := str()
	if !ok || len(update) < 2 || update[0] != 1 || update[1] != 119 {
		return 0, "", false
	}
	update = update[2:]
	key, ok := str()
	client, err := strconv.ParseUint(id, 10, 32)
	if !ok || err != nil || len(update) != 1 || update[0] != 0 {
		return 0, "", false
	}
	return uint32(client), key, true
}

func codeSyncParts(b []byte) (byte, []byte, error) {
	if len(b) == 0 {
		return 0, nil, wire.ErrDocumentPayload
	}
	n, k := binary.Uvarint(b[1:])
	if k <= 0 || int(n) != len(b)-1-k {
		return 0, nil, wire.ErrDocumentPayload
	}
	return b[0], b[1+k:], nil
}
