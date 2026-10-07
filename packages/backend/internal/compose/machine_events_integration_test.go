package compose

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	dto "github.com/prometheus/client_model/go"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/stretchr/testify/require"
)

// The production binding drains authenticated daemon events into a native host
// store and real PostgreSQL, then the mounted live door reads those facts. The
// single-connection writer pool catches accidental nested pool acquisition.
func TestMachineEventsProductionLiveBinding(t *testing.T) {
	f := presenceInstall(t, true)
	ctx := t.Context()
	_, err := f.pool.Exec(ctx, `UPDATE workspaces SET vm_id='machine' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'admin','maya',20001) ON CONFLICT(repository_id,user_id) WHERE user_id IS NOT NULL DO UPDATE SET unix_login='maya',unix_uid=20001`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	config := f.pool.Config()
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, config)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	require.NotEmpty(t, library)
	native := repohostffi.New(library)
	require.NoError(t, native.Load())
	cfg := repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "machine-events"}
	path := cfg.RepoPath("presence-owner", "app")
	_, err = native.InitRepo(path)
	require.NoError(t, err)
	store := filepath.Join(path, ".jj", "repo", "store", "git")
	git := func(input string, args ...string) string {
		t.Helper()
		cmd := hostexec.Git(ctx, append([]string{"-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "core.hooksPath=/dev/null", "-C", store}, args...)...)
		cmd.Stdin = strings.NewReader(input)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, "%s", out)
		return strings.TrimSpace(string(out))
	}
	before := git("before\n", "hash-object", "-w", "--stdin")
	after := git("after\n", "hash-object", "-w", "--stdin")
	a := git("100644 blob "+before+"\ta.ts\n", "mktree")
	b := git("100644 blob "+after+"\ta.ts\n", "mktree")
	tree := git("040000 tree "+a+"\ta\n040000 tree "+b+"\tb\n", "mktree")
	versions := git("versions\n", "commit-tree", tree)
	head := git("head\n", "commit-tree", a)
	git("", "update-ref", "refs/smithers/branches/"+f.row.ID+"/head", head)
	server, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, server.Shutdown(context.Background())) })
	client := repohost.NewLocalClient(http.NotFoundHandler(), cfg.AuthToken)
	client.BindMachineRepository(server.WithMachineRepository)
	gotHead, err := machineBranchHead(pool, client)(ctx, f.row.ID)
	require.NoError(t, err)
	require.Equal(t, head, gotHead)
	_, err = machineBranchHead(pool, client)(ctx, "invalid")
	require.ErrorIs(t, err, machined.ErrUnauthorized)
	registry := new(machined.Registry)
	metrics := routes.NewSmithersMetrics()
	cfgHTTP := testConfigAllFlagsOn()
	cfgHTTP.Auth.Mode = "selfhost"
	cfgHTTP.Auth.SessionCookieName = "session"
	metricServer := httptest.NewUnstartedServer(nil)
	metricOrigin := "http://" + metricServer.Listener.Addr().String()
	cfgHTTP.Server.PublicURL = metricOrigin
	cfgHTTP.Server.AllowedOrigins = []string{metricOrigin}
	metricServer.Config.Handler = githubAppSetupComposeRouter(cfgHTTP, f.pool, nil, metrics)
	metricServer.Start()
	t.Cleanup(metricServer.Close)
	readBursts := func(want *float64) {
		t.Helper()
		request, err := http.NewRequestWithContext(ctx, "GET", metricServer.URL+"/api/install/metrics", nil)
		require.NoError(t, err)
		request.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		require.Equal(t, 200, response.StatusCode)
		var result struct{ Metrics []*dto.MetricFamily }
		require.NoError(t, json.NewDecoder(response.Body).Decode(&result))
		for _, family := range result.Metrics {
			if family.GetName() == "smithers_machine_bursts_total" {
				require.NotNil(t, want, "absent producer must remain absent")
				require.Len(t, family.Metric, 1)
				require.Equal(t, *want, family.Metric[0].GetCounter().GetValue())
				return
			}
		}
		require.Nil(t, want, "burst producer missing from the owner endpoint")
	}
	require.Nil(t, machineBurstObservations(metrics, nil))
	readBursts(nil)
	observeBurst := machineBurstObservations(metrics, registry)
	zero, one, four, five := 0.0, 1.0, 4.0, 5.0
	readBursts(&zero)
	stop, err := bindMachineEvents(ctx, registry, pool, client, observeBurst)
	require.NoError(t, err)
	t.Cleanup(stop)
	require.True(t, registry.EventConsumerReady())
	link, guest := presenceTestLink(t, registry, f.row.ID)
	require.NoError(t, link.Reconciled())
	commitActor := func(identity machined.ActorIdentity) []byte {
		t.Helper()
		ref, err := machined.CommitActor(ctx, pool, f.row.ID, "machine", func(context.Context, pgx.Tx) (machined.ActorIdentity, error) { return identity, nil })
		require.NoError(t, err)
		return ref
	}
	person := commitActor(machined.ActorIdentity{Kind: "person", MemberID: f.user.ID, Via: "ssh"})
	external := commitActor(machined.ActorIdentity{Kind: "agent", MemberID: f.user.ID, Via: "agent", AgentKind: "external", Run: "external-run"})
	coding := commitActor(machined.ActorIdentity{Kind: "agent", MemberID: f.user.ID, Via: "agent", AgentKind: "coding", Run: "event-run"})
	principal := func(ref []byte) []byte { return wire.Union(1, wire.Field(1, wire.Bytes(ref))) }
	sessions := machined.NewSessions(link.Connection, f.row.ID, registry.Sessions(f.row.ID)).WithActor(person, "").WithPresenceVia("ssh")
	opened := make(chan error, 1)
	go func() {
		_, err := sessions.OpenSession(ctx, machined.SessionUser{Login: "maya", UID: 20001}, machined.SessionPTY, nil, nil)
		opened <- err
	}()
	request, err := wire.Read(guest)
	require.NoError(t, err)
	id, method, _, err := request.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.OpenSession), method)
	require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(method, wire.Field(1, wire.U32(1)))))}))
	require.NoError(t, <-opened)
	exchange := func(method wire.Method, fields [][]byte, call func() error) {
		done := make(chan error, 1)
		go func() { done <- call() }()
		request, err := wire.Read(guest)
		require.NoError(t, err)
		id, got, _, err := request.Request()
		require.NoError(t, err)
		require.Equal(t, byte(method), got)
		require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(method), fields...)))}))
		require.NoError(t, <-done)
	}
	exchange(wire.OpenSession, [][]byte{wire.Field(1, wire.U32(2))}, func() error {
		_, err := sessions.WithActor(coding, "event-run").OpenSession(ctx, machined.SessionUser{Login: "agent", UID: 19999}, machined.SessionExec, []string{"codex"}, nil)
		return err
	})
	exchange(wire.RegisterRun, nil, func() error { return sessions.RegisterRun(ctx, "event-run", 2) })
	bytesOf := func(s string) []byte { v, e := hex.DecodeString(s); require.NoError(t, e); return v }
	digest := sha256.Sum256([]byte("after\n"))
	files := append(wire.U16(1), wire.Struct(wire.Field(1, wire.String("a.ts")), wire.Field(2, []byte{2}), wire.Field(4, bytesOf(before)), wire.Field(5, bytesOf(after)), wire.Field(6, digest[:]))...)
	event := func(seq uint64, id byte, actor []byte) machined.Event {
		burst := [16]byte{id}
		return machined.Event{Seq: seq, EventID: [16]byte{id, 1}, Payload: wire.Union(1, wire.Field(1, burst[:]), wire.Field(2, actor), wire.Field(3, files), wire.Field(4, bytesOf(versions)))}
	}
	send := func(e machined.Event, outcome machined.AckOutcome) {
		t.Helper()
		require.NoError(t, guest.SetDeadline(time.Now().Add(10*time.Second)))
		require.NoError(t, wire.Write(guest, transcriptEventFrame(e)))
		frame, err := wire.Read(guest)
		require.NoError(t, err)
		require.Equal(t, wire.Events, frame.Kind)
		require.Equal(t, byte(3), frame.Payload[0])
		fields, err := wire.Fields("ack", frame.Payload[1:])
		require.NoError(t, err)
		require.Equal(t, e.Seq, binary.BigEndian.Uint64(fields[1]))
		require.Equal(t, []byte{byte(outcome)}, fields[2])
	}
	first := event(1, 1, principal(person))
	send(first, machined.AckApplied)
	readBursts(&one)
	send(first, machined.AckDuplicate)
	readBursts(&one)
	send(event(2, 2, wire.Union(4)), machined.AckApplied)
	send(event(3, 3, principal(external)), machined.AckApplied)
	send(event(4, 4, principal(coding)), machined.AckApplied)
	readBursts(&four)

	// The installed consumer also resolves a host reference whose original run
	// and live session are absent. Its sponsor and role come only from admission.
	ref, err := machined.CommitActor(ctx, pool, f.row.ID, "machine", func(context.Context, pgx.Tx) (machined.ActorIdentity, error) {
		return machined.ActorIdentity{Kind: "agent", MemberID: f.user.ID, Via: "agent", AgentKind: "coding", Run: "retained-attempt"}, nil
	})
	require.NoError(t, err)
	send(event(5, 7, wire.Union(1, wire.Field(1, wire.Bytes(ref)))), machined.AckApplied)

	socket := f.dial(t)
	sendPresenceFrame(t, socket, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s:activity"}`, f.row.ID))
	activity := readPresenceFrame(t, socket)
	var entries []struct {
		Actor map[string]any
		Files []map[string]any
	}
	require.NoError(t, json.Unmarshal(activity.Data, &entries))
	require.Len(t, entries, 5)
	require.Equal(t, "retained-attempt", entries[4].Actor["run_id"])
	require.Equal(t, "coding", entries[4].Actor["agent"])
	require.Equal(t, "presence-owner", entries[4].Actor["for_member"].(map[string]any)["login"])
	require.Equal(t, "presence-owner", entries[0].Actor["login"])
	require.Equal(t, "ssh", entries[0].Actor["via"])
	require.Equal(t, "outside", entries[1].Actor["kind"])
	require.Equal(t, "external", entries[2].Actor["agent"])
	require.Equal(t, "coding", entries[3].Actor["agent"])
	require.Equal(t, "presence-owner", entries[3].Actor["for_member"].(map[string]any)["login"])
	// Parse exactly what the app receives using the public TypeScript contract.
	root, err := filepath.Abs("../../../..")
	require.NoError(t, err)
	schema := exec.CommandContext(ctx, "bun", "--eval", `import { BranchActivityEntry } from "./packages/rpc/src/BranchCard.ts"; for (const row of JSON.parse(await Bun.stdin.text())) BranchActivityEntry.parse(row);`)
	schema.Dir = root
	schema.Stdin = strings.NewReader(string(activity.Data))
	schemaOut, err := schema.CombinedOutput()
	require.NoError(t, err, "%s", schemaOut)

	require.Equal(t, before, entries[0].Files[0]["before_blob"])
	sendPresenceFrame(t, socket, fmt.Sprintf(`{"t":"sub","id":2,"topic":"branch:%s:files"}`, f.row.ID))
	readPresenceFrame(t, socket)
	hint := wire.Union(1, wire.Field(1, wire.String("a.ts")), wire.Field(2, principal(person)), wire.Field(3, digest[:]))
	require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Events, Payload: wire.Union(2, wire.Field(1, hint))}))
	update := readPresenceFrame(t, socket)
	var changed struct {
		Written []struct {
			Path  string
			Actor map[string]any
		}
	}
	require.NoError(t, json.Unmarshal(update.Data, &changed))
	require.Len(t, changed.Written, 1)
	require.Equal(t, "a.ts", changed.Written[0].Path)
	require.Equal(t, "ssh", changed.Written[0].Actor["via"])
	socket.CloseNow()
	var unexpected [1]byte
	// These legacy identifiers match sessions which are live right now. They
	// still cannot establish who authored an older event. A reconnect then
	// reuses numeric session 1 with another identity; it grants no history.
	for n, actor := range [][]byte{wire.Union(2, wire.Field(1, wire.U32(1))), wire.Union(2, wire.Field(1, wire.U32(1))), wire.Union(3, wire.Field(1, wire.String("event-run")))} {
		require.NoError(t, guest.SetDeadline(time.Now().Add(5*time.Second)))
		require.NoError(t, wire.Write(guest, transcriptEventFrame(event(uint64(6+n), byte(10+n), actor))))
		_, err = guest.Read(unexpected[:])
		require.ErrorIs(t, err, io.EOF, "legacy author must not be guessed from live sessions")
		link, guest = presenceTestLink(t, registry, f.row.ID)
		require.NoError(t, link.Reconciled())
		sessions = machined.NewSessions(link.Connection, f.row.ID, registry.Sessions(f.row.ID)).WithActor(coding, "event-run")
		exchange(wire.OpenSession, [][]byte{wire.Field(1, wire.U32(1))}, func() error {
			_, err := sessions.OpenSession(ctx, machined.SessionUser{Login: "agent", UID: 19999}, machined.SessionExec, []string{"codex"}, nil)
			return err
		})
		user, run, _, err := link.SessionPresence(f.row.ID, 1)
		require.NoError(t, err)
		require.Equal(t, uint32(19999), user.UID)
		require.Equal(t, "event-run", run)
	}
	// Unknown host principals cannot fabricate authors or receive a receipt.
	require.NoError(t, guest.SetDeadline(time.Now().Add(5*time.Second)))
	require.NoError(t, wire.Write(guest, transcriptEventFrame(event(6, 5, wire.Union(1, wire.Field(1, wire.Bytes([]byte("member:2"))))))))
	_, err = guest.Read(unexpected[:])
	require.ErrorIs(t, err, io.EOF)
	readBursts(&five)
	// A new authenticated connection is consumed too. An unavailable moved-off
	// provider closes it without acknowledging or swallowing the durable event.
	_, guest = presenceTestLink(t, registry, f.row.ID)
	require.NoError(t, guest.SetDeadline(time.Now().Add(5*time.Second)))
	moved := machined.Event{Seq: 7, EventID: [16]byte{6}, Payload: wire.Union(4, wire.Field(1, wire.Union(4)), wire.Field(2, wire.U64(42)), wire.Field(3, bytesOf(head)))}
	require.NoError(t, wire.Write(guest, transcriptEventFrame(moved)))
	_, err = guest.Read(unexpected[:])
	require.ErrorIs(t, err, io.EOF)

	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts`).Scan(&count))
	require.Equal(t, 5, count)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET status='suspended' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	git("", "gc", "--prune=now")
	require.Equal(t, "before", git("", "show", "refs/smithers/branches/"+f.row.ID+"/bursts/01000000-0000-0000-0000-000000000000:a/a.ts"))
	sleeping := f.dial(t)
	sendPresenceFrame(t, sleeping, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s:files"}`, f.row.ID))
	require.Contains(t, string(readPresenceFrame(t, sleeping).Data), fmt.Sprintf("%x", digest))
	sleeping.CloseNow()
	stop()
	require.False(t, registry.EventConsumerReady())
}
