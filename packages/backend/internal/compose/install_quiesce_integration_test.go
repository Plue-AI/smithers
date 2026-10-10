package compose

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// This exercises the install router's actual auth, CSRF, admission and owner
// handler against PostgreSQL. Missing capture must never create a freeze row.
func TestInstallQuiesceRouteGate(t *testing.T) {
	// Use only this lane's database. The shared test harness's automatic
	// orphan sweep must never remove a database this test did not create.
	server := os.Getenv("SMITHERS_INS07_DATABASE_URL")
	if server == "" {
		t.Skip("set SMITHERS_INS07_DATABASE_URL")
	}
	admin, err := pgx.Connect(t.Context(), server)
	require.NoError(t, err)
	name := fmt.Sprintf("fr_t_ins_07_quiesce_%d", time.Now().UnixNano())
	_, err = admin.Exec(t.Context(), "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()+" TEMPLATE template0")
	require.NoError(t, err)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_, err := admin.Exec(ctx, "DROP DATABASE "+pgx.Identifier{name}.Sanitize())
		require.NoError(t, err)
		require.NoError(t, admin.Close(ctx))
	})
	address, err := url.Parse(server)
	require.NoError(t, err)
	address.Path = "/" + name
	pool, err := postgresfixture.Open(t.Context(), address.String(), 4)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	require.NoError(t, product.Apply(t.Context(), pool))
	q := db.New(pool)
	ctx := t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "quiesceowner", LowerUsername: "quiesceowner"})
	require.NoError(t, err)
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "quiescemember", LowerUsername: "quiescemember"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	for key, value := range map[string]string{
		"github.repository": `{"owner_login":"quiesceowner","repository_name":"fixture","repository_id":0}`,
		"owner.access":      fmt.Sprintf(`{"owner_login":"quiesceowner","repository_name":"fixture","repository_id":0,"last_access_check_at":%q}`, time.Now().UTC().Format(time.RFC3339Nano)),
	} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	for _, user := range []db.User{owner, member} {
		token := user.Username + "-session"
		hash := sha256.Sum256([]byte(token))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: user.ID, Username: user.Username, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	// A real install enforces recovery even with the legacy switch off.
	cfg.Install.QuiesceEnabled = false
	cfg.Install.StateDir = t.TempDir()
	cfg.Server.PublicURL = "http://localhost:4000"
	cfg.Server.AllowedOrigins = []string{"http://localhost:4000"}
	capacity := &services.InstallCapacityService{Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, PhysicalCores: 14, DiskFreeBytes: 400 << 30, MacOSVersion: "15.6", Hypervisor: true}}
	require.NoError(t, capacity.Set(ctx, owner.ID, 2))
	// Exercise the production socket composition without a browser session.
	if os.Getuid() != 0 {
		require.NoError(t, os.Chmod(cfg.Install.StateDir, 0700))
		closeHandoff, err := startInstallMaintenanceHandoff(ctx, cfg.Install.StateDir, pool, func(context.Context, io.Writer) error { return nil }, nil, nil)
		require.NoError(t, err)
		t.Cleanup(func() { require.NoError(t, closeHandoff()) })
		transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(cfg.Install.StateDir, "run/host.sock"))
		}}
		defer transport.CloseIdleConnections()
		client := &http.Client{Transport: transport, Timeout: 20 * time.Second}
		response, err := client.Post("http://install/maintenance/quiesce", "application/json", strings.NewReader(`{"op":"backup-cli"}`))
		require.NoError(t, err)
		body, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		require.NoError(t, response.Body.Close())
		require.Equal(t, 503, response.StatusCode)
		require.Contains(t, string(body), "T-MCH-07 required")
		// One owner preflight must name every absent authority, rather than
		// hiding the persistence gaps behind the first missing machine hook.
		for _, ticket := range []string{"T-MCH-06", "T-FLW-01", "T-STK-04", "T-COL-08", "T-COL-09", "T-GH-09", "T-TRM-07", "T-SEC-01"} {
			require.Contains(t, string(body), "quiesce unavailable: "+ticket+" required")
		}
		var freezes int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='quiesce'`).Scan(&freezes))
		require.Zero(t, freezes)
		response, err = client.Get("http://install/maintenance/check")
		require.NoError(t, err)
		body, err = io.ReadAll(response.Body)
		require.NoError(t, err)
		require.NoError(t, response.Body.Close())
		require.Equal(t, 503, response.StatusCode)
		require.Contains(t, string(body), "T-MCH-07 required")
		// One owner preflight must name every absent authority, rather than
		// hiding the persistence gaps behind the first missing machine hook.
		for _, ticket := range []string{"T-MCH-06", "T-FLW-01", "T-STK-04", "T-COL-08", "T-COL-09", "T-GH-09", "T-TRM-07", "T-SEC-01"} {
			require.Contains(t, string(body), "quiesce unavailable: "+ticket+" required")
		}
		request, err := http.NewRequest("DELETE", "http://install/maintenance/quiesce", nil)
		require.NoError(t, err)
		response, err = client.Do(request)
		require.NoError(t, err)
		require.NoError(t, response.Body.Close())
		require.Equal(t, 204, response.StatusCode)
		t.Run("owner preflight", func(t *testing.T) {
			for _, tc := range []struct {
				name, fence, wiki string
				status            int
			}{
				{"merge and burst", "merge in flight: TODO 17; open burst: feature", "", 503},
				{"all refusals", "merge in flight: TODO 17; open burst: feature", "wiki flush unavailable", 503},
				{"ready", "", "", 204},
			} {
				t.Run(tc.name, func(t *testing.T) {
					state := t.TempDir()
					require.NoError(t, os.Chmod(state, 0700))
					require.NoError(t, os.WriteFile(filepath.Join(state, "sentinel"), []byte("live-state"), 0600))
					calls := []string{}
					steps := installMaintenancePreflightFixture{calls: &calls}
					service := services.NewInstallQuiesce(&services.QuiesceGate{Store: services.InstallQuiesceStore{Pool: pool}, StateDir: state})
					service.Machines, service.Admission, service.Host = steps, steps, steps
					service.Barriers = map[string]services.QuiesceBarrier{}
					for _, ticket := range []string{"T-STK-04", "T-COL-08", "T-COL-09", "T-GH-09", "T-TRM-07", "T-SEC-01"} {
						service.Barriers[ticket] = steps
					}
					if tc.fence != "" {
						service.Barriers["T-STK-04"] = installMaintenancePreflightFixture{calls: &calls, refusal: errors.New(tc.fence)}
					}
					if tc.wiki != "" {
						service.Barriers["T-COL-09"] = installMaintenancePreflightFixture{calls: &calls, refusal: errors.New(tc.wiki)}
					}
					closeSocket, err := startInstallMaintenanceHandoff(ctx, state, pool, func(context.Context, io.Writer) error { return nil }, nil, nil, service)
					require.NoError(t, err)
					t.Cleanup(func() { require.NoError(t, closeSocket()) })
					transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
						return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(state, "run/host.sock"))
					}}
					t.Cleanup(transport.CloseIdleConnections)
					response, err := (&http.Client{Transport: transport}).Get("http://install/maintenance/check")
					require.NoError(t, err)
					body, err := io.ReadAll(response.Body)
					require.NoError(t, err)
					require.NoError(t, response.Body.Close())
					require.Equal(t, tc.status, response.StatusCode)
					for _, reason := range []string{tc.fence, tc.wiki} {
						if reason != "" {
							require.Contains(t, string(body), reason)
						}
					}
					require.Equal(t, []string{"check", "check", "check", "check", "check", "check"}, calls)
					var freezes int
					require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='quiesce'`).Scan(&freezes))
					require.Zero(t, freezes)
					bytes, err := os.ReadFile(filepath.Join(state, "sentinel"))
					require.NoError(t, err)
					require.Equal(t, "live-state", string(bytes))
					if tc.status == 204 {
						client := &http.Client{Transport: transport, Timeout: 20 * time.Second}
						post := func(body string) (int, []byte) {
							response, err := client.Post("http://install/maintenance/quiesce", "application/json", strings.NewReader(body))
							require.NoError(t, err)
							bytes, err := io.ReadAll(response.Body)
							require.NoError(t, err)
							require.NoError(t, response.Body.Close())
							return response.StatusCode, bytes
						}
						status, body := post(`{"op":"backup-renew","renew":true}`)
						require.Equal(t, 503, status)
						require.Contains(t, string(body), `"message":"quiesce lease lost"`)
						require.NotContains(t, calls, "capture")
						status, body = post(`{"op":"backup-renew"}`)
						require.Equal(t, 200, status)
						require.Contains(t, string(body), `"ready":true`)
						status, _ = post(`{"op":"backup-renew","renew":true}`)
						require.Equal(t, 200, status)
						_, err = pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_set(value,'{lease_until}','"2026-01-01T00:00:30Z"'::jsonb) WHERE key='quiesce'`)
						require.NoError(t, err)
						status, body = post(`{"op":"backup-renew","renew":true}`)
						require.Equal(t, 503, status)
						require.Contains(t, string(body), `"message":"quiesce lease lost"`)
						require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='quiesce'`).Scan(&freezes))
						require.Zero(t, freezes)
						captures := 0
						for _, call := range calls {
							if call == "capture" {
								captures++
							}
						}
						require.Equal(t, 1, captures)

						t.Run("production persistence barriers", func(t *testing.T) {
							saved := service.Barriers
							savedHost := service.Host
							defer func() { service.Barriers = saved; service.Host = savedHost }()
							bindings, err := flowhost.NewStore(pool, webhook.NoopSecretCodec{})
							require.NoError(t, err)
							jobsStore, err := jobs.NewStore(pool)
							require.NoError(t, err)
							stoppedHosts := []string{}
							composeInstallQuiesceBarriers(service, pool, new(machined.Registry), &flowComposition{pool: pool, bindings: bindings, jobs: jobsStore, stopper: quiesceHostStopFixture{stopped: &stoppedHosts}})
							service.Barriers["T-COL-09"] = steps
							response, err := client.Get("http://install/maintenance/check")
							require.NoError(t, err)
							refusal, err := io.ReadAll(response.Body)
							require.NoError(t, err)
							require.NoError(t, response.Body.Close())
							require.Equal(t, 503, response.StatusCode)
							require.Contains(t, string(refusal), "waiting on smithers-3f root-input validation")
							for _, ticket := range []string{"T-STK-04", "T-GH-09", "T-TRM-07", "T-COL-08"} {
								require.NotContains(t, string(refusal), ticket+" required")
							}
							require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='quiesce'`).Scan(&freezes))
							require.Zero(t, freezes)
							// A persisted ready freeze must not bypass security
							// for authority export or the privileged health wake.
							persisted := fmt.Sprintf(`{"op":"retained-upgrade","by":%d,"since":%q,"lease_until":%q,"ready":true}`, owner.ID, time.Now().UTC().Format(time.RFC3339Nano), time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
							require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "quiesce", Value: []byte(persisted)}))
							marker := filepath.Join(state, ".upgrade-incomplete")
							require.NoError(t, os.WriteFile(marker, []byte("retained"), 0600))
							wakes := 0
							service.HealthWake = func(context.Context, int64, string) error { wakes++; return nil }
							response, err = client.Post("http://install/maintenance/health/wake", "application/json", strings.NewReader(`{"op":"retained-upgrade"}`))
							require.NoError(t, err)
							refusal, err = io.ReadAll(response.Body)
							require.NoError(t, err)
							require.NoError(t, response.Body.Close())
							require.Equal(t, 503, response.StatusCode)
							require.Contains(t, string(refusal), "waiting on smithers-3f root-input validation")
							require.Zero(t, wakes)
							require.ErrorContains(t, service.RequireReady(ctx, "retained-upgrade", owner.ID), "waiting on smithers-3f root-input validation")
							require.NoError(t, os.Remove(marker))
							_, err = pool.Exec(ctx, `DELETE FROM install_settings WHERE key='quiesce'`)
							require.NoError(t, err)
							service.HealthWake = nil
							// Replace security only in this Linux transport rehearsal.
							// Capture, wiki and VM stop remain recording providers; this
							// does not qualify the Mac install. Production stays closed.
							service.Barriers["T-SEC-01"] = steps
							var repository int64
							require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'quiesce-stack','quiesce-stack') RETURNING id`, owner.ID).Scan(&repository))
							require.NoError(t, func() error {
								_, err := pool.Exec(ctx, `INSERT INTO flow_runtime_host_bindings(id,tenant_id,principal_id,binding_kind,binding_id,repository_id,user_id,workspace_id,catalog_key,service_name,runtime_artifact_digest,source_revision,owner_generation,credential_ciphertext,credential_hash,state,service_identity)
                                VALUES('10000000-0000-4000-8000-000000000001','install','owner','browser','fixture',$1,$2,'10000000-0000-4000-8000-000000000002','coding','smithers-coding-host',$3,$4,1,'fixture',decode(repeat('00',32),'hex'),'running','retained-host')`, repository, owner.ID, strings.Repeat("a", 64), strings.Repeat("b", 40))
								return err
							}())
							var item string
							require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,number,pending_op) VALUES($1,17,'{"kind":"merge","target":"17","desired":"merged","state":"unknown"}') RETURNING id::text`, repository).Scan(&item))
							status, body := post(`{"op":"merge-refusal"}`)
							require.Equal(t, 503, status, string(body))
							require.Contains(t, string(body), "merge in flight: TODO 1")
							require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='quiesce'`).Scan(&freezes))
							require.Zero(t, freezes)
							_, err = pool.Exec(ctx, `UPDATE mythical_items SET pending_op='{}' WHERE id=$1::uuid`, item)
							require.NoError(t, err)
							status, body = post(`{"op":"malformed-refusal"}`)
							require.Equal(t, 503, status, string(body))
							require.Contains(t, string(body), "unreadable outbound operation")
							_, err = pool.Exec(ctx, `UPDATE mythical_items SET pending_op=NULL WHERE id=$1::uuid`, item)
							require.NoError(t, err)
							_, err = pool.Exec(ctx, `UPDATE mythical_items SET pending_op='{"kind":"body","target":"17","desired":"digest","state":"unknown"}' WHERE id=$1::uuid`, item)
							require.NoError(t, err)
							type outcome struct {
								status int
								body   []byte
								err    error
							}
							completed := make(chan outcome, 1)
							go func() {
								response, err := client.Post("http://install/maintenance/quiesce", "application/json", strings.NewReader(`{"op":"outbound-drain"}`))
								if err != nil {
									completed <- outcome{err: err}
									return
								}
								bytes, err := io.ReadAll(response.Body)
								closeErr := response.Body.Close()
								completed <- outcome{response.StatusCode, bytes, errors.Join(err, closeErr)}
							}()
							require.Eventually(t, func() bool {
								var ready bool
								err := pool.QueryRow(ctx, `SELECT (value->>'ready')::boolean FROM install_settings WHERE key='quiesce'`).Scan(&ready)
								return err == nil && !ready
							}, 5*time.Second, 10*time.Millisecond)
							select {
							case result := <-completed:
								t.Fatalf("uncertain write did not drain: %+v", result)
							default:
							}
							var retained string
							require.NoError(t, pool.QueryRow(ctx, `SELECT pending_op->>'state' FROM mythical_items WHERE id=$1::uuid`, item).Scan(&retained))
							require.Equal(t, "unknown", retained)
							_, err = pool.Exec(ctx, `UPDATE mythical_items SET pending_op=NULL WHERE id=$1::uuid`, item)
							require.NoError(t, err)
							select {
							case result := <-completed:
								require.NoError(t, result.err)
								require.Equal(t, 200, result.status, string(result.body))
								require.Contains(t, string(result.body), `"ready":true`)
							case <-time.After(5 * time.Second):
								t.Fatal("settled write did not release drain")
							}
							require.Equal(t, []string{"10000000-0000-4000-8000-000000000001"}, stoppedHosts)
							var hostState, hostIdentity string
							require.NoError(t, pool.QueryRow(ctx, `SELECT state,service_identity FROM flow_runtime_host_bindings WHERE id='10000000-0000-4000-8000-000000000001'`).Scan(&hostState, &hostIdentity))
							require.Equal(t, "pending", hostState)
							require.Empty(t, hostIdentity)
							require.NoError(t, service.Reopen(ctx, "outbound-drain"))
							status, body = post(`{"op":"production-barriers"}`)
							require.Equal(t, 200, status, string(body))
							require.Contains(t, string(body), `"ready":true`)
							request, err := http.NewRequest("DELETE", "http://install/maintenance/quiesce?op=production-barriers", nil)
							require.NoError(t, err)
							response, err = client.Do(request)
							require.NoError(t, err)
							require.NoError(t, response.Body.Close())
							require.Equal(t, 204, response.StatusCode)

							t.Run("awake broker sessions", func(t *testing.T) {
								branch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repository, UserID: owner.ID, Name: "quiesce", TargetBookmark: "scratch/quiesce", Kind: "container", Status: "running"})
								require.NoError(t, err)
								_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id='quiesce-vm' WHERE id=$1::uuid`, branch.ID)
								require.NoError(t, err)
								_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'admin','quiesceowner',20001),($1,$3,'write','quiescemember',20002)`, repository, owner.ID, member.ID)
								require.NoError(t, err)
								_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, repository, member.ID)
								require.NoError(t, err)
								registry := service.Barriers["T-TRM-07"].(installMachineBarrier).registry
								authority, err := registry.MintBoot(branch.ID, "quiesce-vm")
								require.NoError(t, err)
								link, peer := externalTranscriptLink(t, registry, branch.ID, authority)
								require.NoError(t, link.Reconciled())
								require.NoError(t, peer.SetDeadline(time.Now().Add(15*time.Second)))
								var burst atomic.Bool
								burst.Store(true)
								killed := make(chan machined.SessionUser, 4)
								peerErrors := make(chan error, 1)
								go func() {
									defer peer.Close()
									for {
										frame, err := wire.Read(peer)
										if err != nil {
											peerErrors <- err
											return
										}
										request, method, args, err := frame.Request()
										if err != nil {
											peerErrors <- err
											return
										}
										var fields [][]byte
										switch wire.Method(method) {
										case wire.Status:
											idle := byte(1)
											if burst.Load() {
												idle = 0
											}
											fields = [][]byte{wire.Field(1, []byte{3}), wire.Field(2, wire.U16(16)), wire.Field(3, wire.String("smithers-machined")), wire.Field(4, wire.U32(0)), wire.Field(5, make([]byte, 20)), wire.Field(6, wire.U16(0)), wire.Field(7, []byte{idle}), wire.Field(8, []byte{1})}
										case wire.KillSessions:
											target, err := wire.Fields("args9", args)
											if err != nil {
												peerErrors <- err
												return
											}
											if target[1][0] != 1 {
												peerErrors <- errors.New("expected user kill selector")
												return
											}
											selected, err := wire.Fields("target_user", target[1][1:])
											if err != nil {
												peerErrors <- err
												return
											}
											user, err := wire.Fields("user", selected[1])
											if err != nil {
												peerErrors <- err
												return
											}
											killed <- machined.SessionUser{Login: string(user[1][2:]), UID: binary.BigEndian.Uint32(user[2])}
											fields = [][]byte{wire.Field(1, wire.U16(1))}
										default:
											peerErrors <- fmt.Errorf("unexpected broker method %d", method)
											return
										}
										if err := wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(request)), wire.Field(2, wire.Union(method, fields...)))}); err != nil {
											peerErrors <- err
											return
										}
									}
								}()
								// Document persistence/capture has its own machine proof.
								// This recording peer exercises burst status and broker kills.
								priorDocuments := service.Barriers["T-COL-08"]
								service.Barriers["T-COL-08"] = steps
								defer func() { service.Barriers["T-COL-08"] = priorDocuments; peer.Close() }()
								status, body := post(`{"op":"open-burst"}`)
								select {
								case peerErr := <-peerErrors:
									require.NoError(t, peerErr)
								default:
								}
								require.Equal(t, 503, status, string(body))
								require.Contains(t, string(body), "open burst: scratch/quiesce")
								require.Empty(t, killed)
								require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='quiesce'`).Scan(&freezes))
								require.Zero(t, freezes)
								burst.Store(false)
								status, body = post(`{"op":"broker-sessions"}`)
								require.Equal(t, 200, status, string(body))
								require.Len(t, killed, 3)
								require.Equal(t, machined.SessionUser{Login: "agent", UID: 19999}, <-killed)
								require.Equal(t, machined.SessionUser{Login: "quiesceowner", UID: 20001}, <-killed)
								require.Equal(t, machined.SessionUser{Login: "quiescemember", UID: 20002}, <-killed)
								require.NoError(t, service.Reopen(ctx, "broker-sessions"))
								_, err = pool.Exec(ctx, `UPDATE workspaces SET status='suspended' WHERE id=$1::uuid`, branch.ID)
								require.NoError(t, err)
							})
						})
						for _, missing := range []string{"machines", "admission", "host", "T-STK-04", "T-COL-08", "T-COL-09", "T-GH-09", "T-TRM-07", "T-SEC-01"} {
							before := len(calls)
							var absent *installMaintenancePreflightFixture
							want := missing
							switch missing {
							case "machines":
								service.Machines = absent
								want = "T-MCH-07"
							case "admission":
								service.Admission = absent
								want = "T-MCH-06"
							case "host":
								service.Host = absent
								want = "T-FLW-01"
							default:
								service.Barriers[missing] = absent
							}
							// Backup preflight must reject the same missing authority
							// before the CLI can stage files or request a freeze.
							response, err := client.Get("http://install/maintenance/backup/check")
							require.NoError(t, err)
							refusal, err := io.ReadAll(response.Body)
							require.NoError(t, err)
							require.NoError(t, response.Body.Close())
							require.Equal(t, 503, response.StatusCode, missing)
							require.Contains(t, string(refusal), "quiesce unavailable: "+want+" required")
							status, body = post(`{"op":"missing-provider"}`)
							require.Equal(t, 503, status, missing)
							require.Contains(t, string(body), "quiesce unavailable: "+want+" required")
							require.Equal(t, before, len(calls))
							require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='quiesce'`).Scan(&freezes))
							require.Zero(t, freezes)
							service.Machines, service.Admission, service.Host = steps, steps, steps
							service.Barriers[missing] = steps
							if missing == "machines" || missing == "admission" || missing == "host" {
								delete(service.Barriers, missing)
							}
						}
						t.Run("composed machine admission", func(t *testing.T) {
							runtime := new(microsandbox.Runtime)
							require.NoError(t, composeInstallAdmission(ctx, service, runtime, nil))
							status, body := post(`{"op":"admission-maintenance"}`)
							require.Equal(t, 200, status, string(body))
							_, err := runtime.Request("person", "workspace:one", "member", "terminal")
							require.ErrorIs(t, err, microsandbox.ErrAdmissionFrozen)
							// Restart reuses the durable freeze, fencing the new runtime
							// before any request or periodic scheduler can grant a wake.
							restarted := new(microsandbox.Runtime)
							require.NoError(t, composeInstallAdmission(ctx, service, restarted, nil))
							_, err = restarted.Request("background", "wiki", "refresh", "wiki")
							require.ErrorIs(t, err, microsandbox.ErrAdmissionFrozen)
							request, err := http.NewRequest("DELETE", "http://install/maintenance/quiesce?op=admission-maintenance", nil)
							require.NoError(t, err)
							response, err := client.Do(request)
							require.NoError(t, err)
							require.NoError(t, response.Body.Close())
							require.Equal(t, 204, response.StatusCode)
							demand, err := restarted.Request("person", "workspace:one", "member", "terminal")
							require.NoError(t, err)
							require.Equal(t, "waiting", demand.State)
							service.Admission = steps
						})
						for _, lost := range []string{"reopened", "expired", "replaced"} {
							t.Run("drain returns after "+lost, func(t *testing.T) {
								calls = nil
								service.Admission = installMaintenanceHeldDrain{
									installMaintenancePreflightFixture: steps,
									drain: func() error {
										var err error
										switch lost {
										case "reopened":
											_, err = pool.Exec(ctx, `DELETE FROM install_settings WHERE key='quiesce'`)
										case "expired":
											_, err = pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_set(value,'{lease_until}','"2026-01-01T00:00:30Z"'::jsonb) WHERE key='quiesce'`)
										case "replaced":
											_, err = pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_set(value,'{since}','"2026-01-01T00:00:00Z"'::jsonb) WHERE key='quiesce'`)
										}
										return err
									},
								}
								status, body := post(`{"op":"held-drain"}`)
								require.Equal(t, 503, status)
								require.Contains(t, string(body), `"message":"quiesce lease lost"`)
								require.NotContains(t, calls, "capture")
								require.NotContains(t, calls, "stop")
								// The fixture's Check and Drain use distinct call names:
								// only admission's drain may have run before lease loss.
								drains := 0
								for _, call := range calls {
									if call == "drain" {
										drains++
									}
								}
								require.Equal(t, 1, drains)
								bytes, err := os.ReadFile(filepath.Join(state, "sentinel"))
								require.NoError(t, err)
								require.Equal(t, "live-state", string(bytes))
								_, err = pool.Exec(ctx, `DELETE FROM install_settings WHERE key='quiesce'`)
								require.NoError(t, err)
							})
						}

					}
				})
			}
		})
	}
	router := githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{Owners: q, Origins: middleware.FixedOrigins("http://localhost:4000"), Setup: &services.InstallSetupService{Pool: pool, Capacity: capacity}})
	request := func(method, path, token, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://localhost:4000"+path, strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: "smithers_session", Value: token})
		r.Header.Set("Origin", "http://localhost:4000")
		r.Header.Set("X-CSRF-Token", "csrf")
		r.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	require.Equal(t, 403, request("POST", "/api/install/quiesce", "quiescemember-session", `{"op":"backup"}`).Code)
	w := request("POST", "/api/install/quiesce", "quiesceowner-session", `{"op":"backup"}`)
	require.Equal(t, 503, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "T-MCH-07 required")
	require.Contains(t, w.Body.String(), `"class":"infra"`)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='quiesce'`).Scan(&count))
	require.Zero(t, count)
	require.Equal(t, 204, request("DELETE", "/api/install/quiesce", "quiesceowner-session", "").Code)
	// A persisted ready freeze closes real install mutation routes, while reads
	// pass through to their normal handler. Reopen restores the original result.
	frozen := fmt.Sprintf(`{"op":"backup-fixture","by":%d,"since":%q,"lease_until":%q,"ready":true}`, owner.ID, time.Now().UTC().Format(time.RFC3339Nano), time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
	before := request("PUT", "/api/install", "quiesceowner-session", `{}`).Code
	require.Equal(t, 400, before)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "quiesce", Value: []byte(frozen)}))
	w = request("PUT", "/api/install", "quiesceowner-session", `{}`)
	require.Equal(t, 503, w.Code)
	require.Contains(t, w.Body.String(), `"code":"install_quiesced"`)
	require.Contains(t, w.Body.String(), `"retry_at":`)
	require.Equal(t, 200, request("GET", "/api/install", "quiesceowner-session", "").Code)
	// Restarted composition has no runtime resume provider. Neither an explicit
	// owner reopen nor lease expiry can claim recovery or discard the freeze.
	w = request("DELETE", "/api/install/quiesce", "quiesceowner-session", "")
	require.Equal(t, 503, w.Code)
	require.Contains(t, w.Body.String(), "T-FLW-01 required")
	expired := fmt.Sprintf(`{"op":"persisted","by":%d,"since":"2026-01-01T00:00:00Z","lease_until":"2026-01-01T00:00:30Z","ready":true}`, owner.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "quiesce", Value: []byte(expired)}))
	w = request("PUT", "/api/install", "quiesceowner-session", `{}`)
	require.Equal(t, 503, w.Code)
	require.Contains(t, w.Body.String(), "T-FLW-01 required")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='quiesce'`).Scan(&count))
	require.Equal(t, 1, count)
	require.Equal(t, 200, request("GET", "/api/install", "quiesceowner-session", "").Code)
	// Remove only this test's synthetic fixture to retain the unfrozen control.
	_, err = pool.Exec(ctx, `DELETE FROM install_settings WHERE key='quiesce'`)
	require.NoError(t, err)
	require.Equal(t, before, request("PUT", "/api/install", "quiesceowner-session", `{}`).Code)
}

