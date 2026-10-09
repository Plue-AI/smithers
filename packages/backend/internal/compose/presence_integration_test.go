package compose

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/runtimebridge"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type presenceBridgeFixture struct{ *runtimebridge.Client }

func (p presenceBridgeFixture) CallRPC(ctx context.Context, _ flowruntime.Target, procedure string, payload json.RawMessage) (json.RawMessage, error) {
	return p.Client.CallRPC(ctx, procedure, payload)
}
func (presenceBridgeFixture) StartHost(context.Context, flowruntime.Target) (bool, error) {
	panic("presence must never start a host")
}
func (presenceBridgeFixture) RefuseRelay(context.Context, flowruntime.Target, string, json.RawMessage) error {
	return nil
}

func realPresenceBridge(t *testing.T) *runtimebridge.Client {
	t.Helper()
	node, err := exec.LookPath("node")
	require.NoError(t, err)
	root, err := filepath.Abs("../../../..")
	require.NoError(t, err)
	// Fixture hosts only packaged presence metadata; no repository code or VM
	// is needed to exercise the actual TS roster and authenticated CallRPC.
	ctx, cancel := context.WithCancel(t.Context())
	cmd := exec.CommandContext(ctx, node, filepath.Join(root, "packages/smithers/gateway/test/host-presence-fixture.ts"))
	var logs bytes.Buffer
	cmd.Stderr = &logs
	output, err := cmd.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, cmd.Start())
	t.Cleanup(func() { cancel(); _ = cmd.Wait() })
	ports := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(output)
		for scanner.Scan() {
			if line := scanner.Text(); strings.HasPrefix(line, "PORT=") {
				ports <- strings.TrimPrefix(line, "PORT=")
				return
			}
		}
	}()
	var port string
	select {
	case port = <-ports:
	case <-time.After(90 * time.Second):
		t.Fatal("TS host did not start", logs.String())
	}
	bridge, err := runtimebridge.New(runtimebridge.Config{Endpoint: "http://127.0.0.1:" + port, Credential: "presence-fixture"})
	require.NoError(t, err)
	return bridge
}

// Literal TODO provider facts exercise enrichment through the composed live socket.
type presenceTodoFixture struct{ branch string }

func (f presenceTodoFixture) Todo(ctx context.Context, repository, number int64) (map[string]any, error) {
	cards, err := f.Todos(ctx, repository)
	return cards[0], err
}
func (f presenceTodoFixture) Todos(context.Context, int64) ([]map[string]any, error) {
	return []map[string]any{{"n": 1, "title": "Retry webhooks", "state": "working", "place": 2, "branch": map[string]any{"id": f.branch}, "rebase_pending": map[string]any{"onto": "main"}}}, nil
}

type presenceInstallFixture struct {
	p           *branchPresence
	todos       *services.MythicalService
	topics      *liveTopics
	row         db.Workspace
	user        db.User
	url, origin string
	bus         *revocation.Bus
	publish     *revocation.DBPublisher
	cookie      string
	pool        *pgxpool.Pool
}

func presenceInstall(t *testing.T, withBroker ...bool) presenceInstallFixture {
	return presenceInstallWithTodos(t, false, withBroker...)
}

