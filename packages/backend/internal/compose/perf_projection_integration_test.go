package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// Actual authenticated install routes, PostgreSQL commits and live subscriptions
// feed the benchmark's strict validator. Queued moves execute no guest code.
// This is contract proof, not a browser measurement or performance receipt.
func TestPerfProjectionCommittedMoveBoundaries(t *testing.T) {
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

	root, err := filepath.Abs("../../../..")
	require.NoError(t, err)
	command := exec.CommandContext(t.Context(), "node", "--input-type=module", "-e", `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { acceptMove, stableSnapshot } from './scripts/perf/projection-delta.mjs'
const require = createRequire(new URL('./packages/smithers/package.json', import.meta.url))
const Socket = require('ws')
const origin = process.env.PERF_ORIGIN
const cookie = process.env.PERF_COOKIE
const streams = []
const wait = (stream, matches) => new Promise((resolve, reject) => {
 const timer = setTimeout(() => reject(new Error(stream.topic + ': frame timeout')), 5000)
 stream.pending = frame => { if (matches(frame)) { clearTimeout(timer); stream.pending = undefined; resolve(frame) } }
})
try {
 for (const topic of ['home', 'todo:2']) {
  const socket = new Socket(origin.replace(/^http/, 'ws') + '/api/live', 'smithers.live.v1', { headers: { Origin: origin, Cookie: cookie } })
  const stream = { topic, socket }
  streams.push(stream)
  const snapshot = wait(stream, frame => frame.t === 'snap')
  socket.on('message', raw => {
   const frame = JSON.parse(raw.toString())
   if (stream.pending) stream.pending(frame)
   else if (!stableSnapshot(frame, stream.cursor)) stream.failure = frame
  })
  socket.on('open', () => socket.send(JSON.stringify({ t: 'sub', id: 1, topic })))
  const frame = await snapshot
  assert.equal(socket.protocol, 'smithers.live.v1')
  assert.equal(frame.cursor, 0)
  stream.cursor = frame.cursor
 }
 for (const [i, direction] of ['up', 'down', 'up', 'down'].entries()) {
  const arrivals = streams.map(stream => wait(stream, frame => !stableSnapshot(frame, stream.cursor)))
  const response = await fetch(origin + '/api/todos/2', {
   method: 'POST', headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': 'csrf', 'Idempotency-Key': 'perf-projection-' + i, 'Content-Type': 'application/json' },
   body: JSON.stringify({ op: 'move', direction }), signal: AbortSignal.timeout(5000)
  })
  assert.equal(response.status, 202, await response.text())
  const frames = await Promise.all(arrivals)
  for (const [index, stream] of streams.entries()) {
   stream.cursor = acceptMove(frames[index], stream.cursor, 2, direction)
   assert.equal(stream.cursor, i + 1)
   assert.equal(stream.failure, undefined)
  }
 }
 console.log('4 committed moves delivered to Home and TODO')
} finally { for (const stream of streams) stream.socket.terminate() }
`)
	command.Dir = root
	command.Env = append(os.Environ(), "PERF_ORIGIN="+origin, "PERF_COOKIE=smithers_session="+token+"; __csrf=csrf")
	output, err := command.CombinedOutput()
	require.NoError(t, err, string(output))
	require.Equal(t, "4 committed moves delivered to Home and TODO\n", string(output))
	var place int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT stack_position FROM mythical_items WHERE id=$1`, second.ID).Scan(&place))
	require.EqualValues(t, 2, place)
}
