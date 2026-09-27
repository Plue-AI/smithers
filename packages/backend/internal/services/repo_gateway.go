package services

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/previewgateway"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// Repo gateway: a box's coding host, running as a service inside the box's
// micro-VM and reached over sandbox provider HTTPS ingress (external 443 ->
// in-VM 7331). Every gateway belongs to a box; there is no repository-level
// gateway (#2194).
//
// Token model (constrained by stock smithers): the gateway validates ONLY the
// exact operator token it was started with — a fixed in-memory map, no DB
// tokens, no RPC mint. Per-request ephemeral tokens (the SSH terminal model)
// would require restarting the gateway, killing live runs. The operator token
// is therefore minted once at provision time, injected into the VM systemd
// environment, and stored encrypted at rest (same AES-256-GCM codec that
// protects repository secrets) plus a SHA-256 hash for audit. The advertised
// expires_at is a client re-resolve cadence: callers must re-fetch after it
// passes because the VM (and with it the token) can be rotated at any time.
// Because the VM alone validates the token, permission revocation is enforced
// by the reaper's access-revocation sweep (sweepRevokedGateways), which tears
// down gateways whose user lost write access to the repository.
const (
	repoGatewayPort        = int32(7331)
	repoGatewayTokenPrefix = "smithers_gateway_"
	// repoGatewayTokenAdvertisedTTL bounds how long a caller may cache the
	// returned token before re-resolving. The token itself stays valid for
	// the lifetime of the gateway process; the TTL exists so clients pick up
	// VM rotation promptly.
	repoGatewayTokenAdvertisedTTL = time.Hour
	repoGatewayCleanupTimeout     = 30 * time.Second
	// repoGatewayHealthProbe* bound the resume-time liveness probe: after the
	// sandbox provider reports the VM running, the gateway process itself must
	// answer /health through the preview ingress (the relay's own upstream)
	// before the resolve path may answer status:"running". A resumed VM's
	// systemd unit takes seconds to bind, so the probe retries briefly; a VM
	// that never answers is wedged and must be discarded + reprovisioned
	// rather than 502-ing every relay call forever.
	repoGatewayHealthProbeAttempts = 15
	repoGatewayHealthProbeInterval = 4 * time.Second
	repoGatewayHealthProbeTimeout  = 5 * time.Second
	// repoGatewayWidowedIdleMax is how long a gateway row whose box VM is
	// stopped may sit past the idle-suspend contract before the reaper
	// discards the row, so the next resolve starts a fresh host.
	repoGatewayWidowedIdleMax = 24 * time.Hour
	// repoGatewayProvisionResponseBudget bounds how long POST
	// /api/repos/{owner}/{repo}/gateway holds the connection before answering
	// 409 "still provisioning". Starting a box's host can take minutes, and no
	// real client holds a connection that long: production measured a
	// Cloudflare-fronted provision answered 504 after 1m9s while a direct one
	// took 1m15s to return 200. Answer inside every client's patience instead,
	// and let the caller poll the 409 (the documented client taxonomy).
	repoGatewayProvisionResponseBudget = 12 * time.Second
	// repoGatewayProvisionBackgroundBudget bounds the detached provisioning
	// work itself. It must stay comfortably under repoGatewayStaleProvisionAge
	// so a wedged provision is reaped rather than holding the active slot.
	repoGatewayProvisionBackgroundBudget = 20 * time.Minute
)

// RepoGatewayQuerier is the DB contract needed by RepoGatewayService.
type RepoGatewayQuerier interface {
	CreateRepoGateway(ctx context.Context, arg runtimeports.CreateRepoGatewayParams) (runtimeports.RepoGateway, error)
	GetActiveRepoGatewayForUserRepo(ctx context.Context, arg runtimeports.GetActiveRepoGatewayForUserRepoParams) (runtimeports.RepoGateway, error)
	UpdateRepoGatewayExecutionInfo(ctx context.Context, arg runtimeports.UpdateRepoGatewayExecutionInfoParams) (runtimeports.RepoGateway, error)
	UpdateRepoGatewayStatus(ctx context.Context, arg runtimeports.UpdateRepoGatewayStatusParams) (runtimeports.RepoGateway, error)
	TouchRepoGatewayActivity(ctx context.Context, id string) error
	SoftDeleteRepoGateway(ctx context.Context, id string) (runtimeports.RepoGateway, error)
	// ListStaleRepoGateways backs the reaper: non-terminal rows older than the
	// given age whose provision is presumed crashed.
	ListStaleRepoGateways(ctx context.Context, ageSeconds int64) ([]runtimeports.RepoGateway, error)
	// ListActiveRepoGateways backs the widowed-gateway sweep: 'running' and
	// 'suspended' rows re-validated against the sandbox provider.
	ListActiveRepoGateways(ctx context.Context) ([]runtimeports.RepoGateway, error)

	// Short-lived repo clone token store (same flow as agent/workspace VMs).
	CreateAccessToken(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error)
	DeleteAccessToken(ctx context.Context, arg db.DeleteAccessTokenParams) error
}

