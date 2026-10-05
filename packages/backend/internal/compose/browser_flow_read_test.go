package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/background"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// relayBoxes is the relay's box lookup on real PostgreSQL: an owner with two
// repositories, a second person (Ben), and the install's branch machine
// service as the migrations create it. Only the repository service's answer
// (GetRepoView) is the test's: the caller may write the named repository
// while canWrite holds.
type relayBoxes struct {
	*db.Queries
	t                    *testing.T
	pool                 *pgxpool.Pool
	owner, ben, machines int64
	login                string
	repo, other          db.Repository
	canWrite             bool
	lookups              []db.GetFlowWorkspaceForUserRepoParams
}

func newRelayBoxes(t *testing.T) *relayBoxes {
	t.Helper()
	pool := composeTestDatabase.Pool(t)
	ctx := t.Context()
	b := &relayBoxes{Queries: db.New(pool), t: t, pool: pool, canWrite: true,
		login: "relay-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]}
	person := func(login string) int64 {
		var id int64
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES ($1,$1) RETURNING id`, login).Scan(&id))
		return id
	}
	b.owner, b.ben = person(b.login), person(b.login+"-ben")
	var err error
	b.machines, err = b.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	repository := func(name string) db.Repository {
		created, err := b.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: b.owner, Valid: true}, Name: name, LowerName: name, DefaultBookmark: "main"})
		require.NoError(t, err)
		return created
	}
	b.repo, b.other = repository("repo"), repository("other")
	return b
}

// box seeds one box of repository, owned by owner (a person, or the machine
// service for a TODO's lane), in status, with a write share for each writer.
func (b *relayBoxes) box(repository db.Repository, owner int64, status string, writers ...int64) string {
	b.t.Helper()
	id := uuid.NewString()
	var code, message *string
	if status == "failed" {
		failure := "box_failed"
		code, message = &failure, &failure
	}
	_, err := b.pool.Exec(b.t.Context(), `INSERT INTO workspaces(id,repository_id,user_id,name,vm_id,status,failure_code,failure_message)
		VALUES ($1,$2,$3,$4,$4,$5,$6,$7)`, id, repository.ID, owner, "box-"+id, status, code, message)
	require.NoError(b.t, err)
	for _, writer := range writers {
		b.share(id, owner, writer, "write")
	}
	return id
}

func (b *relayBoxes) share(box string, owner, grantee int64, level string) {
	b.t.Helper()
	_, err := b.UpsertWorkspaceShare(b.t.Context(), db.UpsertWorkspaceShareParams{WorkspaceID: box, OwnerUserID: owner, GranteeUserID: grantee, Level: level})
	require.NoError(b.t, err)
}

func (b *relayBoxes) exec(sql string, args ...any) {
	b.t.Helper()
	_, err := b.pool.Exec(b.t.Context(), sql, args...)
	require.NoError(b.t, err)
}

// GetRepoView answers the named repository, writable while canWrite holds.
func (b *relayBoxes) GetRepoView(ctx context.Context, _ *db.User, owner, name string) (services.RepoView, error) {
	repository, err := b.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{Owner: owner, LowerName: strings.ToLower(name)})
	return services.RepoView{Repository: repository, CanWrite: b.canWrite}, err
}

// GetFlowWorkspaceForUserRepo is the real query, recorded.
func (b *relayBoxes) GetFlowWorkspaceForUserRepo(ctx context.Context, params db.GetFlowWorkspaceForUserRepoParams) (db.Workspace, error) {
	b.lookups = append(b.lookups, params)
	return b.Queries.GetFlowWorkspaceForUserRepo(ctx, params)
}

func (b *relayBoxes) api() *browserFlowAPI { return &browserFlowAPI{repos: b, queries: b} }

// body is a relay call on box of repository: the procedure, or a provision
// when procedure is empty.
func (b *relayBoxes) body(repository db.Repository, box, procedure, payload string) string {
	if procedure == "" {
		return fmt.Sprintf(`{"repo":%q,"workspaceId":%q}`, b.login+"/"+repository.Name, box)
	}
	return fmt.Sprintf(`{"repo":%q,"workspaceId":%q,"procedure":%q,"payload":%s}`, b.login+"/"+repository.Name, box, procedure, payload)
}

// target is the relay's flow host target for box of repository, as caller.
func (b *relayBoxes) target(repository db.Repository, caller int64, box string) flowruntime.Target {
	return flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", repository.ID), PrincipalID: fmt.Sprintf("user:%d", caller),
		WorkspaceID: box, BindingKind: "browser-flow", BindingID: b.login + "/" + repository.Name}
}

func (b *relayBoxes) request(path, body string, caller int64) *http.Request {
	request := httptest.NewRequest("POST", path, strings.NewReader(body))
	return request.WithContext(context.WithValue(request.Context(), middleware.UserContextKey, &db.User{ID: caller, UserType: "user"}))
}

func browserFlowCall(api *browserFlowAPI, caller int64, body string, provision bool) (*httptest.ResponseRecorder, bool, string) {
	request := httptest.NewRequest("POST", "/api/workflow/rpc", strings.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), middleware.UserContextKey, &db.User{ID: caller, UserType: "user"}))
	writer := httptest.NewRecorder()
	_, target, _, ok := api.prepare(writer, request, provision)
	return writer, ok, target.WorkspaceID
}

func TestBrowserFlowRunsOnlyOnTheNamedBox(t *testing.T) {
	b := newRelayBoxes(t)
	for _, procedure := range []string{"List", "Plan", "Run", "Projection.Snapshot"} {
		for _, state := range []string{"missing", "failed", "suspended", "running"} {
			t.Run(procedure+"/"+state, func(t *testing.T) {
				box := uuid.NewString()
				if state != "missing" {
					box = b.box(b.repo, b.owner, state)
				}
				b.lookups = nil
				writer, ok, workspaceID := browserFlowCall(b.api(), b.owner, b.body(b.repo, box, procedure, `{}`), false)
				require.Equal(t, state == "running" || state == "suspended", ok)
				require.Equal(t, []db.GetFlowWorkspaceForUserRepoParams{{ID: box, RepositoryID: b.repo.ID, UserID: b.owner}}, b.lookups)
				switch state {
				case "missing":
					require.Equal(t, 404, writer.Code)
					require.Contains(t, writer.Body.String(), "Box unavailable.")
				case "failed":
					require.Equal(t, 409, writer.Code)
					require.Contains(t, writer.Body.String(), `"code":"workspace_gone"`)
				default:
					require.Equal(t, box, workspaceID)
				}
			})
		}
	}
}

// A TODO's lane is a branch machine the machine service owns, shared with
// its person alone. The relay and its flow host target accept it for that
// person, as the host's lease does (flowhost/store.go), and refuse it for
// anyone else, once a second person may write it, from another repository,
// or once it is deleted. A person's own box is theirs whatever its shares.
func TestBrowserFlowNamesALaneSharedWithTheCallerAlone(t *testing.T) {
	b := newRelayBoxes(t)
	for _, tc := range []struct {
		name   string
		caller func() int64
		box    func() string
		named  func() db.Repository
		ok     bool
	}{
		{"own box", nil, func() string { return b.box(b.repo, b.owner, "running") }, nil, true},
		{"own box another person may write", nil, func() string { return b.box(b.repo, b.owner, "running", b.ben) }, nil, true},
		{"lane shared with the caller alone", nil, func() string { return b.box(b.repo, b.machines, "running", b.owner) }, nil, true},
		{"lane a reader also sees", nil, func() string {
			lane := b.box(b.repo, b.machines, "running", b.owner)
			b.share(lane, b.machines, b.ben, "read")
			return lane
		}, nil, true},
		{"lane with a second writer", nil, func() string { return b.box(b.repo, b.machines, "running", b.owner, b.ben) }, nil, false},
		{"lane shared with nobody", nil, func() string { return b.box(b.repo, b.machines, "running") }, nil, false},
		{"lane the caller may only read", nil, func() string {
			lane := b.box(b.repo, b.machines, "running")
			b.share(lane, b.machines, b.owner, "read")
			return lane
		}, nil, false},
		{"lane of another person", func() int64 { return b.ben }, func() string { return b.box(b.repo, b.machines, "running", b.owner) }, nil, false},
		{"another person's own box", nil, func() string { return b.box(b.repo, b.ben, "running") }, nil, false},
		{"lane named through another repository", nil, func() string { return b.box(b.repo, b.machines, "running", b.owner) },
			func() db.Repository { return b.other }, false},
		{"deleted lane", nil, func() string {
			lane := b.box(b.repo, b.machines, "running", b.owner)
			b.exec(`UPDATE workspaces SET deleted_at=now() WHERE id=$1`, lane)
			return lane
		}, nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			caller, named := b.owner, b.repo
			if tc.caller != nil {
				caller = tc.caller()
			}
			if tc.named != nil {
				named = tc.named()
			}
			box := tc.box()
			for _, procedure := range []string{"", "Projection.Snapshot"} {
				writer, ok, workspaceID := browserFlowCall(b.api(), caller, b.body(named, box, procedure, `{}`), procedure == "")
				require.Equal(t, tc.ok, ok, writer.Body.String())
				if !tc.ok {
					require.Equal(t, 404, writer.Code)
					require.Contains(t, writer.Body.String(), "Box unavailable.")
					continue
				}
				require.Equal(t, box, workspaceID)
			}
			authority, err := browserFlowTarget{queries: b}.ResolveFlowHostTarget(t.Context(), b.target(named, caller, box))
			if !tc.ok {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			require.Equal(t, flowhost.Authority{Target: b.target(named, caller, box), RepositoryID: named.ID, UserID: caller,
				WorkspaceID: box, CatalogKey: flowhost.CatalogCoding}, authority)
		})
	}
}

// A call that names no box is refused before any lookup: there is no
// repository-level flow host (#2194).
func TestBrowserFlowWithoutABoxIsRefused(t *testing.T) {
	b := newRelayBoxes(t)
	b.box(b.repo, b.owner, "running")
	for _, provision := range []bool{false, true} {
		writer, ok, _ := browserFlowCall(b.api(), b.owner, fmt.Sprintf(`{"repo":%q,"procedure":"Run","payload":{}}`, b.login+"/repo"), provision)
		require.False(t, ok)
		require.Equal(t, 400, writer.Code)
		require.Empty(t, b.lookups)
		require.Contains(t, writer.Body.String(), "a box (workspaceId)")
	}
}

func TestBrowserFlowRefusesAReaderBeforeReadingTheBox(t *testing.T) {
	b := newRelayBoxes(t)
	b.canWrite = false
	writer, ok, _ := browserFlowCall(b.api(), b.owner, b.body(b.repo, b.box(b.repo, b.owner, "running"), "List", `{}`), false)
	require.False(t, ok)
	require.Equal(t, 404, writer.Code)
	require.Empty(t, b.lookups)
}

func TestBrowserFlowUnknownProcedureIsRefused(t *testing.T) {
	b := newRelayBoxes(t)
	writer := httptest.NewRecorder()
	b.api().rpc(writer, b.request("/api/workflow/rpc", b.body(b.repo, b.box(b.repo, b.owner, "running"), "Unknown", `{}`), b.owner))
	require.Equal(t, 400, writer.Code)
	require.Empty(t, b.lookups)
}

// The relay only reads a TODO's lane: the stack runs it, and its person acts
// on its runs through the TODO. Every other procedure is refused before the
// lane wakes or its host is reached; provision readies it for the reads. On
// the caller's own box every procedure passes.
func TestBrowserFlowRelaysOnlyReadsOnALane(t *testing.T) {
	b := newRelayBoxes(t)
	lane := b.box(b.repo, b.machines, "running", b.owner)
	own := b.box(b.repo, b.owner, "running")
	reads := map[string]bool{"List": true, "Projection.Snapshot": true}
	for procedure := range browserFlowProcedures {
		t.Run(procedure, func(t *testing.T) {
			writer, ok, _ := browserFlowCall(b.api(), b.owner, b.body(b.repo, lane, procedure, `{}`), false)
			require.Equal(t, reads[procedure], ok, writer.Body.String())
			if !reads[procedure] {
				require.Equal(t, 403, writer.Code)
				require.Contains(t, writer.Body.String(), `"code":"todo_requires_stack_admission"`)
			}
			writer, ok, _ = browserFlowCall(b.api(), b.owner, b.body(b.repo, own, procedure, `{}`), false)
			require.True(t, ok, writer.Body.String())
		})
	}
	writer, ok, workspaceID := browserFlowCall(b.api(), b.owner, b.body(b.repo, lane, "", ""), true)
	require.True(t, ok, writer.Body.String())
	require.Equal(t, lane, workspaceID)
	// The refusal holds through the whole relay: nothing reaches the host.
	dispatcher := &browserFlowRecordingDispatcher{}
	api := b.api()
	api.dispatcher = dispatcher
	recorder := httptest.NewRecorder()
	api.rpc(recorder, b.request("/api/workflow/rpc", b.body(b.repo, lane, "Run", `{"_tag":"Resume","runId":"run-1","idempotencyKey":"k"}`), b.owner))
	require.Equal(t, 403, recorder.Code, recorder.Body.String())
	require.Empty(t, dispatcher.calls)
}

// The target is the box's coding host, and only while the box runs.
func TestBrowserFlowTargetIsTheBoxCodingHost(t *testing.T) {
	b := newRelayBoxes(t)
	box := b.box(b.repo, b.owner, "running")
	_, ok, workspaceID := browserFlowCall(b.api(), b.owner, b.body(b.repo, box, "List", `{}`), false)
	require.True(t, ok)
	authority, err := browserFlowTarget{queries: b}.ResolveFlowHostTarget(t.Context(), b.target(b.repo, b.owner, workspaceID))
	require.NoError(t, err)
	require.Equal(t, flowhost.CatalogCoding, authority.CatalogKey)
	require.Equal(t, box, authority.WorkspaceID)
	b.exec(`UPDATE workspaces SET status='suspended' WHERE id=$1`, box)
	_, err = browserFlowTarget{queries: b}.ResolveFlowHostTarget(t.Context(), b.target(b.repo, b.owner, workspaceID))
	require.Error(t, err)
	// A target whose tenant is not the named repository's resolves nothing.
	wrong := b.target(b.repo, b.owner, workspaceID)
	wrong.TenantID = fmt.Sprintf("repository:%d", b.other.ID)
	b.exec(`UPDATE workspaces SET status='running' WHERE id=$1`, box)
	_, err = browserFlowTarget{queries: b}.ResolveFlowHostTarget(t.Context(), wrong)
	require.Error(t, err)
}

// #2206: a running box built with a subscription token is not entered, even
// on a deployment that allows ChatGPT tokens: it marks a box only for a
// Claude one (#2777).
func TestBrowserFlowRefusesRebuildRequiredBox(t *testing.T) {
	b := newRelayBoxes(t)
	box := b.box(b.repo, b.owner, "running")
	b.exec(`UPDATE workspaces SET rebuild_required_at=now() WHERE id=$1`, box)
	writer, ok, _ := browserFlowCall(b.api(), b.owner, b.body(b.repo, box, "List", `{}`), false)
	require.False(t, ok)
	require.Equal(t, 409, writer.Code)
}

type startingDispatcher struct {
	ready   bool
	err     error
	targets []flowruntime.Target
}

func (d *startingDispatcher) CallRPC(context.Context, flowruntime.Target, string, json.RawMessage) (json.RawMessage, error) {
	return nil, errors.New("provision never relays a procedure")
}

func (*startingDispatcher) RefuseRelay(ctx context.Context, target flowruntime.Target, procedure string, payload json.RawMessage) error {
	return (&flowdispatch.Service{}).RefuseRelay(ctx, target, procedure, payload)
}

func (d *startingDispatcher) StartHost(_ context.Context, target flowruntime.Target) (bool, error) {
	d.targets = append(d.targets, target)
	return d.ready, d.err
}

// Provision starts the box's coding host and answers "provisioning" until it
// is live, so the flows list works before the box's first run (#2198). A
// TODO's lane shared with the caller alone provisions for them.
func TestBrowserFlowProvisionStartsTheBoxHost(t *testing.T) {
	b := newRelayBoxes(t)
	for name, box := range map[string]string{
		"own box": b.box(b.repo, b.owner, "running"),
		"lane":    b.box(b.repo, b.machines, "running", b.owner),
	} {
		t.Run(name, func(t *testing.T) {
			provision := func(dispatcher *startingDispatcher) *httptest.ResponseRecorder {
				writer := httptest.NewRecorder()
				api := b.api()
				api.dispatcher = dispatcher
				api.provision(writer, b.request("/api/workflow/provision", b.body(b.repo, box, "", ""), b.owner))
				return writer
			}
			starting := &startingDispatcher{}
			writer := provision(starting)
			require.Equal(t, 200, writer.Code)
			require.JSONEq(t, `{"status":"provisioning"}`, writer.Body.String())
			require.Equal(t, []flowruntime.Target{b.target(b.repo, b.owner, box)}, starting.targets)

			writer = provision(&startingDispatcher{ready: true})
			require.Equal(t, 200, writer.Code)
			require.JSONEq(t, `{"status":"ready","workspaceId":"`+box+`","gatewayId":"`+box+`"}`, writer.Body.String())

			writer = provision(&startingDispatcher{err: testFlowFailure("runtime_start_failed")})
			require.Equal(t, 503, writer.Code)
			require.Contains(t, writer.Body.String(), `"code":"runtime_start_failed"`)

			// The plan limit that refused the start reaches the app as itself.
			limit := pkgerrors.New(pkgerrors.CodePlanLimitExceeded, "Your Free plan allows 1 running sandbox.")
			writer = provision(&startingDispatcher{err: fmt.Errorf("flow host: runtime_start_failed: %w", limit)})
			require.Equal(t, 402, writer.Code)
			require.Contains(t, writer.Body.String(), "plan_limit_exceeded")

			// A box whose stale helper could not be refreshed answers that
			// typed reason, not a host outage (#3111).
			stale := &pkgerrors.APIError{Status: 409, Code: pkgerrors.CodeCodingHostUnavailable, Message: "workspace helper could not be refreshed; retry"}
			writer = provision(&startingDispatcher{err: fmt.Errorf("flow host: runtime_start_failed: %w", stale)})
			require.Equal(t, 409, writer.Code)
			require.Contains(t, writer.Body.String(), `"coding_host_unavailable"`)
			require.Contains(t, writer.Body.String(), "workspace helper could not be refreshed; retry")
		})
	}
}

type testFlowFailure string

func (failure testFlowFailure) Error() string              { return string(failure) }
func (failure testFlowFailure) FlowRuntimeCode() string    { return string(failure) }
func (failure testFlowFailure) FlowRuntimeRetryable() bool { return true }

type resumingBoxes struct {
	resumed chan string
	err     error
}

func (b *resumingBoxes) ResumeWorkspace(_ context.Context, id string, _, _ int64) (services.WorkspaceResponse, error) {
	b.resumed <- id
	return services.WorkspaceResponse{}, b.err
}

// A sleeping box wakes in the background: provision and a snapshot answer
// "provisioning" at once, any other procedure is refused as starting, and a
// resume that failed is answered to the next poll (#2198).
func TestBrowserFlowWakesASleepingBox(t *testing.T) {
	b := newRelayBoxes(t)
	box := b.box(b.repo, b.owner, "suspended")
	boxes := &resumingBoxes{resumed: make(chan string, 4), err: pkgerrors.New(pkgerrors.CodePlanLimitExceeded, "Your Free plan allows 1 running sandbox.")}
	dispatcher := &startingDispatcher{}
	api := b.api()
	api.dispatcher, api.boxes, api.resumes = dispatcher, boxes, background.Jobs[string]{FailureTTL: time.Minute}
	call := func(procedure, payload string) *httptest.ResponseRecorder {
		writer := httptest.NewRecorder()
		if procedure == "" {
			api.provision(writer, b.request("/api/workflow/provision", b.body(b.repo, box, "", ""), b.owner))
		} else {
			api.rpc(writer, b.request("/api/workflow/rpc", b.body(b.repo, box, procedure, payload), b.owner))
		}
		return writer
	}
	writer := call("", "")
	require.JSONEq(t, `{"status":"provisioning"}`, writer.Body.String())
	require.Equal(t, box, <-boxes.resumed)
	require.Eventually(t, func() bool { return !api.resumes.Running(box) }, time.Second, time.Millisecond)
	writer = call("", "")
	require.Equal(t, 402, writer.Code, "the plan limit that refused the resume")

	boxes.err = nil
	writer = call("Projection.Snapshot", `{}`)
	require.JSONEq(t, `{"status":"provisioning"}`, writer.Body.String())
	<-boxes.resumed
	writer = call("Plan", `{"flowId":"coding/dispatch","input":{}}`)
	require.Equal(t, 409, writer.Code)
	require.Contains(t, writer.Body.String(), `"code":"workspace_starting"`)
	require.Empty(t, dispatcher.targets, "a sleeping box's host is not started until it runs")

	// A snapshot of a running box whose host is not running starts it.
	b.exec(`UPDATE workspaces SET status='running' WHERE id=$1`, box)
	api.dispatcher = &hostlessDispatcher{startingDispatcher: dispatcher}
	writer = call("Projection.Snapshot", `{}`)
	require.JSONEq(t, `{"status":"provisioning"}`, writer.Body.String())
	require.Len(t, dispatcher.targets, 1)
	writer = call("List", `{"_tag":"flows"}`)
	require.JSONEq(t, `{"status":"provisioning"}`, writer.Body.String(), "the flows list of a box whose host is down starts it")
	require.Len(t, dispatcher.targets, 2)
}

type hostlessDispatcher struct{ *startingDispatcher }

func (d *hostlessDispatcher) CallRPC(context.Context, flowruntime.Target, string, json.RawMessage) (json.RawMessage, error) {
	return nil, testFlowFailure("runtime_host_not_running")
}

// A stopped box is resumed only by provision; a read of it says so. A resume
// that fails for another reason is typed. A TODO's lane the merge stopped
// wakes the same way for its person.
func TestBrowserFlowStoppedBoxWakesOnlyOnProvision(t *testing.T) {
	b := newRelayBoxes(t)
	for name, box := range map[string]string{
		"own box": b.box(b.repo, b.owner, "stopped"),
		"lane":    b.box(b.repo, b.machines, "stopped", b.owner),
	} {
		t.Run(name, func(t *testing.T) {
			boxes := &resumingBoxes{resumed: make(chan string, 4), err: errors.New("vm unavailable")}
			api := b.api()
			api.dispatcher, api.boxes, api.resumes = &startingDispatcher{}, boxes, background.Jobs[string]{FailureTTL: time.Minute}
			call := func(provision bool, body string) *httptest.ResponseRecorder {
				writer := httptest.NewRecorder()
				request := b.request("/api/workflow/rpc", body, b.owner)
				if provision {
					api.provision(writer, request)
				} else {
					api.rpc(writer, request)
				}
				return writer
			}
			writer := call(false, b.body(b.repo, box, "Projection.Snapshot", `{}`))
			require.Equal(t, 409, writer.Code)
			require.Contains(t, writer.Body.String(), `"code":"workspace_stopped"`)
			require.Empty(t, boxes.resumed)

			require.JSONEq(t, `{"status":"provisioning"}`, call(true, b.body(b.repo, box, "", "")).Body.String())
			require.Equal(t, box, <-boxes.resumed)
			require.Eventually(t, func() bool { return !api.resumes.Running(box) }, time.Second, time.Millisecond)
			writer = call(true, b.body(b.repo, box, "", ""))
			require.Equal(t, 503, writer.Code)
			require.Contains(t, writer.Body.String(), `"code":"workspace_resume_failed"`)
		})
	}
}

// The API budget covers what a person does on a box, not a run's progress polls.
func TestBrowserFlowBudgetsAllButProgressReads(t *testing.T) {
	b := newRelayBoxes(t)
	box := b.box(b.repo, b.owner, "running")
	limited := []string{}
	api := b.api()
	api.dispatcher = &hostlessDispatcher{startingDispatcher: &startingDispatcher{}}
	api.limit = func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			limited = append(limited, "limited")
			next.ServeHTTP(w, r)
		})
	}
	for procedure, payload := range map[string]string{"Projection.Snapshot": `{}`, "List": `{}`,
		"Plan": `{"flowId":"coding/dispatch","input":{}}`, "Run": `{"_tag":"Resume","runId":"run-1","idempotencyKey":"k"}`} {
		api.rpc(httptest.NewRecorder(), b.request("/api/workflow/rpc", b.body(b.repo, box, procedure, payload), b.owner))
	}
	require.Len(t, limited, 2)
}
