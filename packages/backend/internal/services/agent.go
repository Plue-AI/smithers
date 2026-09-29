package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// AgentSessionResponse is the API representation of an agent session.
type AgentSessionResponse struct {
	ID           string          `json:"id"`
	RepositoryID int64           `json:"repository_id"`
	UserID       int64           `json:"user_id"`
	Title        string          `json:"title"`
	Status       string          `json:"status"`
	MessageCount int64           `json:"message_count"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
	Metadata     json.RawMessage `json:"metadata"`
	// WorkspaceID is the kind=agent workspace this run executes in (RFD-004).
	WorkspaceID string `json:"workspace_id,omitempty"`
}

// AgentPartResponse is the API representation of a message part.
type AgentPartResponse struct {
	PartIndex int64  `json:"part_index"`
	Type      string `json:"type"`
	Content   any    `json:"content"`
}

// AgentMessageResponse is the API representation of an agent message with its parts.
type AgentMessageResponse struct {
	ID        int64               `json:"id"`
	SessionID string              `json:"session_id"`
	Role      string              `json:"role"`
	Sequence  int64               `json:"sequence"`
	Parts     []AgentPartResponse `json:"parts"`
	CreatedAt time.Time           `json:"created_at"`
}

// AgentSessionEvent is the SSE payload emitted on agent.session streams.
type AgentSessionEvent struct {
	SessionID string                `json:"session_id"`
	Action    string                `json:"action"`
	Message   *AgentMessageResponse `json:"message,omitempty"`
	Status    string                `json:"status,omitempty"`
}

func AgentSessionMessageEvent(msg AgentMessageResponse) AgentSessionEvent {
	return AgentSessionEvent{
		SessionID: msg.SessionID,
		Action:    "message",
		Message:   &msg,
	}
}

type agentTaskPayloadMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// CreateAgentSessionInput is the input for creating a new agent session.
type CreateAgentSessionInput struct {
	RepositoryID int64
	UserID       int64
	Title        string
	Metadata     json.RawMessage
}

// AppendAgentMessageInput is the input for appending a message to a session.
type AppendAgentMessageInput struct {
	SessionID string
	Role      string
	Parts     []db.CreateAgentPartParams
}

// DispatchAgentRunInput is the input for dispatching an agent run.
type DispatchAgentRunInput struct {
	SessionID        string
	RepositoryID     int64
	UserID           int64
	TriggerMessageID int64
	// MessageAuthor is the authenticated login that posted TriggerMessageID.
	// Only the message route sets it; turns the product composes itself
	// (review feedback, conflict and finding repairs) leave it empty, so no
	// run records a person's message it never received.
	MessageAuthor  string
	RepoOwner      string
	RepoName       string
	AgentProvider  string
	AgentTransport string
	// SourceBookmark is the bookmark the run's workspace targets (RFD-004);
	// empty means the repository's default bookmark.
	SourceBookmark string
	// AllowedPaths is the lane's repository-relative write set. When present,
	// the per-run repository token cannot push changes outside these globs.
	AllowedPaths []string
	// ChangesetID, when set, materializes every member repository of the
	// cross-repository changeset into the VM at its pinned commit under
	// /workspace/<org>/<repo> in addition to the session repository.
	ChangesetID int64
}

// ChangesetMaterializedMember is one member repository of a changeset pinned
// at the commit the changeset recorded.
type ChangesetMaterializedMember struct {
	Owner    string
	Repo     string
	CommitID string
}

// AgentChangesetMaterializer resolves a changeset into the member repositories
// an agent VM must clone at pinned revisions.
type AgentChangesetMaterializer interface {
	MaterializeChangeset(ctx context.Context, userID, changesetID int64) ([]ChangesetMaterializedMember, error)
}

// DispatchAgentRunResult is the result of dispatching an agent run.
type DispatchAgentRunResult struct {
	WorkflowRunID  int64
	WorkflowTaskID int64
	OperationID    string
	AgentToken     string
}

// IngestRunnerEventInput is the input for ingesting a runner event.
type IngestRunnerEventInput struct {
	SessionID string
	EventType string // "text", "tool_call", "tool_result", "done"
	Content   json.RawMessage
}

// RepoHostSnapshotter creates repository snapshots for agent tasks.
type RepoHostSnapshotter interface {
	CreateSnapshot(ctx context.Context, repoID int64) (string, error)
}

// AgentSecretReader resolves decrypted repository secrets for agent execution.
type AgentSecretReader interface {
	ListDecryptedSecretsForRepo(ctx context.Context, repositoryID int64) (map[string]string, error)
}

// AgentSandboxConfig configures sandbox provider agent VM resources and watchdogs.
type AgentSandboxConfig struct {
	MemoryMB     int32
	VCPUCount    int32
	RootfsSizeMB int64
	MaxRuntime   time.Duration
	// ModelSeats are the platform model seats the deployment pays for. The
	// guest reaches them through the metered model proxy with the run's own
	// agent token (the repository owner pays); no provider key enters the
	// guest. Seats are re-applied after repository-secret injection so a
	// repository secret cannot replace them.
	ModelSeats  []modelproxy.Seat
	IdleTimeout time.Duration
}

// AgentEnvironmentBoundSecretsLoader supplies repository agent-environment
// secrets that carry an egress-proxy binding (hosts + match_headers). Only
// bound secrets are returned, and only to the dispatch path that hands them
// to the proxy; unbound ones never reach an agent session through this door.
type AgentEnvironmentBoundSecretsLoader interface {
	LoadProxyBoundSecrets(ctx context.Context, repositoryID int64) ([]sandbox.EgressProxySecret, error)
}

// AgentEnvironmentVariablesLoader supplies validated, non-secret repository
// variables for the agent service environment.
type AgentEnvironmentVariablesLoader interface {
	LoadVariables(ctx context.Context, repositoryID int64) ([]AgentEnvironmentVariable, error)
}

// SecretDeliveryMetricsRecorder counts which path each agent secret took.
// Optional: metrics recorders that do not implement it are simply skipped.
type SecretDeliveryMetricsRecorder interface {
	AddAgentSecretDelivery(path string, count int)
}

const (
	secretDeliveryPathLegacyEnv   = "legacy_env"
	secretDeliveryPathEgressProxy = "egress_proxy"
)

// AgentQuerier defines the minimal DB operations needed by AgentService.
type AgentQuerier interface {
	CreateAgentSession(ctx context.Context, arg db.CreateAgentSessionParams) (db.AgentSession, error)
	GetAgentSession(ctx context.Context, id string) (db.AgentSession, error)
	GetAgentSessionWithMessageCount(ctx context.Context, id string) (db.GetAgentSessionWithMessageCountRow, error)
	ListAgentSessionsByRepo(ctx context.Context, arg db.ListAgentSessionsByRepoParams) ([]db.AgentSession, error)
	ListAgentSessionsByRepoWithMessageCount(ctx context.Context, arg db.ListAgentSessionsByRepoWithMessageCountParams) ([]db.ListAgentSessionsByRepoWithMessageCountRow, error)
	CountAgentSessionsByRepo(ctx context.Context, repositoryID int64) (int64, error)
	CountAgentMessagesBySession(ctx context.Context, sessionID string) (int64, error)
	DeleteAgentSession(ctx context.Context, arg db.DeleteAgentSessionParams) error
	CreateAgentMessage(ctx context.Context, arg db.CreateAgentMessageParams) (db.AgentMessage, error)
	GetNextAgentMessageSequence(ctx context.Context, sessionID string) (int32, error)
	CreateAgentPart(ctx context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error)
	ListAgentMessages(ctx context.Context, arg db.ListAgentMessagesParams) ([]db.AgentMessage, error)
	ListAgentMessagesAfterID(ctx context.Context, arg db.ListAgentMessagesAfterIDParams) ([]db.AgentMessage, error)
	ListAgentMessageParts(ctx context.Context, messageID int64) ([]db.AgentPart, error)
	NotifyAgentMessage(ctx context.Context, arg db.NotifyAgentMessageParams) error
	NotifyAgentSession(ctx context.Context, arg db.NotifyAgentSessionParams) error
	GetAgentSessionWorkflowRunID(ctx context.Context, id string) (pgtype.Int8, error)
}

type agentTurnQuerier interface {
	PrepareAgentSessionForTurn(ctx context.Context, sessionID string) (db.AgentSession, error)
}

// AgentDispatchQuerier defines the DB operations needed for agent dispatch.
type AgentDispatchQuerier interface {
	UpsertAgentWorkflowDefinition(ctx context.Context, repositoryID int64) (db.WorkflowDefinition, error)
	CreateWorkflowRun(ctx context.Context, arg db.CreateWorkflowRunParams) (db.WorkflowRun, error)
	CreateWorkflowStep(ctx context.Context, arg db.CreateWorkflowStepParams) (db.WorkflowStep, error)
	CreateWorkflowTask(ctx context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error)
	// The workspace coding host's own run id for one dispatched turn. It is
	// the handle every gateway projection selector takes, so a poller that
	// restarts can find the turn it was streaming.
	RecordWorkflowRunCodingHost(ctx context.Context, arg db.RecordWorkflowRunCodingHostParams) (db.WorkflowRunCodingHost, error)
	GetWorkflowRunCodingHost(ctx context.Context, workflowRunID int64) (db.WorkflowRunCodingHost, error)
	CreateAccessToken(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error)
	DeleteAccessToken(ctx context.Context, arg db.DeleteAccessTokenParams) error
	MarkWorkflowTaskVMRunning(ctx context.Context, arg db.MarkWorkflowTaskVMRunningParams) (int64, error)
	MarkWorkflowTaskTerminalByID(ctx context.Context, arg db.MarkWorkflowTaskTerminalByIDParams) (int64, error)
	GetWorkflowTaskByRunID(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error)
	GetWorkflowRunByRunID(ctx context.Context, id int64) (db.WorkflowRun, error)
	FailWorkflowRun(ctx context.Context, id int64) error
	UpdateWorkflowStepStatusRunning(ctx context.Context, stepID int64) (int64, error)
	UpdateWorkflowStepStatusTerminal(ctx context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error)
	UpdateWorkflowRunStatusBasedOnTasks(ctx context.Context, workflowRunID int64) (string, error)
	ListStaleActiveSessions(ctx context.Context, startedBefore pgtype.Timestamptz) ([]db.AgentSession, error)
	NotifyWorkflowRunEvent(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error
	ClaimAgentSessionForDispatch(ctx context.Context, sessionID string, workflowRunID int64) (bool, error)
	UpdateAgentSessionStartedAt(ctx context.Context, arg db.UpdateAgentSessionStartedAtParams) (db.AgentSession, error)
	UpdateWorkflowRunAgentToken(ctx context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error)
	UpdateWorkflowRunJJHubTokenID(ctx context.Context, arg db.UpdateWorkflowRunJJHubTokenIDParams) error
	GetWorkflowRunJJHubTokenID(ctx context.Context, id int64) (pgtype.Int8, error)
	ClearWorkflowRunJJHubTokenID(ctx context.Context, id int64) error
	UpdateAgentSessionStatus(ctx context.Context, arg db.UpdateAgentSessionStatusParams) (db.AgentSession, error)
	UpdateAgentSessionTerminalStatus(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error)
	GetAgentSessionForFlowProjection(ctx context.Context, arg db.GetAgentSessionForFlowProjectionParams) (db.AgentSession, error)
	UpdateAgentSessionTerminalStatusForFlow(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusForFlowParams) (db.AgentSession, error)
	UpdateAgentSessionTimedOut(ctx context.Context, arg db.UpdateAgentSessionTimedOutParams) (db.AgentSession, error)
}

// AgentLogStore stores agent session logs to GCS.
type AgentLogStore interface {
	PutSessionLog(ctx context.Context, repositoryID int64, sessionID string, payload []byte) error
}

// AgentConcurrencyCounter reports how many agent sandbox provider VMs are currently
// allocated across the whole fleet and reserves fleet slots for new ones. It
// backs the dispatch-time spend guard. Implemented by *db.Queries, so the
// figure is correct across all API pods (an in-process counter would undercount
// fleet-wide).
type AgentConcurrencyCounter interface {
	// CountActiveAgentSessionVMs is the cheap fast-fail precheck read.
	CountActiveAgentSessionVMs(ctx context.Context) (int, error)
	// ReserveAgentSessionVMSlot is the hard gate: an atomic, advisory-locked
	// count+stamp of started_at run just before VM provisioning, so concurrent
	// dispatches cannot all pass a stale count and overshoot the cap.
	ReserveAgentSessionVMSlot(ctx context.Context, sessionID string, maxActive int) (bool, error)
}

var agentRandRead = rand.Read

type agentRuntimeWatchdog struct {
	cancel        context.CancelFunc
	workflowRunID int64
}

// agentAppendTx defines the transaction interface for atomic message appends.
// This interface is used internally by AgentService to perform transactional
// operations that prevent race conditions during concurrent message appends.
//
// Correct usage order within a single transaction:
//  1. LockAgentSessionForAppend — acquires a FOR UPDATE row lock on agent_sessions.
//     This statement blocks until any concurrent holder releases the lock.
//  2. CreateAgentMessageWithNextSequence — computes MAX(sequence)+1 and inserts.
//     Because this is a separate SQL statement from step 1, PostgreSQL READ
//     COMMITTED semantics guarantee it sees all data committed by the previous
//     lock holder, preventing duplicate sequence allocation.
type agentAppendTx interface {
	// LockAgentSessionForAppend returns the locked session's id + repository_id.
	// Ticket 0115/0118: the denormalized repository_id is carried forward from
	// this row onto every agent_messages / agent_parts INSERT in the same tx,
	// so the realtime stream filter `repository_id IN (...) AND session_id IN
	// (...)` lines up with a populated column on every insert path.
	LockAgentSessionForAppend(ctx context.Context, sessionID string) (db.LockAgentSessionForAppendRow, error)
	CreateAgentMessageWithNextSequence(ctx context.Context, arg db.CreateAgentMessageWithNextSequenceParams) (db.AgentMessage, error)
	CreateAgentPart(ctx context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error)
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

// agentAppendTxManager defines the interface for beginning append transactions.
type agentAppendTxManager interface {
	BeginAppendTx(ctx context.Context) (agentAppendTx, error)
}

// pgxAgentAppendTxManager implements agentAppendTxManager using pgx.
type pgxAgentAppendTxManager struct {
	pool *pgxpool.Pool
}

func (m *pgxAgentAppendTxManager) BeginAppendTx(ctx context.Context) (agentAppendTx, error) {
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &pgxAgentAppendTx{
		tx: tx,
		q:  db.New(tx),
	}, nil
}

// pgxAgentAppendTx implements agentAppendTx using pgx transaction.
type pgxAgentAppendTx struct {
	tx pgx.Tx
	q  *db.Queries
}

func (t *pgxAgentAppendTx) LockAgentSessionForAppend(ctx context.Context, sessionID string) (db.LockAgentSessionForAppendRow, error) {
	return t.q.LockAgentSessionForAppend(ctx, sessionID)
}

func (t *pgxAgentAppendTx) CreateAgentMessageWithNextSequence(ctx context.Context, arg db.CreateAgentMessageWithNextSequenceParams) (db.AgentMessage, error) {
	return t.q.CreateAgentMessageWithNextSequence(ctx, arg)
}

func (t *pgxAgentAppendTx) CreateAgentPart(ctx context.Context, arg db.CreateAgentPartParams) (db.AgentPart, error) {
	return t.q.CreateAgentPart(ctx, arg)
}

func (t *pgxAgentAppendTx) Commit(ctx context.Context) error {
	return t.tx.Commit(ctx)
}

func (t *pgxAgentAppendTx) Rollback(ctx context.Context) error {
	return t.tx.Rollback(ctx)
}

// AgentService handles agent session lifecycle.
type AgentService struct {
	// guestEntrypointAssumed skips refuseRetiredAgentLoop. Its zero value is
	// the only one production ever has: no command exists to run a dispatched
	// task inside the box, so every real dispatch refuses.
	//
	// Only a test sets it, to reach the steps after the refusal — the clone
	// token, the per-run repository token, the credential boundary, the
	// egress bindings, the box lifecycle and the cleanup paths. Those are
	// loop-independent, still ship, and are what a Smithers 1.0 entrypoint
	// will reuse, so they stay covered. It lives on the service rather than
	// in a package variable so parallel tests do not share it. Delete it in
	// the same change that gives buildServiceSpec a real Exec.
	guestEntrypointAssumed bool

	neverStartedTimeout   time.Duration
	revocations           revocation.Publisher
	q                     AgentQuerier
	appendTxManager       agentAppendTxManager
	dispatchQ             AgentDispatchQuerier
	logStore              AgentLogStore
	secretInjector        *SecretInjector
	changesetMaterializer AgentChangesetMaterializer
	snapshotter           RepoHostSnapshotter
	secretService         AgentSecretReader
	apiBaseURL            string
	gitBaseURL            string
	sandbox               SandboxVMClient
	sandboxConfig         AgentSandboxConfig
	environmentVariables  AgentEnvironmentVariablesLoader
	boundSecrets          AgentEnvironmentBoundSecretsLoader
	sandboxMetrics        SandboxMetricsRecorder
	workflowMetrics       WorkflowRunMetricsObserver
	sessionMetrics        AgentSessionMetricsObserver
	agentSnapshotID       string
	billing               BillingPolicy
	// workspaces turns agent runs into workspaces (RFD-004). nil keeps the
	// ephemeral-VM path for direct/test construction.
	workspaces AgentWorkspaceBackend
	// flowDispatcher admits turns durably and projects receipts from the one
	// canonical TypeScript host. Deployment composition supplies either the
	// trusted owner or isolated Plue runtime resolver behind it.
	flowDispatcher AgentFlowDispatcher
	// concurrencyCounter + concurrencyMax cap how many agent sandbox provider VMs may be
	// allocated fleet-wide; enforced ONLY on the dispatch (VM-provision) path.
	// A nil counter or max <= 0 disables the cap.
	concurrencyCounter AgentConcurrencyCounter
	concurrencyMax     int
	watchdogsMu        sync.Mutex
	watchdogs          map[string]*agentRuntimeWatchdog
}

// AgentServiceOption configures optional dependencies for AgentService.
type AgentServiceOption func(*AgentService)

// AgentWorkspaceBackend is the workspace service surface an agent run uses
// to execute inside a workspace (RFD-004).
type AgentWorkspaceBackend interface {
	CreateAgentWorkspace(ctx context.Context, input CreateAgentWorkspaceInput) (AgentWorkspaceResult, error)
	SuspendAgentWorkspace(ctx context.Context, workspaceID string) error
	FailAgentWorkspace(ctx context.Context, workspaceID string) error
	SnapshotAgentWorkspace(ctx context.Context, workspaceID, name string) (string, error)
}

// SetWorkspaceBackend wires the workspace service; agent runs then execute
// in kind=agent workspaces instead of throwaway VMs.
func (s *AgentService) SetWorkspaceBackend(backend AgentWorkspaceBackend) {
	if s == nil {
		return
	}
	s.workspaces = backend
}

// WithAgentDispatchQuerier sets the dispatch querier for agent dispatch operations.
func WithAgentDispatchQuerier(q AgentDispatchQuerier) AgentServiceOption {
	return func(s *AgentService) {
		s.dispatchQ = q
	}
}

// WithAgentLogStore sets the log store for archiving agent session logs.
func WithAgentLogStore(store AgentLogStore) AgentServiceOption {
	return func(s *AgentService) {
		s.logStore = store
	}
}

// WithAgentChangesetMaterializer lets agent runs materialize a changeset's
// member repositories at their pinned commits.
func WithAgentChangesetMaterializer(m AgentChangesetMaterializer) AgentServiceOption {
	return func(s *AgentService) {
		s.changesetMaterializer = m
	}
}

func WithAgentSecretInjector(injector *SecretInjector) AgentServiceOption {
	return func(s *AgentService) {
		s.secretInjector = injector
	}
}

// WithAgentAPIBaseURL sets the API base URL included in task payloads.
func WithAgentAPIBaseURL(url string) AgentServiceOption {
	return func(s *AgentService) {
		s.apiBaseURL = url
	}
}

// WithAgentGitBaseURL sets the public Smithers base URL used for sandbox repo cloning.
func WithAgentGitBaseURL(url string) AgentServiceOption {
	return func(s *AgentService) {
		s.gitBaseURL = url
	}
}

// WithAgentSandboxClient sets the sandbox provider VM client used for agent execution.
func WithAgentSandboxClient(client SandboxVMClient) AgentServiceOption {
	return func(s *AgentService) {
		s.sandbox = client
	}
}

// WithAgentSandboxMetrics sets the metrics recorder for sandbox provider agent VMs.
func WithAgentSandboxMetrics(metrics SandboxMetricsRecorder) AgentServiceOption {
	return func(s *AgentService) {
		s.sandboxMetrics = metrics
	}
}

// WithAgentWorkflowMetrics wires workflow terminal metrics into agent-driven runs.
func WithAgentWorkflowMetrics(metrics WorkflowRunMetricsObserver) AgentServiceOption {
	return func(s *AgentService) {
		s.workflowMetrics = metrics
	}
}

// WithAgentSessionMetrics wires terminal agent session metrics into AgentService.
func WithAgentSessionMetrics(metrics AgentSessionMetricsObserver) AgentServiceOption {
	return func(s *AgentService) {
		s.sessionMetrics = metrics
	}
}

// WithAgentSnapshotID sets the prebuilt snapshot used for agent VMs.
func WithAgentSnapshotID(snapshotID string) AgentServiceOption {
	return func(s *AgentService) {
		s.agentSnapshotID = strings.TrimSpace(snapshotID)
	}
}

func WithAgentBillingPolicy(policy BillingPolicy) AgentServiceOption {
	return func(s *AgentService) {
		s.billing = policy
	}
}

func WithAgentSecretService(secretService AgentSecretReader) AgentServiceOption {
	return func(s *AgentService) {
		s.secretService = secretService
	}
}

// WithAgentEnvironmentBoundSecrets lets dispatch route proxy-bound
// agent-environment secrets through the egress proxy.
func WithAgentEnvironmentBoundSecrets(loader AgentEnvironmentBoundSecretsLoader) AgentServiceOption {
	return func(s *AgentService) {
		s.boundSecrets = loader
	}
}

// WithAgentEnvironmentVariables makes repository non-secret variables
// available to the agent process.
func WithAgentEnvironmentVariables(loader AgentEnvironmentVariablesLoader) AgentServiceOption {
	return func(s *AgentService) {
		s.environmentVariables = loader
	}
}

func WithAgentSandboxConfig(cfg AgentSandboxConfig) AgentServiceOption {
	return func(s *AgentService) {
		s.sandboxConfig = cfg
	}
}

// WithAgentConcurrencyCap wires the fleet-wide active-agent-VM cap enforced on
// the dispatch (VM-provision) path only. A nil counter or max <= 0 disables it,
// so the cap is opt-in and no-ops until an operator sets a positive value.
func WithAgentConcurrencyCap(counter AgentConcurrencyCounter, max int) AgentServiceOption {
	return func(s *AgentService) {
		if counter != nil && max > 0 {
			s.concurrencyCounter = counter
			s.concurrencyMax = max
		}
	}
}

// WithRepoHostSnapshotter sets the repo-host snapshotter for materializing repository snapshots.
func WithRepoHostSnapshotter(snap RepoHostSnapshotter) AgentServiceOption {
	return func(s *AgentService) {
		s.snapshotter = snap
	}
}

// NewAgentService returns a new AgentService.
func NewAgentService(q AgentQuerier) *AgentService {
	return &AgentService{
		q:         q,
		watchdogs: make(map[string]*agentRuntimeWatchdog),
	}
}

// NewAgentServiceWithPool returns a new AgentService that supports transactional
// message appends using the provided connection pool. This constructor should be
// used in production to ensure atomic sequence allocation and message creation.
func NewAgentServiceWithPool(q AgentQuerier, pool *pgxpool.Pool, opts ...AgentServiceOption) *AgentService {
	svc := &AgentService{
		q:         q,
		watchdogs: make(map[string]*agentRuntimeWatchdog),
	}
	if pool != nil {
		svc.appendTxManager = &pgxAgentAppendTxManager{
			pool: pool,
		}
	}
	for _, opt := range opts {
		opt(svc)
	}
	return svc
}

// CreateSession creates a new agent session for the given repository and user.
func (s *AgentService) CreateSession(ctx context.Context, input CreateAgentSessionInput) (AgentSessionResponse, error) {
	if s.q == nil {
		return AgentSessionResponse{}, pkgerrors.Internal("agent store unavailable")
	}

	id := uuid.New().String()
	// agent_sessions.title is VARCHAR(255) NOT NULL; reject over-length and
	// NUL/invalid-UTF8 up front so a malformed title does not fail the INSERT
	// (SQLSTATE 22001/22021) as an opaque 500.
	title := strings.TrimSpace(input.Title)
	if len(title) > 255 {
		return AgentSessionResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "AgentSession", Field: "title", Code: "invalid"})
	}
	if err := validateSafeText("AgentSession", "title", title); err != nil {
		return AgentSessionResponse{}, err
	}
	metadata := input.Metadata
	if len(metadata) == 0 {
		metadata = json.RawMessage(`{}`)
	}
	var metadataObject map[string]json.RawMessage
	if err := json.Unmarshal(metadata, &metadataObject); err != nil || metadataObject == nil {
		return AgentSessionResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "AgentSession", Field: "metadata", Code: "invalid"})
	}
	session, err := s.q.CreateAgentSession(ctx, db.CreateAgentSessionParams{
		ID:           id,
		RepositoryID: input.RepositoryID,
		UserID:       input.UserID,
		Title:        title,
		Status:       "active",
		Metadata:     metadata,
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if stdErrors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "uq_agent_sessions_active_finding_dispatch" {
			return AgentSessionResponse{}, pkgerrors.Conflict("finding dispatch already running")
		}
		return AgentSessionResponse{}, pkgerrors.Internal("create agent session: " + err.Error())
	}

	return toAgentSessionResponse(session), nil
}