type RepoGatewayRelayQuerier interface {
	GetRepoGatewayByID(ctx context.Context, id string) (runtimeports.RepoGateway, error)
}

// RepoGatewayRelayTarget is the authenticated, internal routing result used by
// the API relay. The public client never receives the controller/service URL.
type RepoGatewayRelayTarget struct {
	GatewayID string
	Domain    string
	// UserID and RepositoryID identify whose authorization the relay rides on,
	// so a revocation of either can end every connection the relay carries.
	UserID       int64
	RepositoryID int64
	WorkspaceID  string
	SandboxID    string
}

// AuthorizeRelay verifies the static operator token before any HTTP or
// WebSocket bytes are proxied to a repository gateway.
func (s *RepoGatewayService) AuthorizeRelay(ctx context.Context, gatewayID, token string) (RepoGatewayRelayTarget, error) {
	if s.q == nil || strings.TrimSpace(gatewayID) == "" || strings.TrimSpace(token) == "" {
		return RepoGatewayRelayTarget{}, pkgerrors.Unauthorized("invalid gateway credentials")
	}
	relayQ, ok := s.q.(RepoGatewayRelayQuerier)
	if !ok {
		return RepoGatewayRelayTarget{}, pkgerrors.Internal("repo gateway relay store unavailable")
	}
	gateway, err := relayQ.GetRepoGatewayByID(ctx, gatewayID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RepoGatewayRelayTarget{}, pkgerrors.Unauthorized("invalid gateway credentials")
		}
		return RepoGatewayRelayTarget{}, pkgerrors.Internal("load repo gateway: " + err.Error())
	}
	digest := sha256.Sum256([]byte(token))
	want, decodeErr := hex.DecodeString(gateway.AuthTokenHash)
	if decodeErr != nil || len(want) != len(digest) || subtle.ConstantTimeCompare(want, digest[:]) != 1 {
		return RepoGatewayRelayTarget{}, pkgerrors.Unauthorized("invalid gateway credentials")
	}
	if gateway.Status != "running" || strings.TrimSpace(gateway.VmID) == "" {
		return RepoGatewayRelayTarget{}, pkgerrors.Conflict("repo gateway is not running")
	}
	// A box-less row is a retired product gateway (#2194): it relays nothing
	// while the reaper removes it.
	if !gateway.WorkspaceID.Valid {
		return RepoGatewayRelayTarget{}, pkgerrors.Conflict("repo gateway is not running")
	}
	workspace, err := s.loadGatewayWorkspace(ctx, gateway.WorkspaceID.String(), gateway.RepositoryID, gateway.UserID)
	if err != nil {
		return RepoGatewayRelayTarget{}, err
	}
	if workspace.VmID != gateway.VmID || workspace.Status != "running" {
		return RepoGatewayRelayTarget{}, pkgerrors.Conflict("bound workspace is not running at the recorded VM")
	}
	_ = s.workspaces.q.TouchWorkspaceActivity(ctx, workspace.ID)
	_ = s.q.TouchRepoGatewayActivity(ctx, gateway.ID)
	return RepoGatewayRelayTarget{GatewayID: gateway.ID, Domain: gatewayIngressDomain(gateway), UserID: gateway.UserID, RepositoryID: gateway.RepositoryID, WorkspaceID: gatewayWorkspaceID(gateway), SandboxID: gateway.VmID}, nil
}

// RepoGatewayVMClient is the minimal sandbox provider surface for a box's
// coding host. It never creates or starts a VM: the box owns its VM, and
// DeleteSandbox only reclaims a retired repository-level gateway's VM.
type RepoGatewayVMClient interface {
	InspectSandbox(ctx context.Context, vmID string) (sandbox.Sandbox, error)
	DeleteSandbox(ctx context.Context, vmID string) error
	CreateService(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error)
	Execute(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error)
	PublishIngress(ctx context.Context, domain string, req sandbox.PublishIngressRequest) (sandbox.IngressRoute, error)
	RevokeIngress(ctx context.Context, domain string) error
}

