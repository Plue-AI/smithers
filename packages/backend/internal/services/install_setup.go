package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

var InstallStepIDs = [...]string{"address", "app_manifest", "sign_in", "repository", "models", "source", "machine"}

// InstallStep is the sole setup projection; operation identity and fencing stay
// in settings, while delivery and external receipts stay in the shared jobs store.
type InstallStep struct {
	ID          string                 `json:"id"`
	Status      InstallStepState       `json:"status"`
	OperationID string                 `json:"operation_id,omitempty"`
	Attempt     int                    `json:"attempt,omitempty"`
	ExpiresAt   time.Time              `json:"expires_at,omitempty"`
	Pct         *int                   `json:"pct,omitempty"`
	Error       *InstallReadinessError `json:"error,omitempty"`
	Blocked     *InstallSetupBlock     `json:"blocked,omitempty"`
	Input       json.RawMessage        `json:"input,omitempty"`
	// Machine readiness receipts (InstallMachineReadyService): main's resolved
	// revision, the verified layer and the readiness attempt fence.
	Revision         string `json:"revision,omitempty"`
	LayerKey         string `json:"layer_key,omitempty"`
	ReadinessAttempt uint64 `json:"readiness_attempt,omitempty"`
}
type InstallSetupBlock struct {
	Line   string `json:"line"`
	FixURL string `json:"fix_url"`
}
type InstallSetupInput struct {
	Bind       string   `json:"bind,omitempty"`
	Origins    []string `json:"origins,omitempty"`
	Owner      string   `json:"owner,omitempty"`
	Repository string   `json:"repository,omitempty"`
}

// ValidateInstallSetupBody precedes both step and job writes. Every transport
// has exactly one literal body contract; null is refused.
func ValidateInstallSetupBody(step string, raw []byte) (InstallSetupInput, error) {
	var fields map[string]json.RawMessage
	var input InstallSetupInput
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return input, pkgerrors.BadRequest("setup body must be an object")
	}
	allowed := map[string][]string{"address": {"bind", "origins"}, "app_manifest": {"owner"}, "repository": {"repository"}, "models": {}, "source": {}, "machine": {}, "sign_in": {}}
	keys, ok := allowed[step]
	if !ok {
		return input, pkgerrors.NotFound("setup step not found")
	}
	if len(fields) != len(keys) {
		return input, pkgerrors.BadRequest("invalid setup fields")
	}
	for _, key := range keys {
		if len(fields[key]) == 0 || string(fields[key]) == "null" {
			return input, pkgerrors.BadRequest("missing setup field: " + key)
		}
	}
	if json.Unmarshal(raw, &input) != nil {
		return input, pkgerrors.BadRequest("invalid setup field type")
	}
	switch step {
	case "address":
		host, port, err := net.SplitHostPort(input.Bind)
		if err != nil || port != "4000" || !(host == "localhost" || net.ParseIP(host) != nil) {
			return input, pkgerrors.BadRequest("invalid bind address")
		}
		if len(input.Origins) == 0 || len(input.Origins) > 10 {
			return input, pkgerrors.BadRequest("origins required")
		}
		seen := map[string]bool{}
		teammates := false
		for i, origin := range input.Origins {
			u, err := url.Parse(origin)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || seen[strings.ToLower(u.Host)] {
				return input, pkgerrors.BadRequest("invalid public origin")
			}
			seen[strings.ToLower(u.Host)] = true
			// Saved as the browser sends it: macOS names the host
			// Williams-Mac-mini.local, the browser's Origin is lower case.
			input.Origins[i] = middleware.CanonicalOrigin(origin)
			teammates = teammates || !loopbackOrigin(origin)
		}
		// A network bind serves teammates only at an origin they can open;
		// loopback origins alone would answer them 421 unknown_origin.
		if NetworkBind(input.Bind) != "" && !teammates {
			return input, pkgerrors.BadRequest("network needs the address teammates use")
		}
	case "app_manifest":
		if !gitHubAppComponent.MatchString(input.Owner) {
			return input, pkgerrors.BadRequest("invalid GitHub owner")
		}
	case "repository":
		if !gitHubInstallationRepoName.MatchString(input.Repository) {
			return input, pkgerrors.BadRequest("repository must be owner/name")
		}
	}
	return input, nil
}

