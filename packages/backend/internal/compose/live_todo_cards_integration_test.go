package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/repository"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The production control route, source transaction, card builder and upgrade
// route share real PostgreSQL. Only the repository/machine providers are absent:
// dropping a queued TODO executes no repository code and needs neither.
func TestLiveTodoCommittedCardsRollbackAndReplay(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q, ctx := db.New(pool), t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "live-owner", LowerUsername: "live-owner", DisplayName: "Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1);`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, owner.ID)
	require.NoError(t, err)
	for key, value := range map[string]string{"github.repository": fmt.Sprintf(`{"owner_login":"live-owner","repository_name":"app","repository_id":%d}`, repo.ID), "owner.access": fmt.Sprintf(`{"owner_login":"live-owner","repository_name":"app","repository_id":%d,"last_access_check_at":"2026-10-06T00:00:00Z"}`, repo.ID)} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo.ID)
	require.NoError(t, err)
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "queued", Title: pgtype.Text{String: "Committed card", Valid: true}, OwnerID: pgtype.Int8{Int64: owner.ID, Valid: true}, Checks: []byte(`{"todo":true}`)})
	require.NoError(t, err)
	require.EqualValues(t, 1, item.Number.Int64)
	item.Title = pgtype.Text{String: "Committed card", Valid: true}
	item, err = q.SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	second, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "queued", OwnerID: pgtype.Int8{Int64: owner.ID, Valid: true}, Checks: []byte(`{"todo":true}`)})
	require.NoError(t, err)
	require.EqualValues(t, 2, second.Number.Int64)
	token := "live-card-browser"
	hash := sha256.Sum256([]byte(token))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: owner.ID, Username: owner.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	busContext, stopBus := context.WithCancel(ctx)
	defer stopBus()
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(busContext))
	routes.SetRevocationSource(bus)
	defer routes.SetRevocationSource(nil)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	service := services.NewMythicalService(pool, nil)
	capacity := &services.InstallCapacityService{Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, DiskFreeBytes: 400 << 30}}
	topics := &liveTopics{queries: q, todos: service, jobs: store, install: &services.InstallSetupService{Capacity: capacity}}
	var mainSHA string
	if ffi := os.Getenv("SMITHERS_FFI_LIBRARY_PATH"); ffi != "" {
		local, err := repository.OpenLocal(repository.Config{StoragePath: t.TempDir(), AuthToken: "home-native", FFILibraryPath: ffi, InstallMainMirror: true})
		require.NoError(t, err)
		t.Cleanup(func() { require.NoError(t, local.Shutdown(context.Background())) })
		require.NoError(t, local.Client().InitRepo(ctx, owner.Username, repo.Name, "main", true))
		main, err := local.Client().GetBookmark(ctx, owner.Username, repo.Name, "main")
		require.NoError(t, err)
		mainSHA = main.TargetCommitID
		topics.main = local.Client()
	}
	chatStore, err := chat.NewStore(pool)
	require.NoError(t, err)
	topics.viewState = conversationLiveViewState(q, chatStore, nil)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL, cfg.Server.AllowedOrigins = origin, []string{origin}
	handler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	server.Config.Handler = hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{}, conformanceServices{pool: pool, live: handler, mythical: &routes.MythicalHandler{Service: service}})
	server.Start()
	defer server.Close()
	headers := http.Header{"Cookie": {"smithers_session=" + token}, "Origin": {origin}}
	dial := func() *websocket.Conn {
		socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: headers})
		require.NoError(t, err)
		t.Cleanup(func() { socket.CloseNow() })
		return socket
	}
	read := func(socket *websocket.Conn) live.Frame {
		deadline, stop := context.WithTimeout(ctx, 5*time.Second)
		defer stop()
		_, raw, err := socket.Read(deadline)
		require.NoError(t, err)
		var frame live.Frame
		require.NoError(t, json.Unmarshal(raw, &frame))
		return frame
	}
	socket := dial()
	require.NoError(t, socket.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"todo:1"}`)))
	initial := read(socket)
	require.Equal(t, "snap", initial.T)
	require.EqualValues(t, 0, *initial.Cursor)
	require.Contains(t, string(initial.Data), `"state":"queued"`)
	homeSocket := dial()
	require.NoError(t, homeSocket.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"home"}`)))
	homeInitial := read(homeSocket)
	require.Equal(t, "snap", homeInitial.T)
	require.EqualValues(t, 0, *homeInitial.Cursor)
	t.Run("native main row", func(t *testing.T) {
		if mainSHA == "" {
			t.Skip("SMITHERS_FFI_LIBRARY_PATH is required for the native main-row proof")
		}
		var homeMain struct {
			Main struct {
				SHA   string `json:"sha"`
				Title string `json:"title"`
			} `json:"main"`
		}
		require.NoError(t, json.Unmarshal(homeInitial.Data, &homeMain))
		require.Equal(t, mainSHA, homeMain.Main.SHA)
		require.Equal(t, "Initial commit", homeMain.Main.Title)
	})
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "live-member", LowerUsername: "live-member", DisplayName: "Member"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo.ID, member.ID)
	require.NoError(t, err)
	memberToken := "live-member-session"
	memberHash := sha256.Sum256([]byte(memberToken))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(memberHash[:]), UserID: member.ID, Username: member.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	memberSocket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Cookie": {"smithers_session=" + memberToken}, "Origin": {origin}}})
	require.NoError(t, err)
	defer memberSocket.CloseNow()
	require.NoError(t, memberSocket.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"home"}`)))
	memberHome := read(memberSocket)
	require.JSONEq(t, string(homeInitial.Data), string(memberHome.Data))
	_, err = pool.Exec(ctx, `UPDATE collaborators SET toasts_hidden=true, view_state=jsonb_build_object('main',jsonb_build_object('last_seen_seq',9,'toasts_hidden',false)) WHERE repository_id=$1 AND user_id=$2`, repo.ID, member.ID)
	require.NoError(t, err)
	memberViewTopic := "view:" + strconv.FormatInt(member.ID, 10) + ":main"
	require.NoError(t, memberSocket.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"t":"sub","id":2,"topic":%q}`, memberViewTopic))))
	privateView := read(memberSocket)
	require.Equal(t, "snap", privateView.T)
	require.EqualValues(t, 2, privateView.ID)
	require.JSONEq(t, `{"last_seen_seq":9,"toasts_hidden":false,"global_toasts_hidden":true}`, string(privateView.Data))
	require.NoError(t, homeSocket.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"t":"sub","id":2,"topic":%q}`, memberViewTopic))))
	forbidden := read(homeSocket)
	require.Equal(t, "err", forbidden.T)
	require.Equal(t, "forbidden", forbidden.Code)
	require.NoError(t, memberSocket.Write(ctx, websocket.MessageText, []byte(`{"t":"unsub","id":2}`)))
	memberReload, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Cookie": {"smithers_session=" + memberToken}, "Origin": {origin}}})
	require.NoError(t, err)
	defer memberReload.CloseNow()
	require.NoError(t, memberReload.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"t":"sub","id":1,"topic":%q}`, memberViewTopic))))
	reloadedView := read(memberReload)
	require.Equal(t, "snap", reloadedView.T)
	require.JSONEq(t, string(privateView.Data), string(reloadedView.Data))
	call := func(n int64, key string) int {
		request, err := http.NewRequest("POST", origin+"/api/todos/"+strconv.FormatInt(n, 10), strings.NewReader(`{"op":"drop"}`))
		require.NoError(t, err)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", origin)
		request.Header.Set("Idempotency-Key", key)
		request.Header.Set("X-CSRF-Token", "csrf")
		request.AddCookie(&http.Cookie{Name: "smithers_session", Value: token})
		request.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		return response.StatusCode
	}
	// Fail after the item update, before its fact can commit.
	_, err = pool.Exec(ctx, `CREATE FUNCTION reject_live_card_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected source failure'; END $$; CREATE TRIGGER reject_live_card_fact BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION reject_live_card_fact()`)
	require.NoError(t, err)
	require.Equal(t, 503, call(1, "rolled-back-drop"))
	var state string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM mythical_items WHERE id=$1`, item.ID).Scan(&state))
	require.Equal(t, "queued", state)
	scope := jobs.Scope{TenantID: strconv.FormatInt(repo.ID, 10), PrincipalID: "todo:" + uuid.UUID(item.ID.Bytes).String()}
	head, err := store.Head(ctx, scope)
	require.NoError(t, err)
	require.Zero(t, head)
	repoHead, err := store.Head(ctx, jobs.RepositoryTodosScope(strconv.FormatInt(repo.ID, 10)))
	require.NoError(t, err)
	require.Zero(t, repoHead)
	// A concurrent reader stays alive across the absence assertion.
	type pendingRead struct {
		frame live.Frame
		err   error
	}
	received := make(chan pendingRead, 1)
	go func() {
		deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		_, raw, err := socket.Read(deadline)
		var frame live.Frame
		if err == nil {
			err = json.Unmarshal(raw, &frame)
		}
		received <- pendingRead{frame, err}
	}()
	select {
	case <-received:
		t.Fatal("rollback published a frame")
	case <-time.After(500 * time.Millisecond):
	}
	_, err = pool.Exec(ctx, `DROP TRIGGER reject_live_card_fact ON product_job_events; DROP FUNCTION reject_live_card_fact()`)
	require.NoError(t, err)
	require.Equal(t, 202, call(1, "committed-drop"))
	var delta live.Frame
	select {
	case result := <-received:
		require.NoError(t, result.err)
		delta = result.frame
	case <-time.After(6 * time.Second):
		t.Fatal("committed fact was not delivered")
	}
	require.Equal(t, "delta", delta.T)
	require.EqualValues(t, 1, *delta.Cursor)
	var event struct {
		State string
		Data  struct {
			Card json.RawMessage `json:"card"`
		}
	}
	require.NoError(t, json.Unmarshal(delta.Data, &event))
	require.Equal(t, "dropped", event.State)
	require.Contains(t, string(event.Data.Card), `"state":"dropped"`)
	require.Contains(t, string(event.Data.Card), `"n":1`)
	require.Contains(t, string(event.Data.Card), `"title":"Committed card"`)
	homeDelta := read(homeSocket)
	require.Equal(t, "delta", homeDelta.T)
	require.EqualValues(t, 1, *homeDelta.Cursor)
	var firstHome struct {
		Data struct {
			Home struct {
				Items  []struct{ N int64 }
				Counts map[string]int
			}
		}
	}
	require.NoError(t, json.Unmarshal(homeDelta.Data, &firstHome))
	require.Zero(t, firstHome.Data.Home.Counts["dropped"], "finished TODOs are absent from Home counts")
	require.Equal(t, 1, firstHome.Data.Home.Counts["queued"])
	require.Len(t, firstHome.Data.Home.Items, 1)
	require.EqualValues(t, 2, firstHome.Data.Home.Items[0].N)
	// A committed member profile change has no TODO fact. Both cards refresh at
	// their existing cursors, while the next TODO mutation still arrives as delta.
	secondSocket := dial()
	require.NoError(t, secondSocket.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"todo:2"}`)))
	require.Equal(t, "snap", read(secondSocket).T)
	_, err = pool.Exec(ctx, `UPDATE users SET display_name='Updated owner' WHERE id=$1`, owner.ID)
	require.NoError(t, err)
	profileHome := read(homeSocket)
	require.Equal(t, "snap", profileHome.T)
	require.EqualValues(t, 1, *profileHome.Cursor)
	require.Contains(t, string(profileHome.Data), "Updated owner")
	profileTodo := read(secondSocket)
	require.Equal(t, "snap", profileTodo.T)
	require.EqualValues(t, 0, *profileTodo.Cursor)
	require.Contains(t, string(profileTodo.Data), "Updated owner")
	require.Equal(t, 202, call(2, "second-item-drop"))
	secondHome := read(homeSocket)
	require.Equal(t, "delta", secondHome.T)
	require.EqualValues(t, 2, *secondHome.Cursor)
	page, err := store.ReplayRepositoryTodos(ctx, strconv.FormatInt(repo.ID, 10), 0, 100)
	require.NoError(t, err)
	require.Len(t, page.Events, 2)
	require.EqualValues(t, 1, page.Events[0].Sequence)
	require.EqualValues(t, 1, page.Events[1].Sequence)
	require.NotEqual(t, page.Events[0].Scope.PrincipalID, page.Events[1].Scope.PrincipalID)
	require.EqualValues(t, 2, page.Head)
	firstPage, err := store.ReplayRepositoryTodos(ctx, strconv.FormatInt(repo.ID, 10), 0, 1)
	require.NoError(t, err)
	require.True(t, firstPage.More)
	require.EqualValues(t, 1, firstPage.Cursor)
	_, err = store.ReplayRepositoryTodos(ctx, strconv.FormatInt(repo.ID, 10), 3, 1)
	require.ErrorIs(t, err, jobs.ErrCursorAhead)
	homeReplay := dial()
	require.NoError(t, homeReplay.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"home","cursor":0}`)))
	replayFirst := read(homeReplay)
	replaySecond := read(homeReplay)
	require.JSONEq(t, string(homeDelta.Data), string(replayFirst.Data))
	require.JSONEq(t, string(secondHome.Data), string(replaySecond.Data))
	replay := dial()
	require.NoError(t, replay.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"todo:1","cursor":0}`)))
	resumed := read(replay)
	require.Equal(t, "delta", resumed.T)
	require.JSONEq(t, string(delta.Data), string(resumed.Data))
	require.EqualValues(t, 1, *resumed.Cursor)
	require.NoError(t, store.ExpireEventsThrough(ctx, scope, 1))
	require.NoError(t, replay.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"todo:1","cursor":0}`)))
	require.NoError(t, homeReplay.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"home","cursor":0}`)))
	retainedHome := read(homeReplay)
	require.Equal(t, "snap", retainedHome.T)
	require.EqualValues(t, 2, *retainedHome.Cursor)
	require.Contains(t, string(retainedHome.Data), `"dropped":0`)
	retained := read(replay)
	require.Equal(t, "snap", retained.T)
	require.EqualValues(t, 1, *retained.Cursor)
	require.Contains(t, string(retained.Data), `"state":"dropped"`)
	// A separately committed Settings source retains its snapshot refresh without
	// consuming or coalescing a TODO journal position.
	rows, err := q.SetInstallParallel(ctx, db.SetInstallParallelParams{Value: json.RawMessage(`1`), ActorID: owner.ID})
	require.NoError(t, err)
	require.EqualValues(t, 1, rows)
	refreshed := read(homeReplay)
	require.Equal(t, "snap", refreshed.T)
	require.EqualValues(t, 2, *refreshed.Cursor)
	require.Contains(t, string(refreshed.Data), `"parallel":1`)
	unchanged, err := store.Head(ctx, jobs.RepositoryTodosScope(strconv.FormatInt(repo.ID, 10)))
	require.NoError(t, err)
	require.EqualValues(t, 2, unchanged)
	// Seed only the admitted attempt. Every subsequent state is written by
	// the production runtime projector, never by the socket fixture or SQL.
	third, err := q.InsertMythicalTodo(ctx, repo.ID, owner.ID, "Runtime transitions", "Use the committed runtime",
		json.RawMessage(`[{"rev":1,"text":"Use the committed runtime"}]`),
		json.RawMessage(`{"todo":true,"run_launched":true,"flowSource":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`))
	require.NoError(t, err)
	machineOwner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	branch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: machineOwner, Name: "live-admission", Kind: "container", Status: "suspended", TargetBookmark: "smithers/live-admission"})
	require.NoError(t, err)
	_, err = q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: branch.ID, OwnerUserID: machineOwner, GranteeUserID: owner.ID, Level: "write"})
	require.NoError(t, err)
	_, _, err = q.BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: branch.ID, RepositoryID: repo.ID, ItemID: third.ID, Name: "live-admission"})
	require.NoError(t, err)
	third.WorkspaceID = branch.ID
	branches := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)))
	topics.presence = &branchPresence{queries: q, branches: branches}
	third.State = "running"
	third.Attempt = 1
	third.FlowDigest = pgtype.Text{String: strings.Repeat("a", 64), Valid: true}
	third, err = q.SaveMythicalItem(ctx, third)
	require.NoError(t, err)
	thirdSocket := dial()
	require.NoError(t, thirdSocket.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"t":"sub","id":1,"topic":"todo:%d"}`, third.Number.Int64))))
	admitted := read(thirdSocket)
	require.Equal(t, "snap", admitted.T)
	require.Contains(t, string(admitted.Data), `"state":"starting"`)
	require.EqualValues(t, 0, *admitted.Cursor)
	branchSocket := dial()
	require.NoError(t, branchSocket.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, branch.ID))))
	branchInitial := read(branchSocket)
	require.Equal(t, "snap", branchInitial.T)
	require.Contains(t, string(branchInitial.Data), `"state":"starting"`)
	// A fresh Home reader includes the seeded attempt before observing deltas.
	transitionHome := dial()
	require.NoError(t, transitionHome.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"home"}`)))
	require.Equal(t, "snap", read(transitionHome).T)
	projection, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": uuid.UUID(third.ID.Bytes).String(),
		"generation": third.Generation, "attempt": 1, "phase": "todo", "flowDigest": strings.Repeat("a", 64), "flowSource": strings.Repeat("b", 40)})
	require.NoError(t, err)
	var recorded, recordedHome []live.Frame
	for index, expected := range []string{"working", "needs_you", "working"} {
		var waits []flowruntime.PendingWait
		if index == 1 {
			waits = []flowruntime.PendingWait{{RunID: "planning-run", FlowID: "coding/PreparePlan", Reason: "approval", Token: "literal-question",
				Name: "clarification", CreatedAt: 1, Request: json.RawMessage(`{"task":"human","name":"clarification","kind":"ask","prompt":"Use backoff?","attempt":1,"maxAttempts":3}`)}}
		}
		update := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{
			Projection: projection, FlowID: "todo", ExecutionDigest: strings.Repeat("a", 64), RunID: "live-transition-run",
			Run: &flowruntime.Run{RunID: "live-transition-run", FlowID: "todo", Status: "running", PendingWaits: waits}}}
		require.NoError(t, service.ProjectFlowRuntime(ctx, update))
		frame := read(thirdSocket)
		require.Equal(t, "delta", frame.T)
		require.EqualValues(t, index+1, *frame.Cursor)
		var fact struct {
			State string
			Data  struct {
				Card struct{ State string }
				Home struct{ Counts map[string]int }
			}
		}
		require.NoError(t, json.Unmarshal(frame.Data, &fact))
		require.Equal(t, expected, fact.State)
		require.Equal(t, expected, fact.Data.Card.State)
		var committedState string
		var committedData []byte
		require.NoError(t, pool.QueryRow(ctx, `SELECT state,data FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 AND sequence=$3`,
			strconv.FormatInt(repo.ID, 10), "todo:"+uuid.UUID(third.ID.Bytes).String(), index+1).Scan(&committedState, &committedData))
		require.Equal(t, expected, committedState)
		var delivered jobs.Event
		require.NoError(t, json.Unmarshal(frame.Data, &delivered))
		require.JSONEq(t, string(committedData), string(delivered.Data))
		homeFrame := read(transitionHome)
		require.Equal(t, "delta", homeFrame.T)
		require.EqualValues(t, index+3, *homeFrame.Cursor)
		require.NoError(t, json.Unmarshal(homeFrame.Data, &fact))
		require.Equal(t, 1, fact.Data.Home.Counts[expected])
		branchFrame := read(branchSocket)
		require.Equal(t, "delta", branchFrame.T)
		require.EqualValues(t, index+1, *branchFrame.Cursor)
		require.NoError(t, json.Unmarshal(branchFrame.Data, &fact))
		require.Equal(t, expected, fact.Data.Card.State)
		require.JSONEq(t, string(frame.Data), string(branchFrame.Data))
		recorded = append(recorded, frame)
		recordedHome = append(recordedHome, homeFrame)
	}
	// A reader disconnected through both question transitions receives each
	// committed historical card, in order, rather than only the newest state.
	thirdReplay := dial()
	require.NoError(t, thirdReplay.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"t":"sub","id":1,"topic":"todo:%d","cursor":1}`, third.Number.Int64))))
	for _, expected := range recorded[1:] {
		frame := read(thirdReplay)
		require.Equal(t, "delta", frame.T)
		require.Equal(t, *expected.Cursor, *frame.Cursor)
		require.JSONEq(t, string(expected.Data), string(frame.Data))
	}

	transitionHomeReplay := dial()
	require.NoError(t, transitionHomeReplay.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"home","cursor":2}`)))
	for _, expected := range recordedHome {
		frame := read(transitionHomeReplay)
		require.Equal(t, "delta", frame.T)
		require.Equal(t, *expected.Cursor, *frame.Cursor)
		require.JSONEq(t, string(expected.Data), string(frame.Data))
	}

}
