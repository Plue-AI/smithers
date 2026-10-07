package modelhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

const ModelTestOperation = "model.test"

func modelTestScope(owner int64) jobs.Scope {
	return jobs.Scope{TenantID: "install", PrincipalID: strconv.FormatInt(owner, 10)}
}

func (s OwnerModels) admitModelTest(w http.ResponseWriter, r *http.Request, owner int64, requestID string, payload json.RawMessage) {
	store, err := jobs.NewStore(s.Pool)
	if err != nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Could not read model test"))
		return
	}
	receipt, err := store.Admit(r.Context(), jobs.Admission{Scope: modelTestScope(owner), Operation: ModelTestOperation,
		RequestID: requestID, Payload: payload, AuthorizationContext: json.RawMessage(`{"actor":"owner-session"}`),
		// A provider probe has no upstream idempotency or lookup. Ambiguous calls
		// become uncertain on recovery rather than spending a second time.
		EffectPolicy: jobs.EffectUnsafe, EffectKey: fmt.Sprintf("model.test:%d:%s", owner, requestID)})
	if errors.Is(err, jobs.ErrPayloadConflict) {
		pkgerrors.WriteError(w, pkgerrors.Conflict("Model test request differs"))
		return
	}
	if err != nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Could not read model test"))
		return
	}
	modelJSON(w, http.StatusAccepted, receipt)
}

// TestReceipt is owner-session guarded by the composed router, like admission.
func (s OwnerModels) TestReceipt(w http.ResponseWriter, r *http.Request) {
	owner, id := ownerOf(r), r.URL.Query().Get("requestId")
	if owner <= 0 {
		pkgerrors.WriteError(w, pkgerrors.Unauthorized("Sign in required"))
		return
	}
	if !requestIDPattern.MatchString(id) {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("Invalid model test"))
		return
	}
	store, err := jobs.NewStore(s.Pool)
	if err != nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Could not read model test"))
		return
	}
	op, err := store.GetByRequest(r.Context(), modelTestScope(owner), ModelTestOperation, id)
	if errors.Is(err, jobs.ErrNotFound) {
		pkgerrors.WriteError(w, pkgerrors.NotFound("Model test unavailable"))
		return
	}
	if err != nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Could not read model test"))
		return
	}
	modelJSON(w, 200, map[string]any{"requestId": id, "state": op.State, "result": op.TerminalReceipt})
}

// RunModelTests shares the existing product-operation lifecycle and fencing.
func (s OwnerModels) RunModelTests(ctx context.Context) error {
	store, err := jobs.NewStore(s.Pool)
	if err != nil {
		return err
	}
	return store.RunWorker(ctx, jobs.WorkerConfig{WorkerID: "model-test-" + strconv.FormatInt(time.Now().UnixNano(), 10),
		Capacity: 1, Lease: time.Minute, Operations: []string{ModelTestOperation}}, s.HandleModelTest)
}

func (s OwnerModels) HandleModelTest(ctx context.Context, lease *jobs.Lease) error {
	claim := lease.Claim()
	owner, err := strconv.ParseInt(claim.Scope.PrincipalID, 10, 64)
	current, ownerErr := db.New(s.Pool).GetSelfHostOwner(ctx)
	if err != nil || ownerErr != nil || current.ID != owner || claim.Scope.TenantID != "install" || owner <= 0 || claim.Operation != ModelTestOperation || s.Tester == nil {
		return lease.Fail(ctx, json.RawMessage(`{"ok":false,"latencyMs":0,"failure":{"code":"unreachable"},"fault":"dependency"}`))
	}
	if err := lease.StartExternal(ctx, json.RawMessage(`{"kind":"model.test"}`)); err != nil {
		return err
	}
	result, status := s.runModelTest(ctx, owner, claim.Payload)
	settle, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if status != http.StatusOK {
		return lease.Fail(settle, json.RawMessage(`{"ok":false,"latencyMs":0,"failure":{"code":"invalid"},"fault":"user"}`))
	}
	return lease.Complete(settle, result)
}