func installStepIndex(id string) int {
	for i, value := range InstallStepIDs {
		if value == id {
			return i
		}
	}
	return -1
}
func installStepCanStart(step InstallStep, now time.Time) bool {
	switch step.Status {
	case InstallPending, InstallFailed, "blocked":
		return true
	case InstallRunning:
		return !step.ExpiresAt.IsZero() && !step.ExpiresAt.After(now)
	}
	return false
}

type InstallSetupService struct {
	Now              func() time.Time
	Pool             *pgxpool.Pool
	Jobs             *jobs.Store
	Capacity         *InstallCapacityService
	RepositoryAccess *GitHubUserReposService
	// Address serves step 0's bind and origins; nil saves them only.
	Address *InstallAddress
	// Providers are host-side orchestration only. No repository flow is loaded.
	Providers map[string]func(context.Context, *jobs.Lease, InstallSetupInput) error
	// Models runs POST /api/model/test's call for each key before Model
	// access is done. Without it the step fails: an untested key is not done.
	Models InstallModelTester
}

// InstallModelTester is modelhost.ModelTester: one owner-scoped call through
// the private model host, answered as a @smthrs/rpc ModelTestResult.
type InstallModelTester interface {
	RunModelTest(context.Context, int64, json.RawMessage) (json.RawMessage, error)
}