func presenceInstallWithTodos(t *testing.T, realTodos bool, withBroker ...bool) presenceInstallFixture {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "presence-owner", LowerUsername: "presence-owner", DisplayName: "Alice"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, user.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: user.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"presence-owner","repository_name":"app","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	access := strings.TrimSuffix(binding, "}") + fmt.Sprintf(`,"last_access_check_at":%q}`, time.Now().UTC().Format(time.RFC3339))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(access)}))
	row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: user.ID, Name: "presence", TargetBookmark: "scratch/presence-owner/presence", Kind: "vm", Status: "running"})
	require.NoError(t, err)
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, user.ID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo.ID)
	require.NoError(t, err)
	cookie := "presence-cookie"
	sum := sha256.Sum256([]byte(cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	todoService := services.NewMythicalService(pool, nil)
	todoContext := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &user, SessionHash: hex.EncodeToString(sum[:])})
	_, err = todoService.FileTodo(todoContext, repo.ID, user.ID, services.MythicalTodoInput{Title: "Retry webhooks", Prompt: "Retry webhooks", Request: "presence-item"})
	require.NoError(t, err)
	item, err := q.GetMythicalItemByNumber(ctx, repo.ID, 1)
	require.NoError(t, err)
	_, _, err = q.BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: row.ID, RepositoryID: repo.ID, ItemID: item.ID, Name: "presence"})
	require.NoError(t, err)
	providers := services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)
	// The install's command authority, as main.go composes it: a request door
	// such as GetBranch admits only a live request credential, which a card
	// refresh never carries.
	branches := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(pool), services.WithBranchMachineProviders(providers), services.WithWorkspaceInstallAuthorization(q))
	hosts, _ := presenceHostBinding(t, pool, row, user.ID)
	p := &branchPresence{hosts: hosts, visits: &presenceVisits{audit: services.NewAuditService(q), now: time.Now}, queries: q, branches: branches, dispatcher: presenceBridgeFixture{realPresenceBridge(t)}, members: &services.Members{Pool: pool}}
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(ctx))
	routes.SetRevocationSource(bus)
	t.Cleanup(func() { routes.SetRevocationSource(nil) })
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	topics := &liveTopics{changePool: pool, queries: q, presence: p, todos: presenceTodoFixture{branch: row.ID}}
	var hints live.Hints
	if len(withBroker) > 0 && withBroker[0] {
		broker := sse.NewBroker(pool)
		require.NoError(t, broker.Start(ctx))
		t.Cleanup(broker.Stop)
		hints = live.BrokerHints{Broker: broker}
	}
	handler := &routes.LiveHandler{Queries: q, Hub: live.NewHub(ctx, hints), Origins: func() []string { return []string{origin} }, Topics: topics.resolver, Presence: p.session}
	extras := routerExtras{Live: handler}
	if realTodos {
		topics.todos = todoService
		extras.Mythical = &routes.MythicalHandler{Service: todoService}
	}
	server.Config.Handler = githubAppSetupComposeRouter(cfg, pool, nil, extras)
	server.Start()
	t.Cleanup(server.Close)
	return presenceInstallFixture{p: p, todos: todoService, topics: topics, row: row, user: user, url: "ws" + strings.TrimPrefix(origin, "http") + "/api/live", origin: origin, bus: bus, publish: revocation.NewDBPublisher(q, bus), cookie: cookie, pool: pool}
}
func (f presenceInstallFixture) dial(t *testing.T) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	conn, response, err := websocket.Dial(ctx, f.url, &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Origin": {f.origin}, "Cookie": {"session=" + f.cookie}}})
	if err != nil {
		t.Fatalf("live upgrade: %v response=%v", err, response)
	}
	conn.SetReadLimit(live.SendBudget)
	t.Cleanup(func() { conn.CloseNow() })
	return conn
}
func sendPresenceFrame(t *testing.T, c *websocket.Conn, raw string) {
	t.Helper()
	require.NoError(t, c.Write(t.Context(), websocket.MessageText, []byte(raw)))
}
func readPresenceFrame(t *testing.T, c *websocket.Conn) liveFrame {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	_, raw, err := c.Read(ctx)
	require.NoError(t, err)
	var frame liveFrame
	require.NoError(t, json.Unmarshal(raw, &frame))
	return frame
}
func (f presenceInstallFixture) roster(t *testing.T) []leaseParticipant {
	t.Helper()
	raw, err := f.p.call(t.Context(), f.row, "presence-owner/app", "Branch.Roster", map[string]any{})
	require.NoError(t, err)
	var rows []leaseParticipant
	require.NoError(t, json.Unmarshal(raw, &rows))
	return rows
}