// repoGatewayDomain returns the Plue-routed preview hostname for a sandbox.
func repoGatewayDomain(vmID string) string {
	label := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(vmID)), "_", "-")
	return "smithers-gw-" + label + ".preview.jjhub.tech"
}

// RepoGatewayAccessQuerier is the DB surface for the access-revocation sweep:
// list live gateway rows, load their repository, and re-resolve the user's
// current permission. *db.Queries implements it.
type RepoGatewayAccessQuerier interface {
	RepoPermQuerier
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	ListActiveRepoGateways(ctx context.Context) ([]runtimeports.RepoGateway, error)
}

// WithRepoGatewayAccessRevocation wires the periodic authorization sweep run
// by the reaper: every live gateway's user is re-checked against current
// repository permissions and gateways whose user lost write access are torn
// down. The gateway VM validates ONLY its static operator token (Smithers is
// not in the request path), so collaborator/team/org/repo permission
// revocation cannot reach an already-resolved token any other way — without
// this sweep a revoked writer keeps driving the gateway and its cloned checkout
// for the lifetime of the VM.
func WithRepoGatewayAccessRevocation(q RepoGatewayAccessQuerier) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) { s.accessQuerier = q }
}

// RepoGatewayConnectionInput identifies the repo + user asking for a gateway.
type RepoGatewayConnectionInput struct {
	RepositoryID        int64
	UserID              int64
	RepoOwner           string
	RepoName            string
	RepoDefaultBookmark string
	WorkspaceID         string
}

// RepoGatewayConnectionInfo is returned to the API caller. Token is plaintext
// in-memory for this response only.
type RepoGatewayConnectionInfo struct {
	BaseURL     string    `json:"base_url"`
	Token       string    `json:"token"`
	ExpiresAt   time.Time `json:"expires_at"`
	GatewayID   string    `json:"gateway_id"`
	VMID        string    `json:"vm_id"`
	Status      string    `json:"status"`
	WorkspaceID string    `json:"workspace_id,omitempty"`
}

// RepoGatewayService provisions and resumes the coding host of a box.
type RepoGatewayService struct {
	revocations revocation.Publisher
	q           RepoGatewayQuerier
	sandbox     RepoGatewayVMClient
	workspaces  *WorkspaceService
	secretCodec webhook.SecretCodec
	gitBaseURL  string
	// accessQuerier backs the reaper's access-revocation sweep (nil disables it).
	accessQuerier RepoGatewayAccessQuerier
	// healthProbeBaseURL enables the resume-time liveness probe when non-empty
	// (see repoGatewayHealthProbe*). Empty disables it for local dev, which has
	// no preview gateway.
	healthProbeBaseURL string
	healthProbeClient  *http.Client
	// previewRelayToken is presented to the preview gateway on every probe
	// and repository-job call (previewgateway.RelayTokenHeader): the gateway
	// refuses smithers-gw-* domains without it.
	previewRelayToken string
	// sleep is overridable in tests so probe retries don't cost wall-clock.
	sleep func(context.Context, time.Duration) error
	// provisionResponseBudget / provisionBackgroundBudget are overridable in
	// tests so the detached-provision path costs no wall-clock.
	provisionResponseBudget   time.Duration
	provisionBackgroundBudget time.Duration
	// resolveMu + resolveInflight singleflight the reuse/resume of an existing
	// gateway row, so a client polling the 409 does not start a fresh
	// multi-minute resume on every poll.
	resolveMu       sync.Mutex
	resolveInflight map[string]*repoGatewayResolve
}

// repoGatewayResolve is one in-flight reuse-or-replace of an existing gateway
// row. It carries the result to every caller that attached to it; `done` is
// closed once info/err are written, which is the happens-before edge they read
// through.
type repoGatewayResolve struct {
	done chan struct{}
	info RepoGatewayConnectionInfo
	err  error
}

// RepoGatewayServiceOption configures optional dependencies.
type RepoGatewayServiceOption func(*RepoGatewayService)

// WithRepoGatewaySandboxClient sets the sandbox provider VM client.
func WithRepoGatewaySandboxClient(client RepoGatewayVMClient) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) {
		s.sandbox = client
	}
}