// Only Check may run during the read-only installing-owner preflight. The
// missing dependency contracts are fake here; this is not Mac qualification.
type installMaintenancePreflightFixture struct {
	calls   *[]string
	refusal error
}

func (s installMaintenancePreflightFixture) Check(context.Context) error {
	*s.calls = append(*s.calls, "check")
	return s.refusal
}
func (s installMaintenancePreflightFixture) Drain(context.Context) error {
	*s.calls = append(*s.calls, "drain")
	return nil
}
func (s installMaintenancePreflightFixture) Stop(context.Context) error {
	*s.calls = append(*s.calls, "stop")
	return nil
}
func (s installMaintenancePreflightFixture) CaptureAndStop(context.Context) error {
	*s.calls = append(*s.calls, "capture")
	return nil
}
func (s installMaintenancePreflightFixture) Resume(context.Context) error {
	*s.calls = append(*s.calls, "resume")
	return nil
}

// Dependency fixture pauses at the admission boundary to model lease changes
// while the real owner request and durable freeze remain active.
type installMaintenanceHeldDrain struct {
	installMaintenancePreflightFixture
	drain func() error
}

func (s installMaintenanceHeldDrain) Drain(context.Context) error {
	*s.calls = append(*s.calls, "drain")
	return s.drain()
}

type quiesceHostStopFixture struct{ stopped *[]string }

func (f quiesceHostStopFixture) StopFlowHost(_ context.Context, binding flowhost.Binding) error {
	*f.stopped = append(*f.stopped, binding.ID)
	return nil
}
