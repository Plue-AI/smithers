package compose

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// movedOffHost is the composed install around one authenticated guest link:
// production event consumer, ingest transaction and served TODO controls.
// Only the guest side of the machine connection is a fixture.
type movedOffHost struct {
	t       *testing.T
	f       presenceInstallFixture
	service *services.MythicalService
	server  *httptest.Server
	actor   []byte
}

const movedOffPreMove = "1234567890abcdef1234567890abcdef12345678"

func newMovedOffHost(t *testing.T) *movedOffHost {
	t.Helper()
	f := presenceInstall(t)
	ctx := t.Context()
	_, err := f.pool.Exec(ctx, `UPDATE workspaces SET vm_id='machine' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET workspace_id=$1,state='running' WHERE repository_id=$2 AND number=1`, f.row.ID, f.row.RepositoryID)
	require.NoError(t, err)
	service := services.NewMythicalService(f.pool, nil)
	actor, err := machined.CommitActor(ctx, f.pool, f.row.ID, "machine", func(context.Context, pgx.Tx) (machined.ActorIdentity, error) {
		return machined.ActorIdentity{Kind: "person", MemberID: f.user.ID, Via: "ssh"}, nil
	})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	server := httptest.NewUnstartedServer(nil)
	cfg.Server.PublicURL = "http://" + server.Listener.Addr().String()
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	server.Config.Handler = githubAppSetupComposeRouter(cfg, f.pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: service}})
	server.Start()
	t.Cleanup(server.Close)
	return &movedOffHost{t: t, f: f, service: service, server: server, actor: actor}
}

// attach mounts a fresh production event consumer, with or without the
// moved-off provider, and connects one authenticated guest link to it.
func (h *movedOffHost) attach(moved *services.MythicalService) net.Conn {
	h.t.Helper()
	registry := new(machined.Registry)
	var providers []*services.MythicalService
	if moved != nil {
		providers = append(providers, moved)
	}
	stop, err := bindMachineEvents(h.t.Context(), registry, h.f.pool, repohost.NewLocalClient(http.NotFoundHandler(), "fixture"), nil, nil, providers...)
	require.NoError(h.t, err)
	h.t.Cleanup(stop)
	link, guest := presenceTestLink(h.t, registry, h.f.row.ID)
	require.NoError(h.t, link.Reconciled())
	return guest
}

func (h *movedOffHost) payload(actor []byte, item uint64) []byte {
	head, err := hex.DecodeString(movedOffPreMove)
	require.NoError(h.t, err)
	return wire.Union(4, wire.Field(1, wire.Union(1, wire.Field(1, wire.Bytes(actor)))), wire.Field(2, wire.U64(item)), wire.Field(3, head))
}

// deliver sends one durable event. A nil outcome means the host must refuse:
// no acknowledgement, and the link closes so the daemon outbox keeps it.
func (h *movedOffHost) deliver(guest net.Conn, event machined.Event, outcome *machined.AckOutcome) {
	h.t.Helper()
	require.NoError(h.t, guest.SetDeadline(time.Now().Add(10*time.Second)))
	// Raw bytes: a hostile guest skips the encoder's validation, so only the
	// host's frame and event decoders stand between it and the transaction.
	payload := transcriptEventFrame(event).Payload
	raw := make([]byte, 9+len(payload))
	binary.BigEndian.PutUint32(raw, uint32(len(payload)))
	raw[4] = byte(wire.Events)
	copy(raw[9:], payload)
	_, err := guest.Write(raw)
	require.NoError(h.t, err)
	if outcome == nil {
		// No acknowledgement: the host closes the link; it does not stall.
		_, err = guest.Read(make([]byte, 1))
		require.ErrorIs(h.t, err, io.EOF, "a refused event must not be acknowledged")
		return
	}
	frame, err := wire.Read(guest)
	require.NoError(h.t, err)
	require.Equal(h.t, wire.Events, frame.Kind)
	fields, err := wire.Fields("ack", frame.Payload[1:])
	require.NoError(h.t, err)
	require.Equal(h.t, event.Seq, binary.BigEndian.Uint64(fields[1]))
	require.Equal(h.t, []byte{byte(*outcome)}, fields[2])
}

type movedOffEffects struct {
	fact             []byte
	waits            []services.TodoWait
	receipts, events int
	requests         int
}