// GetSession returns a single agent session by ID, enriched with message count.
func (s *AgentService) GetSession(ctx context.Context, sessionID string) (AgentSessionResponse, error) {
	if s.q == nil {
		return AgentSessionResponse{}, pkgerrors.Internal("agent store unavailable")
	}

	row, err := s.q.GetAgentSessionWithMessageCount(ctx, sessionID)
	if err != nil {
		return AgentSessionResponse{}, pkgerrors.NotFound("agent session not found")
	}

	return toAgentSessionWithCountResponse(row), nil
}

// GetSessionForRepo verifies that the given agent session exists and belongs to the
// specified repository. Returns nil on success or an error if not found / mismatch.
func (s *AgentService) GetSessionForRepo(ctx context.Context, sessionID string, repoID int64) error {
	if s.q == nil {
		return pkgerrors.Internal("agent store unavailable")
	}

	session, err := s.q.GetAgentSession(ctx, sessionID)
	if err != nil {
		return pkgerrors.NotFound("agent session not found")
	}

	if session.RepositoryID != repoID {
		return pkgerrors.NotFound("agent session not found")
	}

	return nil
}

// ListSessions returns paginated agent sessions for the given repository,
// enriched with message count for each session.
func (s *AgentService) ListSessions(ctx context.Context, repositoryID int64, page, perPage int) ([]AgentSessionResponse, int64, error) {
	if s.q == nil {
		return nil, 0, pkgerrors.Internal("agent store unavailable")
	}
	if page < 1 {
		page = 1
	}
	if perPage < 1 || perPage > 100 {
		perPage = 30
	}
	offset := (page - 1) * perPage

	rows, err := s.q.ListAgentSessionsByRepoWithMessageCount(ctx, db.ListAgentSessionsByRepoWithMessageCountParams{
		RepositoryID: repositoryID,
		PageOffset:   ClampInt32(offset),
		PageSize:     int32(perPage),
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("list agent sessions: " + err.Error())
	}

	total, err := s.q.CountAgentSessionsByRepo(ctx, repositoryID)
	if err != nil {
		return nil, 0, pkgerrors.Internal("count agent sessions: " + err.Error())
	}

	result := make([]AgentSessionResponse, 0, len(rows))
	for _, row := range rows {
		result = append(result, toAgentSessionListResponse(row))
	}
	return result, total, nil
}

// AppendMessage appends a message (with parts) to an agent session.
// When the service is configured with a transaction manager (via NewAgentServiceWithPool),
// this operation is performed atomically with row-level locking to prevent race conditions
// during concurrent appends to the same session.
// After all parts are persisted, publishes a pg_notify on the agent_session_{id} channel
// so that any connected SSE listeners receive the event in real time.
func (s *AgentService) AppendMessage(ctx context.Context, sessionID, role string, parts []db.CreateAgentPartParams) (AgentMessageResponse, error) {
	if s.q == nil {
		return AgentMessageResponse{}, pkgerrors.Internal("agent store unavailable")
	}

	s.touchAgentWorkspaceActivity(ctx, sessionID)

	// Use transactional path if transaction manager is available
	if s.appendTxManager != nil {
		return s.appendMessageWithTx(ctx, sessionID, role, parts)
	}

	// Fall back to non-transactional path for backward compatibility
	return s.appendMessageWithoutTx(ctx, sessionID, role, parts)
}

// agentWorkspaceActivityToucher is the optional querier surface that keeps
// an agent workspace out of idle suspension while its run is active.
type agentWorkspaceActivityToucher interface {
	TouchWorkspaceActivityByAgentSession(ctx context.Context, agentSessionID string) error
}

func (s *AgentService) touchAgentWorkspaceActivity(ctx context.Context, sessionID string) {
	if s == nil || s.workspaces == nil {
		return
	}
	if toucher, ok := s.q.(agentWorkspaceActivityToucher); ok {
		_ = toucher.TouchWorkspaceActivityByAgentSession(ctx, sessionID)
	}
}

// agentSessionWorkspaceID returns the workspace a session executes in, or
// "" when it runs on the ephemeral path or the backend is not wired.
func (s *AgentService) agentSessionWorkspaceID(ctx context.Context, sessionID string) string {
	if s == nil || s.workspaces == nil || s.q == nil {
		return ""
	}
	session, err := s.q.GetAgentSession(ctx, sessionID)
	if err != nil {
		return ""
	}
	return UUIDString(session.WorkspaceID)
}

// appendMessageWithTx performs atomic message append using a transaction.
//
// Concurrency safety: uses a two-statement pattern within the same transaction:
//  1. LockAgentSessionForAppend acquires a FOR UPDATE row lock on agent_sessions.
//     This statement blocks until any concurrent holder releases the lock.
//  2. CreateAgentMessageWithNextSequence computes MAX(sequence)+1 and inserts.
//     As a separate SQL statement in the same transaction, PostgreSQL READ
//     COMMITTED semantics guarantee it re-reads committed data (including any
//     rows committed by the previous lock holder), preventing duplicate sequences.
func (s *AgentService) appendMessageWithTx(ctx context.Context, sessionID, role string, parts []db.CreateAgentPartParams) (AgentMessageResponse, error) {
	tx, err := s.appendTxManager.BeginAppendTx(ctx)
	if err != nil {
		return AgentMessageResponse{}, pkgerrors.Internal("begin append transaction: " + err.Error())
	}

	// Step 1: Acquire row-level lock on the session. This blocks until any
	// concurrent append transaction for the same session commits, ensuring the
	// next MAX(sequence) read sees their committed rows. Also returns the
	// session's repository_id (ticket 0115/0118) which we denormalize onto the
	// inserted agent_messages row and every agent_parts row below.
	locked, err := tx.LockAgentSessionForAppend(ctx, sessionID)
	if err != nil {
		_ = tx.Rollback(ctx)
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return AgentMessageResponse{}, pkgerrors.Conflict("agent session is no longer active")
		}
		return AgentMessageResponse{}, pkgerrors.Internal("lock agent session: " + err.Error())
	}

	// Step 2: Compute and insert the message. As a separate statement from the
	// lock above, this re-reads MAX(sequence) with READ COMMITTED semantics,
	// seeing all rows committed before this statement started. The message's
	// repository_id is taken from the locked session row inside the same CTE,
	// not from a mutable arg (ticket 0115).
	msg, err := tx.CreateAgentMessageWithNextSequence(ctx, db.CreateAgentMessageWithNextSequenceParams{
		SessionID: sessionID,
		Role:      role,
	})
	if err != nil {
		_ = tx.Rollback(ctx)
		return AgentMessageResponse{}, pkgerrors.Internal("create agent message: " + err.Error())
	}

	// Create parts within the same transaction. Ticket 0118: every part carries
	// the same repository_id + session_id as its parent message so the realtime
	// shape filter matches on exact-table columns without a join.
	partResponses := make([]AgentPartResponse, 0, len(parts))
	for i, p := range parts {
		p.MessageID = msg.ID
		p.PartIndex = int64(i)
		p.RepositoryID = locked.RepositoryID
		p.SessionID = sessionID
		created, err := tx.CreateAgentPart(ctx, p)
		if err != nil {
			_ = tx.Rollback(ctx)
			return AgentMessageResponse{}, pkgerrors.Internal("create agent part: " + err.Error())
		}
		partResponses = append(partResponses, AgentPartResponse{
			PartIndex: created.PartIndex,
			Type:      created.PartType,
			Content:   created.Content,
		})
	}

	// Commit transaction
	if err := tx.Commit(ctx); err != nil {
		_ = tx.Rollback(ctx)
		return AgentMessageResponse{}, pkgerrors.Internal("commit append transaction: " + err.Error())
	}

	resp := AgentMessageResponse{
		ID:        msg.ID,
		SessionID: msg.SessionID,
		Role:      msg.Role,
		Sequence:  msg.Sequence,
		Parts:     partResponses,
		CreatedAt: msg.CreatedAt,
	}

	// Publish pg_notify after commit so SSE subscribers receive the event.
	// Errors are intentionally ignored — SSE is best-effort; the message is already persisted.
	if payload, marshalErr := json.Marshal(AgentSessionMessageEvent(resp)); marshalErr == nil {
		safeSessionID := strings.ReplaceAll(sessionID, "-", "")
		_ = s.q.NotifyAgentMessage(ctx, db.NotifyAgentMessageParams{
			SessionID: safeSessionID,
			Payload:   string(payload),
		})
	}

	return resp, nil
}