// WithRepoGatewaySecretCodec sets the codec used to encrypt the gateway
// operator token at rest. Production wiring passes the same codec used for
// repository/webhook secrets.
func WithRepoGatewaySecretCodec(codec webhook.SecretCodec) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) {
		if codec != nil {
			s.secretCodec = codec
		}
	}
}

// WithRepoGatewayGitBaseURL sets the public base URL used to clone repos into
// gateway VMs.
func WithRepoGatewayGitBaseURL(url string) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) {
		s.gitBaseURL = strings.TrimSpace(url)
	}
}

// WithRepoGatewayHealthProbe enables the resume-time liveness probe against
// {baseURL}/__preview/{gateway-domain}/health (the relay's own upstream path).
// An empty baseURL disables the probe. A nil client gets a bounded default.
func WithRepoGatewayHealthProbe(baseURL string, client *http.Client) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) {
		s.healthProbeBaseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
		if client != nil {
			s.healthProbeClient = client
		}
	}
}

// WithPreviewRelayToken sets the credential the preview gateway demands for
// smithers-gw-* domains. Empty leaves every probe unauthenticated, which the
// gateway refuses with 401 (fail closed, and loud).
func WithPreviewRelayToken(token string) RepoGatewayServiceOption {
	return func(s *RepoGatewayService) { s.previewRelayToken = strings.TrimSpace(token) }
}

// setPreviewRelayToken stamps the relay credential on one preview gateway request.
func (s *RepoGatewayService) setPreviewRelayToken(req *http.Request) {
	if s.previewRelayToken != "" {
		req.Header.Set(previewgateway.RelayTokenHeader, s.previewRelayToken)
	}
}

// NewRepoGatewayService returns a new RepoGatewayService.
func NewRepoGatewayService(q RepoGatewayQuerier, opts ...RepoGatewayServiceOption) *RepoGatewayService {
	svc := &RepoGatewayService{
		q:                 q,
		secretCodec:       webhook.NoopSecretCodec{},
		healthProbeClient: &http.Client{Timeout: repoGatewayHealthProbeTimeout},

		provisionResponseBudget:   repoGatewayProvisionResponseBudget,
		provisionBackgroundBudget: repoGatewayProvisionBackgroundBudget,
		sleep: func(ctx context.Context, d time.Duration) error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(d):
				return nil
			}
		},
	}
	for _, opt := range opts {
		if opt != nil {
			opt(svc)
		}
	}
	return svc
}

// GetRepoGatewayConnectionInfo returns connection details for the repo's
// gateway, provisioning or resuming the backing sandbox provider VM as needed.
func (s *RepoGatewayService) GetRepoGatewayConnectionInfo(ctx context.Context, input RepoGatewayConnectionInput) (RepoGatewayConnectionInfo, error) {
	// Every gateway is a box's coding host; there is no repository-level
	// gateway to fall back to (#2194).
	if input.WorkspaceID == "" {
		return RepoGatewayConnectionInfo{}, pkgerrors.BadRequest("workspace_id is required: flows run on a box")
	}
	if s.q == nil {
		return RepoGatewayConnectionInfo{}, pkgerrors.Internal("repo gateway store unavailable")
	}
	if s.sandbox == nil {
		// Honest degradation: this deployment has no sandbox provider credentials,
		// so no gateway can exist. 409 (not 500) so clients can render a
		// "workflows not available on this deployment" state.
		return RepoGatewayConnectionInfo{}, pkgerrors.Conflict("gateway provisioning is not configured on this deployment")
	}
	return s.getWorkspaceGateway(ctx, input)
}

