package compose

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/livedocument"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type wikiBrowser struct {
	conn   *websocket.Conn
	frames chan []byte
	client uint32
	state  string
}

func (b *wikiBrowser) receive(t *testing.T, predicate func([]byte) bool) []byte {
	t.Helper()
	timeout := time.NewTimer(15 * time.Second)
	defer timeout.Stop()
	for {
		select {
		case raw := <-b.frames:
			if predicate(raw) {
				return raw
			}
		case <-timeout.C:
			t.Fatal("wiki frame timeout")
			return nil
		}
	}
}
func yjsWiki(t *testing.T, state string, client uint32, text string) (string, []byte) {
	t.Helper()
	module, err := filepath.Abs("../../../../apps/app/node_modules/yjs/dist/yjs.mjs")
	require.NoError(t, err)
	script := fmt.Sprintf(`import * as Y from %q; const [state,id,text]=Bun.argv.slice(1);const d=new Y.Doc(); if(state)Y.applyUpdate(d,Buffer.from(state,'base64')); d.clientID=Number(id);const sv=Y.encodeStateVector(d);const y=d.getText('markdown');d.transact(()=>{y.delete(0,y.length);y.insert(0,text)});console.log(JSON.stringify({state:Buffer.from(Y.encodeStateAsUpdate(d)).toString('base64'),update:Buffer.from(Y.encodeStateAsUpdate(d,sv)).toString('base64')}));d.destroy();`, module)
	raw, err := exec.Command("bun", "-e", script, state, fmt.Sprint(client), text).CombinedOutput()
	require.NoError(t, err, string(raw))
	var answer struct{ State, Update string }
	require.NoError(t, json.Unmarshal(raw, &answer))
	update, err := base64.StdEncoding.DecodeString(answer.Update)
	require.NoError(t, err)
	return answer.State, update
}
func TestWikiHostCommittedReceiptsAndRestart(t *testing.T) {
	libraryPath := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if libraryPath == "" {
		t.Skip("native ABI required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool, databaseURL := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	// Match the install's fail-closed live upgrade and durable revocation source.
	bus := revocation.NewBus(pool, q)
	busCtx, stopBus := context.WithCancel(context.Background())
	require.NoError(t, bus.Start(busCtx))
	routes.SetRevocationSource(bus)
	t.Cleanup(func() {
		routes.SetRevocationSource(nil)
		stopRevocationListener(stopBus, bus, revocationBusStopTimeout)
	})
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "wiki-owner", LowerUsername: "wiki-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES(true,$1)`, owner.ID)
	require.NoError(t, err)
	repository, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding, _ := json.Marshal(map[string]any{"owner_login": owner.Username, "repository_name": "app", "repository_id": repository.ID})
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: binding}))
	access, _ := json.Marshal(map[string]any{"owner_login": owner.Username, "repository_name": "app", "repository_id": repository.ID, "last_access_check_at": time.Now().UTC().Format(time.RFC3339Nano)})
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: access}))
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "alice", LowerUsername: "alice"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, member.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,github_id,github_login) VALUES($1,$2,'write',102,'alice')`, repository.ID, member.ID)
	require.NoError(t, err)
	memberSum := sha256.Sum256([]byte("wiki-member"))
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES($1,$2,$3,NOW()+interval '1 hour')`, hex.EncodeToString(memberSum[:]), member.ID, member.Username)
	require.NoError(t, err)
	sum := sha256.Sum256([]byte("wiki-browser"))
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES($1,$2,$3,NOW()+interval '1 hour')`, hex.EncodeToString(sum[:]), owner.ID, owner.Username)
	require.NoError(t, err)
	native := repohostffi.New(libraryPath)
	require.NoError(t, native.Load())
	sidecar, err := repohostserver.NewWithFFI(repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "wiki-test-secret", PushHookCallbackToken: "test-callback"}, native)
	require.NoError(t, err)
	storageServer := httptest.NewServer(sidecar.Handler())
	defer storageServer.Close()
	repoHost := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: storageServer.URL}, "wiki-test-secret")
	wiki := services.NewWikiService(q, nil, services.WithWikiCollaboration(q, repoHost), services.WithWikiContent(blob.NewMemoryStore()))
	page, err := wiki.CreateWikiPage(ctx, &owner, owner.Username, "app", services.CreateWikiPageInput{Title: "Home", Slug: "home", Body: "old"})
	require.NoError(t, err)
	library, err := livedocument.Load(libraryPath)
	require.NoError(t, err)
	defer library.Close()
	host := composeWikiHost(ctx, library, q, wiki)
	defer func() { host.Close() }()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = config.AuthModeSelfHosted
	cfg.Auth.SessionCookieName = "session"
	topics := &liveTopics{queries: q, wikiDocuments: host}
	var origin string
	handler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if spa := os.Getenv("SMITHERS_WIKI_SPA_DIR"); spa != "" && !strings.HasPrefix(r.URL.Path, "/api/") {
			path := filepath.Join(spa, filepath.Clean("/"+r.URL.Path))
			if info, e := os.Stat(path); e != nil || info.IsDir() {
				path = filepath.Join(spa, "index.html")
			}
			http.ServeFile(w, r, path)
			return
		}
		hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{}, conformanceServices{live: handler, wiki: wiki}).ServeHTTP(w, r)
	}))
	defer server.Close()
	origin = server.URL
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	if harness := os.Getenv("SMITHERS_WIKI_BROWSER_HARNESS"); harness != "" {
		// Browser proof uses this same install router, database and native adapter.
		data, _ := json.Marshal(map[string]any{"origin": origin, "repo": owner.Username + "/app", "pageId": page.ID, "owner": owner.Username, "member": member.Username})
		require.NoError(t, os.WriteFile(harness, data, 0600))
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				t.Fatal("browser harness timed out")
			case <-ticker.C:
				if _, err := os.Stat(harness + ".stop"); err == nil {
					return
				}
			}
		}
	}
	connect := func(client uint32, cookie string) *wikiBrowser {
		conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Origin": {origin}, "Cookie": {"session=" + cookie}}})
		require.NoError(t, err)
		b := &wikiBrowser{conn: conn, frames: make(chan []byte, 128)}
		t.Cleanup(func() { conn.CloseNow() })
		go func() {
			for {
				_, raw, e := conn.Read(ctx)
				if e != nil {
					return
				}
				b.frames <- raw
			}
		}()
		require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"t":"sub","id":1,"topic":"doc:wiki:%d","client_id":%d}`, page.ID, client))))
		raw := b.receive(t, func(raw []byte) bool { return strings.Contains(string(raw), `"t":"snap"`) })
		var snap struct {
			Data struct {
				ClientID uint32 `json:"client_id"`
			}
		}
		require.NoError(t, json.Unmarshal(raw, &snap))
		b.client = snap.Data.ClientID
		// Yjs sync step 1 with empty vector.
		require.NoError(t, conn.Write(ctx, websocket.MessageBinary, []byte{1, 0, 0, 0, 1, 0, 1, 0}))
		raw = b.receive(t, func(raw []byte) bool { return len(raw) > 7 && raw[0] == 1 && raw[5] == 1 })
		// These small fixtures use a one-byte varuint length.
		_, n := binary.Uvarint(raw[6:])
		require.Greater(t, n, 0)
		b.state = base64.StdEncoding.EncodeToString(raw[6+n:])
		return b
	}
	a, b := connect(0, "wiki-browser"), connect(0, "wiki-member")
	require.NotEqual(t, a.client, b.client)
	// Drain bootstrap save receipts before exercising the transaction fence.
	for _, browser := range []*wikiBrowser{a, b} {
		browser.receive(t, func(raw []byte) bool { return strings.Contains(string(raw), `"t":"saved"`) })
	}
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `SELECT id FROM wiki_pages WHERE id=$1 FOR UPDATE`, page.ID)
	require.NoError(t, err)
	_, update := yjsWiki(t, a.state, a.client, "Alice")
	send := func(browser *wikiBrowser, update []byte) {
		payload := []byte{1, 0, 0, 0, 1, 2}
		payload = binary.AppendUvarint(payload, uint64(len(update)))
		payload = append(payload, update...)
		require.NoError(t, browser.conn.Write(ctx, websocket.MessageBinary, payload))
	}
	send(a, update)
	b.receive(t, func(raw []byte) bool { return len(raw) > 5 && raw[0] == 1 && raw[5] == 2 })
	_, bobUpdate := yjsWiki(t, b.state, b.client, "Bob")
	send(b, bobUpdate)
	time.Sleep(2300 * time.Millisecond)
	var revision int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT revision FROM wiki_pages WHERE id=$1`, page.ID).Scan(&revision))
	require.Equal(t, page.Revision, revision)
	for draining := true; draining; {
		select {
		case raw := <-a.frames:
			require.NotContains(t, string(raw), `"t":"saved"`)
		default:
			draining = false
		}
	}
	require.NoError(t, tx.Commit(ctx))
	raw := a.receive(t, func(raw []byte) bool { return strings.Contains(string(raw), `"t":"saved"`) })
	var receipt struct{ Seq uint64 }
	require.NoError(t, json.Unmarshal(raw, &receipt))
	require.GreaterOrEqual(t, receipt.Seq, uint64(1))
	var body string
	require.NoError(t, pool.QueryRow(ctx, `SELECT body,revision FROM wiki_pages WHERE id=$1`, page.ID).Scan(&body, &revision))
	require.Contains(t, body, "Alice")
	require.Contains(t, body, "Bob")
	require.Len(t, body, 8)
	require.Equal(t, page.Revision+1, revision)
	competitor := composeWikiHost(ctx, library, q, wiki)
	defer competitor.Close()
	source, code := competitor.Resolve(ctx, fmt.Sprintf("doc:wiki:%d", page.ID), repository.ID, owner.ID)
	require.Empty(t, code)
	_, err = source.Document.OpenClient(ctx, 0)
	require.ErrorContains(t, err, "already hosted")
	// Delete-only edit has an unchanged vector and still waits for its own SQL commit.
	var stored []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT crdt_state FROM wiki_pages WHERE id=$1`, page.ID).Scan(&stored))
	_, deletion := yjsWiki(t, base64.StdEncoding.EncodeToString(stored), a.client, "")
	send(a, deletion)
	a.receive(t, func(raw []byte) bool { return strings.Contains(string(raw), `"t":"saved"`) })
	require.NoError(t, pool.QueryRow(ctx, `SELECT body FROM wiki_pages WHERE id=$1`, page.ID).Scan(&body))
	require.Equal(t, "", body)
	a.conn.CloseNow()
	b.conn.CloseNow()
	host.Close()
	host = composeWikiHost(ctx, library, q, wiki)
	topics.wikiDocuments = host
	reopened := connect(a.client, "wiki-browser")
	_, roundtrip := yjsWiki(t, reopened.state, reopened.client, "")
	require.Equal(t, byte(0), roundtrip[0], "reopened state needs no insertion")
	var revisions int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM wiki_page_revisions WHERE page_id=$1`, page.ID).Scan(&revisions))
	require.Equal(t, 3, revisions)
	// Continuous traffic cannot postpone persistence past the ten-second cap.
	module, _ := filepath.Abs("../../../../apps/app/node_modules/yjs/dist/yjs.mjs")
	burstScript := fmt.Sprintf(`import * as Y from %q;const d=new Y.Doc();Y.applyUpdate(d,Buffer.from(Bun.argv[1],'base64'));d.clientID=Number(Bun.argv[2]);const updates=[];for(let i=0;i<1100;i++){const sv=Y.encodeStateVector(d);d.getText('markdown').insert(i,'x');updates.push(Buffer.from(Y.encodeStateAsUpdate(d,sv)).toString('base64'))}console.log(JSON.stringify(updates));d.destroy();`, module)
	burstRaw, err := exec.Command("bun", "-e", burstScript, reopened.state, fmt.Sprint(reopened.client)).CombinedOutput()
	require.NoError(t, err, string(burstRaw))
	var burst []string
	require.NoError(t, json.Unmarshal(burstRaw, &burst))
	reopened.receive(t, func(raw []byte) bool { return strings.Contains(string(raw), `"t":"saved"`) })
	started := time.Now()
	firstReceipt := time.Duration(0)
	ticker := time.NewTicker(10 * time.Millisecond)
	for _, encoded := range burst {
		<-ticker.C
		update, err := base64.StdEncoding.DecodeString(encoded)
		require.NoError(t, err)
		send(reopened, update)
		for draining := true; draining; {
			select {
			case frame := <-reopened.frames:
				if strings.Contains(string(frame), `"t":"saved"`) && firstReceipt == 0 {
					firstReceipt = time.Since(started)
				}
			default:
				draining = false
			}
		}
	}
	ticker.Stop()
	require.GreaterOrEqual(t, firstReceipt, 10*time.Second)
	require.Less(t, firstReceipt, 11*time.Second)
	reopened.receive(t, func(raw []byte) bool { return strings.Contains(string(raw), `"t":"saved"`) })
	require.NoError(t, pool.QueryRow(ctx, `SELECT body,revision FROM wiki_pages WHERE id=$1`, page.ID).Scan(&body, &revision))
	require.Equal(t, strings.Repeat("x", 1100), body)
	require.Equal(t, page.Revision+4, revision, "100 updates/sec create two batches, not 1100 revisions")
	reopened.conn.CloseNow()
	host.Close()
	// A real killed process has no chance to flush or run Close. The database
	// belongs to this parent, so its normal test cleanup survives every kill.
	startChild := func() (*exec.Cmd, string) {
		address := filepath.Join(t.TempDir(), "address")
		child := exec.Command(os.Args[0], "-test.run=^TestWikiHostCrashChild$", "-test.v")
		child.Env = append(os.Environ(), "SMITHERS_WIKI_CRASH_DATABASE="+databaseURL, "SMITHERS_WIKI_CRASH_ADDRESS="+address)
		var logs strings.Builder
		child.Stdout = &logs
		child.Stderr = &logs
		require.NoError(t, child.Start())
		t.Cleanup(func() {
			if child.ProcessState == nil {
				child.Process.Kill()
				child.Wait()
			}
		})
		var childOrigin string
		require.Eventually(t, func() bool {
			raw, err := os.ReadFile(address)
			if err == nil {
				childOrigin = string(raw)
			}
			return childOrigin != ""
		}, 10*time.Second, 10*time.Millisecond, "child startup")

		return child, childOrigin
	}
	// Kill before idle persistence with two clients retaining their causal edits.
	uncommitted, uncommittedOrigin := startChild()
	origin = uncommittedOrigin
	left, right := connect(0, "wiki-browser"), connect(0, "wiki-member")
	for _, browser := range []*wikiBrowser{left, right} {
		browser.receive(t, func(raw []byte) bool { return strings.Contains(string(raw), `"t":"saved"`) })
	}
	_, leftUpdate := yjsWiki(t, left.state, left.client, "unreceipted owner")
	_, rightUpdate := yjsWiki(t, right.state, right.client, "unreceipted member")
	send(left, leftUpdate)
	send(right, rightUpdate)
	time.Sleep(time.Second)
	require.NoError(t, uncommitted.Process.Kill())
	require.Error(t, uncommitted.Wait())
	left.conn.CloseNow()
	right.conn.CloseNow()
	require.NoError(t, pool.QueryRow(ctx, `SELECT body FROM wiki_pages WHERE id=$1`, page.ID).Scan(&body))
	require.Equal(t, strings.Repeat("x", 1100), body, "unreceipted host state did not commit")
	replaying, replayOrigin := startChild()
	origin = replayOrigin
	replayLeft, replayRight := connect(left.client, "wiki-browser"), connect(right.client, "wiki-member")
	for _, browser := range []*wikiBrowser{replayLeft, replayRight} {
		browser.receive(t, func(raw []byte) bool { return strings.Contains(string(raw), `"t":"saved"`) })
	}
	send(replayLeft, leftUpdate)
	send(replayRight, rightUpdate)
	replayLeft.receive(t, func(raw []byte) bool { return strings.Contains(string(raw), `"t":"saved"`) })
	require.NoError(t, pool.QueryRow(ctx, `SELECT body FROM wiki_pages WHERE id=$1`, page.ID).Scan(&body))
	require.Contains(t, body, "unreceipted owner")
	require.Contains(t, body, "unreceipted member")
	require.Equal(t, len("unreceipted owner")+len("unreceipted member"), len(body), "replay retains each keystroke once")
	replayLeft.conn.CloseNow()
	replayRight.conn.CloseNow()
	require.NoError(t, replaying.Process.Kill())
	require.Error(t, replaying.Wait())
	child, childOrigin := startChild()
	origin = childOrigin
	typing := connect(0, "wiki-browser")
	_, keystrokes := yjsWiki(t, typing.state, typing.client, "receipted keystrokes")
	typing.receive(t, func(raw []byte) bool { return strings.Contains(string(raw), `"t":"saved"`) })
	send(typing, keystrokes)
	typing.receive(t, func(raw []byte) bool { return strings.Contains(string(raw), `"t":"saved"`) })
	typing.conn.CloseNow()
	require.NoError(t, child.Process.Kill())
	require.Error(t, child.Wait())
	require.NoError(t, pool.QueryRow(ctx, `SELECT body FROM wiki_pages WHERE id=$1`, page.ID).Scan(&body))
	require.Equal(t, "receipted keystrokes", body)
	recovered, recoveryOrigin := startChild()
	origin = recoveryOrigin
	reading := connect(0, "wiki-browser")
	require.NotEmpty(t, reading.state)
	// The state read through the restarted live boundary renders the same text.
	module, _ = filepath.Abs("../../../../apps/app/node_modules/yjs/dist/yjs.mjs")
	script := fmt.Sprintf(`import * as Y from %q;const d=new Y.Doc();Y.applyUpdate(d,Buffer.from(Bun.argv[1],'base64'));console.log(d.getText('markdown').toString());d.destroy();`, module)
	raw, err = exec.Command("bun", "-e", script, reading.state).CombinedOutput()
	require.NoError(t, err, string(raw))
	require.Equal(t, "receipted keystrokes", strings.TrimSpace(string(raw)))
	reading.conn.CloseNow()
	require.NoError(t, recovered.Process.Kill())
	require.Error(t, recovered.Wait())

	// Admission and update policy are exercised over the composed socket, with
	// native Yrs validating each candidate before the shared document changes.
	origin = server.URL
	host = composeWikiHost(ctx, library, q, wiki)
	topics.wikiDocuments = host
	for _, attack := range []string{"foreign", "authors", "root", "oversized"} {
		t.Run("refuse "+attack, func(t *testing.T) {
			browser := connect(0, "wiki-member")
			defer browser.conn.CloseNow()
			browser.receive(t, func(raw []byte) bool { return strings.Contains(string(raw), `"t":"saved"`) })
			var before []byte
			var revision int64
			require.NoError(t, pool.QueryRow(ctx, `SELECT crdt_state,revision FROM wiki_pages WHERE id=$1`, page.ID).Scan(&before, &revision))
			script := fmt.Sprintf(`import * as Y from %q;const [state,id,attack]=Bun.argv.slice(1);const d=new Y.Doc();Y.applyUpdate(d,Buffer.from(state,'base64'));d.clientID=Number(id);const sv=Y.encodeStateVector(d);if(attack==='foreign')d.clientID=Number(id)===12345?12346:12345;if(attack==='authors')d.getMap('authors').set(String(id),'forged');else if(attack==='root')d.getText('injected').insert(0,'bad');else d.getText('markdown').insert(0,attack==='oversized'?'x'.repeat(1048577):'bad');console.log(Buffer.from(Y.encodeStateAsUpdate(d,sv)).toString('base64'));d.destroy();`, module)
			raw, err := exec.Command("bun", "-e", script, browser.state, fmt.Sprint(browser.client), attack).CombinedOutput()
			require.NoError(t, err, string(raw))
			update, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
			require.NoError(t, err)
			send(browser, update)
			refused := browser.receive(t, func(raw []byte) bool {
				require.NotContains(t, string(raw), `"t":"saved"`)
				return strings.Contains(string(raw), `"t":"err"`)
			})
			require.Contains(t, string(refused), `"id":1`)
			var after []byte
			var afterRevision int64
			require.NoError(t, pool.QueryRow(ctx, `SELECT crdt_state,revision FROM wiki_pages WHERE id=$1`, page.ID).Scan(&after, &afterRevision))
			require.Equal(t, before, after)
			require.Equal(t, revision, afterRevision)
		})
	}
	// Remove repository membership while a valid subscription is idle. No next
	// keystroke or other traffic is needed to terminate it within five seconds.
	revoked := connect(0, "wiki-member")
	revoked.receive(t, func(raw []byte) bool { return strings.Contains(string(raw), `"t":"saved"`) })
	started = time.Now()
	_, err = pool.Exec(ctx, `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, repository.ID, member.ID)
	require.NoError(t, err)
	refused := revoked.receive(t, func(raw []byte) bool { return strings.Contains(string(raw), `"t":"err"`) })
	require.Contains(t, string(refused), `"code":"forbidden"`)
	require.Less(t, time.Since(started), 5*time.Second)
	revoked.conn.CloseNow()

}
