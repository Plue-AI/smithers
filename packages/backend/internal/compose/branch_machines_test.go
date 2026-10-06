package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
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
// single-owner microVM runtime; injected providers stay a trusted-process
// test seam, and no composition takes both.
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
	runtime := new(microsandbox.Runtime)
	svc := services.NewWorkspaceService(q, services.WithWorkspaceRuntime(runtime), services.WithWorkspaceTransactions(pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), runtime)))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://localhost:4000"
	cfg.Server.AllowedOrigins = []string{"http://localhost:4000"}
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
	args[len(args)-1] = reflect.ValueOf([]any{routerExtras{}})
	router := fn.CallSlice(args)[0].Interface().(http.Handler)
	holder := "workspace:" + row.ID
	_, err = runtime.Request("todo", holder, holder, "machine")
	require.NoError(t, err)
	_, err = runtime.Request("person", "workspace:other", "person:2", "terminal")
	require.NoError(t, err)
	read := func(position int) {
		req := httptest.NewRequest("GET", "http://localhost:4000/api/branches/main", nil)
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
}