// resolveExistingGateway reuses an existing gateway row — resuming its VM and
// re-declaring the gateway service when the provider idle-suspended it — under
// the SAME response budget the provision path has had since the wave-11 wedge.
//
// The reuse path was the one half of this route left holding the caller's
// connection for as long as the work took: resuming the box, re-declaring its
// host service, and finally the health probe's attempt loop. Production measured the product's
// "Preparing your <repo> workspace…" standing past 120s with no run card and no
// error, and POST /api/workflow/provision timing out at 20s, on exactly this
// path (repro apps/ui/canary-repros/honesty/22.6 and flow-sweep/A.18).
//
// So run it on a context detached from request cancellation and answer 409
// "still resuming" once the response budget elapses — the documented client
// taxonomy the provision path already uses, which callers poll rather than
// stampede. The work is singleflighted per gateway row: without that, a client
// polling every two seconds would start a fresh four-minute resume per poll and
// the gateway could never converge.
func (s *RepoGatewayService) resolveExistingGateway(ctx context.Context, existing runtimeports.RepoGateway, input RepoGatewayConnectionInput) (RepoGatewayConnectionInfo, error) {
	resolve, started := s.beginGatewayResolve(existing.ID)
	if started {
		backgroundBudget := s.provisionBackgroundBudget
		if backgroundBudget <= 0 {
			backgroundBudget = repoGatewayProvisionBackgroundBudget
		}
		resolveCtx, cancelResolve := context.WithTimeout(context.WithoutCancel(ctx), backgroundBudget)
		go func() {
			defer cancelResolve()
			var info RepoGatewayConnectionInfo
			var reuseErr error = pkgerrors.Internal("repo gateway resolve failed")
			defer func() {
				// A panic must still fail this resolve and release the
				// singleflight entry, or every later caller for this gateway
				// joins a resolve that never completes.
				if r := recover(); r != nil {
					slog.Error("repo gateway resolve panicked", "gateway_id", existing.ID,
						"panic", r, "stack", string(debug.Stack()))
					info, reuseErr = RepoGatewayConnectionInfo{}, pkgerrors.Internal("repo gateway resolve failed")
				}
				resolve.info, resolve.err = info, reuseErr
				// Drop the entry BEFORE publishing, so a caller arriving after
				// this point starts a fresh resolve rather than adopting a
				// finished one.
				s.endGatewayResolve(existing.ID)
				close(resolve.done)
			}()
			info, reuseErr = s.reuseWorkspaceGateway(resolveCtx, existing)
			if errors.Is(reuseErr, errRepoGatewayUnrecoverable) {
				// The row cannot serve: its token is unrecoverable, its VM is
				// gone or stale-fenced, or it failed to resume. Tear it down
				// and provision a fresh one — here, on the detached context,
				// so the replacement converges even though the caller has
				// already been answered 409.
				s.discardGatewayAfterReuse(resolveCtx, existing)
				info, reuseErr = s.provisionWorkspaceGateway(resolveCtx, input)
			}
		}()
	}

	responseBudget := s.provisionResponseBudget
	if responseBudget <= 0 {
		responseBudget = repoGatewayProvisionResponseBudget
	}
	timer := time.NewTimer(responseBudget)
	defer timer.Stop()
	select {
	case <-resolve.done:
		return resolve.info, resolve.err
	case <-timer.C:
		return RepoGatewayConnectionInfo{}, repositoryWorkspacePending("repo gateway is still resuming")
	case <-ctx.Done():
		// The caller went away. The resume keeps running on the detached
		// context — a client hang-up must never abandon a half-resumed VM.
		return RepoGatewayConnectionInfo{}, repositoryWorkspacePending("repo gateway is still resuming")
	}
}

// beginGatewayResolve joins the in-flight resolve for a gateway row, or starts
// one. The second return reports whether this caller owns the work.
func (s *RepoGatewayService) beginGatewayResolve(gatewayID string) (*repoGatewayResolve, bool) {
	s.resolveMu.Lock()
	defer s.resolveMu.Unlock()
	if existing, ok := s.resolveInflight[gatewayID]; ok {
		return existing, false
	}
	if s.resolveInflight == nil {
		s.resolveInflight = make(map[string]*repoGatewayResolve)
	}
	resolve := &repoGatewayResolve{done: make(chan struct{})}
	s.resolveInflight[gatewayID] = resolve
	return resolve, true
}

func (s *RepoGatewayService) endGatewayResolve(gatewayID string) {
	s.resolveMu.Lock()
	defer s.resolveMu.Unlock()
	delete(s.resolveInflight, gatewayID)
}

// errRepoGatewayUnrecoverable marks an existing gateway row that cannot be
// reused — its operator token cannot be decrypted (codec/key rotation or row
// corruption), its sandbox provider VM no longer exists (404), the placement
// is stale-fenced at the worker (409 stale_generation — the worker will never
// drive that generation again), or the VM persistently fails to resume from
// its snapshot. In each case the caller discards the row and provisions fresh.
var errRepoGatewayUnrecoverable = errors.New("repo gateway unrecoverable")

