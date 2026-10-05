// Package ports defines the small set of dependencies that differ between a
// single-owner installation and a clustered deployment. Product policy, SQL,
// HTTP handlers, job admission, and Flow semantics are not deployment ports.
package ports

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/workspace"
)

var ErrModelCredentialMissing = errors.New("model credential is missing")

// ErrModelRequestInvalid identifies a model stream request rejected before provider execution.
var ErrModelRequestInvalid = errors.New("model stream request is invalid")

// PlatformModelKeys supplies the provider keys the deployment pays for. Keys
// are resolved per call by the metered model proxy and never cached, logged
// or placed in a guest. Nil offers no platform models.
type PlatformModelKeys = modelproxy.Keys

const RecommendationModelID = "typesafe-ai/jev"

// RecommendationCommand is one command the client offered to the decision
// model. The model may only return names from this set.
type RecommendationCommand struct {
	Name    string `json:"name"`
	Summary string `json:"summary"`
}

type RecommendationTailMessage struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

type RecommendationRequest struct {
	Repo     *string                     `json:"repo"`
	Tail     []RecommendationTailMessage `json:"tail"`
	Commands []RecommendationCommand     `json:"commands"`
	Model    json.RawMessage             `json:"model,omitempty"`
}

type RecommendationResult struct {
	Commands []string `json:"commands"`
	Model    string   `json:"model"`
	// Usage is the token count the model reported, nil when it reported
	// none. The route meters it; it never reaches the client.
	Usage *RecommendationUsage `json:"-"`
}

// RecommendationUsage is what one decision-model call reported.
type RecommendationUsage struct {
	InputTokens  int64
	OutputTokens int64
}

// CommandSelectionRequest asks the decision model which offered commands a
// user message asks the app to run or asks about.
type CommandSelectionRequest struct {
	Message  string                      `json:"message"`
	Tail     []RecommendationTailMessage `json:"tail"`
	Repo     *string                     `json:"repo"`
	Commands []RecommendationCommand     `json:"commands"`
}

// SelectedCommand is one offered command with the probability the decision
// model gave it.
type SelectedCommand struct {
	Name        string  `json:"name"`
	Probability float64 `json:"probability"`
}

// CommandSelectionResult lists the selected commands by probability,
// highest first. An empty list means the message concerns no command.
type CommandSelectionResult struct {
	Commands []SelectedCommand
	Model    string
	// Usage is the token count the model reported, nil when it reported
	// none. The route meters it; it never reaches the client.
	Usage *RecommendationUsage
}

const (
	// CommandSelectionMinProbability is the lowest probability a selected
	// command may carry.
	CommandSelectionMinProbability = 0.02
	// CommandSelectionMax caps the selected commands.
	CommandSelectionMax = 12
)

// Recommender is the deployment-provided decision model. It recommends the
// next commands for a conversation and selects the commands a message asks
// for. Implementations own provider credentials; the HTTP route only supplies
// bounded product input.
type Recommender interface {
	Recommend(context.Context, RecommendationRequest) (RecommendationResult, error)
	SelectCommands(context.Context, CommandSelectionRequest) (CommandSelectionResult, error)
}

// RecommendationLog persists the receipt that pairs a recommendation with
// the next command the user runs.
type RecommendationLog interface {
	AppendRecommendation(context.Context, RecommendationRequest, RecommendationResult, string) (string, error)
	RecordRecommendationOutcome(context.Context, string, string, time.Time) (int, error)
}

// ModelStreamHost runs a sealed, non-tool model request in the same owner
// scoped model host used by durable chat turns.
type ModelStreamHost interface {
	RunModelStream(context.Context, ModelStreamGrant) (io.ReadCloser, error)
}

type ModelStreamGrant struct {
	OwnerID      int64
	RepositoryID int64
	Request      json.RawMessage
}

// RepositoryEndpointResolver chooses the storage/execution endpoint for a
// repository. The common repository client still owns its operation protocol;
// local installations resolve to their bundled repository service, while a
// cluster can route to a storage set. The returned URL must come from trusted
// configuration, never a user-controlled or mutable operation record.
type RepositoryEndpointResolver = repository.StorageSetResolver

// RepositoryPlacement maps a stable product repository ID to a deployment
// storage set. Plue owns its placement table; product repository rows do not.
type RepositoryPlacement = services.RepoPlacementLookup