// appendMessageWithoutTx performs non-transactional message append.
// This is used for backward compatibility when no transaction manager is configured.
func (s *AgentService) appendMessageWithoutTx(ctx context.Context, sessionID, role string, parts []db.CreateAgentPartParams) (AgentMessageResponse, error) {
	// Ticket 0115/0118: look up the parent session to get its repository_id
	// (plus to confirm it's not tombstoned). We denormalize the value onto
	// every agent_messages / agent_parts row so the realtime stream filter
	// can match on exact-table columns.
	session, err := s.q.GetAgentSession(ctx, sessionID)
	if err != nil {
		return AgentMessageResponse{}, pkgerrors.Internal("load agent session: " + err.Error())
	}
	if session.Status != "active" {
		return AgentMessageResponse{}, pkgerrors.Conflict("agent session is no longer active")
	}

	seq, err := s.q.GetNextAgentMessageSequence(ctx, sessionID)
	if err != nil {
		return AgentMessageResponse{}, pkgerrors.Internal("get next message sequence: " + err.Error())
	}

	msg, err := s.q.CreateAgentMessage(ctx, db.CreateAgentMessageParams{
		SessionID:    sessionID,
		RepositoryID: session.RepositoryID,
		Role:         role,
		Sequence:     int64(seq),
	})
	if err != nil {
		return AgentMessageResponse{}, pkgerrors.Internal("create agent message: " + err.Error())
	}

	partResponses := make([]AgentPartResponse, 0, len(parts))
	for i, p := range parts {
		p.MessageID = msg.ID
		p.PartIndex = int64(i)
		p.RepositoryID = session.RepositoryID
		p.SessionID = sessionID
		created, err := s.q.CreateAgentPart(ctx, p)
		if err != nil {
			return AgentMessageResponse{}, pkgerrors.Internal("create agent part: " + err.Error())
		}
		partResponses = append(partResponses, AgentPartResponse{
			PartIndex: created.PartIndex,
			Type:      created.PartType,
			Content:   created.Content,
		})
	}

	resp := AgentMessageResponse{
		ID:        msg.ID,
		SessionID: msg.SessionID,
		Role:      msg.Role,
		Sequence:  msg.Sequence,
		Parts:     partResponses,
		CreatedAt: msg.CreatedAt,
	}

	// Publish pg_notify after all parts are persisted so SSE subscribers receive the event.
	// Errors are intentionally ignored — SSE is best-effort; the message is already persisted.
	if payload, marshalErr := json.Marshal(AgentSessionMessageEvent(resp)); marshalErr == nil {
		safeSessionID := strings.ReplaceAll(sessionID, "-", "")
		_ = s.q.NotifyAgentMessage(ctx, db.NotifyAgentMessageParams{
			SessionID: safeSessionID,
			Payload:   string(payload),
		})
	}

	return resp, nil
}

