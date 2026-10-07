package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	dto "github.com/prometheus/client_model/go"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestInstallMetricsOwnerBoundary(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	users := make([]db.User, 3)
	cookies := make([]string, 3)
	for i, login := range []string{"owner", "member", "maintainer"} {
		var err error
		users[i], err = q.CreateUser(ctx, db.CreateUserParams{Username: login, LowerUsername: login, DisplayName: login})
		require.NoError(t, err)
		cookies[i] = login + "-metrics-session"
		digest := sha256.Sum256([]byte(cookies[i]))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: users[i].ID, Username: login, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	}
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, users[0].ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: users[0].ID, Valid: true}, Name: "scratch", LowerName: "scratch", DefaultBookmark: "main"})
	require.NoError(t, err)
	for i, permission := range []string{"admin", "write", "admin"} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, users[i].ID, permission)
		require.NoError(t, err)
	}
	for key, value := range map[string]string{
		"github.repository": fmt.Sprintf(`{"owner_login":"owner","repository_name":"scratch","repository_id":%d}`, repo.ID),
		"owner.access":      fmt.Sprintf(`{"owner_login":"owner","repository_name":"scratch","repository_id":%d,"last_access_check_at":"2026-10-05T10:00:00Z"}`, repo.ID),
	} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	ownerToken := "smithers_0000000000000000000000000000000000000123"
	digest := sha256.Sum256([]byte(ownerToken))
	hash := hex.EncodeToString(digest[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: users[0].ID, Name: "metrics-cli", TokenHash: hash, TokenLastEight: hash[len(hash)-8:], Scopes: "read:repository", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	delegated := "smithers_0000000000000000000000000000000000000456"
	digest = sha256.Sum256([]byte(delegated))
	hash = hex.EncodeToString(digest[:])
	scopes := "read:repository"
	for _, scope := range middleware.DelegationScopes(middleware.Delegation{Via: "smithers", Session: liveAppTurnCredentialFixture(t, pool, users[0].ID) + "/1"}) {
		scopes += "," + scope
	}
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: users[0].ID, Name: "metrics-delegated", TokenHash: hash, TokenLastEight: hash[len(hash)-8:], SystemIssued: true, Scopes: scopes, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.AllowedOrigins = []string{"http://mini.lan:8080"}
	metrics := routes.NewSmithersMetrics()
	metrics.RequestDurationSeconds().WithLabelValues("POST", "/api/todos/{n}").Observe(.125)
	metrics.SetLandingQueueDepth(3)
	runtime := new(microsandbox.Runtime)
	metrics.MustRegister(runtime.MachineMetrics())
	_, err = runtime.Request("todo", "workspace:A", "todo:5", "machine")
	require.NoError(t, err)
	_, err = runtime.Request("person", "workspace:A", "Alice", "terminal")
	require.NoError(t, err)
	_, err = runtime.Request("background", "review:50", "review:50", "review")
	require.NoError(t, err)

	// Invoke the production composition with real auth storage and collectors;
	// unrelated handlers are absent, not substituted implementations.
	fn := reflect.ValueOf(buildRouter)
	args := make([]reflect.Value, fn.Type().NumIn())
	for i := range args {
		args[i] = reflect.Zero(fn.Type().In(i))
		for _, value := range []any{cfg, q, pool, metrics} {
			v := reflect.ValueOf(value)
			if v.Type() == fn.Type().In(i) {
				args[i] = v
			}
		}
	}
	capacity := &services.InstallCapacityService{Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 64 << 30, PerfCores: 10, PhysicalCores: 12, DiskFreeBytes: 200 << 30, MacOSVersion: "15.7", Hypervisor: true}}
	args[len(args)-1] = reflect.ValueOf([]any{routerExtras{GitHubAppSetup: &routes.GitHubAppSetupHandler{Owners: q, Setup: &services.InstallSetupService{Pool: pool, Capacity: capacity}}}})
	router := fn.CallSlice(args)[0].Interface().(http.Handler)
	for _, tc := range []struct {
		name, cookie, token string
		status              int
	}{
		{"anonymous", "", "", 401}, {"owner", cookies[0], "", 200},
		{"member", cookies[1], "", 403}, {"maintainer", cookies[2], "", 403},
		{"owner token", "", ownerToken, 403},
		{"delegated owner", "", delegated, 403},
		{"invalid delegated", "", "delegated-invalid", 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://mini.lan:8080/api/install/metrics", nil)
			if tc.cookie != "" {
				r.AddCookie(&http.Cookie{Name: "session", Value: tc.cookie})
			}
			if tc.token != "" {
				r.Header.Set("Authorization", "Bearer "+tc.token)
			}
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r)
			require.Equal(t, tc.status, w.Code, w.Body.String())
			if tc.status == 200 {
				require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
				var snapshot struct {
					Clock   string            `json:"clock"`
					Metrics []json.RawMessage `json:"metrics"`
				}
				require.NoError(t, json.Unmarshal(w.Body.Bytes(), &snapshot))
				require.Equal(t, "process cumulative collectors", snapshot.Clock)
				require.Contains(t, w.Body.String(), `"sample_sum":0.125`)
				require.Contains(t, w.Body.String(), `"name":"smithers_landing_queue_depth"`)
				require.Contains(t, w.Body.String(), `"value":3`)
				require.Contains(t, w.Body.String(), `"memory_bytes":68719476736`)
				require.Contains(t, w.Body.String(), `"perf_cores":10`)
				require.Contains(t, w.Body.String(), `"macos_version":"15.7"`)
				require.Contains(t, w.Body.String(), `"live_connections":0`)
				var data struct {
					Metrics []*dto.MetricFamily `json:"metrics"`
				}
				require.NoError(t, json.Unmarshal(w.Body.Bytes(), &data))
				depths := map[string]float64{}
				wakes := map[string]float64{}
				for _, family := range data.Metrics {
					if family.GetName() == "smithers_machine_wake_total" {
						for _, sample := range family.Metric {
							labels := map[string]string{}
							for _, label := range sample.Label {
								labels[label.GetName()] = label.GetValue()
							}
							wakes[labels["kind"]+":"+labels["outcome"]] = sample.GetCounter().GetValue()
						}
					}

					if family.GetName() != "smithers_machine_queue_depth" {
						continue
					}
					for _, sample := range family.Metric {
						require.Len(t, sample.Label, 1)
						require.Equal(t, "class", sample.Label[0].GetName())
						depths[sample.Label[0].GetValue()] = sample.GetGauge().GetValue()
					}
				}
				require.Equal(t, map[string]float64{"person": 1, "todo": 0, "background": 1}, depths)
				require.Equal(t, map[string]float64{"cold:success": 0, "cold:failure": 0, "warm:success": 0, "warm:failure": 0}, wakes)
				require.NotContains(t, w.Body.String(), `"name":"smithers_machine_wake_duration_seconds"`, "no wake duration is invented before a boot")

			}
		})
	}
	t.Run("SSHBenchmarkIdentity", func(t *testing.T) {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		require.NoError(t, err)
		cfg.Server.AllowedOrigins = []string{"http://" + listener.Addr().String()}
		for i := range args {
			if args[i].Type() == reflect.TypeOf(metrics) {
				args[i] = reflect.ValueOf(routes.NewSmithersMetrics())
			}
			if args[i].Type() == reflect.TypeOf((*routes.SSHKeyHandler)(nil)) {
				args[i] = reflect.ValueOf(&routes.SSHKeyHandler{Service: services.NewSSHKeyService(q)})
			}
		}
		server := httptest.NewUnstartedServer(fn.CallSlice(args)[0].Interface().(http.Handler))
		require.NoError(t, server.Listener.Close())
		server.Listener = listener
		server.Start()
		defer server.Close()
		identity := filepath.Join(t.TempDir(), "member_key")
		keygen := exec.CommandContext(t.Context(), "/usr/bin/ssh-keygen", "-t", "ed25519", "-N", "", "-f", identity)
		bytes, err := keygen.CombinedOutput()
		require.NoError(t, err, string(bytes))
		publicKey, err := os.ReadFile(identity + ".pub")
		require.NoError(t, err)
		// Derive the expected fingerprint independently with OpenSSH.
		bytes, err = exec.CommandContext(t.Context(), "/usr/bin/ssh-keygen", "-l", "-f", identity+".pub").Output()
		require.NoError(t, err)
		fields := strings.Fields(string(bytes))
		require.GreaterOrEqual(t, len(fields), 2)
		_, err = q.CreateSSHKey(ctx, db.CreateSSHKeyParams{UserID: users[0].ID, Name: "benchmark", PublicKey: string(publicKey), Fingerprint: fields[1], KeyType: "ssh-ed25519"})
		require.NoError(t, err)
		root, err := filepath.Abs("../../../..")
		require.NoError(t, err)
		for i, credential := range []string{"session=" + cookies[0], "session=" + cookies[1], ""} {
			command := exec.CommandContext(t.Context(), "node", "--input-type=module", "-e", `
import { authenticatedSSHKey } from './scripts/perf/lib/ssh-member.mjs'
const context = { request: { get: async (url, options) => {
  const response = await fetch(url, { headers: { Cookie: process.env.PERF_FIXTURE_COOKIE }, redirect: 'manual', signal: AbortSignal.timeout(options.timeout) })
  return { status: () => response.status, json: () => response.json() }
} } }
try { console.log(await authenticatedSSHKey(context, process.env.PERF_FIXTURE_ORIGIN, process.env.PERF_FIXTURE_IDENTITY)) }
catch (error) { console.log(error.message); process.exitCode = 1 }
`)
			command.Dir = root
			command.Env = append(os.Environ(), "PERF_FIXTURE_COOKIE="+credential, "PERF_FIXTURE_ORIGIN="+server.URL, "PERF_FIXTURE_IDENTITY="+identity)
			bytes, err = command.CombinedOutput()
			if i == 0 {
				require.NoError(t, err, string(bytes))
				require.Equal(t, fields[1], strings.TrimSpace(string(bytes)))
			} else {
				require.Error(t, err, string(bytes))
				if i == 1 {
					require.Contains(t, string(bytes), "not registered")
				} else {
					require.Contains(t, string(bytes), "returned 401")
				}
			}
		}
	})
	t.Run("TestPerfRunnerMissingProvider", func(t *testing.T) {
		// Real TCP, session storage, owner authorization and install composition.
		// Only the detected capacity is fixed; no measurement provider is faked.
		addresses, err := net.InterfaceAddrs()
		require.NoError(t, err)
		var host string
		for _, address := range addresses {
			if network, ok := address.(*net.IPNet); ok && network.IP.To4() != nil && !network.IP.IsLoopback() {
				host = network.IP.String()
				break
			}
		}
		require.NotEmpty(t, host, "LAN interface required for configured public-origin test")
		listener, err := net.Listen("tcp", net.JoinHostPort(host, "0"))
		require.NoError(t, err)
		cfg.Server.AllowedOrigins = []string{"http://" + listener.Addr().String()}
		for i := range args {
			if args[i].Type() == reflect.TypeOf(metrics) {
				args[i] = reflect.ValueOf(routes.NewSmithersMetrics())
			}
		}
		server := httptest.NewUnstartedServer(fn.CallSlice(args)[0].Interface().(http.Handler))
		require.NoError(t, server.Listener.Close())
		server.Listener = listener
		server.Start()
		defer server.Close()
		root, err := filepath.Abs("../../../..")
		require.NoError(t, err)
		for _, program := range []string{"run", "keystroke", "disk-write", "warm-wake", "rebase-hold"} {
			for _, credential := range []string{"session=" + cookies[0], "session=" + cookies[1]} {
				output := t.TempDir()
				command := exec.CommandContext(t.Context(), "node", "scripts/perf/"+program+".mjs")
				command.Dir = root
				command.Env = append(os.Environ(), "SMITHERS_PERF_ORIGIN="+server.URL,
					"SMITHERS_PERF_OWNER_COOKIE="+credential, "SMITHERS_PERF_TOKEN=",
					"SMITHERS_PERF_MEMBER_A=", "SMITHERS_PERF_ARTIFACT_ROOT="+output)
				bytes, err := command.CombinedOutput()
				var exit *exec.ExitError
				require.ErrorAs(t, err, &exit, string(bytes))
				require.Equal(t, 2, exit.ExitCode(), string(bytes))
				var summary struct {
					Status  string          `json:"status"`
					Host    json.RawMessage `json:"host"`
					Budgets []struct {
						Check, Status, Reason string
						Activation            []string
						Samples               []json.RawMessage
					} `json:"budgets"`
				}
				require.NoError(t, json.Unmarshal(bytes, &summary), string(bytes))
				require.Equal(t, "incomplete", summary.Status)
				if program == "run" {
					require.Len(t, summary.Budgets, 6)
				} else {
					require.Len(t, summary.Budgets, 1)
					require.Equal(t, map[string]string{"keystroke": "C-PERF-03", "disk-write": "C-PERF-04", "warm-wake": "C-PERF-05", "rebase-hold": "C-PERF-06"}[program], summary.Budgets[0].Check)
				}
				for _, budget := range summary.Budgets {
					require.Equal(t, "skipped", budget.Status)
					require.Empty(t, budget.Samples)
					require.NotEmpty(t, budget.Reason)
					if credential == "session="+cookies[1] {
						require.Contains(t, budget.Reason, "returned 403")
					} else if program != "run" {
						for _, ticket := range []string{"T-INS-02", "T-MCH-11", "T-SEC-01", "T-MCH-10"} {
							require.Contains(t, budget.Activation, ticket)
						}
					}
				}
				if credential == "session="+cookies[0] {
					require.Contains(t, string(summary.Host), `"perf_cores":10`, string(bytes))
				}
				require.NotContains(t, string(bytes), credential)
			}
		}
	})
}
