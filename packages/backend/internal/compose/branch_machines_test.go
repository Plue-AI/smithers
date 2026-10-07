package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/workspace"
)

type ownerOnly struct{ owner int64 }

func (o ownerOnly) AuthorizeMember(_ context.Context, userID int64) *pkgerrors.APIError {
	if userID != o.owner {
		return pkgerrors.Forbidden("not the owner")
	}
	return nil
}

// guestMicroVM is a microVM runtime whose guests run repository code as agent.
type guestMicroVM struct{ isolatedRuntime }

func (guestMicroVM) GuestIdentity() (string, int) { return "agent", 19999 }

// The install composes its own branch machine providers only on a
// single-owner microVM runtime, a hosted deployment its hosted providers only
// on a microVM runtime; injected providers stay a trusted-process test seam,
// and no composition takes two.
func TestComposeBranchMachines(t *testing.T) {
	trusted := isolatedRuntime{isolation: workspace.IsolationTrustedProcess}
	microVM := guestMicroVM{isolatedRuntime{isolation: workspace.IsolationSandboxed}}
	injected := &services.BranchMachineProviders{}
	for _, tc := range []struct {
		name    string
		options Options
		hosted  bool
		want    string
		install bool
		// hostedProviders checks the hosted providers, whose membership and
		// authority read the database (TestHostedBranchMachineMembership).
		hostedProviders bool
	}{
		{name: "neither keeps machines dark", options: Options{Workspace: microVM}},
		{name: "both", options: Options{Workspace: trusted, BranchMachines: injected, InstallBranchMachines: true},
			want: "branch machine providers are injected or the install's, not both"},
		{name: "injected on trusted process", options: Options{Workspace: trusted, BranchMachines: injected}},
		{name: "injected on a microVM", options: Options{Workspace: microVM, BranchMachines: injected},
			want: "injected branch machine providers are for the trusted-process runtime only"},
		{name: "injected without a runtime", options: Options{BranchMachines: injected},
			want: "injected branch machine providers are for the trusted-process runtime only"},
		{name: "install on a microVM", options: Options{Workspace: microVM, InstallBranchMachines: true}, install: true},
		{name: "install on trusted process", options: Options{Workspace: trusted, InstallBranchMachines: true},
			want: "install branch machines require the microVM workspace runtime"},
		{name: "install without a runtime", options: Options{InstallBranchMachines: true},
			want: "install branch machines require the microVM workspace runtime"},
		{name: "install on a hosted deployment", options: Options{Workspace: microVM, InstallBranchMachines: true}, hosted: true,
			want: "install branch machines require a single-owner install"},
		{name: "hosted on a microVM", options: Options{Workspace: microVM, HostedBranchMachines: true}, hosted: true, hostedProviders: true},
		{name: "hosted on an install", options: Options{Workspace: microVM, HostedBranchMachines: true},
			want: "hosted branch machines require a hosted deployment"},
		{name: "hosted on trusted process", options: Options{Workspace: trusted, HostedBranchMachines: true}, hosted: true,
			want: "hosted branch machines require the microVM workspace runtime"},
		{name: "hosted without a runtime", options: Options{HostedBranchMachines: true}, hosted: true,
			want: "hosted branch machines require the microVM workspace runtime"},
		{name: "hosted and install", options: Options{Workspace: microVM, HostedBranchMachines: true, InstallBranchMachines: true}, hosted: true,
			want: "hosted branch machine providers exclude injected and install providers"},
		{name: "hosted and injected", options: Options{Workspace: trusted, HostedBranchMachines: true, BranchMachines: injected}, hosted: true,
			want: "hosted branch machine providers exclude injected and install providers"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			providers, err := composeBranchMachines(tc.options, tc.hosted, ownerOnly{owner: 7})
			if tc.want != "" {
				require.EqualError(t, err, tc.want)
				require.Nil(t, providers)
				return
			}
			require.NoError(t, err)
			switch {
			case tc.hostedProviders:
				require.NotNil(t, providers)
				ctx := context.Background()
				require.NoError(t, providers.MicroVM(ctx))
				require.NoError(t, providers.SessionIdentity(ctx))
				require.Error(t, providers.Authorize(ctx, nil, "branch.fork", 1, "main", 7), "an unknown command is refused before any read")
				require.NotNil(t, providers.Membership)
				require.NotNil(t, providers.LaneBinding)
			case tc.options.BranchMachines != nil:
				require.Same(t, injected, providers)
			case !tc.install:
				require.Nil(t, providers)
			default:
				require.NotNil(t, providers)
				ctx := context.Background()
				require.NoError(t, providers.MicroVM(ctx))
				require.NoError(t, providers.SessionIdentity(ctx))
				require.NoError(t, providers.Authorize(ctx, nil, "branch.join", 1, "scratch/owner/a", 7))
				require.Error(t, providers.Authorize(ctx, nil, "branch.join", 1, "scratch/owner/a", 8))
				require.NotNil(t, providers.Membership)
				require.NotNil(t, providers.LaneBinding)
			}
		})
	}
}