const maxAgentMessagesPageSize = 200

// ListMessages returns paginated messages for an agent session, including parts.
func (s *AgentService) ListMessages(ctx context.Context, sessionID string, page, perPage int) ([]AgentMessageResponse, error) {
	if s.q == nil {
		return nil, pkgerrors.Internal("agent store unavailable")
	}
	if page < 1 {
		page = 1
	}
	if perPage < 1 || perPage > maxAgentMessagesPageSize {
		perPage = 50
	}
	offset := (page - 1) * perPage

	msgs, err := s.q.ListAgentMessages(ctx, db.ListAgentMessagesParams{
		SessionID:  sessionID,
		PageOffset: ClampInt32(offset),
		PageSize:   int32(perPage),
	})
	if err != nil {
		return nil, pkgerrors.Internal("list agent messages: " + err.Error())
	}

	result := make([]AgentMessageResponse, 0, len(msgs))
	for _, m := range msgs {
		parts, err := s.q.ListAgentMessageParts(ctx, m.ID)
		if err != nil {
			return nil, pkgerrors.Internal("list message parts: " + err.Error())
		}
		partResponses := make([]AgentPartResponse, 0, len(parts))
		for _, p := range parts {
			partResponses = append(partResponses, AgentPartResponse{
				PartIndex: p.PartIndex,
				Type:      p.PartType,
				Content:   p.Content,
			})
		}
		result = append(result, AgentMessageResponse{
			ID:        m.ID,
			SessionID: m.SessionID,
			Role:      m.Role,
			Sequence:  m.Sequence,
			Parts:     partResponses,
			CreatedAt: m.CreatedAt,
		})
	}
	return result, nil
}