// Initialize retains every previously committed step during restart.
func (s *InstallSetupService) Initialize(ctx context.Context) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, id := range InstallStepIDs {
		value, _ := json.Marshal(InstallStep{ID: id, Status: InstallPending})
		if _, err = tx.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES($1,$2) ON CONFLICT DO NOTHING`, "setup.step."+id, value); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
func setupNow(now func() time.Time) time.Time {
	if now != nil {
		return now()
	}
	return time.Now()
}

// installWorkerLive reports whether a running step's job is still being
// worked: a worker holds an unexpired lease, or the handler deferred its next
// pass. Admit refuses a restart while it holds, and Steps shows the step
// running, so GET and POST agree after the step's expires_at lapses.
const installWorkerLive = `SELECT COALESCE(lease_expires_at > clock_timestamp() OR (status = 'ready' AND next_attempt_at > clock_timestamp()), false) FROM product_job_dispatches WHERE operation_id=$1`

func (s *InstallSetupService) Steps(ctx context.Context) ([]InstallStep, error) {
	result := make([]InstallStep, 0, len(InstallStepIDs))
	for _, id := range InstallStepIDs {
		step, err := s.readStep(ctx, db.New(s.Pool), id)
		if err != nil {
			return nil, err
		}
		if step.Status == InstallRunning && installStepCanStart(step, setupNow(s.Now)) {
			live := false
			// The App step runs in the browser and has no job.
			if step.OperationID != "" {
				err = s.Pool.QueryRow(ctx, installWorkerLive, step.OperationID).Scan(&live)
				if err != nil && !errors.Is(err, pgx.ErrNoRows) {
					return nil, err
				}
			}
			if !live {
				step.Status = InstallPending
				step.Pct = nil
			}
		}
		result = append(result, step)
	}
	return result, nil
}
func (s *InstallSetupService) readStep(ctx context.Context, q *db.Queries, id string) (InstallStep, error) {
	step := InstallStep{ID: id, Status: InstallPending}
	row, err := q.GetInstallSetting(ctx, "setup.step."+id)
	if errors.Is(err, pgx.ErrNoRows) {
		if id == "sign_in" {
			if _, ownerErr := q.GetSelfHostOwner(ctx); ownerErr == nil {
				step.Status = InstallReady
			} else if !errors.Is(ownerErr, pgx.ErrNoRows) {
				return step, ownerErr
			}
		}
		return step, nil
	}
	if err != nil {
		return step, err
	}
	if err = json.Unmarshal(row.Value, &step); err != nil {
		return step, err
	}
	step.ID = id
	// A claimed owner is signed in, whatever an earlier refused attempt recorded.
	if id == "sign_in" && step.Status != InstallReady {
		if _, ownerErr := q.GetSelfHostOwner(ctx); ownerErr == nil {
			step = InstallStep{ID: id, Status: InstallReady}
		} else if !errors.Is(ownerErr, pgx.ErrNoRows) {
			return step, ownerErr
		}
	}
	return step, nil
}
func saveInstallStep(ctx context.Context, tx pgx.Tx, step InstallStep) error {
	raw, err := json.Marshal(step)
	if err != nil {
		return err
	}
	return db.New(tx).UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.step." + step.ID, Value: raw})
}

func (s *InstallSetupService) Admit(ctx context.Context, id, key string, raw json.RawMessage) (jobs.RequestReceipt, error) {
	_, err := ValidateInstallSetupBody(id, raw)
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	if s == nil || s.Pool == nil || s.Jobs == nil {
		return jobs.RequestReceipt{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "install setup unavailable")
	}
	if len(key) == 0 || len(key) > 128 {
		return jobs.RequestReceipt{}, pkgerrors.BadRequest("Idempotency-Key required")
	}
	if id == "app_manifest" || id == "sign_in" {
		return jobs.RequestReceipt{}, pkgerrors.Conflict("use the browser sign-in action")
	}
	if id != "address" && id != "models" && s.Providers[id] == nil {
		return jobs.RequestReceipt{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "setup provider unavailable")
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(345506)`); err != nil {
		return jobs.RequestReceipt{}, err
	}
	scope := jobs.Scope{TenantID: "install", PrincipalID: "owner"}
	// Replays precede readiness checks and preserve the first admission result.
	prior, err := s.Jobs.GetByRequest(ctx, scope, "install.setup."+id, key)
	if err == nil {
		var receipt jobs.RequestReceipt
		if string(prior.Payload) != string(raw) {
			var a, b any
			json.Unmarshal(prior.Payload, &a)
			json.Unmarshal(raw, &b)
			aa, _ := json.Marshal(a)
			bb, _ := json.Marshal(b)
			if string(aa) != string(bb) {
				return receipt, pkgerrors.Conflict("Idempotency-Key reused")
			}
		}
		err = json.Unmarshal(prior.RequestReceipt, &receipt)
		return receipt, err
	}
	if !errors.Is(err, jobs.ErrNotFound) {
		return jobs.RequestReceipt{}, err
	}
	q := db.New(tx)
	index := installStepIndex(id)
	if index > 0 {
		previous, err := s.readStep(ctx, q, InstallStepIDs[index-1])
		if err != nil {
			return jobs.RequestReceipt{}, err
		}
		if previous.Status != InstallReady {
			return jobs.RequestReceipt{}, pkgerrors.Conflict("previous setup step is incomplete")
		}
	}
	step, err := s.readStep(ctx, q, id)
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	if !installStepCanStart(step, setupNow(s.Now)) {
		return jobs.RequestReceipt{}, pkgerrors.Conflict("setup step is running or complete")
	}
	if step.Status == InstallRunning {
		var live bool
		if err := tx.QueryRow(ctx, installWorkerLive+` FOR UPDATE`, step.OperationID).Scan(&live); err != nil {
			return jobs.RequestReceipt{}, err
		}
		if live {
			return jobs.RequestReceipt{}, pkgerrors.Conflict("setup worker lease is active")
		}
		operation, err := s.Jobs.Get(ctx, scope, step.OperationID)
		if err != nil {
			return jobs.RequestReceipt{}, err
		}
		if operation.State.Terminal() {
			return jobs.RequestReceipt{}, pkgerrors.Conflict("terminal setup receipt requires reconciliation")
		}
		var receipt jobs.RequestReceipt
		if err = json.Unmarshal(operation.RequestReceipt, &receipt); err != nil {
			return receipt, err
		}
		step.Attempt++
		step.ExpiresAt = setupNow(s.Now).Add(time.Minute)
		if err = saveInstallStep(ctx, tx, step); err != nil {
			return receipt, err
		}
		return receipt, tx.Commit(ctx)
	}
	receipt, err := s.Jobs.AdmitInTx(ctx, tx, jobs.Admission{Scope: scope, Operation: "install.setup." + id, RequestID: key, Payload: raw, EffectPolicy: jobs.EffectIdempotent})
	if err != nil {
		return receipt, err
	}
	step.Status = InstallRunning
	step.OperationID = receipt.OperationID
	step.Attempt++
	step.ExpiresAt = setupNow(s.Now).Add(time.Minute)
	step.Input = raw
	step.Error = nil
	step.Blocked = nil
	if err = saveInstallStep(ctx, tx, step); err != nil {
		return receipt, err
	}
	return receipt, tx.Commit(ctx)
}