func (h *movedOffHost) effects() movedOffEffects {
	h.t.Helper()
	ctx := h.t.Context()
	var e movedOffEffects
	require.NoError(h.t, h.f.pool.QueryRow(ctx, `SELECT moved_off FROM workspaces WHERE id=$1`, h.f.row.ID).Scan(&e.fact))
	var checks []byte
	require.NoError(h.t, h.f.pool.QueryRow(ctx, `SELECT checks FROM mythical_items WHERE repository_id=$1 AND number=1`, h.f.row.RepositoryID).Scan(&checks))
	var decoded struct {
		Waits []services.TodoWait `json:"waits"`
	}
	require.NoError(h.t, json.Unmarshal(checks, &decoded))
	for _, wait := range decoded.Waits {
		if wait.Kind == "moved_off" {
			e.waits = append(e.waits, wait)
		}
	}
	require.NoError(h.t, h.f.pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts WHERE workspace_id=$1`, h.f.row.ID).Scan(&e.receipts))
	require.NoError(h.t, h.f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type IN ('branch.moved-off','todo.moved-off','todo.returned-to-item','todo.kept-moved','todo.return-requested')`).Scan(&e.events))
	require.NoError(h.t, h.f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests`).Scan(&e.requests))
	return e
}

// post presses an in-card control through the served catalog dispatcher with
// one credential: a browser session cookie, or a bearer token.
func (h *movedOffHost) post(op, wait, key string, credential func(*http.Request)) (int, map[string]any) {
	h.t.Helper()
	body, err := json.Marshal(map[string]any{"op": op, "id": wait})
	require.NoError(h.t, err)
	request, err := http.NewRequestWithContext(h.t.Context(), http.MethodPost, h.server.URL+"/api/todos/1", strings.NewReader(string(body)))
	require.NoError(h.t, err)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", key)
	credential(request)
	response, err := http.DefaultClient.Do(request)
	require.NoError(h.t, err)
	defer response.Body.Close()
	var result map[string]any
	require.NoError(h.t, json.NewDecoder(response.Body).Decode(&result))
	return response.StatusCode, result
}

func (h *movedOffHost) session(cookie string) func(*http.Request) {
	return func(request *http.Request) {
		request.Header.Set("Origin", h.server.URL)
		request.Header.Set("X-CSRF-Token", "moved-csrf")
		request.AddCookie(&http.Cookie{Name: "__csrf", Value: "moved-csrf"})
		request.AddCookie(&http.Cookie{Name: "session", Value: cookie})
	}
}

func bearer(token, via string) func(*http.Request) {
	return func(request *http.Request) {
		request.Header.Set("Authorization", "Bearer "+token)
		if via != "" {
			request.Header.Set("Smithers-Via", via)
		}
	}
}

func (h *movedOffHost) token(user db.User, name, scopes string, systemIssued bool) string {
	h.t.Helper()
	plaintext := "smithers_" + hex.EncodeToString([]byte(name + "-moved-off-token-padding"))[:40]
	sum := sha256Hex(plaintext)
	_, err := db.New(h.f.pool).CreateAccessToken(h.t.Context(), db.CreateAccessTokenParams{
		UserID: user.ID, Name: name, TokenHash: sum, TokenLastEight: sum[len(sum)-8:],
		SystemIssued: systemIssued, Scopes: scopes,
		ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
	})
	require.NoError(h.t, err)
	return plaintext
}

// T-COL-05 TestMovedOffUnavailableProviders (host half): with each host
// provider removed, the authenticated machine event and the served Return
// refuse before any wait, branch fact, activity, receipt, stack request or
// guest rewrite. No legacy or host path substitutes. Restoring the providers
// applies the same retained event exactly once.
func TestMovedOffUnavailableProviders(t *testing.T) {
	h := newMovedOffHost(t)
	ctx := t.Context()
	none := h.effects()
	require.Empty(t, none.fact)
	require.Empty(t, none.waits)
	event := machined.Event{Seq: 1, EventID: [16]byte{0x51}, Payload: h.payload(h.actor, 1)}
	unknown := make([]byte, 16)
	unknown[0] = 0xff
	for _, missing := range []struct {
		name   string
		moved  *services.MythicalService
		event  machined.Event
		before func()
		after  func()
	}{
		// The production consumer is mounted without the moved-off provider.
		{name: "moved-off-consumer", event: event},
		// Codec: a reserved event without its pre-move commit, and one with
		// trailing bytes, are not facts.
		{name: "codec-missing-target", moved: h.service, event: machined.Event{Seq: 1, EventID: event.EventID,
			Payload: wire.Union(4, wire.Field(1, wire.Union(1, wire.Field(1, wire.Bytes(h.actor)))), wire.Field(2, wire.U64(1))),
		}},
		{name: "codec-trailing-bytes", moved: h.service, event: machined.Event{Seq: 1, EventID: event.EventID, Payload: append(h.payload(h.actor, 1), 0)}},
		// Attribution: an actor reference the host never committed.
		{name: "attribution", moved: h.service, event: machined.Event{Seq: 1, EventID: event.EventID, Payload: h.payload(unknown, 1)}},
		// Branch binding: the branch no longer holds a live item lane.
		{name: "branch-binding", moved: h.service, event: event,
			before: func() {
				_, err := h.f.pool.Exec(ctx, `UPDATE mythical_lanes SET retired_at=NOW() WHERE workspace_id=$1`, h.f.row.ID)
				require.NoError(t, err)
			},
			after: func() {
				_, err := h.f.pool.Exec(ctx, `UPDATE mythical_lanes SET retired_at=NULL WHERE workspace_id=$1`, h.f.row.ID)
				require.NoError(t, err)
			}},
		// Item binding: the daemon names an item this branch does not hold.
		{name: "item-binding", moved: h.service, event: machined.Event{Seq: 1, EventID: event.EventID, Payload: h.payload(h.actor, 2)}},
	} {
		t.Run(missing.name, func(t *testing.T) {
			if missing.before != nil {
				missing.before()
			}
			guest := h.attach(missing.moved)
			h.deliver(guest, missing.event, nil)
			if missing.after != nil {
				missing.after()
			}
			require.Equal(t, none, h.effects())
		})
	}

	applied := machined.AckApplied
	guest := h.attach(h.service)
	h.deliver(guest, event, &applied)
	moved := h.effects()
	require.NotEmpty(t, moved.fact)
	require.Len(t, moved.waits, 1, "the retained event opens one wait once its providers exist")
	require.Equal(t, movedOffPreMove, moved.waits[0].SHA)
	require.Equal(t, 1, moved.receipts)
	duplicate := machined.AckDuplicate
	h.deliver(guest, event, &duplicate)
	require.Equal(t, moved, h.effects())

	// Return without the machine Return provider: 503, the choice stays
	// unclaimed and no rewrite reaches the guest.
	status, result := h.post("return-to-item", moved.waits[0].ID, "return-without-provider", h.session(h.f.cookie))
	require.Equal(t, http.StatusServiceUnavailable, status, "%v", result)
	require.Equal(t, moved, h.effects())
	require.NoError(t, guest.SetReadDeadline(time.Now().Add(300*time.Millisecond)))
	_, err := guest.Read(make([]byte, 1))
	require.ErrorIs(t, err, os.ErrDeadlineExceeded, "no Return RPC reaches the guest")

	// Keep needs no machine provider; it records the choice and the branch
	// fact, wait and write hold remain until the metadata watcher reports return.
	status, result = h.post("keep-moved", moved.waits[0].ID, "keep-without-provider", h.session(h.f.cookie))
	require.Equal(t, http.StatusAccepted, status, "%v", result)
	kept := h.effects()
	require.Equal(t, moved.fact, kept.fact)
	require.Len(t, kept.waits, 1)
	require.Nil(t, kept.waits[0].SettledAt)
	require.Equal(t, "keep-moved", kept.waits[0].Answer)
}

// T-COL-05 Go integration: through the served catalog dispatcher and shared
// authorizer, a delegated Keep, an agent Return, terminal and machine
// credentials, an unbound credential and a non-member refuse without effects.
// An app agent may Return (Appendix B.4); the first answer still wins.
func TestMovedOffControlsRefuseUnauthorizedCredentials(t *testing.T) {
	h := newMovedOffHost(t)
	ctx := t.Context()
	applied := machined.AckApplied
	h.deliver(h.attach(h.service), machined.Event{Seq: 1, EventID: [16]byte{0x52}, Payload: h.payload(h.actor, 1)}, &applied)
	moved := h.effects()
	require.Len(t, moved.waits, 1)
	wait := moved.waits[0].ID
	h.service.SetMovedOffReturn(movedReturnBoundary{})

	q := db.New(h.f.pool)
	outsider, err := q.CreateUser(ctx, db.CreateUserParams{Username: "moved-outsider", LowerUsername: "moved-outsider"})
	require.NoError(t, err)
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: outsider.ID, Username: outsider.Username, SessionKey: sha256Hex("moved-outsider-cookie"), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	repo := middleware.RepositoryRestrictionScope(h.f.row.RepositoryID)
	external := h.token(h.f.user, "moved-external", "read:repository,write:repository,read:user,"+repo+",via:claude-code", true)
	turn := liveAppTurnCredentialFixture(t, h.f.pool, h.f.user.ID)
	app := h.token(h.f.user, "moved-app", "read:repository,write:repository,read:user,via:smithers,terminal-session:"+turn+"/1", true)
	session := "5e550000-0000-4000-8000-0000000000c5"
	_, err = h.f.pool.Exec(ctx, `INSERT INTO workspace_sessions(id,workspace_id,repository_id,user_id,status) VALUES($1,$2,$3,$4,'running')`, session, h.f.row.ID, h.f.row.RepositoryID, h.f.user.ID)
	require.NoError(t, err)
	terminal := h.token(h.f.user, "moved-terminal", "read:repository,read:user,"+repo+","+strings.Join(middleware.DelegationScopes(middleware.Delegation{Via: "terminal", Branch: h.f.row.ID, Profile: middleware.TerminalProfileS1, Session: session}), ","), true)
	machine := h.token(h.f.user, "moved-machine", "write:repository,"+repo+","+middleware.WorkspaceRestrictionScope(h.f.row.ID), true)
	unbound := h.token(h.f.user, "moved-unbound", "write:repository,credential:other-install", false)

	for _, refused := range []struct {
		name, op   string
		credential func(*http.Request)
		status     int
		code       string
	}{
		{"delegated-keep", "keep-moved", bearer(external, "claude-code"), 403, "never"},
		{"app-agent-keep", "keep-moved", bearer(app, "smithers"), 403, "never"},
		{"external-agent-return", "return-to-item", bearer(external, "claude-code"), 403, "permission"},
		{"terminal-keep", "keep-moved", bearer(terminal, "codex"), 403, "permission"},
		{"terminal-return", "return-to-item", bearer(terminal, "codex"), 403, "permission"},
		{"machine-return", "return-to-item", bearer(machine, ""), 403, "permission"},
		{"unbound-return", "return-to-item", bearer(unbound, ""), 401, "unauthenticated"},
		{"unknown-bearer-return", "return-to-item", bearer("smithers_0000000000000000000000000000000000000000", ""), 401, "unauthenticated"},
		{"non-member-keep", "keep-moved", h.session("moved-outsider-cookie"), 403, "permission"},
	} {
		t.Run(refused.name, func(t *testing.T) {
			status, result := h.post(refused.op, wait, "refused-"+refused.name, refused.credential)
			require.Equal(t, refused.status, status, "%v", result)
			require.Equal(t, refused.code, result["code"], "%v", result)
			require.Equal(t, moved, h.effects(), "a refused press leaves no answer, fact or request")
		})
	}

	// Wrong wait: another TODO's or an earlier move's wait id is not this one.
	status, result := h.post("return-to-item", "moved-00000000-0000-0000-0000-000000000000", "stale-wait", h.session(h.f.cookie))
	require.Equal(t, http.StatusNotFound, status, "%v", result)
	require.Equal(t, "wait_not_found", result["code"])
	require.Equal(t, moved, h.effects())

	// The app agent acts for its person and may Return; the person's later
	// Keep learns who answered.
	status, result = h.post("return-to-item", wait, "app-return", bearer(app, "smithers"))
	require.Equal(t, http.StatusAccepted, status, "%v", result)
	answered := h.effects()
	require.Equal(t, "return-to-item", answered.waits[0].Answer)
	require.Equal(t, h.f.user.Username, answered.waits[0].AnsweredBy)
	require.Equal(t, moved.fact, answered.fact, "Return is requested; only metadata settlement clears the fact")
	status, result = h.post("keep-moved", wait, "late-keep", h.session(h.f.cookie))
	require.Equal(t, http.StatusConflict, status, "%v", result)
	require.Equal(t, h.f.user.Username, result["answered_by"])
}