// maxAgentReplayLimit bounds one SSE catch-up page, not the total replay.
const maxAgentReplayLimit = 1000

// ListMessagesAfterID returns messages with IDs greater than afterID for the
// given session. This is used by the SSE stream handler to replay missed events
// when a client reconnects with a Last-Event-ID header.
// The limit is clamped to maxAgentReplayLimit (1000); callers drain further pages.
func (s *AgentService) ListMessagesAfterID(ctx context.Context, sessionID string, afterID int64, limit int) ([]AgentMessageResponse, error) {
	if s.q == nil {
		return nil, pkgerrors.Internal("agent store not configured")
	}
	if limit < 1 || limit > maxAgentReplayLimit {
		limit = maxAgentReplayLimit
	}
	msgs, err := s.q.ListAgentMessagesAfterID(ctx, db.ListAgentMessagesAfterIDParams{
		SessionID:  sessionID,
		AfterID:    afterID,
		MaxResults: int32(limit),
	})
	if err != nil {
		return nil, pkgerrors.Internal("list agent messages after ID: " + err.Error())
	}
	result := make([]AgentMessageResponse, 0, len(msgs))
	for _, m := range msgs {
		parts, err := s.q.ListAgentMessageParts(ctx, m.ID)
		if err != nil {
			return nil, pkgerrors.Internal("list message parts: " + err.Error())
		}
		partResponses := make([]AgentPartResponse, 0, len(parts))
		for _, p := range parts {
			partResponses = append(partResponses, AgentPartResponse{
				PartIndex: p.PartIndex,
				Type:      p.PartType,
				Content:   p.Content,
			})
		}
		result = append(result, AgentMessageResponse{
			ID:        m.ID,
			SessionID: m.SessionID,
			Role:      m.Role,
			Sequence:  m.Sequence,
			Parts:     partResponses,
			CreatedAt: m.CreatedAt,
		})
	}
	return result, nil
}