func (s *InstallSetupService) Handle(ctx context.Context, lease *jobs.Lease) error {
	claim := lease.Claim()
	id := strings.TrimPrefix(claim.Operation, "install.setup.")
	input, err := ValidateInstallSetupBody(id, claim.Payload)
	if err != nil {
		return err
	}
	// The job fence, rather than a second background goroutine, owns recovery.
	if err = lease.StartExternal(ctx, json.RawMessage(`{"phase":"setup"}`)); err != nil {
		return err
	}
	var models *installModelCheck
	switch id {
	case "address":
		// The new listener opens before the settings commit; the step stays
		// running until both are done, and a bind that cannot listen fails it.
		err = s.Address.apply(input.Bind)
	case "models":
		// Provider calls run before the settings transaction opens.
		models, err = s.checkModels(ctx)
	default:
		provider := s.Providers[id]
		if provider == nil {
			err = pkgerrors.New(pkgerrors.CodeServiceUnavailable, "setup provider unavailable")
		} else {
			err = provider(ctx, lease, input)
		}
	}
	if errors.Is(err, jobs.ErrDeferred) {
		return err
	}
	committed := false
	if id == "address" {
		defer func() {
			if !committed {
				s.Address.revert()
			}
		}()
	}
	tx, writeErr := s.Pool.Begin(ctx)
	if writeErr != nil {
		return writeErr
	}
	defer tx.Rollback(ctx)
	if id == "address" && err == nil {
		err = s.writeAddress(ctx, tx, input)
	}
	if id == "models" && models != nil {
		if writeErr = models.save(ctx, tx, err == nil); writeErr != nil {
			return writeErr
		}
	}
	state := InstallReady
	var failure *InstallReadinessError
	if err != nil {
		state = InstallFailed
		failure = &InstallReadinessError{Code: "install_setup_failed", Class: "infra", Message: "Setup failed"}
		var typed *InstallReadinessError
		if errors.As(err, &typed) {
			failure = typed
		}
	}
	step, writeErr := s.readStep(ctx, db.New(tx), id)
	if writeErr != nil {
		return writeErr
	}
	if step.OperationID != claim.OperationID {
		return jobs.ErrClaimLost
	}
	step.Status = state
	step.Attempt = claim.Attempt
	step.Error = failure
	// GitHub settings the owner fixes on GitHub block the step with the fix.
	if failure != nil && (failure.Code == "squash_disabled" || failure.Code == "default_branch_not_main") {
		step.Status = "blocked"
		step.Blocked = &InstallSetupBlock{Line: failure.Message, FixURL: failure.Fix}
		step.Error = nil
	}
	step.ExpiresAt = time.Time{}
	receipt, _ := json.Marshal(step)
	if writeErr = s.Jobs.SettleInTx(ctx, tx, claim, receipt, err != nil); writeErr != nil {
		return writeErr
	}
	if writeErr = saveInstallStep(ctx, tx, step); writeErr != nil {
		return writeErr
	}
	if writeErr = tx.Commit(ctx); writeErr != nil {
		return writeErr
	}
	if id == "address" && err == nil {
		committed = true
		s.Address.commit(input.Bind, input.Origins)
	}
	return nil
}
func (s *InstallSetupService) writeAddress(ctx context.Context, tx pgx.Tx, input InstallSetupInput) error {
	for key, value := range map[string]any{"bind": input.Bind, "public_origins": input.Origins} {
		raw, _ := json.Marshal(value)
		if err := db.New(tx).UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: raw}); err != nil {
			return err
		}
	}
	return nil
}

// InstallFastModel is the fast role on a Cerebras key (mvp.md §6.5). The
// openai-chat protocol has no default address; Cerebras serves
// /v1/chat/completions at its origin, so the base URL carries no /v1.
const InstallFastModel = `{"protocol":"openai-chat","modelId":"gpt-oss-120b","credential":"CEREBRAS_API_KEY","baseUrl":"https://api.cerebras.ai"}`

