package compose

import (
	"encoding/json"
	"fmt"
	"github.com/stretchr/testify/require"
	"strings"
	"testing"
)

// Admission never trusts a newer Active graph, inherited display steps, or an
// Action merely named like the packaged Flow boundary. The positive engine
// proof is TestTodoFourStepComposedInstall/MicroVM.
func TestTodoPauseOverrideInspectionInstallHTTP(t *testing.T) {
	h := newTodoSignalLiteralInstall(t)
	ctx := t.Context()
	digest, source := strings.Repeat("d", 64), strings.Repeat("a", 40)
	const qualified = `{"inspection":{"nodes":[{"kind":"FlowCall","label":"coding/todo-boundary"}],"diagnostics":[]}}`
	for i, c := range []struct {
		name, config, status, source, digest string
		want                                 int
	}{
		{"missing inspection", `{}`, "loaded", source, digest, 503},
		{"no boundary", `{"inspection":{"nodes":[],"diagnostics":[]}}`, "loaded", source, digest, 503},
		{"display only", `{"steps":[{"label":"coding/todo-boundary"}]}`, "loaded", source, digest, 503},
		{"wrong node kind", `{"inspection":{"nodes":[{"kind":"ActionCall","label":"coding/todo-boundary"}],"diagnostics":[]}}`, "loaded", source, digest, 503},
		{"opaque graph", `{"inspection":{"nodes":[{"kind":"FlowCall","label":"coding/todo-boundary"}],"diagnostics":[{"code":"declaration_requires_input"}]}}`, "loaded", source, digest, 503},
		{"missing diagnostics", `{"inspection":{"nodes":[{"kind":"FlowCall","label":"coding/todo-boundary"}]}}`, "loaded", source, digest, 503},
		{"failed load", qualified, "failed", source, digest, 503},
		{"wrong source", qualified, "loaded", strings.Repeat("b", 40), digest, 503},
		{"other digest", qualified, "loaded", source, strings.Repeat("e", 64), 503},
		{"retained pin", qualified, "loaded", source, digest, 202},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, err := h.pool.Exec(ctx, `DELETE FROM workflow_definitions WHERE repository_id=$1`, h.item.RepositoryID)
			require.NoError(t, err)
			_, err = h.pool.Exec(ctx, `INSERT INTO workflow_definitions(repository_id,name,path,config,is_active,source_commit,digest,status) VALUES($1,'todo','flows/todo/flow.ts',$2,false,$3,$4,$5)`, h.item.RepositoryID, c.config, c.source, c.digest, c.status)
			require.NoError(t, err)
			checks, _ := json.Marshal(map[string]any{"todo": true, "run_launched": true, "run_attached": true, "flowSource": source})
			_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET state='running',checks=$2,attempt=1,request_run_id='run-1',request_outcome='',workspace_id='11111111-1111-4111-8111-111111111111',flow_digest=$3,paused_at=NULL WHERE id=$1`, h.item.ID, checks, digest)
			require.NoError(t, err)
			before, err := h.q.GetMythicalItem(ctx, h.item.ID)
			require.NoError(t, err)
			var count int
			require.NoError(t, h.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests`).Scan(&count))
			status, receipt := h.call(t, "POST", `{"op":"stop"}`, fmt.Sprintf("override-%d", i))
			require.Equal(t, c.want, status, receipt)
			if c.want == 503 {
				after, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				require.Equal(t, before, after, "refusal must not change the item, attempt, archive or pin")
				var afterCount int
				require.NoError(t, h.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests`).Scan(&afterCount))
				require.Equal(t, count, afterCount, "no signal or other external effect")
			}
		})
	}
}
