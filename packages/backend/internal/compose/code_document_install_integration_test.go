package compose

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
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
		require.Equal(t, 2, install.daemon.opened(), "each subscription is its own daemon stream")

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

		// Suspending Alice's membership ends her document within 5 s.
		_, err := install.pool.Exec(t.Context(), `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, install.alice)
		require.NoError(t, err)
		removed := time.Now()
		alice.text(t, `{"t":"err","id":7,"code":"forbidden"}`)
		require.Less(t, time.Since(removed), 5*time.Second)
	})
	t.Run("production clients co-edit", func(t *testing.T) {
		install := startCodeDocumentInstall(t, true)
		script, err := filepath.Abs("../../../../apps/app/e2e/real/code-document-install.fixture.ts")
		require.NoError(t, err)
		command := exec.CommandContext(t.Context(), "bun", "run", script)
		command.Env = append(os.Environ(), "SMITHERS_CODE_DOCUMENT_ORIGIN="+install.origin, "SMITHERS_CODE_DOCUMENT_TOPIC="+install.topic)
		output, err := command.CombinedOutput()
		require.NoError(t, err, string(output))
		lines := strings.Split(strings.TrimSpace(string(output)), "\n")
		var result struct {
			Text       string
			Ben, Alice uint32
			Samples    int
			P95        float64
		}
		require.NoError(t, json.Unmarshal([]byte(lines[len(lines)-1]), &result), string(output))
		t.Logf("%d keystrokes, p95 %.1f ms", result.Samples, result.P95)
		require.Equal(t, 41, result.Samples)
		require.Equal(t, result.Text, install.daemon.text(t), "the daemon holds what both pages show")
		members := install.daemon.clientMembers(t, install)
		require.Equal(t, map[int64]bool{install.ben: true}, members[result.Ben], "Ben's characters carry only Ben's actor")
		require.Equal(t, map[int64]bool{install.alice: true}, members[result.Alice], "Alice's characters carry only Alice's actor")
	})
}

type codeDocumentInstall struct {
	origin, branch, topic string
	ben, alice            int64
	pool                  *pgxpool.Pool
	daemon                *scriptedDocumentDaemon
}

func startCodeDocumentInstall(t *testing.T, activate bool) *codeDocumentInstall {
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
	handler := startCodeDocumentProcess(t, Options{
		Repository:        repohost.NewClient(&repohost.StaticStorageSetResolver{URL: repositoryURL}, "split-process-repo"),
		ChatHost:          unusedChatHost{},
		Workspace:         runtime,
		BranchMachines:    rehearsalBranchMachines(pool),
		Machined:          registry,
		LiveCodeDocuments: activate,
		// The install requires a product origin for Flow hosts; none run here.
		FlowHostProductAPIURL: origin,
	})
	server.Config.Handler = handler
	server.Start()
	t.Cleanup(server.Close)

	link, guest := presenceTestLink(t, registry, branch.ID)
	require.NoError(t, link.Connection.Reconciled())
	daemon := serveScriptedDocumentDaemon(t, guest)
	return &codeDocumentInstall{origin: origin, branch: branch.ID, topic: "doc:code:" + branch.ID + ":retry.ts", ben: ben, alice: alice, pool: pool, daemon: daemon}
}

// startCodeDocumentProcess is startSplitProcess with the product's log kept
// for a failing test's report.
func startCodeDocumentProcess(t *testing.T, options Options) http.Handler {
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
	t.Cleanup(func() {
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
	select {
	case handler := <-ready:
		return handler
	case <-finished:
		t.Fatalf("composition stopped before ready: %v", runErr)
	case <-time.After(60 * time.Second):
		t.Fatal("composition did not become ready")
	}
	return nil
}

type codeDocumentBrowser struct {
	conn *websocket.Conn
	doc  *livedocument.Document
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
	t.Helper()
	require.NoError(t, b.conn.Write(t.Context(), websocket.MessageText, []byte(`{"t":"sub","id":7,"topic":"`+topic+`"}`)))
}

func (b *codeDocumentBrowser) read(t *testing.T) (websocket.MessageType, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	kind, raw, err := b.conn.Read(ctx)
	require.NoError(t, err)
	return kind, raw
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
	require.NotZero(t, snap.Data.ClientID)
	// Like the browser provider, ask the daemon for its state (sync step 1).
	require.NoError(t, b.conn.Write(t.Context(), websocket.MessageBinary, append([]byte{1, 0, 0, 0, 7}, codeSync(0, []byte{0})...)))
	for {
		kind, raw = b.read(t)
		require.Equal(t, websocket.MessageBinary, kind, string(raw))
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

// scriptedDocumentDaemon stands in for the branch daemon on the guest end
// of the authenticated link: one stream per subscription, a daemon-allocated
// client id, fan-out to the other streams and an immediate receipt per update.
// It does not enforce the daemon's actor checks or touch a disk.
type scriptedDocumentDaemon struct {
	mu      sync.Mutex
	doc     *livedocument.Document
	guest   net.Conn
	next    uint32
	streams map[uint32]*scriptedStream
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

func serveScriptedDocumentDaemon(t *testing.T, guest net.Conn) *scriptedDocumentDaemon {
	t.Helper()
	library, err := livedocument.Load(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NoError(t, err)
	doc, err := library.Open(livedocument.Code, nil)
	require.NoError(t, err)
	d := &scriptedDocumentDaemon{doc: doc, guest: guest, streams: map[uint32]*scriptedStream{}, next: 5}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			frame, err := wire.Read(guest)
			if err != nil {
				return
			}
			d.mu.Lock()
			err = d.handle(frame)
			d.mu.Unlock()
			if err != nil {
				d.fail(err)
				return
			}
		}
	}()
	t.Cleanup(func() {
		guest.Close()
		<-done
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

func (d *scriptedDocumentDaemon) write(stream uint32, msg wire.Document) error {
	payload, err := wire.EncodeDocumentV2(msg)
	if err != nil {
		return err
	}
	return wire.Write(d.guest, wire.Frame{Kind: wire.Documents, Stream: stream, Payload: payload})
}

// fanOut is the daemon's job under relay: other streams receive each update.
func (d *scriptedDocumentDaemon) fanOut(from uint32, update []byte) error {
	for stream := range d.streams {
		if stream != from {
			if err := d.write(stream, wire.Document{Msg: wire.DocumentSync, Data: codeSync(2, update)}); err != nil {
				return err
			}
		}
	}
	return nil
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
			author, err := d.doc.SetAuthor(uint64(client), hex.EncodeToString(actor))
			if err != nil {
				return err
			}
			return d.fanOut(stream, author)
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
	if err != nil || msg.Msg != wire.DocumentInput {
		return err
	}
	kind, payload, err := codeSyncParts(msg.Data)
	if err != nil {
		return err
	}
	switch kind {
	case 0:
		state, err := d.doc.Sync2(payload)
		if err != nil {
			return err
		}
		return d.write(frame.Stream, wire.Document{Msg: wire.DocumentSync, Data: codeSync(1, state)})
	case 2:
		if _, err := d.doc.Peer(payload); err != nil {
			return err
		}
		d.inputs = append(d.inputs, scriptedDocumentInput{actor: append([]byte(nil), msg.Actor...), seq: msg.Seq, update: append([]byte(nil), payload...)})
		sv, err := d.doc.Sync1()
		if err != nil {
			return err
		}
		if err := d.write(frame.Stream, wire.Document{Msg: wire.DocumentSaved, AtMS: uint64(time.Now().UnixMilli()), ThroughSeq: msg.Seq, Data: sv}); err != nil {
			return err
		}
		return d.fanOut(frame.Stream, payload)
	}
	return nil
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