// installDecisionModel is the Decisions role: the evaluation protocol the
// Gateway key serves, so the setup test asks it a typed decision.
const installDecisionModel = `{"protocol":"evaluation","modelId":"typesafe-ai/jev","credential":"AI_GATEWAY_API_KEY"}`

// ModelProviderNames are the built-in keys' providers in product words.
var ModelProviderNames = map[string]string{"OPENAI_API_KEY": "OpenAI", "ANTHROPIC_API_KEY": "Anthropic", "CEREBRAS_API_KEY": "Cerebras", "OPENROUTER_API_KEY": "OpenRouter", "AI_GATEWAY_API_KEY": "AI Gateway"}

// installModelFailure is one role's failed key test. Digest is the sealed
// key's md5 at test time, so a key saved since then reads as saved again.
type installModelFailure struct {
	Credential string `json:"credential"`
	Digest     string `json:"digest"`
	Error      string `json:"error"`
}

type installModelCheck struct {
	roles  map[string]json.RawMessage
	failed map[string]installModelFailure
}

func modelCredentialOf(binding json.RawMessage) string {
	var model struct {
		Credential string `json:"credential"`
	}
	_ = json.Unmarshal(binding, &model)
	return model.Credential
}

// checkModels derives the three role bindings from the owner's coding model
// and saved keys, then tests each role's key with one real call.
func (s *InstallSetupService) checkModels(ctx context.Context) (*installModelCheck, error) {
	owner, err := db.New(s.Pool).GetSelfHostOwner(ctx)
	if err != nil {
		return nil, err
	}
	var coding json.RawMessage
	if err = s.Pool.QueryRow(ctx, `SELECT model FROM owner_model_defaults WHERE user_id=$1`, owner.ID).Scan(&coding); err != nil {
		return nil, &InstallReadinessError{Code: "model_missing", Class: "user", Message: "Choose a coding model"}
	}
	if modelCredentialOf(coding) == "" {
		return nil, fmt.Errorf("invalid coding model")
	}
	digests, err := s.modelKeyDigests(ctx, owner.ID)
	if err != nil {
		return nil, err
	}
	for _, name := range []string{modelCredentialOf(coding), "AI_GATEWAY_API_KEY"} {
		if digests[name] == "" {
			return nil, &InstallReadinessError{Code: "model_key_missing", Class: "user", Message: "Save coding and Gateway keys"}
		}
	}
	check := &installModelCheck{failed: map[string]installModelFailure{},
		roles: map[string]json.RawMessage{"coding": coding, "fast": coding, "jev": json.RawMessage(installDecisionModel)}}
	tested := []string{"coding", "jev"}
	// Without a fast key the app agent uses the coding model (mvp.md §6.5).
	if digests["CEREBRAS_API_KEY"] != "" {
		check.roles["fast"] = json.RawMessage(InstallFastModel)
		tested = append(tested, "fast")
	}
	if s.Models == nil {
		return check, &InstallReadinessError{Code: "model_host_unavailable", Class: "infra", Message: "Model host unavailable"}
	}
	reasons := make([]string, len(tested))
	var calls sync.WaitGroup
	for i, role := range tested {
		calls.Go(func() { reasons[i] = installModelTestReason(s.runModelTest(ctx, owner.ID, role, check.roles[role])) })
	}
	calls.Wait()
	var lines []string
	for i, role := range tested {
		if reasons[i] == "" {
			continue
		}
		credential := modelCredentialOf(check.roles[role])
		check.failed[role] = installModelFailure{Credential: credential, Digest: digests[credential], Error: reasons[i]}
		lines = append(lines, ModelProviderNames[credential]+" key: "+reasons[i])
	}
	if len(lines) > 0 {
		return check, &InstallReadinessError{Code: "model_key_refused", Class: "user", Message: strings.Join(lines, "; ")}
	}
	return check, nil
}