// RepositoryProvisioning is the actual durable reservation contract consumed by
// repository creation, imports, and the common recovery worker.
type RepositoryProvisioning = services.RepositoryProvisioningStore

// BlobStore is the actual product blob contract consumed by the extracted
// services. The alias prevents a second storage model from drifting away from
// the routes and artifact/LFS semantics. The local adapter implements signed
// transfer URLs through authenticated application routes; cloud adapters can
// use provider-signed URLs. Callers import this public alias, never internal.
type BlobStore = blob.Store

// ObjectAttrs and SignedUpload are the value types in the shared blob
// contract. Re-exporting them lets an external deployment implement BlobStore
// and its optional capabilities without importing an internal Go package.
type ObjectAttrs = blob.ObjectAttrs
type SignedUpload = blob.SignedUpload
type CreateOnlyUploadSigner = blob.CreateOnlyUploadSigner
type CreateOnlyPromoter = blob.CreateOnlyPromoter
type GenerationPurger = blob.GenerationPurger
type Putter = blob.Putter

const UnknownObjectSize = blob.UnknownObjectSize

var ErrObjectNotFound = blob.ErrObjectNotFound
var ErrObjectAlreadyExists = blob.ErrObjectAlreadyExists

// AgentLogStore persists archived session transcripts through the same
// deployment-owned storage boundary.
type AgentLogStore = services.AgentLogStore

// Workspace aliases keep the common runtime contract independent of composition.
type IsolationLevel = workspace.IsolationLevel

const (
	IsolationTrustedProcess   = workspace.IsolationTrustedProcess
	IsolationSandboxed        = workspace.IsolationSandboxed
	WorkspaceStarting         = workspace.WorkspaceStarting
	WorkspaceRunning          = workspace.WorkspaceRunning
	WorkspaceStopping         = workspace.WorkspaceStopping
	WorkspaceStopped          = workspace.WorkspaceStopped
	WorkspaceFailed           = workspace.WorkspaceFailed
	WorkspaceRecoveryRequired = workspace.WorkspaceRecoveryRequired
	ServiceRunning            = workspace.ServiceRunning
	ServiceExited             = workspace.ServiceExited
	ServiceStopped            = workspace.ServiceStopped
	ServiceFailed             = workspace.ServiceFailed
)

var (
	ErrWorkspaceNotFound           = workspace.ErrWorkspaceNotFound
	ErrWorkspaceStopped            = workspace.ErrWorkspaceStopped
	ErrManagedHostNotRunning       = workspace.ErrManagedHostNotRunning
	ErrManagedHostIdentityConflict = workspace.ErrManagedHostIdentityConflict
	ErrWorkspaceSourceUnavailable  = workspace.ErrWorkspaceSourceUnavailable
)

type Terminal = workspace.Terminal
type WorkspaceState = workspace.WorkspaceState
type WorkspaceCapabilities = workspace.WorkspaceCapabilities
type WorkspaceSpec = workspace.WorkspaceSpec
type Workspace = workspace.Workspace
type ColdSnapshot = workspace.ColdSnapshot
type ColdSnapshotSpec = workspace.ColdSnapshotSpec
type WorkspaceSnapshots = workspace.WorkspaceSnapshots
type Command = workspace.Command
type CommandResult = workspace.CommandResult
type ServiceSpec = workspace.ServiceSpec
type Service = workspace.Service
type ServiceState = workspace.ServiceState
type ServiceObservation = workspace.ServiceObservation
type PreviewTarget = workspace.PreviewTarget
type FileEntry = workspace.FileEntry
type WorkspaceLifecycle = workspace.WorkspaceLifecycle
type WorkspaceExecution = workspace.WorkspaceExecution
type WorkspaceTerminal = workspace.WorkspaceTerminal
type WorkspacePreview = workspace.WorkspacePreview
type WorkspaceFiles = workspace.WorkspaceFiles
type WorkspaceRuntime = workspace.WorkspaceRuntime
type WorkspaceOperation = workspace.Operation
type IsolationGuarantees = workspace.IsolationGuarantees
type WorkspaceIsolationGuarantees = workspace.IsolationGuarantees
type WorkspaceIsolationReporter = workspace.IsolationReporter
type WorkspacePortPurpose = workspace.PortPurpose
type WorkspacePortRequest = workspace.PortRequest
type WorkspacePortDialer = workspace.PortDialer
type RoutedPreviewSpec = workspace.RoutedPreviewSpec
type RoutedPreview = workspace.RoutedPreview
type WorkspaceRoutedPreview = workspace.RoutedPreviewPublisher
type WorkspaceServiceCatalog = workspace.WorkspaceServiceCatalog
type WorkspaceNamedServiceController = workspace.WorkspaceNamedServiceController
type ManagedHostIdentity = workspace.ManagedHostIdentity
type ManagedHostConnection = workspace.ManagedHostConnection
type ManagedHostPlacement = workspace.ManagedHostPlacement
type ManagedHostBuilder = workspace.ManagedHostBuilder
type ManagedHostBuilderFunc = workspace.ManagedHostBuilderFunc
type ManagedHostProbe = workspace.ManagedHostProbe
type ManagedHostProbeFunc = workspace.ManagedHostProbeFunc
type ManagedHostSpec = workspace.ManagedHostSpec
type WorkspaceManagedHosts = workspace.WorkspaceManagedHosts
type WorkspaceSourceRevisionResolver = workspace.WorkspaceSourceRevisionResolver