// DispatchAgentRun creates the workflow infrastructure for an agent run and returns
// the workflow run ID, task ID, and a freshly generated agent token. The token is
// stored as a SHA-256 hash in workflow_runs.agent_token_hash.
// EnsureSessionDispatchable returns a Conflict error when the session already
// has an active (queued or running) workflow run. Dispatching a second run
// would re-point agent_sessions.workflow_run_id, revoking the still-running
// agent's callback token (401-locking it) and leaking its VM.
func (s *AgentService) EnsureSessionDispatchable(ctx context.Context, sessionID string) error {
	if s.q == nil || s.dispatchQ == nil {
		return pkgerrors.Internal("agent store unavailable")
	}
	runID, err := s.q.GetAgentSessionWorkflowRunID(ctx, sessionID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("agent session not found")
		}
		return pkgerrors.Internal("load agent session workflow run: " + err.Error())
	}
	if !runID.Valid {
		return nil
	}
	run, err := s.dispatchQ.GetWorkflowRunByRunID(ctx, runID.Int64)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return pkgerrors.Internal("load workflow run: " + err.Error())
	}
	switch run.Status {
	case "queued", "running":
		return pkgerrors.Conflict("agent session already has an active run")
	}
	return nil
}

func (s *AgentService) DispatchAgentRun(ctx context.Context, input DispatchAgentRunInput) (DispatchAgentRunResult, error) {
	d := &agentDispatch{
		svc:   s,
		ctx:   ctx,
		input: input,
	}
	return d.execute()
}

// DispatchLandingAuthorTurn resumes the session that authored a landing
// request, appends reviewer feedback to its transcript, and launches the same
// agent-run path used by an interactive user message.
func (s *AgentService) DispatchLandingAuthorTurn(ctx context.Context, input LandingAgentTurnDispatchInput) error {
	if s == nil || s.q == nil {
		return pkgerrors.Internal("agent store unavailable")
	}
	turnQueries, ok := s.q.(agentTurnQuerier)
	if !ok {
		return pkgerrors.Internal("agent turn store unavailable")
	}
	session, err := turnQueries.PrepareAgentSessionForTurn(ctx, input.SessionID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Conflict("agent author session already has an active run or is unavailable")
		}
		return pkgerrors.Internal("prepare agent author session: " + err.Error())
	}
	if session.RepositoryID != input.RepositoryID || session.UserID != input.UserID {
		return pkgerrors.Forbidden("agent author session does not belong to the landing request")
	}

	prompt := fmt.Sprintf("A reviewer returned landing request #%d to you. Address all open review comments and requested changes, then push the resulting revision.", input.Number)
	if feedback := strings.TrimSpace(input.Feedback); feedback != "" {
		prompt += "\n\nLatest feedback:\n" + feedback
	}
	content, err := json.Marshal(prompt)
	if err != nil {
		return pkgerrors.Internal("encode landing feedback: " + err.Error())
	}
	message, err := s.AppendMessage(ctx, input.SessionID, "user", []db.CreateAgentPartParams{{
		PartType: "text",
		Content:  content,
	}})
	if err != nil {
		return err
	}

	dispatchCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Minute)
	SafeGo("landing-author-turn-dispatch", func() {
		defer cancel()
		_, dispatchErr := s.DispatchAgentRun(dispatchCtx, DispatchAgentRunInput{
			SessionID:        input.SessionID,
			RepositoryID:     input.RepositoryID,
			UserID:           input.UserID,
			TriggerMessageID: message.ID,
			RepoOwner:        input.RepoOwner,
			RepoName:         input.RepoName,
		})
		if dispatchErr != nil {
			slog.Error("landing author turn agent dispatch failed",
				"landing_number", input.Number,
				"agent_session_id", input.SessionID,
				"error", dispatchErr)
		}
	})
	return nil
}

func sandboxSystemdInternalError(err error) bool {
	var statusErr *sandbox.StatusError
	return stdErrors.As(err, &statusErr) &&
		statusErr.StatusCode == 500 &&
		strings.EqualFold(strings.TrimSpace(statusErr.ErrorCode), "INTERNAL_ERROR")
}

// validIngestEventTypes defines the allowed event types for IngestRunnerEvent.
var validIngestEventTypes = map[string]bool{
	"text":        true,
	"tool_call":   true,
	"tool_result": true,
	"done":        true,
}

// IngestRunnerEvent processes an event from the runner, appending it as a message
// to the agent session. For "done" events, it also updates the session status.
func (s *AgentService) IngestRunnerEvent(ctx context.Context, input IngestRunnerEventInput) error {
	if !validIngestEventTypes[input.EventType] {
		return pkgerrors.BadRequest("invalid event type: " + input.EventType)
	}

	// All event types produce an assistant message
	role := "assistant"

	// Determine part type based on event type
	partType := input.EventType

	_, err := s.AppendMessage(ctx, input.SessionID, role, []db.CreateAgentPartParams{
		{
			PartType: partType,
			Content:  input.Content,
		},
	})
	if err != nil {
		return err
	}

	// Handle "done" events: update session status
	if input.EventType == "done" {
		if s.dispatchQ == nil {
			return pkgerrors.Internal("agent dispatch querier unavailable")
		}
		s.cancelAgentRuntimeWatchdog(input.SessionID)

		// Determine final status: "completed" normally, "failed" if content indicates error
		finalStatus := "completed"
		if isDoneWithError(input.Content) {
			finalStatus = "failed"
		}

		session, updated, err := s.transitionAgentSessionTerminalStatus(ctx, input.SessionID, finalStatus, pgtype.Int8{})
		if err != nil {
			return pkgerrors.Internal("update session status: " + err.Error())
		}
		if !updated {
			return nil
		}

		s.finalizeAgentSession(ctx, session, finalStatus, agentDoneErrorMessage(input.Content))
	}

	return nil
}