// This proves branch queue projections through the production install router;
// it is not a terminal/SSH dispatch or real-VM C-MCH-11 receipt.
func TestFrTMCH06BranchWaitPositionProductionHTTPPostgres(t *testing.T) {
	raw := os.Getenv("SMITHERS_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("SMITHERS_TEST_DATABASE_URL required")
	}
	ctx := t.Context()
	admin, err := pgx.Connect(ctx, raw)
	require.NoError(t, err)
	t.Cleanup(func() { _ = admin.Close(context.Background()) })
	name := fmt.Sprintf("fr_t_mch_06_%d", time.Now().UnixNano())
	_, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize())
	require.NoError(t, err)
	t.Cleanup(func() {
		_, err := admin.Exec(context.Background(), "DROP DATABASE "+pgx.Identifier{name}.Sanitize())
		require.NoError(t, err)
	})
	u, err := url.Parse(raw)
	require.NoError(t, err)
	u.Path = "/" + name
	pool, err := postgresfixture.Open(ctx, u.String(), 5)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	require.NoError(t, product.Apply(ctx, pool))
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "admissionowner", LowerUsername: "admissionowner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "fixture", LowerName: "fixture", DefaultBookmark: "main"})
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(`{"owner_login":"admissionowner","repository_name":"fixture","repository_id":0}`)}))
	access := fmt.Sprintf(`{"owner_login":"admissionowner","repository_name":"fixture","repository_id":0,"last_access_check_at":%q}`, time.Now().UTC().Format(time.RFC3339Nano))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(access)}))
	token := "fr-t-mch-06-session"
	hash := sha256.Sum256([]byte(token))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: owner.ID, Username: owner.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: owner.ID, Name: "main", Kind: "container", Status: "starting", TargetBookmark: "main", EnvironmentSource: "base"})
	require.NoError(t, err)
	// Restart settles a transitional VM through independently confirmed stop
	// before the authenticated Home projection can report its slot as free.
	root := t.TempDir()
	sum := sha256.Sum256([]byte(row.ID))
	directory := filepath.Join(root, "workspaces", hex.EncodeToString(sum[:]))
	require.NoError(t, os.MkdirAll(directory, 0700))
	require.NoError(t, os.WriteFile(filepath.Join(root, "owner"), []byte("smithers-backend-0123456789abcdef\n"), 0600))
	machine := "smthrs-ws-01234567-" + hex.EncodeToString(sum[:])[:20]
	metadata, err := json.Marshal(map[string]any{"version": 1, "id": row.ID, "machine": machine, "state": "starting"})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(directory, "metadata.json"), metadata, 0600))
	binary := filepath.Join(t.TempDir(), "msb")
	marker := filepath.Join(t.TempDir(), "stop-confirmed")
	script := fmt.Sprintf(`#!/bin/sh
case "$1" in
 list) if [ -f %q ]; then echo '[{"name":%q,"status":"stopped"}]'; else echo '[{"name":%q,"status":"starting"}]'; fi ;;
 stop) touch %q ;;
 *) exit 99 ;;
esac
`, marker, machine, machine, marker)
	require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
	runtime, err := microsandbox.New(ctx, microsandbox.Config{Root: root, Binary: binary, CPUs: 2, MemoryMiB: 8192, DiskMiB: 32768, MaxRunningVMs: 3, SkipQualification: true})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	require.FileExists(t, marker)
	observed, err := runtime.InspectWorkspace(ctx, row.ID)
	require.NoError(t, err)
	require.Equal(t, workspace.WorkspaceStopped, observed.State)
	svc := services.NewWorkspaceService(q, services.WithWorkspaceRuntime(runtime), services.WithWorkspaceBillingPolicy(services.NewMachineAdmissionPolicy(services.NewUnlimitedBillingPolicy())), services.WithWorkspaceTransactions(pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), runtime)))
	cfg := testConfigAllFlagsOn()
	server := httptest.NewUnstartedServer(nil)
	t.Cleanup(server.Close)
	origin := "http://" + server.Listener.Addr().String()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	hubCtx, cancelHub := context.WithCancel(ctx)
	t.Cleanup(cancelHub)
	capacity := &services.InstallCapacityService{Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 64 << 30, PerfCores: 8, DiskFreeBytes: 140 << 30}, InUse: runtime.InUse}
	topics := &liveTopics{queries: q, todos: &todoCalls{}, capacity: capacity}
	liveHandler := &routes.LiveHandler{Queries: q, Hub: live.NewHub(hubCtx, nil), Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	fn := reflect.ValueOf(buildRouter)
	args := make([]reflect.Value, fn.Type().NumIn())
	for i := range args[:len(args)-1] {
		args[i] = reflect.Zero(fn.Type().In(i))
		if fn.Type().In(i) == reflect.TypeOf(q) {
			args[i] = reflect.ValueOf(q)
		}
		if fn.Type().In(i) == reflect.TypeOf(pool) {
			args[i] = reflect.ValueOf(pool)
		}
		if fn.Type().In(i) == reflect.TypeOf(&routes.WorkspaceHandler{}) {
			args[i] = reflect.ValueOf(&routes.WorkspaceHandler{Service: svc})
		}
	}
	args[0] = reflect.ValueOf(cfg)
	args[len(args)-1] = reflect.ValueOf([]any{routerExtras{Live: liveHandler}})
	router := fn.CallSlice(args)[0].Interface().(http.Handler)
	server.Config.Handler = router
	server.Start()
	holder := "workspace:" + row.ID
	_, err = runtime.Request("todo", holder, holder, "machine")
	require.NoError(t, err)
	_, err = runtime.Request("person", "workspace:other", "person:2", "terminal")
	require.NoError(t, err)
	read := func(position int) {
		req := httptest.NewRequest("GET", origin+"/api/branches/main", nil)
		req.RemoteAddr = "127.0.0.1:1234"
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: token})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		require.Equal(t, 200, response.Code, response.Body.String())
		var branch services.BranchMachineResponse
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &branch))
		require.Equal(t, position, branch.Machine.WaitPosition)
		if position == 0 {
			require.NotContains(t, response.Body.String(), `"wait_position"`)
		}
	}
	read(2)
	runtime.CancelAdmission("workspace:other", "person:2", time.Now())
	read(1)
	runtime.CancelAdmission(holder, holder, time.Now())
	read(0)
	require.Zero(t, runtime.InUse(), "reads never wake machines")
	// A failed owner terminal wake must withdraw its person demand, preserving
	// a TODO on the same branch and the other person's queue position. This is
	// the existing workspace-session HTTP door, not a full C-MCH-11 journey.
	_, err = q.UpdateWorkspaceStatus(ctx, db.UpdateWorkspaceStatusParams{ID: row.ID, Status: "suspended"})
	require.NoError(t, err)
	svc.EnableMachineAdmission(nil) // unavailable disk provider refuses before VM boot
	_, err = runtime.Request("todo", holder, holder, "machine")
	require.NoError(t, err)
	_, err = runtime.Request("person", "workspace:other", "person:2", "terminal")
	require.NoError(t, err)
	request := httptest.NewRequest("POST", origin+"/api/repos/admissionowner/fixture/workspace/sessions", strings.NewReader(fmt.Sprintf(`{"workspace_id":%q}`, row.ID)))
	request.RemoteAddr = "127.0.0.1:1234"
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", origin)
	request.Header.Set("X-CSRF-Token", "csrf")
	request.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
	request.AddCookie(&http.Cookie{Name: "smithers_session", Value: token})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	require.Equal(t, 503, response.Code, response.Body.String())
	rows := runtime.AdmissionSnapshot()
	require.Len(t, rows, 3)
	require.Equal(t, "waiting", rows[0].State)
	require.Equal(t, 2, rows[0].Position)
	require.Equal(t, "waiting", rows[1].State)
	require.Equal(t, 1, rows[1].Position)
	require.True(t, strings.HasPrefix(rows[2].Actor, fmt.Sprintf("person:%d:session:", owner.ID)))
	require.Equal(t, "cancelled", rows[2].State)
	read(2)
	_, err = q.UpdateWorkspaceStatus(ctx, db.UpdateWorkspaceStatusParams{ID: row.ID, Status: "stopped"})
	require.NoError(t, err)
	read(2)
	runtime.CancelAdmission("workspace:other", "person:2", time.Now())
	read(1)
	runtime.CancelAdmission(holder, holder, time.Now())
	read(0)
	require.Zero(t, runtime.InUse(), "failed terminal wake never boots a VM")

	// Closing a queued terminal withdraws only that session's request. Another
	// terminal owned by the same person and the TODO remain coalesced on D.
	first, err := q.CreateWorkspaceSession(ctx, db.CreateWorkspaceSessionParams{WorkspaceID: row.ID, RepositoryID: repo.ID, UserID: owner.ID, Cols: 80, Rows: 24})
	require.NoError(t, err)
	second, err := q.CreateWorkspaceSession(ctx, db.CreateWorkspaceSessionParams{WorkspaceID: row.ID, RepositoryID: repo.ID, UserID: owner.ID, Cols: 80, Rows: 24})
	require.NoError(t, err)
	actor := func(id string) string { return fmt.Sprintf("person:%d:session:%s", owner.ID, id) }
	_, err = runtime.Request("todo", holder, holder, "machine")
	require.NoError(t, err)
	_, err = runtime.Request("person", "workspace:other", "person:2", "terminal")
	require.NoError(t, err)
	_, err = runtime.Request("person", holder, actor(first.ID), "machine")
	require.NoError(t, err)
	_, err = runtime.Request("person", holder, actor(second.ID), "machine")
	require.NoError(t, err)
	read(2)
	for _, stopped := range []string{first.ID, second.ID} {
		request := httptest.NewRequest("POST", origin+"/api/repos/admissionowner/fixture/workspace/sessions/"+stopped+"/destroy", nil)
		request.RemoteAddr = "127.0.0.1:1234"
		request.Header.Set("Origin", origin)
		request.Header.Set("X-CSRF-Token", "csrf")
		request.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		request.AddCookie(&http.Cookie{Name: "smithers_session", Value: token})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		require.Equal(t, http.StatusNoContent, response.Code, response.Body.String())
		stored, err := q.GetWorkspaceSession(ctx, stopped)
		require.NoError(t, err)
		require.Equal(t, "stopped", stored.Status)
		for _, demand := range runtime.AdmissionSnapshot() {
			if demand.Actor == actor(stopped) {
				require.Equal(t, "cancelled", demand.State)
				require.Zero(t, demand.Position)
			}
			if demand.Actor == holder || stopped == first.ID && demand.Actor == actor(second.ID) {
				require.Equal(t, "waiting", demand.State)
				require.Equal(t, 2, demand.Position)
			}
		}
		read(2)
	}
	runtime.CancelAdmission("workspace:other", "person:2", time.Now())
	read(1)
	runtime.CancelAdmission(holder, holder, time.Now())
	read(0)
	require.Zero(t, runtime.InUse())

	// The Home card uses the same owner capacity and runtime accounting as
	// admission, rather than counting only the machines visible on TODO cards.
	header := http.Header{"Origin": []string{origin}, "Cookie": []string{"smithers_session=" + token}}
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{"smithers.live.v1"}, HTTPHeader: header})
	require.NoError(t, err)
	defer conn.CloseNow()
	require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"home"}`)))
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		_, raw, err := conn.Read(readCtx)
		require.NoError(t, err)
		var frame liveFrame
		require.NoError(t, json.Unmarshal(raw, &frame))
		if frame.T != "snap" {
			require.NotEqual(t, "err", frame.T, string(raw))
			continue
		}
		var home struct {
			Machines services.MachineCapacity `json:"machines"`
		}
		require.NoError(t, json.Unmarshal(frame.Data, &home))
		require.Equal(t, services.MachineCapacity{InUse: 0, Capacity: 3}, home.Machines)
		break
	}
}