// errRepoGatewayProbeIndeterminate marks a liveness probe that never reached
// the preview ingress at all — infrastructure said nothing about THIS gateway,
// so the row must be kept rather than discarded. Without the distinction a
// single ingress/netpol outage would tear down every gateway in the pool.
var errRepoGatewayProbeIndeterminate = errors.New("repo gateway liveness probe indeterminate")

// vmPlacementStale reports the sandbox provider's 409 stale_generation fencing
// answer: the worker holds (or holds no) state for a DIFFERENT placement
// generation, so the recorded one can never be inspected, resumed, or deleted
// through the controller again. Unlike a transport blip this is a definitive
// per-placement verdict, and unlike a 404 the inspect call does not map it to
// "gone" — without this classifier a stale-fenced gateway row answers
// status:"running" while every reuse 500s, the same wedge as a dead VM.
func vmPlacementStale(err error) bool {
	var statusErr *sandbox.StatusError
	if !errors.As(err, &statusErr) {
		return false
	}
	return statusErr.StatusCode == http.StatusConflict &&
		(statusErr.Code == "stale_generation" || statusErr.ErrorCode == "stale_generation")
}

// discardGatewayAfterReuse performs the destructive half of a failed resume
// with a bounded context that survives the request ending. A successful
// StartSandbox must never be allowed to leave its row active when the caller
// disconnects before service re-declaration finishes.
func (s *RepoGatewayService) discardGatewayAfterReuse(ctx context.Context, gateway runtimeports.RepoGateway) {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), repoGatewayCleanupTimeout)
	defer cancel()
	s.discardGateway(cleanupCtx, gateway)
}

func (s *RepoGatewayService) probeGatewayHealthChecked(ctx context.Context, vmID string, validate func(io.Reader) error) error {
	if s.healthProbeBaseURL == "" {
		return nil
	}
	probeURL := s.healthProbeBaseURL + "/__preview/" + repoGatewayDomain(vmID) + "/health"
	var lastErr error
	ingressAnswered := false
	for attempt := 0; attempt < repoGatewayHealthProbeAttempts; attempt++ {
		if attempt > 0 {
			if sleepErr := s.sleep(ctx, repoGatewayHealthProbeInterval); sleepErr != nil {
				return sleepErr
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, probeURL, nil)
		if err != nil {
			return err
		}
		s.setPreviewRelayToken(req)
		resp, err := s.healthProbeClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		ingressAnswered = true
		if resp.StatusCode == http.StatusOK && validate != nil {
			validationErr := validate(io.LimitReader(resp.Body, 8192))
			_ = resp.Body.Close()
			// A responding incompatible host is not a startup delay. Keep the
			// workspace and report the missing capability without 15 retries.
			return validationErr
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			return nil
		}
		lastErr = fmt.Errorf("gateway health probe answered %d", resp.StatusCode)
	}
	if !ingressAnswered {
		if lastErr == nil {
			lastErr = errors.New("gateway health probe exhausted attempts")
		}
		return fmt.Errorf("%w: %v", errRepoGatewayProbeIndeterminate, lastErr)
	}
	if lastErr == nil {
		lastErr = errors.New("gateway health probe exhausted attempts")
	}
	return lastErr
}

// discardGateway tombstones a gateway row and deletes its VM (best effort).
func (s *RepoGatewayService) discardGateway(ctx context.Context, gateway runtimeports.RepoGateway) {
	defer revokeModelProxyTokens(ctx, s.q, gateway.UserID, "gateway-"+gateway.ID)
	defer meterSandboxUsage(ctx, s.q, gateway.UserID, "gateway", gateway.ID, false)
	// Announce for both ownership modes, even when guest cleanup fails.
	defer revocation.PublishBestEffort(ctx, s.revocations, revocation.Event{
		Kind: revocation.KindGatewayRevoked, GatewayID: gateway.ID,
		UserID: gateway.UserID, RepositoryID: gateway.RepositoryID,
		Reason: "repository gateway torn down",
	})
	if gateway.WorkspaceID.Valid {
		// Fence detached resolves before stopping the process. Reversing this
		// order lets a stale resolve reinstall a service after cleanup finishes.
		if _, err := s.q.SoftDeleteRepoGateway(ctx, gateway.ID); err != nil {
			slog.Warn("failed to tombstone workspace gateway", "gateway_id", gateway.ID, "error", err)
		}
		s.stopWorkspaceGateway(ctx, gateway)
		return
	} else if strings.TrimSpace(gateway.VmID) != "" {
		if err := s.sandbox.RevokeIngress(ctx, repoGatewayDomain(gateway.VmID)); err != nil {
			slog.Warn("failed to unmap gateway ingress domain", "vm_id", gateway.VmID, "error", err)
		}
		if err := s.sandbox.DeleteSandbox(ctx, gateway.VmID); err != nil {
			slog.Warn("failed to delete unrecoverable gateway vm", "vm_id", gateway.VmID, "error", err)
		}
	}
	if _, err := s.q.SoftDeleteRepoGateway(ctx, gateway.ID); err != nil {
		slog.Warn("failed to tombstone unrecoverable gateway row", "gateway_id", gateway.ID, "error", err)
	}
}

func (s *RepoGatewayService) markGatewayFailed(ctx context.Context, gatewayID string) {
	defer meterSandboxUsage(ctx, s.q, 0, "gateway", gatewayID, false)
	if _, err := s.q.UpdateRepoGatewayStatus(ctx, runtimeports.UpdateRepoGatewayStatusParams{
		ID:     gatewayID,
		Status: "failed",
	}); err != nil {
		slog.Warn("failed to mark repo gateway failed", "gateway_id", gatewayID, "error", err)
	}
}

// repoGatewayStaleProvisionAge bounds how long a non-terminal provision row may
// sit before the reaper treats it as crashed and reclaims it. It sits well
// above repoGatewayProvisionBackgroundBudget so an in-flight provision is never
// reaped out from under itself.
const repoGatewayStaleProvisionAge = 30 * time.Minute

// repoGatewayReaperInterval is the sweep cadence.
const repoGatewayReaperInterval = 5 * time.Minute

var repoGatewayReaperIntervalDuration = repoGatewayReaperInterval

// StartReaper runs a best-effort background sweep that reclaims gateway rows
// stuck in a non-terminal state, retired box-less rows (#2194, whose VMs it
// deletes) and rows whose box is gone. Each tick also runs the
// access-revocation sweep (when wired), tearing down live gateways whose user
// lost write access to the repository. Blocks until ctx is
// cancelled; run it in its own goroutine.
func (s *RepoGatewayService) StartReaper(ctx context.Context) {
	if s == nil || s.q == nil || s.sandbox == nil {
		return
	}
	ticker := time.NewTicker(repoGatewayReaperIntervalDuration)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sweepStaleGateways(ctx)
			s.sweepRevokedGateways(ctx)
			s.sweepWidowedGateways(ctx)
			s.sweepDiscardedWorkspaceGateways(ctx)
		}
	}
}