func (s *AgentService) markAgentDispatchInfrastructureFailed(ctx context.Context, taskID, stepID, workflowRunID int64, sessionID, message string) {
	if s.dispatchQ != nil {
		run, runErr := s.dispatchQ.GetWorkflowRunByRunID(ctx, workflowRunID)
		if runErr != nil && !stdErrors.Is(runErr, pgx.ErrNoRows) {
			middleware.LoggerWithAgentSessionAndWorkflowRun(ctx, sessionID, workflowRunID).
				Warn("failed to load workflow run before terminal metric update", "error", runErr)
		}
		if taskID != 0 {
			_, _ = s.dispatchQ.MarkWorkflowTaskTerminalByID(ctx, db.MarkWorkflowTaskTerminalByIDParams{
				ID:     taskID,
				Status: "failed",
				LastError: pgtype.Text{
					String: message,
					Valid:  strings.TrimSpace(message) != "",
				},
			})
		}
		_, _ = s.dispatchQ.UpdateWorkflowStepStatusTerminal(ctx, db.UpdateWorkflowStepStatusTerminalParams{
			StepID: stepID,
			Status: "failure",
		})
		if taskID == 0 {
			// A taskless run cannot be advanced through task-derived status updates.
			if failErr := s.dispatchQ.FailWorkflowRun(ctx, workflowRunID); failErr != nil {
				middleware.LoggerWithAgentSessionAndWorkflowRun(ctx, sessionID, workflowRunID).
					Warn("failed to mark taskless workflow run failed", "error", failErr)
			} else if runErr == nil {
				ObserveWorkflowRunCompletion(s.workflowMetrics, run, "failure")
			}
		} else {
			status, statusErr := s.dispatchQ.UpdateWorkflowRunStatusBasedOnTasks(ctx, workflowRunID)
			if statusErr == nil && runErr == nil {
				ObserveWorkflowRunCompletion(s.workflowMetrics, run, status)
			}
		}
		NotifyWorkflowRunEvent(ctx, s.dispatchQ, workflowRunID, "agent.infrastructure_failed")
		// A losing dispatch already minted its callback token before claiming
		// the session. Revoke that run's token even when it never owned the
		// session, or a newer run has claimed it before cleanup arrives.
		s.revokeAgentSessionToken(ctx, pgtype.Int8{Int64: workflowRunID, Valid: true})
	}
	if s.dispatchQ != nil && strings.TrimSpace(sessionID) != "" {
		s.cancelAgentRuntimeWatchdogForRun(sessionID, workflowRunID)
		session, updated, err := s.transitionAgentSessionTerminalStatus(ctx, sessionID, "failed", pgtype.Int8{Int64: workflowRunID, Valid: true})
		if err == nil && updated {
			s.observeAgentSessionCompletion("failed")
			s.archiveAgentTranscript(ctx, session, "failed")
			s.revokeAgentSessionJJHubToken(ctx, session.UserID, session.WorkflowRunID)
		}
	}
}

func agentTerminalWorkflowStatuses(sessionStatus string) (taskStatus string, stepStatus string) {
	switch strings.TrimSpace(sessionStatus) {
	case "completed":
		return "done", "success"
	case "cancelled":
		return "cancelled", "cancelled"
	default:
		return "failed", "failure"
	}
}

func agentDoneErrorMessage(content json.RawMessage) string {
	if len(content) == 0 {
		return ""
	}

	var parsed map[string]any
	if err := json.Unmarshal(content, &parsed); err != nil {
		return ""
	}

	if errorText, ok := parsed["error"].(string); ok {
		return strings.TrimSpace(errorText)
	}
	return ""
}

func serializeAgentTaskMessageHistory(messages []AgentMessageResponse) []agentTaskPayloadMessage {
	if len(messages) == 0 {
		return []agentTaskPayloadMessage{}
	}

	history := make([]agentTaskPayloadMessage, 0, len(messages))
	for _, message := range messages {
		history = append(history, agentTaskPayloadMessage{
			Role:    message.Role,
			Content: renderAgentTaskMessageContent(message.Parts),
		})
	}
	return history
}

func renderAgentTaskMessageContent(parts []AgentPartResponse) string {
	if len(parts) == 0 {
		return ""
	}

	rendered := make([]string, 0, len(parts))
	for _, part := range parts {
		text := strings.TrimSpace(renderAgentTaskPartContent(part.Content))
		if text != "" {
			rendered = append(rendered, text)
		}
	}
	return strings.Join(rendered, "\n")
}

func renderAgentTaskPartContent(content any) string {
	switch value := content.(type) {
	case nil:
		return ""
	case json.RawMessage:
		return renderAgentTaskJSONContent(value)
	case []byte:
		return renderAgentTaskJSONContent(value)
	case string:
		return value
	case map[string]any:
		if text, ok := value["value"].(string); ok {
			return text
		}
		if text, ok := value["output"].(string); ok {
			return text
		}
	}

	raw, err := json.Marshal(content)
	if err != nil {
		return fmt.Sprint(content)
	}
	return string(raw)
}

func renderAgentTaskJSONContent(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}

	var decoded any
	if err := json.Unmarshal(raw, &decoded); err == nil {
		return renderAgentTaskPartContent(decoded)
	}
	return string(raw)
}

func (s *AgentService) injectAgentRepoSecrets(ctx context.Context, repositoryID int64, env map[string]string) error {
	if s == nil || repositoryID <= 0 || env == nil {
		return nil
	}

	if s.secretInjector != nil {
		injectedEnv, err := s.secretInjector.InjectRepositoryEnvironment(ctx, repositoryID, env)
		if err != nil {
			return err
		}
		for name, value := range injectedEnv {
			env[name] = value
		}
		return nil
	}

	if s.secretService == nil {
		return nil
	}

	secrets, err := s.secretService.ListDecryptedSecretsForRepo(ctx, repositoryID)
	if err != nil {
		return err
	}

	for name, value := range secrets {
		if _, reserved := env[name]; reserved {
			continue
		}
		env[name] = value
	}

	return nil
}

func (s *AgentService) startAgentRuntimeWatchdog(sessionID, vmID string, workflowRunID, userID int64) {
	if s == nil || s.sandbox == nil || strings.TrimSpace(sessionID) == "" || strings.TrimSpace(vmID) == "" {
		return
	}
	if s.sandboxConfig.MaxRuntime <= 0 {
		return
	}

	watchdogCtx, cancel := context.WithCancel(context.Background())
	watchdog := &agentRuntimeWatchdog{cancel: cancel, workflowRunID: workflowRunID}

	s.watchdogsMu.Lock()
	if s.watchdogs == nil {
		s.watchdogs = make(map[string]*agentRuntimeWatchdog)
	}
	previous := s.watchdogs[sessionID]
	s.watchdogs[sessionID] = watchdog
	s.watchdogsMu.Unlock()

	if previous != nil {
		previous.cancel()
	}

	maxRuntime := s.sandboxConfig.MaxRuntime
	go func() {
		timer := time.NewTimer(maxRuntime)
		defer timer.Stop()

		select {
		case <-timer.C:
			s.clearAgentRuntimeWatchdog(sessionID, watchdog)

			deleteCtx, cancelDelete := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancelDelete()

			// The watchdog deletes the VM but does NOT finalize the session, so
			// revoke the per-run jjhub API token here too or it would stay live
			// until its TTL. Best-effort on a detached context.
			s.revokeAgentSessionJJHubToken(deleteCtx, userID, pgtype.Int8{Int64: workflowRunID, Valid: workflowRunID > 0})
			logger := middleware.LoggerWithAgentSessionAndWorkflowRun(context.Background(), sessionID, workflowRunID)
			// RFD-004: a run executing in a workspace is suspended, never
			// deleted; the computer stays for the human to inspect.
			if workspaceID := s.agentSessionWorkspaceID(deleteCtx, sessionID); workspaceID != "" {
				if err := s.workspaces.SuspendAgentWorkspace(deleteCtx, workspaceID); err != nil {
					logger.Error("agent runtime watchdog failed to suspend workspace", "workspace_id", workspaceID, "error", err)
					return
				}
				logger.Warn("agent runtime watchdog suspended workspace after max runtime",
					"workspace_id", workspaceID, "max_runtime_seconds", int64(maxRuntime.Seconds()))
				return
			}

			err := s.sandbox.DeleteSandbox(deleteCtx, vmID)
			if err != nil && !isSandboxNotFound(err) {
				logger.Error("agent runtime watchdog failed to delete sandbox", "vm_id", vmID, "type", "agent", "error", err)
				return
			}
			if err != nil {
				logger.Warn("agent runtime watchdog found sandbox already absent", "vm_id", vmID, "type", "agent")
				return
			}

			logger.Warn(
				"agent runtime watchdog deleted sandbox after max runtime",
				"vm_id", vmID,
				"type", "agent",
				"max_runtime_seconds", int64(maxRuntime.Seconds()),
			)
		case <-watchdogCtx.Done():
			s.clearAgentRuntimeWatchdog(sessionID, watchdog)
		}
	}()
}

