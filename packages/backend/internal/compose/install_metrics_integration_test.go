package compose

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
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
	"strconv"
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
	require.NoError(t, registerInstallMachineMetrics(metrics, runtime))
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
	t.Run("authenticated lifecycle qualification consumer refuses unqualified install", func(t *testing.T) {
		server := httptest.NewServer(router)
		defer server.Close()
		module, err := filepath.Abs("../../../../scripts/perf/lib/qualification.mjs")
		require.NoError(t, err)
		source := `import {requireMachineQualification} from ` + strconv.Quote("file://"+module) + `;
        Object.defineProperty(process,"platform",{value:"darwin"});
        const env={SMITHERS_PERF_ORIGIN:"http://mini.lan:8080",SMITHERS_PERF_OWNER_COOKIE:"session="+process.argv[2],SMITHERS_PERF_COMMIT:"a".repeat(40),SMITHERS_PERF_INSTALL_VERSION:"1.0.0",SMITHERS_PERF_MACHINE_QUALIFIED:"true"};
        let reads=0;
        const request=async(url,options)=>{
          if(url!=="http://mini.lan:8080/api/install/metrics"||options.redirect!=="error")throw new Error("foreign read");
          reads++;return new Promise(async(resolve,reject)=>{const {get}=await import("node:http");get(process.argv[1]+"/api/install/metrics",{headers:{...options.headers,Host:"mini.lan:8080"}},response=>{let data="";response.on("data",chunk=>data+=chunk);response.on("end",()=>resolve({status:response.statusCode,json:async()=>JSON.parse(data)}));response.on("error",reject)}).on("error",reject)});
        };
        for(const cookie of [env.SMITHERS_PERF_OWNER_COOKIE,"", "session="+process.argv[3]]){
          let refused=false;
          try{await requireMachineQualification({...env,SMITHERS_PERF_OWNER_COOKIE:cookie},request)}catch(error){
            if(!/authenticated lifecycle qualification unavailable/.test(error.message))throw error;
            refused=true;
          }
          if(!refused)throw new Error("unqualified install admitted machine workload");
        }
        if(reads!==2)throw new Error("missing identity refusal did not precede request");
        console.log("2 authenticated reads, 3 refusals, 0 mutations");`
		output, err := exec.CommandContext(t.Context(), "node", "--input-type=module", "-e", source, server.URL, cookies[0], cookies[1]).CombinedOutput()
		require.NoError(t, err, "%s", output)
	})
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
				require.Contains(t, w.Body.String(), `"machine_qualification":{"missing":["T-INS-02","T-MCH-11","T-SEC-01","T-MCH-10"],"status":"unavailable","version":1}`)
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
	t.Run("signed qualification publication", func(t *testing.T) {
		public, private, err := ed25519.GenerateKey(rand.Reader)
		require.NoError(t, err)
		id := services.QualificationIdentity{Commit: strings.Repeat("a", 40), InstallVersion: "1.0.0", BundleDigest: strings.Repeat("b", 64), Origin: "http://mini.lan:8080", HostID: "reference-mini"}
		qualified := services.MachineQualification{Version: 1, Status: "qualified", Commit: id.Commit, InstallVersion: id.InstallVersion, BundleDigest: id.BundleDigest, Origin: id.Origin, HostID: id.HostID, Runtime: "microvm", NonRoot: true, ReviewedBy: "smithers-3f", InventoryDigest: strings.Repeat("c", 64)}
		// Literal acceptance inventory, independent of the service's policy map.
		for name, paths := range map[string][]string{
			"TestGuestHelperInstallPinsInterpreterAndEnv": {"fresh", "retained"},
			"TestRootSetupNeverFollowsMemberSymlinks":     {"fresh", "retained"},
			"TestRootPreflightParsesOnlyEnvelope":         {"exec", "file", "terminal", "relay"},
			"TestRootLayerInputsValidatedBeforeUse":       {"layer"},
			"TestSSHRootInputsValidatedBeforeUse":         {"ssh", "retained"},
			"TestTerminalRootInputsValidatedBeforeUse":    {"terminal"},
			"TestBranchMachineRootInputsValidated":        {"fresh", "retained"},
			"TestMemberImageRootInputs":                   {"member-image"},
			"TestLiveDocumentBrokerInputs":                {"document", "retained"},
		} {
			qualified.Receipts = append(qualified.Receipts, services.QualificationReceipt{Name: name, Paths: paths, Status: "passed", Commit: id.Commit, BundleDigest: id.BundleDigest, InventoryDigest: qualified.InventoryDigest, Provenance: "authenticated-reference-host", ReceiptDigest: strings.Repeat("d", 64)})
		}
		var document []byte
		documentPath := filepath.Join(t.TempDir(), "machine-qualification.json")
		t.Setenv("SMITHERS_DATA_ROOT", filepath.Dir(documentPath))
		t.Setenv("SMITHERS_MACHINE_QUALIFICATION_FILE", "")
		sign := func(value services.MachineQualification) {
			payload, e := json.Marshal(value)
			require.NoError(t, e)
			document, e = json.Marshal(map[string]any{"key_id": "reviewed-mini", "payload": json.RawMessage(payload), "signature": base64.StdEncoding.EncodeToString(ed25519.Sign(private, payload))})
			require.NoError(t, e)
			require.NoError(t, os.WriteFile(documentPath, document, 0600))
		}
		authority := services.QualificationAuthority{HostID: id.HostID, PublicKey: public}
		service := services.NewInstalledQualification(id.Origin)
		service.Identity = func(context.Context) (services.QualificationIdentity, error) { return id, nil }
		service.Authorities = map[string]services.QualificationAuthority{"reviewed-mini": authority}
		for i := range args {
			if args[i].Type() == reflect.TypeOf(metrics) {
				args[i] = reflect.ValueOf(routes.NewSmithersMetrics())
			}
		}
		previous := args[len(args)-1]
		defer func() { args[len(args)-1] = previous }()
		args[len(args)-1] = reflect.ValueOf([]any{routerExtras{Qualification: service}})
		handler := fn.CallSlice(args)[0].Interface().(http.Handler)
		read := func(cookie string) *httptest.ResponseRecorder {
			request := httptest.NewRequest("GET", "http://mini.lan:8080/api/install/metrics", nil)
			request.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, request)
			return w
		}
		sign(qualified)
		require.Contains(t, read(cookies[0]).Body.String(), `"status":"qualified"`)
		require.Equal(t, 403, read(cookies[1]).Code)
		require.Equal(t, 403, read(cookies[2]).Code)
		for _, token := range []string{ownerToken, delegated} {
			request := httptest.NewRequest("GET", "http://mini.lan:8080/api/install/metrics", nil)
			request.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, request)
			require.Equal(t, 403, w.Code)
		}

		server := httptest.NewServer(handler)
		defer server.Close()
		module, e := filepath.Abs("../../../../scripts/perf/lib/qualification.mjs")
		require.NoError(t, e)
		source := `import {requireMachineQualification} from ` + strconv.Quote("file://"+module) + `;
Object.defineProperty(process,"platform",{value:"darwin"});
const env={SMITHERS_PERF_ORIGIN:"http://mini.lan:8080",SMITHERS_PERF_OWNER_COOKIE:"session="+process.argv[2],SMITHERS_PERF_COMMIT:"a".repeat(40),SMITHERS_PERF_INSTALL_VERSION:"1.0.0"};
const result=await requireMachineQualification(env,(_url,options)=>new Promise(async(resolve,reject)=>{const {get}=await import("node:http");get(process.argv[1]+"/api/install/metrics",{headers:{...options.headers,Host:"mini.lan:8080"}},response=>{let data="";response.on("data",chunk=>data+=chunk);response.on("end",()=>resolve({status:response.statusCode,json:async()=>JSON.parse(data)}));response.on("error",reject)}).on("error",reject)}));
if(result.receipts.length!==9||result.status!=="qualified")throw new Error("publication refused");`
		output, e := exec.CommandContext(t.Context(), "node", "--input-type=module", "-e", source, server.URL, cookies[0]).CombinedOutput()
		require.NoError(t, e, "%s", output)
		for _, mutate := range []struct {
			name   string
			change func(*services.MachineQualification)
		}{
			{"foreign commit", func(q *services.MachineQualification) { q.Commit = strings.Repeat("e", 40) }},
			{"foreign version", func(q *services.MachineQualification) { q.InstallVersion = "other" }},
			{"foreign bundle", func(q *services.MachineQualification) { q.BundleDigest = strings.Repeat("e", 64) }},
			{"foreign origin", func(q *services.MachineQualification) { q.Origin = "http://other.lan" }},
			{"foreign host", func(q *services.MachineQualification) { q.HostID = "other" }},
			{"process runtime", func(q *services.MachineQualification) { q.Runtime = "process" }},
			{"root", func(q *services.MachineQualification) { q.NonRoot = false }},
			{"unreviewed", func(q *services.MachineQualification) { q.ReviewedBy = "owner" }},
			{"missing receipt", func(q *services.MachineQualification) { q.Receipts = q.Receipts[:8] }},
			{"duplicate receipt", func(q *services.MachineQualification) { q.Receipts[1] = q.Receipts[0] }},
			{"failed receipt", func(q *services.MachineQualification) { q.Receipts[0].Status = "failed" }},
			{"missing path", func(q *services.MachineQualification) { q.Receipts[0].Paths = nil }},
			{"unauthenticated receipt", func(q *services.MachineQualification) { q.Receipts[0].Provenance = "fixture" }},
			{"unbound inventory", func(q *services.MachineQualification) { q.Receipts[0].InventoryDigest = strings.Repeat("e", 64) }},
			{"unbound bundle receipt", func(q *services.MachineQualification) { q.Receipts[0].BundleDigest = strings.Repeat("e", 64) }},
			{"invalid receipt digest", func(q *services.MachineQualification) { q.Receipts[0].ReceiptDigest = "not-a-digest" }},
			{"invalid inventory digest", func(q *services.MachineQualification) { q.InventoryDigest = "not-a-digest" }},
			{"duplicate paths", func(q *services.MachineQualification) {
				q.Receipts[0].Paths = append(append([]string(nil), q.Receipts[0].Paths...), q.Receipts[0].Paths[0])
			}},
			{"unknown receipt", func(q *services.MachineQualification) { q.Receipts[0].Name = "TestMadeUp" }},
			{"unknown version", func(q *services.MachineQualification) { q.Version = 2 }},
			{"unbound receipt", func(q *services.MachineQualification) { q.Receipts[0].Commit = strings.Repeat("e", 40) }},
		} {
			t.Run(mutate.name, func(t *testing.T) {
				q := qualified
				q.Receipts = append([]services.QualificationReceipt(nil), qualified.Receipts...)
				mutate.change(&q)
				sign(q)
				require.Contains(t, read(cookies[0]).Body.String(), `"status":"unavailable"`)
			})
		}
		sign(qualified)
		originalRead := service.Read
		service.Read = func(context.Context) ([]byte, error) { return nil, os.ErrNotExist }
		require.Contains(t, read(cookies[0]).Body.String(), `"status":"unavailable"`)
		service.Read = func(context.Context) ([]byte, error) { return make([]byte, (1<<20)+1), nil }
		require.Contains(t, read(cookies[0]).Body.String(), `"status":"unavailable"`)
		service.Read = originalRead
		originalIdentity := service.Identity
		service.Identity = func(context.Context) (services.QualificationIdentity, error) { return id, os.ErrInvalid }
		require.Contains(t, read(cookies[0]).Body.String(), `"status":"unavailable"`)
		service.Identity = originalIdentity
		for _, origin := range []string{"http://localhost:8080", "http://127.0.0.1:8080", "http://mini.lan/path", "http://owner@mini.lan", "https://mini.lan?q=1"} {
			previousOrigin := id.Origin
			id.Origin = origin
			q := qualified
			q.Origin = origin
			sign(q)
			require.Contains(t, read(cookies[0]).Body.String(), `"status":"unavailable"`)
			id.Origin = previousOrigin
		}
		sign(qualified)
		document[len(document)-4] ^= 1
		require.NoError(t, os.WriteFile(documentPath, document, 0600))
		require.Contains(t, read(cookies[0]).Body.String(), `"status":"unavailable"`)
		sign(qualified)
		service.Authorities = nil
		require.Contains(t, read(cookies[0]).Body.String(), `"status":"unavailable"`)
		service.Authorities = map[string]services.QualificationAuthority{"reviewed-mini": authority}
		document = append(document, []byte(` {}`)...)
		require.NoError(t, os.WriteFile(documentPath, document, 0600))
		require.Contains(t, read(cookies[0]).Body.String(), `"status":"unavailable"`)
	})
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