// sweepStaleGateways reclaims one batch of stale gateway rows. Exported-for-test
// via a thin wrapper is unnecessary; the query + this method are unit-tested
// directly through the querier + sandbox mocks.
func (s *RepoGatewayService) sweepStaleGateways(ctx context.Context) {
	ageSeconds := int64(repoGatewayStaleProvisionAge / time.Second)
	rows, err := s.q.ListStaleRepoGateways(ctx, ageSeconds)
	if err != nil {
		slog.Warn("repo gateway reaper: list stale rows failed", "error", err)
		return
	}
	for _, row := range rows {
		s.discardGateway(ctx, row)
	}
}

// sweepWidowedGateways discards live rows whose backing VM can no longer
// serve: the VM is gone at the provider (reclaimed out-of-band — the row
// would otherwise answer status:"running" forever while every relay call
// fails), or the VM has sat stopped past repoGatewayWidowedIdleMax — far
// beyond the 30-minute idle-suspend contract — so the next resolve provisions
// a fresh gateway (current engine pin, current agent seat) instead of
// resuming an indefinitely stale snapshot. Deleting the stopped VM also
// releases its retained disk. A provider blip is NOT evidence: rows are kept
// on any uncertain answer and the next tick retries.
func (s *RepoGatewayService) sweepWidowedGateways(ctx context.Context) {
	rows, err := s.q.ListActiveRepoGateways(ctx)
	if err != nil {
		slog.Warn("repo gateway widowed sweep: list active rows failed", "error", err)
		return
	}
	for _, row := range rows {
		// A row without a box is a retired repository-level product gateway
		// (#2194): nothing resolves it any more, so its VM is only a cost.
		if !row.WorkspaceID.Valid {
			slog.Info("repo gateway retired: no owning box", "gateway_id", row.ID, "vm_id", row.VmID)
			s.discardGateway(ctx, row)
			continue
		}
		workspace, loadErr := s.loadGatewayWorkspace(ctx, row.WorkspaceID.String(), row.RepositoryID, row.UserID)
		var apiErr *pkgerrors.APIError
		if errors.As(loadErr, &apiErr) && (apiErr.Status == 404 || apiErr.Status == 403) {
			s.discardGateway(ctx, row)
			continue
		}
		if loadErr != nil {
			continue
		}
		if workspace.VmID != row.VmID {
			s.discardGateway(ctx, row)
			continue
		}

		if strings.TrimSpace(row.VmID) == "" {
			continue
		}
		vm, err := s.sandbox.InspectSandbox(ctx, row.VmID)
		if err != nil {
			if vmAlreadyGone(err) || vmPlacementStale(err) {
				slog.Warn("repo gateway widowed: vm is gone",
					"gateway_id", row.ID, "vm_id", row.VmID, "error", err)
				s.discardGateway(ctx, row)
			} else {
				slog.Warn("repo gateway widowed sweep: inspect failed",
					"gateway_id", row.ID, "vm_id", row.VmID, "error", err)
			}
			continue
		}
		if vm.State == sandbox.StateRunning || vm.State == sandbox.StateStarting {
			continue
		}
		if idleFor := time.Since(row.LastActivityAt); idleFor <= repoGatewayWidowedIdleMax {
			continue
		}
		slog.Info("repo gateway widowed: vm stopped beyond idle contract",
			"gateway_id", row.ID, "vm_id", row.VmID,
			"vm_state", vm.State, "last_activity_at", row.LastActivityAt)
		s.discardGateway(ctx, row)
	}
}