func TestPresenceSessionBinding(t *testing.T) {
	f := presenceInstall(t)
	one, two := f.dial(t), f.dial(t)
	sendPresenceFrame(t, one, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	require.Equal(t, "snap", readPresenceFrame(t, one).T)
	move := fmt.Sprintf(`{"t":"presence","id":1,"actor":"spoofed","sessionId":"foreign","where":{"branch":%q,"path":"retry.ts","line":12}}`, f.row.ID)
	sendPresenceFrame(t, one, move)
	changed := readPresenceFrame(t, one)
	require.Equal(t, "snap", changed.T)
	require.Contains(t, string(changed.Data), `"line":12`)
	require.Contains(t, string(changed.Data), `"name":"Alice"`)
	require.NotContains(t, string(changed.Data), "spoofed")
	sendPresenceFrame(t, two, move)
	require.Eventually(t, func() bool { return len(f.roster(t)) == 2 }, time.Second, 10*time.Millisecond)
	rows := f.roster(t)
	require.Equal(t, "member:"+strconv.FormatInt(f.user.ID, 10), rows[0].ParticipantID)
	require.NotEqual(t, rows[0].SessionID, rows[1].SessionID)
	_ = two.Close(websocket.StatusNormalClosure, "")
	require.Eventually(t, func() bool { return len(f.roster(t)) == 1 }, time.Second, 10*time.Millisecond)
	// A move with the same ID did not unsubscribe the Branch card.
	sendPresenceFrame(t, one, fmt.Sprintf(`{"t":"presence","id":1,"where":{"branch":%q,"path":"retry.ts","line":40}}`, f.row.ID))
	// Join/leave snapshots can already be queued on this subscription. Read
	// through them without treating an intermediate roster as the move receipt.
	moveCtx, cancelMove := context.WithTimeout(t.Context(), time.Second)
	defer cancelMove()
	for {
		_, raw, err := one.Read(moveCtx)
		require.NoError(t, err, "last move was not delivered within 1 second")
		var frame liveFrame
		require.NoError(t, json.Unmarshal(raw, &frame))
		require.Equal(t, "snap", frame.T)
		if strings.Contains(string(frame.Data), `"line":40`) {
			break
		}
	}
	require.NoError(t, f.publish.Publish(t.Context(), revocation.Event{Kind: revocation.KindBrowserSessionRevoked, TokenHash: fmt.Sprintf("%x", sha256.Sum256([]byte(f.cookie)))}))
	require.Eventually(t, func() bool { return len(f.roster(t)) == 0 }, time.Second, 10*time.Millisecond)
}

func TestPresenceUnavailableFailsClosed(t *testing.T) {
	f := presenceInstall(t)
	conn := f.dial(t)
	for _, where := range []string{`{"branch":"foreign","path":"retry.ts"}`, fmt.Sprintf(`{"branch":%q,"path":"../secret"}`, f.row.ID), fmt.Sprintf(`{"branch":%q,"terminal":"foreign"}`, f.row.ID), fmt.Sprintf(`{"branch":%q,"watching":"foreign"}`, f.row.ID), fmt.Sprintf(`{"branch":%q,"run":"finished","step":"review"}`, f.row.ID)} {
		sendPresenceFrame(t, conn, `{"t":"presence","id":8,"where":`+where+`}`)
		frame := readPresenceFrame(t, conn)
		require.Equal(t, "err", frame.T)
		require.Contains(t, []string{live.Forbidden, live.Unsupported}, frame.Code)
	}
	require.Empty(t, f.roster(t))
	state, err := f.p.call(t.Context(), f.row, "presence-owner/app", "Branch.PresenceOn", map[string]any{})
	require.NoError(t, err)
	require.JSONEq(t, `"unknown"`, string(state))
}

func TestPresenceDeltaCoalescing(t *testing.T) {
	f := presenceInstall(t)
	writer, reader := f.dial(t), f.dial(t)
	sendPresenceFrame(t, reader, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	_ = readPresenceFrame(t, reader)
	frames := make(chan liveFrame, 20)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	go func() {
		for {
			_, raw, err := reader.Read(ctx)
			if err != nil {
				return
			}
			var frame liveFrame
			if json.Unmarshal(raw, &frame) == nil {
				frame.At = time.Now()
				frames <- frame
			}
		}
	}()
	start := time.Now()
	for line := 1; line <= 100; line++ {
		sendPresenceFrame(t, writer, fmt.Sprintf(`{"t":"presence","id":2,"where":{"branch":%q,"path":"retry.ts","line":%d}}`, f.row.ID, line))
		time.Sleep(10 * time.Millisecond)
	}
	received := []liveFrame{}
	last := false
	for deadline := time.After(time.Second); !last; {
		select {
		case frame := <-frames:
			require.Equal(t, "snap", frame.T)
			received = append(received, frame)
			last = strings.Contains(string(frame.Data), `"line":100`)
		case <-deadline:
			t.Fatal("last move was not delivered within 1 second")
		}
	}
	for i, frame := range received {
		count := 0
		for _, other := range received[i:] {
			if other.At.Sub(frame.At) < time.Second {
				count++
			}
		}
		require.LessOrEqual(t, count, 4)
	}
	require.Less(t, received[len(received)-1].At.Sub(start), 2*time.Second)
}

// Clock injection covers the two-minute boundary without waiting two minutes;
// every membership transition still enters through the composed /api/live.
func TestPresenceVisitAudit(t *testing.T) {
	f := presenceInstall(t)
	base := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	var seconds atomic.Int64
	f.p.visits.now = func() time.Time { return base.Add(time.Duration(seconds.Load()) * time.Second) }
	beat := func(c *websocket.Conn, at int64, line int) {
		seconds.Store(at)
		sendPresenceFrame(t, c, fmt.Sprintf(`{"t":"presence","id":7,"where":{"branch":%q,"path":"retry.ts","line":%d}}`, f.row.ID, line))
		require.Eventually(t, func() bool {
			f.p.visits.mu.Lock()
			defer f.p.visits.mu.Unlock()
			for _, v := range f.p.visits.visits {
				if v.last.Equal(base.Add(time.Duration(at) * time.Second)) {
					return true
				}
			}
			return false
		}, time.Second, 10*time.Millisecond)
	}
	finish := func(c *websocket.Conn, at int64) {
		seconds.Store(at)
		sendPresenceFrame(t, c, `{"t":"presence","id":7,"where":{"branch":""}}`)
	}
	empty := func() {
		require.Eventually(t, func() bool { f.p.visits.mu.Lock(); defer f.p.visits.mu.Unlock(); return len(f.p.visits.visits) == 0 }, time.Second, 10*time.Millisecond)
	}
	count := func() int {
		var n int
		require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_log WHERE event_type='presence'`).Scan(&n))
		return n
	}
	one, two := f.dial(t), f.dial(t)
	for at := int64(0); at <= 110; at += 10 {
		beat(one, at, int(at)+1)
	}
	finish(one, 119)
	empty()
	require.Equal(t, 0, count())
	for at := int64(3600); at <= 3710; at += 10 {
		beat(one, at, int(at)+1)
	}
	beat(two, 3710, 4000)
	require.Eventually(t, func() bool {
		f.p.visits.mu.Lock()
		defer f.p.visits.mu.Unlock()
		for _, visit := range f.p.visits.visits {
			if len(visit.sessions) == 2 {
				return true
			}
		}
		return false
	}, time.Second, 10*time.Millisecond)
	finish(one, 3719)
	require.Eventually(t, func() bool { return len(f.roster(t)) == 1 }, time.Second, 10*time.Millisecond)
	require.Equal(t, 0, count())
	finish(two, 3720)
	empty()
	require.Equal(t, 1, count())
	var metadata []byte
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT metadata FROM audit_log WHERE event_type='presence' AND action='visit'`).Scan(&metadata))
	require.JSONEq(t, fmt.Sprintf(`{"branch":%q,"member":%d,"via":"app","start":"2026-10-05T13:00:00Z","end":"2026-10-05T13:02:00Z"}`, f.row.ID, f.user.ID), string(metadata))
}

// An expired second tab cannot hold the visit open after the last active tab
// leaves. Both announcements and departure go through the install live door.
func TestPresenceVisitAuditExpiredTabCleanLeave(t *testing.T) {
	f := presenceInstall(t)
	base := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	var seconds atomic.Int64
	f.p.visits.now = func() time.Time { return base.Add(time.Duration(seconds.Load()) * time.Second) }
	active, lost := f.dial(t), f.dial(t)
	beat := func(c *websocket.Conn, at int64) {
		seconds.Store(at)
		sendPresenceFrame(t, c, fmt.Sprintf(`{"t":"presence","id":7,"where":{"branch":%q}}`, f.row.ID))
		require.Eventually(t, func() bool {
			f.p.visits.mu.Lock()
			defer f.p.visits.mu.Unlock()
			for _, visit := range f.p.visits.visits {
				if visit.last.Equal(base.Add(time.Duration(at) * time.Second)) {
					return true
				}
			}
			return false
		}, time.Second, 10*time.Millisecond)
	}
	beat(lost, 0)
	for at := int64(1); at <= 121; at += 10 {
		beat(active, at)
	}
	seconds.Store(122)
	sendPresenceFrame(t, active, `{"t":"presence","id":7,"where":{"branch":""}}`)
	require.Eventually(t, func() bool {
		var n int
		err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_log WHERE event_type='presence' AND action='visit'`).Scan(&n)
		return err == nil && n == 1
	}, time.Second, 10*time.Millisecond)
	var metadata []byte
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT metadata FROM audit_log WHERE event_type='presence' AND action='visit'`).Scan(&metadata))
	require.JSONEq(t, fmt.Sprintf(`{"branch":%q,"member":%d,"via":"app","start":"2026-10-06T12:00:00Z","end":"2026-10-06T12:02:02Z"}`, f.row.ID, f.user.ID), string(metadata))
	// The lost tab's later leave cannot emit a duplicate visit.
	sendPresenceFrame(t, lost, `{"t":"presence","id":7,"where":{"branch":""}}`)
	require.Eventually(t, func() bool { return len(f.roster(t)) == 0 }, time.Second, 10*time.Millisecond)
	var count int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_log WHERE event_type='presence'`).Scan(&count))
	require.Equal(t, 1, count)
}

// Machine state and branch names change under an already mounted card. These
// facts are read over the composed install socket, with no wake request.
func TestPresenceBranchRefreshMachineNameAndOrigin(t *testing.T) {
	f := presenceInstall(t)
	origin := "https://factory.example:8443"
	f.p.publicOrigin = func() string { return origin }
	conn := f.dial(t)
	sendPresenceFrame(t, conn, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	first := readPresenceFrame(t, conn)
	require.Equal(t, "snap", first.T)
	require.Contains(t, string(first.Data), `"state":"awake"`)
	require.Contains(t, string(first.Data), `"item":{"n":1,"place":2,"state":"working","title":"Retry webhooks"}`)
	require.Contains(t, string(first.Data), `"rebase":{"onto":"main","state":"pending"}`)
	require.Contains(t, string(first.Data), `"ssh_line":"ssh -p 2222 scratch/presence-owner/presence@factory.example"`)
	for _, state := range []struct{ stored, visible string }{{"releasing", "releasing"}, {"suspended", "asleep"}, {"starting", "waking"}, {"running", "awake"}} {
		_, err := f.pool.Exec(t.Context(), `UPDATE workspaces SET status=$2 WHERE id=$1`, f.row.ID, state.stored)
		require.NoError(t, err)
		frame := readPresenceFrame(t, conn)
		require.Equal(t, "snap", frame.T)
		require.Contains(t, string(frame.Data), `"state":"`+state.visible+`"`)
	}
	_, err := f.pool.Exec(t.Context(), `UPDATE workspaces SET status='suspended', head_commit_id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', target_bookmark='scratch/presence-owner/renamed' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	second := readPresenceFrame(t, conn)
	require.Equal(t, "snap", second.T)
	require.Contains(t, string(second.Data), `"state":"asleep"`)
	require.Contains(t, string(second.Data), `"head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"`)
	require.Contains(t, string(second.Data), `"item":{"n":1,"place":2,"state":"working","title":"Retry webhooks"}`)
	require.Contains(t, string(second.Data), `"name":"scratch/presence-owner/renamed"`)
	require.Contains(t, string(second.Data), `"ssh_line":"ssh -p 2222 scratch/presence-owner/renamed@factory.example"`)
	require.Contains(t, string(second.Data), `"id":"`+f.row.ID+`"`)
	var status string
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT status FROM workspaces WHERE id=$1`, f.row.ID).Scan(&status))
	require.Equal(t, "suspended", status, "subscription never wakes a branch")
}

// The mounted Branch card follows the same coalesced queue as branch GET.
func TestPresenceBranchMachineWaitPosition(t *testing.T) {
	f := presenceInstall(t)
	q := db.New(f.pool)
	runtime := new(microsandbox.Runtime)
	providers := services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)
	f.p.branches = services.NewWorkspaceService(q, services.WithWorkspaceTransactions(f.pool), services.WithWorkspaceRuntime(runtime), services.WithBranchMachineProviders(providers))
	_, err := f.pool.Exec(t.Context(), `UPDATE workspaces SET status='starting', vm_id='' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	holder := "workspace:" + f.row.ID
	_, err = runtime.Request("todo", holder, "todo:1", "machine")
	require.NoError(t, err)
	_, err = runtime.Request("person", "workspace:other", "person:2", "terminal")
	require.NoError(t, err)
	conn := f.dial(t)
	sendPresenceFrame(t, conn, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	read := func(position int) {
		t.Helper()
		frame := readPresenceFrame(t, conn)
		require.Equal(t, "snap", frame.T)
		var branch struct {
			Machine struct {
				State    string `json:"state"`
				Position int    `json:"position"`
			} `json:"machine"`
		}
		require.NoError(t, json.Unmarshal(frame.Data, &branch))
		if position > 0 {
			require.Equal(t, "waiting", branch.Machine.State)
		} else {
			require.Equal(t, "waking", branch.Machine.State)
		}
		require.Equal(t, position, branch.Machine.Position)
		if position == 0 {
			require.NotContains(t, string(frame.Data), `"position"`)
		}
	}
	read(2)
	runtime.CancelAdmission("workspace:other", "person:2", time.Now())
	read(1)
	runtime.CancelAdmission(holder, "todo:1", time.Now())
	read(0)
	require.Zero(t, runtime.InUse(), "subscribing and ranking do not wake a machine")
}

// C-INS-03: a mounted Branch card follows committed Address changes without
// a wake or a process restart, and falls back to localhost on This Mac only.
func TestPresenceBranchRefreshCommittedInstallAddress(t *testing.T) {
	f := presenceInstall(t)
	address := &services.InstallAddress{Configured: []string{"http://localhost:4000"}, Listen: func(string) error { return nil }}
	setup := &services.InstallSetupService{Pool: f.pool, Address: address}
	f.p.publicOrigin = address.Public
	conn := f.dial(t)
	sendPresenceFrame(t, conn, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	first := readPresenceFrame(t, conn)
	require.Contains(t, string(first.Data), `"ssh_line":"ssh -p 2222 scratch/presence-owner/presence@localhost"`)
	require.NoError(t, setup.SetAddress(t.Context(), f.user.ID, services.InstallSetupInput{Bind: "0.0.0.0:4000", Origins: []string{"http://lan-a:4000", "https://box.example"}}))
	second := readPresenceFrame(t, conn)
	require.Contains(t, string(second.Data), `"ssh_line":"ssh -p 2222 scratch/presence-owner/presence@lan-a"`)
	require.NoError(t, setup.SetAddress(t.Context(), f.user.ID, services.InstallSetupInput{Origins: []string{"http://localhost:4000"}}))
	third := readPresenceFrame(t, conn)
	require.Contains(t, string(third.Data), `"ssh_line":"ssh -p 2222 scratch/presence-owner/presence@localhost"`)
	var status string
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT status FROM workspaces WHERE id=$1`, f.row.ID).Scan(&status))
	require.Equal(t, "running", status)
}

// Fork metadata is already stored by the stack service. Captured reads expose it
// on the same topic and a subsequent item binding replaces the scratch facts.
// A TODO's lane keeps the stack's bookmark, an internal identity. Its Branch
// card names the TODO's branch, smithers/<slug>, and copies the SSH line that
// logs in by the slug (spec §8.1.1, §8.10.1).
func TestPresenceTodoBranchNameAndSSHLogin(t *testing.T) {
	f := presenceInstallWithTodos(t, true)
	lane, err := db.New(f.pool).GetMythicalLane(t.Context(), f.row.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `UPDATE workspaces SET target_bookmark='mythical', name='TODO 1 attempt 1 g1' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `UPDATE mythical_items SET workspace_id=$2 WHERE id=$1`, lane.ItemID, f.row.ID)
	require.NoError(t, err)
	conn := f.dial(t)
	sendPresenceFrame(t, conn, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	first := readPresenceFrame(t, conn)
	require.Equal(t, "snap", first.T, string(first.Data))
	require.Contains(t, string(first.Data), `"name":"smithers/retry-webhooks"`)
	require.Contains(t, string(first.Data), `"ssh_line":"ssh -p 2222 retry-webhooks@localhost"`)
	require.NotContains(t, string(first.Data), `mythical`)
	require.NotContains(t, string(first.Data), `attempt 1`)
	// The retained coding branch is still the TODO's branch after its lane
	// is released. The sleeping Branch card must agree with the TODO card.
	_, err = f.pool.Exec(t.Context(), `UPDATE workspaces SET status='suspended' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `UPDATE mythical_items SET workspace_id='', state='proposed' WHERE id=$1`, lane.ItemID)
	require.NoError(t, err)
	for {
		frame := readPresenceFrame(t, conn)
		if !strings.Contains(string(frame.Data), `"state":"asleep"`) || !strings.Contains(string(frame.Data), `"state":"in_review"`) {
			continue
		}
		require.Contains(t, string(frame.Data), `"name":"smithers/retry-webhooks"`)
		require.Contains(t, string(frame.Data), `"ssh_line":"ssh -p 2222 retry-webhooks@localhost"`)
		require.NotContains(t, string(frame.Data), `mythical`)
		request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, f.origin+"/api/todos/1", nil)
		require.NoError(t, err)
		request.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		require.Equal(t, http.StatusOK, response.StatusCode)
		var todo struct {
			Branch struct {
				Name string `json:"name"`
			} `json:"branch"`
		}
		require.NoError(t, json.NewDecoder(response.Body).Decode(&todo))
		require.Equal(t, "smithers/retry-webhooks", todo.Branch.Name, "the real TODO and sleeping Branch projections agree")
		break
	}
}

func TestPresenceScratchSourceAndItemCutover(t *testing.T) {
	f := presenceInstall(t)
	q := db.New(f.pool)
	lane, err := q.GetMythicalLane(t.Context(), f.row.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `DELETE FROM mythical_lanes WHERE workspace_id=$1`, f.row.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `UPDATE workspaces SET is_fork=true, status='suspended', forked_from_item=$2 WHERE id=$1`, f.row.ID, lane.ItemID)
	require.NoError(t, err)
	conn := f.dial(t)
	sendPresenceFrame(t, conn, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	first := readPresenceFrame(t, conn)
	require.Equal(t, "snap", first.T)
	require.Contains(t, string(first.Data), `"scratch":{"forked_from":{"kind":"item","n":1,"title":"Retry webhooks"}}`)
	require.NotContains(t, string(first.Data), `"item":`)
	require.Contains(t, string(first.Data), `"state":"asleep"`)
	_, err = f.pool.Exec(t.Context(), `UPDATE workspaces SET forked_from_item=NULL WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	second := readPresenceFrame(t, conn)
	require.Contains(t, string(second.Data), `"scratch":{"forked_from":{"kind":"main"}}`)
	_, _, err = q.BindMythicalLane(t.Context(), lane)
	require.NoError(t, err)
	third := readPresenceFrame(t, conn)
	require.Contains(t, string(third.Data), `"item":{"n":1,"place":2,"state":"working","title":"Retry webhooks"}`)
	require.NotContains(t, string(third.Data), `"scratch":`)
	require.Contains(t, string(third.Data), `"id":"`+f.row.ID+`"`)
	var status string
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT status FROM workspaces WHERE id=$1`, f.row.ID).Scan(&status))
	require.Equal(t, "suspended", status)
}

// A new scratch has a real machine but no coding host until its first terminal.
// Keep that door visible without granting a safe-idle or presence receipt.
func TestPresenceFreshScratchCardBeforeHost(t *testing.T) {
	f := presenceInstall(t)
	_, err := f.pool.Exec(t.Context(), `UPDATE flow_runtime_host_bindings SET state='pending' WHERE workspace_id=$1`, f.row.ID)
	require.NoError(t, err)
	conn := f.dial(t)
	sendPresenceFrame(t, conn, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	frame := readPresenceFrame(t, conn)
	require.Equal(t, "snap", frame.T)
	var model struct {
		ID      string `json:"id"`
		Machine struct {
			State string `json:"state"`
		} `json:"machine"`
		Presence []any `json:"presence"`
	}
	require.NoError(t, json.Unmarshal(frame.Data, &model))
	require.Equal(t, f.row.ID, model.ID)
	require.Equal(t, "awake", model.Machine.State)
	require.Empty(t, model.Presence)
	_, err = f.p.call(t.Context(), f.row, "presence-owner/app", "Branch.PresenceOn", map[string]any{})
	require.ErrorIs(t, err, flowhost.ErrHostNotRunning)
	var running int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM flow_runtime_host_bindings WHERE workspace_id=$1 AND state='running'`, f.row.ID).Scan(&running))
	require.Zero(t, running, "opening the branch card must not start a host")
	state, _ := f.p.rebasePresence(t.Context(), f.row.RepositoryID, f.row.ID)
	require.Equal(t, services.RebasePresenceUnknown, state)
}
