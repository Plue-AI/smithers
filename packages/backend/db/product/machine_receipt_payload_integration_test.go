package product

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

func TestMachineReceiptPayloadMigration(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := t.Context()
	migrations, err := registeredMigrations()
	require.NoError(t, err)
	cut := slices.IndexFunc(migrations, func(m migration) bool { return m.version == 136 })
	require.Positive(t, cut)
	require.NoError(t, applyOnce(ctx, pool, migrations[:cut]))
	repo := reviewRepo(t, pool)
	var branch string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,name) SELECT $1,id,'retained' FROM users WHERE username='smithers-machines' RETURNING id`, repo).Scan(&branch))
	_, err = pool.Exec(ctx, `INSERT INTO machine_event_receipts(workspace_id,event_id,outcome,transcript_checkpoint) VALUES($1,'10000000-0000-4000-8000-000000000001','stale_base','{"retained":true}')`, branch)
	require.NoError(t, err)
	// A committed fact can authenticate a legacy capture without trusting a
	// new delivery. An orphan receipt above has no such evidence.
	_, err = pool.Exec(ctx, `INSERT INTO machine_event_receipts(workspace_id,event_id,outcome) VALUES($1,'10000000-0000-4000-8000-000000000002','stale_base');
 INSERT INTO product_job_streams(tenant_id,principal_id,head) VALUES ($2,$3,1);
 INSERT INTO product_job_requests(id,tenant_id,principal_id,operation,request_id,payload_fingerprint,payload,authorization_context,state,request_receipt)
 VALUES ('20000000-0000-4000-8000-000000000001',$2,$3,'capture','request',decode(repeat('00',32),'hex'),'{}','{}','accepted','{}');
 INSERT INTO product_job_events(tenant_id,principal_id,sequence,event_id,operation_id,event_type,state,data)
 VALUES ($2,$3,1,'30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','branch.captured','completed',
 jsonb_build_object('branch',$1::text,'machine_event_id','10000000-0000-4000-8000-000000000002','head',repeat('11',20),'tree',repeat('22',20),'base',repeat('33',20),'applied',false))`, pgx.QueryExecModeSimpleProtocol, branch, fmt.Sprint(repo), "branch:"+branch)
	require.NoError(t, err)
	// Do not infer replay identity from a wrong branch/outcome, malformed object
	// ID, or two inconsistent facts for the same durable event.
	unproven := [][]string{
		{`{"branch":"other"}`},
		{`{"applied":true}`},
		{`{"head":"invalid"}`},
		{`{}`, `{"head":"4444444444444444444444444444444444444444"}`},
	}
	sequence := 1
	for i, patches := range unproven {
		id := fmt.Sprintf("10000000-0000-4000-8000-%012d", i+3)
		_, err = pool.Exec(ctx, `INSERT INTO machine_event_receipts(workspace_id,event_id,outcome) VALUES($1,$2,'stale_base')`, branch, id)
		require.NoError(t, err)
		for _, patch := range patches {
			sequence++
			_, err = pool.Exec(ctx, `INSERT INTO product_job_events(tenant_id,principal_id,sequence,event_id,operation_id,event_type,state,data)
SELECT tenant_id,principal_id,$1,gen_random_uuid(),operation_id,event_type,state,
 data || jsonb_build_object('machine_event_id',$2::text) || $3::jsonb
FROM product_job_events WHERE event_id='30000000-0000-4000-8000-000000000001'`, sequence, id, patch)
			require.NoError(t, err)
		}
	}
	require.NoError(t, Apply(ctx, pool))
	require.NoError(t, Apply(ctx, pool))
	var outcome string
	var checkpoint, digest, capture []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT outcome,transcript_checkpoint,payload_digest,capture_payload FROM machine_event_receipts WHERE workspace_id=$1 AND event_id='10000000-0000-4000-8000-000000000001'`, branch).Scan(&outcome, &checkpoint, &digest, &capture))
	require.Equal(t, "stale_base", outcome)
	require.JSONEq(t, `{"retained":true}`, string(checkpoint))
	require.Nil(t, digest)
	require.Nil(t, capture)
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload_digest,capture_payload FROM machine_event_receipts WHERE workspace_id=$1 AND event_id='10000000-0000-4000-8000-000000000002'`, branch).Scan(&digest, &capture))
	want, err := hex.DecodeString("020000003f01" + strings.Repeat("11", 20) + "02" + strings.Repeat("22", 20) + "03" + strings.Repeat("33", 20))
	require.NoError(t, err)
	require.Equal(t, want, capture)
	decoded, err := wire.DecodeCaptured(capture)
	require.NoError(t, err)
	require.Equal(t, wire.Captured{Head: strings.Repeat("11", 20), Tree: strings.Repeat("22", 20), Base: strings.Repeat("33", 20)}, decoded)
	for i := range unproven {
		id := fmt.Sprintf("10000000-0000-4000-8000-%012d", i+3)
		var unbound bool
		require.NoError(t, pool.QueryRow(ctx, `SELECT payload_digest IS NULL AND capture_payload IS NULL FROM machine_event_receipts WHERE workspace_id=$1 AND event_id=$2`, branch, id).Scan(&unbound))
		require.True(t, unbound, "unproven event %s", id)
	}
	wantDigest := sha256.Sum256(want)
	require.Equal(t, wantDigest[:], digest)
	for _, pair := range []struct{ digest, capture []byte }{
		{make([]byte, 31), nil}, {make([]byte, 33), nil}, {make([]byte, 32), []byte{}}, {make([]byte, 32), make([]byte, 257)}, {nil, []byte{2}},
	} {
		_, err = pool.Exec(ctx, `INSERT INTO machine_event_receipts(workspace_id,event_id,outcome,payload_digest,capture_payload) VALUES($1,gen_random_uuid(),'applied',$2,$3)`, branch, pair.digest, pair.capture)
		var pgErr *pgconn.PgError
		require.ErrorAs(t, err, &pgErr)
		require.Equal(t, "23514", pgErr.Code)
	}
	_, err = pool.Exec(ctx, `INSERT INTO machine_event_receipts(workspace_id,event_id,outcome,payload_digest,capture_payload) VALUES($1,gen_random_uuid(),'applied',$2,$3)`, branch, make([]byte, 32), make([]byte, 68))
	require.NoError(t, err)
}