// modelKeyDigests names the owner's saved keys with each sealed value's md5.
func (s *InstallSetupService) modelKeyDigests(ctx context.Context, ownerID int64) (map[string]string, error) {
	rows, err := s.Pool.Query(ctx, `SELECT name, md5(value_encrypted) FROM owner_model_credentials WHERE user_id=$1 AND value_encrypted IS NOT NULL`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	digests := map[string]string{}
	for rows.Next() {
		var name, digest string
		if err = rows.Scan(&name, &digest); err != nil {
			return nil, err
		}
		digests[name] = digest
	}
	return digests, rows.Err()
}

// runModelTest sends the role's binding as POST /api/model/test's record.
func (s *InstallSetupService) runModelTest(ctx context.Context, ownerID int64, role string, binding json.RawMessage) (json.RawMessage, error) {
	var record map[string]json.RawMessage
	if err := json.Unmarshal(binding, &record); err != nil {
		return nil, err
	}
	record["id"], _ = json.Marshal(role)
	request, err := json.Marshal(map[string]any{"model": record})
	if err != nil {
		return nil, err
	}
	return s.Models.RunModelTest(ctx, ownerID, request)
}

// installModelTestReason is a test's outcome in product words, empty when it
// passed. It reads the ModelTestFailure codes and statuses, never provider text.
func installModelTestReason(result json.RawMessage, err error) string {
	if err != nil {
		return "Could not test the key"
	}
	var outcome struct {
		OK      bool `json:"ok"`
		Failure struct {
			Code   string `json:"code"`
			Status int    `json:"status"`
		} `json:"failure"`
	}
	if json.Unmarshal(result, &outcome) != nil {
		return "Could not test the key"
	}
	if outcome.OK {
		return ""
	}
	switch outcome.Failure.Code {
	case "refused":
		switch status := outcome.Failure.Status; {
		case status == 401 || status == 403:
			return "Key rejected"
		case status == 402:
			return "Out of credits"
		case status == 429:
			return "Out of credits or rate limited"
		case status == 404:
			return "Model not found"
		case status >= 500:
			return "Provider error; try again"
		default:
			return fmt.Sprintf("Refused (HTTP %d)", status)
		}
	case "timeout":
		return "No answer in time"
	case "unreachable":
		return "Provider unreachable"
	case "credential_missing", "credential_unknown":
		return "Key missing"
	case "model_not_allowed":
		return "Model not allowed"
	case "endpoint_forbidden":
		return "Address not allowed for this key"
	case "empty_output":
		return "Empty answer"
	case "invalid":
		return "Model settings invalid"
	}
	return "Test failed"
}

// save writes the role bindings once every test passed, and the failures
// either way, so Status shows each refused key on its role.
func (c *installModelCheck) save(ctx context.Context, tx pgx.Tx, passed bool) error {
	q := db.New(tx)
	if passed {
		for role, value := range c.roles {
			if err := q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "agent:" + role, Value: value}); err != nil {
				return err
			}
		}
	}
	raw, err := json.Marshal(c.failed)
	if err != nil {
		return err
	}
	return q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "models.tests", Value: raw})
}