const WorkspacePortPurposeFlowRuntime = workspace.PortPurposeFlowRuntime

var WithWorkspaceOperation = workspace.WithOperation
var WorkspaceOperationFromContext = workspace.OperationFromContext

// ChatTurnGrant authorizes one trusted TypeScript host generation to produce
// frames for one already-admitted turn. Token is an opaque short-lived
// capability and Request contains no resolved provider credential value.
type ChatTurnCursor struct {
	Version  int    `json:"version"`
	RunID    string `json:"runId"`
	LegID    string `json:"legId"`
	Batch    int64  `json:"batch"`
	Position int64  `json:"position"`
	Hash     string `json:"hash"`
}

type ChatTurnGrant struct {
	TurnID          string          `json:"turnId"`
	OwnerID         int64           `json:"ownerId"`
	RepositoryID    int64           `json:"repositoryId,omitempty"`
	RunID           string          `json:"runId"`
	LegID           string          `json:"legId"`
	Generation      int64           `json:"generation"`
	Token           string          `json:"token"`
	Cursor          ChatTurnCursor  `json:"cursor"`
	ExpiresAt       time.Time       `json:"expiresAt"`
	Request         json.RawMessage `json:"request"`
	ProducerBaseURL string          `json:"producerBaseUrl"`
	// Source is present only when the turn's author can read a mirrored
	// main; the model host offers its source read tool only then.
	Source *ChatTurnSource `json:"source,omitempty"`
	// API is present only when the credential that admitted the turn is its
	// author's browser session now; the model host offers the commands that
	// read the install's API only then.
	API *ChatTurnAPI `json:"api,omitempty"`
}

// ChatTurnSource names the mirrored repository, as owner/name, that an
// app-agent turn reads through the producer's source read callback.
type ChatTurnSource struct {
	Repository string `json:"repository"`
}

// ChatTurnAPI names the person an app-agent turn's commands read the
// install's API as, by the login their private cards are addressed to.
type ChatTurnAPI struct {
	Author string `json:"author"`
}

// ChatAPIAnswer is one install route's answer to a host-run command.
type ChatAPIAnswer = services.APIAnswer

// Install API call refusals, stated by the producer's API callback.
var (
	ErrAPIForbidden   = services.ErrAPIForbidden
	ErrAPICallRefused = services.ErrAPICallRefused
)

// SourceFile is one file an app-agent turn read from its repository's
// mirrored main.
type SourceFile = services.SourceFile

// SourceDirectory is one directory an app-agent turn listed on its
// repository's mirrored main.
type SourceDirectory = services.SourceDirectory

// SourceEntry is one entry of a listed directory: a file or a directory.
type SourceEntry = services.SourceEntry

// Source read refusals. A turn's host states each one to the model and the
// conversation; none is retried by the host.
var (
	ErrSourceNotReady    = services.ErrSourceNotReady
	ErrSourcePathRefused = services.ErrSourcePathRefused
	ErrSourceForbidden   = services.ErrSourceForbidden
	ErrSourceNotFound    = services.ErrSourceNotFound
	ErrSourceTooLarge    = services.ErrSourceTooLarge
)

// ChatHost runs the canonical TypeScript model runtime. Go owns admission and
// receipts; adapters differ only in where this same packaged host runs.
type ChatHost interface {
	RunChatTurn(ctx context.Context, grant ChatTurnGrant) error
}