func (s *AgentService) cancelAgentRuntimeWatchdog(sessionID string) {
	if s == nil || strings.TrimSpace(sessionID) == "" {
		return
	}

	s.watchdogsMu.Lock()
	if s.watchdogs == nil {
		s.watchdogsMu.Unlock()
		return
	}
	watchdog := s.watchdogs[sessionID]
	delete(s.watchdogs, sessionID)
	s.watchdogsMu.Unlock()

	if watchdog != nil {
		watchdog.cancel()
	}
}

// A terminal projection can finish after a replacement turn has installed its
// watchdog under the same session ID. Only cancel the watchdog for this run.
func (s *AgentService) cancelAgentRuntimeWatchdogForRun(sessionID string, workflowRunID int64) {
	if s == nil || strings.TrimSpace(sessionID) == "" || workflowRunID <= 0 {
		return
	}
	s.watchdogsMu.Lock()
	watchdog := s.watchdogs[sessionID]
	if watchdog != nil && watchdog.workflowRunID == workflowRunID {
		delete(s.watchdogs, sessionID)
	} else {
		watchdog = nil
	}
	s.watchdogsMu.Unlock()
	if watchdog != nil {
		watchdog.cancel()
	}
}

func (s *AgentService) clearAgentRuntimeWatchdog(sessionID string, expected *agentRuntimeWatchdog) {
	if s == nil || strings.TrimSpace(sessionID) == "" || expected == nil {
		return
	}

	s.watchdogsMu.Lock()
	defer s.watchdogsMu.Unlock()
	if current := s.watchdogs[sessionID]; current == expected {
		delete(s.watchdogs, sessionID)
	}
}

// isDoneWithError checks if a "done" event's content indicates an error.
// It looks for an "error" field in the JSON content.
func isDoneWithError(content json.RawMessage) bool {
	if len(content) == 0 {
		return false
	}
	var parsed map[string]any
	if err := json.Unmarshal(content, &parsed); err != nil {
		return false
	}
	_, hasError := parsed["error"]
	return hasError
}

// generateAgentToken generates a cryptographically random agent token.
// Returns the plaintext token (smithers_agent_ + 40 hex chars), its SHA-256 hash
// as hex, and any error from the random source.
func generateAgentToken() (plaintext string, hash string, err error) {
	randomBytes := make([]byte, 20)
	if _, err := agentRandRead(randomBytes); err != nil {
		return "", "", err
	}

	hexPart := hex.EncodeToString(randomBytes)
	plaintext = "smithers_agent_" + hexPart

	sum := sha256.Sum256([]byte(plaintext))
	hash = hex.EncodeToString(sum[:])

	return plaintext, hash, nil
}

// CancelSession uses the same terminal transition and finalization as user deletion,
// preserving the session row for history and rejecting a concurrent terminal transition.
func (s *AgentService) CancelSession(ctx context.Context, sessionID string, userID int64, reason string) error {
	if s.q == nil || s.dispatchQ == nil {
		return pkgerrors.Internal("agent store unavailable")
	}
	session, err := s.q.GetAgentSession(ctx, sessionID)
	if err != nil {
		return ResourceStoreError(err, "agent session")
	}
	if session.UserID != userID {
		return pkgerrors.Forbidden("you do not own this agent session")
	}
	if session.Status != "active" {
		return pkgerrors.Conflict("agent session is not active")
	}
	cancelled, err := s.cancelAgentFlowRun(ctx, session)
	if err != nil {
		return pkgerrors.Internal("cancel canonical agent Flow run").WithCause(err)
	}
	if cancelled {
		// Product state stays active until the canonical runtime receipt
		// projector observes actual cancellation.
		return nil
	}
	terminal, updated, err := s.transitionAgentSessionTerminalStatus(ctx, sessionID, "cancelled", pgtype.Int8{})
	if err != nil {
		return pkgerrors.Internal("cancel agent session").WithCause(err)
	}
	if !updated {
		return pkgerrors.Conflict("agent session is not active")
	}
	if strings.TrimSpace(reason) == "" {
		reason = "agent session cancelled"
	}
	s.finalizeAgentSession(ctx, terminal, "cancelled", reason)
	return nil
}

// DeleteSession deletes an agent session owned by the given user. Deleting is
// a lifecycle operation: an active session is first transitioned to
// 'cancelled' and finalized (task/step/run terminalized, sandbox VM deleted,
// transcript archived, tokens revoked) before the row is tombstoned.
// The caller must have already verified the session belongs to the repository.
func (s *AgentService) DeleteSession(ctx context.Context, sessionID string, userID int64) error {
	if s.q == nil {
		return pkgerrors.Internal("agent store unavailable")
	}

	// Verify the session exists before attempting to delete.
	session, err := s.q.GetAgentSession(ctx, sessionID)
	if err != nil {
		return pkgerrors.NotFound("agent session not found")
	}

	// Verify the requesting user owns the session.
	if session.UserID != userID {
		return pkgerrors.Forbidden("you do not own this agent session")
	}

	// Stop any in-flight run BEFORE tombstoning: once deleted_at is set the
	// session becomes invisible to the reaper (ListStaleActiveSessions filters
	// deleted_at IS NULL) and to runner callbacks, so nothing else would tear
	// down the sandbox VM, terminalize the workflow task, or revoke the run's
	// tokens. transitionAgentSessionTerminalStatus only matches status='active'
	// rows, so already-terminal sessions skip finalize (it already ran).
	// The canonical Flow run is stopped first: finalize tears down product
	// state but never touches the durable Flow job, which would otherwise keep
	// editing the workspace for a session nobody can see.
	if session.Status == "active" {
		s.cancelAgentFlowRunBestEffort(ctx, session, "delete")
	}
	if s.dispatchQ != nil {
		terminal, updated, terr := s.transitionAgentSessionTerminalStatus(ctx, sessionID, "cancelled", pgtype.Int8{})
		if terr != nil {
			return pkgerrors.Internal("cancel agent session before delete: " + terr.Error())
		}
		if updated {
			s.finalizeAgentSession(ctx, terminal, "cancelled", "agent session deleted")
		}
	}

	if err := s.q.DeleteAgentSession(ctx, db.DeleteAgentSessionParams{
		ID:     sessionID,
		UserID: userID,
	}); err != nil {
		return pkgerrors.Internal("delete agent session: " + err.Error())
	}

	return nil
}

func toAgentSessionResponse(s db.AgentSession) AgentSessionResponse {
	return AgentSessionResponse{
		ID:           s.ID,
		RepositoryID: s.RepositoryID,
		UserID:       s.UserID,
		Title:        s.Title,
		Status:       s.Status,
		CreatedAt:    s.CreatedAt,
		UpdatedAt:    s.UpdatedAt,
		Metadata:     s.Metadata,
		WorkspaceID:  UUIDString(s.WorkspaceID),
	}
}

func toAgentSessionWithCountResponse(s db.GetAgentSessionWithMessageCountRow) AgentSessionResponse {
	return AgentSessionResponse{
		ID:           s.ID,
		RepositoryID: s.RepositoryID,
		UserID:       s.UserID,
		Title:        s.Title,
		Status:       s.Status,
		MessageCount: s.MessageCount,
		CreatedAt:    s.CreatedAt,
		UpdatedAt:    s.UpdatedAt,
		Metadata:     s.Metadata,
		WorkspaceID:  UUIDString(s.WorkspaceID),
	}
}

func toAgentSessionListResponse(s db.ListAgentSessionsByRepoWithMessageCountRow) AgentSessionResponse {
	return AgentSessionResponse{
		ID:           s.ID,
		RepositoryID: s.RepositoryID,
		UserID:       s.UserID,
		Title:        s.Title,
		Status:       s.Status,
		MessageCount: s.MessageCount,
		CreatedAt:    s.CreatedAt,
		UpdatedAt:    s.UpdatedAt,
		Metadata:     s.Metadata,
		WorkspaceID:  UUIDString(s.WorkspaceID),
	}
}
