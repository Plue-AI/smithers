package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
)

// J1 invokes this at Working, then follows the same TODO through its real PR.
// The daemon's authenticated frame calls Admit in the burst transaction; the
// trusted-process fixture supplies that committed watcher fact, not a microVM.
func (r *rehearsal) outsideChangeKeepsTodoRunning(todo rehearsalTodo) error {
	if todo.Branch == nil || todo.Run == nil {
		return fmt.Errorf("working TODO lacks branch/run")
	}
	var repositoryID, ownerID int64
	if err := r.pool.QueryRow(r.ctx, `SELECT repository_id,user_id FROM workspaces WHERE id=$1`, todo.Branch.ID).Scan(&repositoryID, &ownerID); err != nil {
		return err
	}
	store, err := jobs.NewStore(r.pool)
	if err != nil {
		return err
	}
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		return nil, machined.ErrNotReady
	})})
	if err != nil {
		return err
	}
	notes := machined.NewOutsideChangeNotes(&machined.PinnedCodingNoteRuns{}, dispatcher)
	burst := uuid.NewString()
	err = pgx.BeginFunc(r.ctx, r.pool, func(tx pgx.Tx) error {
		scope := jobs.Scope{TenantID: fmt.Sprint(repositoryID), PrincipalID: "branch:" + todo.Branch.ID}
		fact, _ := json.Marshal(map[string]any{"id": burst, "kind": "burst", "branch": todo.Branch.ID, "actor": map[string]string{"kind": "outside"}, "files": []map[string]string{{"path": "package-lock.json", "change": "added"}}})
		if _, err := jobs.RecordFactInTx(r.ctx, tx, scope, uuid.NewString(), "branch.burst", "completed", fact); err != nil {
			return err
		}
		return notes.Admit(r.ctx, tx, todo.Branch.ID, burst, json.RawMessage(`{"kind":"outside"}`), []string{"package-lock.json"})
	})
	if err != nil {
		return err
	}
	var count int
	if err = r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE request_id=$1`, "outside-change:"+todo.Branch.ID+":"+burst).Scan(&count); err != nil {
		return err
	}
	if count != 0 {
		return fmt.Errorf("dark watcher queued %d signals", count)
	}
	// An informational refusal left by an older install must also be harmless.
	payload, _ := json.Marshal(map[string]string{"runId": todo.Run.ID, "name": "outside_change"})
	receipt, err := store.Admit(r.ctx, jobs.Admission{Scope: jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repositoryID), PrincipalID: fmt.Sprintf("user:%d", ownerID)}, Operation: flowdispatch.OperationSignal, RequestID: uuid.NewString(), Payload: payload, EffectPolicy: jobs.EffectReconcile, EffectKey: uuid.NewString(), AvailableAt: time.Now().Add(time.Hour)})
	if err != nil {
		return err
	}
	var binding string
	var ciphertext string
	if err = r.pool.QueryRow(r.ctx, `SELECT id::text,credential_ciphertext FROM flow_runtime_host_bindings WHERE workspace_id=$1 AND catalog_key='coding' AND state='running'`, todo.Branch.ID).Scan(&binding, &ciphertext); err != nil {
		return err
	}
	codec, err := webhook.NewSecretCodec("rehearsal-encryption-key")
	if err != nil {
		return err
	}
	secret, err := codec.DecryptString(ciphertext)
	if err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() {
		time.Sleep(100 * time.Millisecond)
		_, err := r.pool.Exec(r.ctx, `UPDATE product_job_requests SET state='failed',terminal_receipt='{"reason":"bridge-refused"}'::jsonb WHERE id=$1::uuid`, receipt.OperationID)
		done <- err
	}()
	req, err := http.NewRequestWithContext(r.ctx, http.MethodGet, r.origin+modelproxy.Path+"/input-fence?run="+url.QueryEscape(todo.Run.ID), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+flowhost.RoleModelCredential(binding, string(secret), "implementer"))
	response, err := http.DefaultClient.Do(req)
	refusal := <-done
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if refusal != nil {
		return refusal
	}
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("watcher input fence: HTTP %d: %s", response.StatusCode, body)
	}
	return nil
}