// sweepRevokedGateways tears down live gateways whose user no longer has
// write access to the repository. The provision route checks write permission
// once, but the returned operator token is then validated only by the VM for
// the lifetime of the gateway process — so a collaborator/team/org/repo
// permission change leaves a revoked writer holding a working token against a
// VM that contains the cloned checkout. This sweep bounds that exposure to the
// reaper cadence. Over-revocation is safe:
// a still-authorized user simply re-provisions on the next resolve. On any
// uncertain answer (transient DB failure) the gateway is kept and the next
// sweep retries — except a hard-deleted repository, whose gateway can never
// be re-authorized and is discarded.
func (s *RepoGatewayService) sweepRevokedGateways(ctx context.Context) {
	if s.accessQuerier == nil {
		return
	}
	rows, err := s.accessQuerier.ListActiveRepoGateways(ctx)
	if err != nil {
		slog.Warn("repo gateway revocation sweep: list active rows failed", "error", err)
		return
	}
	for _, row := range rows {
		repository, err := s.accessQuerier.GetRepoByID(ctx, row.RepositoryID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				slog.Warn("repo gateway revoked: repository is gone",
					"gateway_id", row.ID, "vm_id", row.VmID, "repository_id", row.RepositoryID)
				s.discardGateway(ctx, row)
			} else {
				slog.Warn("repo gateway revocation sweep: load repository failed",
					"gateway_id", row.ID, "repository_id", row.RepositoryID, "error", err)
			}
			continue
		}
		canWrite, err := canWriteRepo(ctx, s.accessQuerier, repository, row.UserID)
		if err != nil {
			slog.Warn("repo gateway revocation sweep: permission check failed",
				"gateway_id", row.ID, "user_id", row.UserID, "repository_id", row.RepositoryID, "error", err)
			continue
		}
		if canWrite {
			continue
		}
		slog.Info("repo gateway revoked: user lost write access",
			"gateway_id", row.ID, "vm_id", row.VmID, "user_id", row.UserID, "repository_id", row.RepositoryID)
		s.discardGateway(ctx, row)
	}
}

// generateRepoGatewayToken mints the gateway operator token
// (smithers_gateway_ + 40 hex chars) and its SHA-256 hash.
func generateRepoGatewayToken() (plaintext string, hash string, err error) {
	plaintext = repoGatewayTokenPrefix + randomHex(20)
	sum := sha256.Sum256([]byte(plaintext))
	return plaintext, hex.EncodeToString(sum[:]), nil
}

func isRepoGatewayActiveUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23505" && pgErr.ConstraintName == "uq_repo_gateways_active"
	}
	lower := strings.ToLower(err.Error())
	return strings.Contains(lower, "uq_repo_gateways_active")
}