// Status reads only persisted settings and credential flags; secrets are never
// decoded or serialized by the install projection.
func (s *InstallSetupService) Status(ctx context.Context) (map[string]any, error) {
	steps, err := s.Steps(ctx)
	if err != nil {
		return nil, err
	}
	projected := make([]map[string]any, 0, len(steps))
	for _, step := range steps {
		value := map[string]any{"id": step.ID, "state": step.Status}
		if step.Pct != nil {
			value["pct"] = *step.Pct
		}
		if step.Error != nil {
			value["error"] = step.Error
		}
		if step.Blocked != nil {
			value["blocked"] = step.Blocked
		}
		projected = append(projected, value)
	}
	capacity, hostCapacity := 0, 0
	memory, disk := float64(0), float64(0)
	if s.Capacity != nil {
		host, err := s.Capacity.Read(ctx)
		if err != nil {
			return nil, err
		}
		capacity = host.Machines.Capacity
		hostCapacity = host.Limits.Capacity
		memory = float64(host.Profile.MemoryBytes) / (1 << 30)
		disk = float64(host.Profile.DiskFreeBytes) / (1 << 30)
	}
	q := db.New(s.Pool)
	bind := "127.0.0.1:4000"
	origins := []string{"http://localhost:4000"}
	if row, err := q.GetInstallSetting(ctx, "bind"); err == nil {
		if err = json.Unmarshal(row.Value, &bind); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if row, err := q.GetInstallSetting(ctx, "public_origins"); err == nil {
		if err = json.Unmarshal(row.Value, &origins); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	listen := "mac"
	if NetworkBind(bind) != "" {
		listen = "network"
	}
	owner, ownerErr := q.GetSelfHostOwner(ctx)
	if ownerErr != nil && !errors.Is(ownerErr, pgx.ErrNoRows) {
		return nil, ownerErr
	}
	github := map[string]any{"signed_in": ownerErr == nil, "app_installed": false}
	if ownerErr == nil {
		github["owner"] = owner.Username
		projected[2]["state"] = InstallReady
	}
	app, appErr := q.GetGithubApp(ctx)
	if appErr == nil {
		github["app_installed"] = app.InstallationID.Valid && app.InstallationID.Int64 > 0
	} else if !errors.Is(appErr, pgx.ErrNoRows) {
		return nil, appErr
	}
	var coding json.RawMessage
	if err := s.Pool.QueryRow(ctx, `SELECT model FROM owner_model_defaults WHERE user_id=$1`, owner.ID).Scan(&coding); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	keys, err := s.modelKeyDigests(ctx, owner.ID)
	if err != nil {
		return nil, err
	}
	failed := map[string]installModelFailure{}
	if row, err := q.GetInstallSetting(ctx, "models.tests"); err == nil {
		if err = json.Unmarshal(row.Value, &failed); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	fast := json.RawMessage(`{"protocol":"openai-chat","credential":"CEREBRAS_API_KEY"}`)
	defaults := map[string]json.RawMessage{"fast": fast, "coding": coding, "jev": json.RawMessage(`{"protocol":"openai-chat","credential":"AI_GATEWAY_API_KEY"}`)}
	models := make([]map[string]string, 0, 3)
	for _, role := range []string{"fast", "coding", "jev"} {
		value := map[string]string{"role": role, "provider": map[string]string{"fast": "Cerebras", "coding": "OpenAI", "jev": "AI Gateway"}[role], "key": "none"}
		binding := defaults[role]
		row, err := q.GetInstallSetting(ctx, "agent:"+role)
		if err == nil {
			binding = row.Value
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if len(binding) > 0 {
			var model struct {
				Protocol   string `json:"protocol"`
				Credential string `json:"credential"`
			}
			if err = json.Unmarshal(binding, &model); err != nil {
				return nil, err
			}
			provider := ModelProviderNames[model.Credential]
			if provider == "" {
				provider = model.Protocol
			}
			value["provider"] = provider
			if keys[model.Credential] != "" {
				value["key"] = "saved"
			}
			// A refused key stays failed until a new value is saved for it.
			if failure, ok := failed[role]; ok && failure.Credential == model.Credential && failure.Digest == keys[model.Credential] && failure.Digest != "" {
				value["key"] = "failed"
				value["error"] = failure.Error
			}
		}
		models = append(models, value)
	}
	result := map[string]any{"address": map[string]any{"listen": listen, "bind": bind, "origins": origins}, "steps": projected, "this_mac": map[string]any{"memory_gb": memory, "disk_free_gb": disk, "capacity": hostCapacity}, "github": github, "models": models, "chatgpt": false, "capacity": capacity}
	repository, err := q.GetInstallSetting(ctx, "repository")
	if err == nil {
		var slug string
		if err = json.Unmarshal(repository.Value, &slug); err != nil {
			return nil, err
		}
		o, n, _ := strings.Cut(slug, "/")
		result["repository"] = map[string]string{"owner": o, "name": n}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if ownerErr == nil && s.RepositoryAccess != nil && result["repository"] == nil {
		repositories, failure := VerifyGitHubAppInstallations(ctx, s.RepositoryAccess, owner.ID, "")
		if failure != nil {
			return nil, failure
		}
		choices := make([]string, 0, len(repositories))
		for _, repository := range repositories {
			choices = append(choices, repository.FullName)
		}
		result["repositories"] = choices
		github["app_installed"] = len(choices) > 0
		if len(choices) == 0 {
			installURL, err := s.RepositoryAccess.GitHubAppInstallURL(ctx)
			if err != nil {
				return nil, err
			}
			if installURL != "" {
				projected[3]["state"] = "blocked"
				projected[3]["blocked"] = map[string]string{"line": "Install the GitHub App", "fix_url": installURL}
			}
		}
	}
	if result["repository"] != nil && steps[3].Status == InstallReady {
		github["squash_allowed"] = true
	}
	return result, nil
}
