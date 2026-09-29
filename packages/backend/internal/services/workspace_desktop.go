package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"log/slog"
	"math/big"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// kind=desktop workspaces run nix/modules/desktop.nix: XFCE on a TigerVNC
// framebuffer, served to the browser by noVNC/websockify on guest port 6080.
// The API publishes that port as a preview domain the preview-gateway can
// dial, and relays it at /api/workspaces/{id}/desktop/{token}/... (never a
// public IP). The per-session VNC password lives only in the guest's tmpfs
// (/run/smithers-desktop) and in the one-time session response.

const (
	workspaceDesktopService = "smithers-desktop"
	// The image bakes the system profile into /usr/local/bin before NixOS
	// activation links /run/current-system. Desktop startup must use that shim
	// because agentd can accept exec requests before activation completes.
	workspaceDesktopStartCommand = "/usr/local/bin/smithers-desktop-start"
	workspaceDesktopPasswdHelper = "smithers-desktop-passwd"
	workspaceDesktopPasswordPath = "/run/smithers-desktop/password"
	workspaceDesktopPort         = int32(6080)
	workspaceDesktopSessionTTL   = 12 * time.Hour
	workspaceDesktopSessionIDLen = 12
	// VNC classic auth uses at most 8 password characters.
	workspaceDesktopVNCPasswordLen = 8
	// A desktop runs XFCE, Xvnc and a browser, so it cannot take the provider's
	// 512 MiB default (internal/microsandbox/worker/runtime.go): measured on
	// prod 2026-09-13, an idle session left ~180 MB free and a single browser
	// tab took the guest to 22 MB available, where exec timed out. 1 vCPU is
	// deliberate — admission charges vcpus*1000 millis against the 7000 a
	// worker has (infra/helm/microsandbox/values.yaml), so 2 vCPU would cut a
	// worker from 7 desktops to 3; raise it per deployment with
	// SMITHERS_SANDBOX_DESKTOP_VCPU_COUNT once a measurement asks for it.
	defaultWorkspaceDesktopMemoryMB  = 2048
	defaultWorkspaceDesktopVCPUCount = 1
	previewDomainSuffix              = ".preview.jjhub.tech"
	workspaceDesktopActivationWait   = 60 * time.Second
	workspaceDesktopRetryInterval    = 250 * time.Millisecond
)

// workspaceDesktopDomain is the preview hostname the desktop web port is
// published under: the preview gateway dials the controller by this name.
func workspaceDesktopDomain(vmID string) string {
	label := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(vmID)), "_", "-")
	return "smithers-desk-" + label + previewDomainSuffix
}

// workspaceDesktopStreamPath is the relay root for a workspace, relative to
// the API origin.
func workspaceDesktopStreamPath(workspaceID string) string {
	return "/api/workspaces/" + url.PathEscape(strings.TrimSpace(workspaceID)) + "/desktop/"
}

// workspaceDesktopVMClient is the optional provider surface desktops need.
// The Microsandbox client implements it; test fakes need not.
type workspaceDesktopVMClient interface {
	PublishIngress(ctx context.Context, domain string, req sandbox.PublishIngressRequest) (sandbox.IngressRoute, error)
	WriteFile(ctx context.Context, vmID, path string, req sandbox.WriteFileRequest) error
	Execute(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error)
}

// workspaceDesktopSessionRecorder is the optional querier surface for the
// stream session columns (generated sqlc has it; test fakes need not).
type workspaceDesktopSessionRecorder interface {
	SetWorkspaceDesktopSession(ctx context.Context, arg db.SetWorkspaceDesktopSessionParams) error
}

// applyWorkspaceDesktopBoot adds the desktop bootstrap to a create request:
// the guest's size, a random first password in its tmpfs (nobody knows it; the
// first session mint replaces it) and the init service that converts it and
// starts smithers-desktop.target. The size is set unconditionally — every
// desktop create reaches this seam, and the container base request never fills
// those fields — so a non-positive deployment value falls back here rather
// than booting a 0 MiB guest.
func applyWorkspaceDesktopBoot(req *sandbox.CreateRequest, memoryMB, vcpuCount int32) {
	if memoryMB <= 0 {
		memoryMB = defaultWorkspaceDesktopMemoryMB
	}
	if vcpuCount <= 0 {
		vcpuCount = defaultWorkspaceDesktopVCPUCount
	}
	req.MemSizeMB = &memoryMB
	req.VCPUCount = &vcpuCount
	if req.Files == nil {
		req.Files = map[string]sandbox.SandboxFile{}
	}
	req.Files[workspaceDesktopPasswordPath] = sandbox.SandboxFile{Content: randomDesktopPassword() + "\n"}
	remainAfterExit := true
	emitReadySignal := true
	if req.Init == nil {
		req.Init = &sandbox.ServiceConfig{Enabled: true}
	}
	// A desktop is not ready merely because agentd and networking answer. Move
	// the request's ready signal from the generic /bin/true service to the
	// desktop start script, which exits only after port 6080 serves vnc.html.
	for i := range req.Init.Services {
		if req.Init.Services[i].Name == workspaceReadyService {
			req.Init.Services[i].ReadySignal = nil
		}
	}
	req.Init.Services = append(req.Init.Services, sandbox.ServiceSpec{
		Name:            workspaceDesktopService,
		Mode:            sandbox.ServiceModeOneshot,
		Exec:            []string{workspaceDesktopStartCommand},
		User:            "root",
		After:           []string{"network-online.target"},
		WantedBy:        []string{"multi-user.target"},
		RemainAfterExit: &remainAfterExit,
		ReadySignal:     &emitReadySignal,
	})
}

// randomDesktopPassword returns an 8-character alphanumeric VNC password.
func randomDesktopPassword() string {
	const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	out := make([]byte, workspaceDesktopVNCPasswordLen)
	for i := range out {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		if err != nil {
			panic("desktop password entropy: " + err.Error())
		}
		out[i] = alphabet[n.Int64()]
	}
	return string(out)
}

// The stored hash covers both creator and entropy. The creator can be trusted
// only after the complete presented token matches that hash.
func generateDesktopSessionToken(userID int64) (plaintext, hash string) {
	plaintext = "smithers_desk_v1_" + strconv.FormatInt(userID, 10) + "_" + randomHex(24)
	sum := sha256.Sum256([]byte(plaintext))
	return plaintext, hex.EncodeToString(sum[:])
}

// desktopSessionCreator accepts only the current canonical credential format.
// Legacy credentials have no trustworthy creator and require a fresh mint.
func desktopSessionCreator(token string) (int64, bool) {
	payload, ok := strings.CutPrefix(token, "smithers_desk_v1_")
	if !ok {
		return 0, false
	}
	creator, entropy, ok := strings.Cut(payload, "_")
	if !ok {
		return 0, false
	}
	userID, err := strconv.ParseInt(creator, 10, 64)
	if err != nil || userID <= 0 || strconv.FormatInt(userID, 10) != creator {
		return 0, false
	}
	random, err := hex.DecodeString(entropy)
	if err != nil || len(random) != 24 || hex.EncodeToString(random) != entropy {
		return 0, false
	}
	return userID, true
}

// ensureWorkspaceDesktop publishes the desktop web port for a running
// kind=desktop workspace. Best effort on the provisioning path: a failure is
// logged and retried by the next session mint, which reports it.
func (s *WorkspaceService) ensureWorkspaceDesktop(ctx context.Context, workspace db.Workspace) error {
	if normalizeWorkspaceKind(workspace.Kind) != "desktop" || strings.TrimSpace(workspace.VmID) == "" {
		return nil
	}
	client, ok := s.sandbox.(workspaceDesktopVMClient)
	if !ok {
		return pkgerrors.Internal("sandbox provider cannot publish desktop ports")
	}
	publishCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if _, err := client.PublishIngress(publishCtx, workspaceDesktopDomain(workspace.VmID), sandbox.PublishIngressRequest{
		SandboxID: workspace.VmID,
		Port:      workspaceDesktopPort,
	}); err != nil {
		slog.Warn("workspace desktop port publish failed", "workspace_id", workspace.ID, "vm_id", workspace.VmID, "error", err)
		return pkgerrors.Internal("publish desktop port: " + err.Error())
	}
	return nil
}

// WorkspaceDesktopSessionResponse is returned once per session mint. The
// stream URL carries the relay token and the VNC password; neither is
// persisted in plaintext.
type WorkspaceDesktopSessionResponse struct {
	WorkspaceID string `json:"workspace_id"`
	// StreamURL opens the noVNC viewer through the API relay (relative to the
	// API origin until the route prefixes it). Load it in an iframe.
	StreamURL string                  `json:"stream_url"`
	Session   WorkspaceDesktopSession `json:"session"`
	// Token authenticates the relay path; Password is the VNC password. Both
	// are already embedded in StreamURL.
	Token    string `json:"token"`
	Password string `json:"vnc_password"`
}

// CreateDesktopSession mints a new stream session for a running desktop
// workspace: rotates the VNC password inside the guest (tmpfs only), issues a
// relay token (hash stored), publishes the port, and returns the viewer URL.
func (s *WorkspaceService) CreateDesktopSession(ctx context.Context, workspaceID string, repositoryID, userID int64) (WorkspaceDesktopSessionResponse, error) {
	if userID <= 0 {
		return WorkspaceDesktopSessionResponse{}, pkgerrors.Unauthorized("invalid desktop session creator")
	}
	if s.q == nil {
		return WorkspaceDesktopSessionResponse{}, pkgerrors.Internal("workspace store unavailable")
	}
	workspace, err := s.loadWorkspaceWithAccess(ctx, workspaceID, repositoryID, userID, WorkspaceAccessWrite)
	if err != nil {
		return WorkspaceDesktopSessionResponse{}, err
	}
	if normalizeWorkspaceKind(workspace.Kind) != "desktop" {
		return WorkspaceDesktopSessionResponse{}, pkgerrors.BadRequest("workspace kind is not desktop")
	}
	if workspace.Status != "running" || strings.TrimSpace(workspace.VmID) == "" {
		return WorkspaceDesktopSessionResponse{}, pkgerrors.Conflict("desktop workspace is not running")
	}
	client, ok := s.sandbox.(workspaceDesktopVMClient)
	if !ok {
		return WorkspaceDesktopSessionResponse{}, pkgerrors.Internal("sandbox provider cannot stream desktops")
	}
	recorder, ok := s.q.(workspaceDesktopSessionRecorder)
	if !ok {
		return WorkspaceDesktopSessionResponse{}, pkgerrors.Internal("desktop session store unavailable")
	}

	password := randomDesktopPassword()
	// Leave transport headroom beyond the 60-second NixOS activation wait.
	guestCtx, cancel := context.WithTimeout(ctx, workspaceDesktopActivationWait+5*time.Second)
	defer cancel()
	if err := client.WriteFile(guestCtx, workspace.VmID, workspaceDesktopPasswordPath, sandbox.WriteFileRequest{Content: password + "\n"}); err != nil {
		return WorkspaceDesktopSessionResponse{}, pkgerrors.Internal("deliver desktop password: " + err.Error())
	}
	if err := rotateWorkspaceDesktopPassword(guestCtx, client, workspace.VmID); err != nil {
		return WorkspaceDesktopSessionResponse{}, err
	}
	if err := s.ensureWorkspaceDesktop(ctx, workspace); err != nil {
		return WorkspaceDesktopSessionResponse{}, err
	}

	token, tokenHash := generateDesktopSessionToken(userID)
	sessionID := "dsk_" + randomHex(workspaceDesktopSessionIDLen)
	expiresAt := time.Now().UTC().Add(workspaceDesktopSessionTTL)
	if err := recorder.SetWorkspaceDesktopSession(ctx, db.SetWorkspaceDesktopSessionParams{
		ID:                      workspace.ID,
		DesktopSessionID:        sessionID,
		DesktopSessionTokenHash: tokenHash,
		DesktopSessionExpiresAt: pgtype.Timestamptz{Time: expiresAt, Valid: true},
	}); err != nil {
		return WorkspaceDesktopSessionResponse{}, pkgerrors.Internal("store desktop session: " + err.Error())
	}
	_ = s.q.TouchWorkspaceActivity(ctx, workspace.ID)
	return WorkspaceDesktopSessionResponse{
		WorkspaceID: workspace.ID,
		StreamURL:   workspaceDesktopViewerPath(workspace.ID, token, password),
		Session:     WorkspaceDesktopSession{ID: sessionID, ExpiresAt: expiresAt},
		Token:       token,
		Password:    password,
	}, nil
}

// rotateWorkspaceDesktopPassword tolerates the short interval in which agentd
// is reachable but NixOS activation has not exposed the desktop helper yet.
// The baked /usr/local/bin shim is preferred; retrying also keeps older images
// safe while /run/current-system is being linked.
//
// It uses the same shim the observe/input routes do, which separates two
// failures the old command could not tell apart. Exit 69 means activation is
// still running: retry, and report 503 desktop_not_ready if the window closes.
// Exit 127 means activation FINISHED and the helper is still absent, which is
// terminal for this box — it booted an image that predates the helper — so it
// fails at once with the same 409 desktop_tools_unavailable the control routes
// answer, rather than spending 60 s to report a retryable 503 that will never
// come true.
func rotateWorkspaceDesktopPassword(ctx context.Context, client workspaceDesktopVMClient, vmID string) error {
	return rotateWorkspaceDesktopPasswordWithWait(ctx, client, vmID, workspaceDesktopActivationWait, workspaceDesktopRetryInterval)
}

func rotateWorkspaceDesktopPasswordWithWait(ctx context.Context, client workspaceDesktopVMClient, vmID string, activationWait, retryInterval time.Duration) error {
	waitCtx, cancel := context.WithTimeout(ctx, activationWait)
	defer cancel()

	command := desktopHelperCommand(workspaceDesktopPasswdHelper, "")
	timeoutMS := int64(20_000)
	for {
		result, err := client.Execute(waitCtx, vmID, sandbox.ExecRequest{Command: command, TimeoutMS: &timeoutMS})
		if err == nil && (result.StatusCode == nil || *result.StatusCode == 0) {
			return nil
		}
		if waitCtx.Err() != nil {
			if ctx.Err() == nil {
				return pkgerrors.DesktopNotReady("desktop is still starting; retry shortly")
			}
			return pkgerrors.Internal("rotate desktop password: " + ctx.Err().Error())
		}
		if err == nil && result.StatusCode != nil && *result.StatusCode == desktopExitMissing {
			return pkgerrors.DesktopToolsUnavailable("this box's image has no desktop tools; open a new box to get them")
		}
		if !desktopHelperNotReady(result, err) {
			if err != nil {
				return pkgerrors.Internal("rotate desktop password: " + err.Error())
			}
			return pkgerrors.Internal("rotate desktop password exited " + strings.TrimSpace(result.Stderr))
		}

		timer := time.NewTimer(retryInterval)
		select {
		case <-waitCtx.Done():
			timer.Stop()
			return pkgerrors.DesktopNotReady("desktop is still starting; retry shortly")
		case <-timer.C:
		}
	}
}

// desktopHelperNotReady reports the retryable half of a failed rotation: the
// guest has not finished activating (exit 69), or the transport itself failed
// while the VM is still coming up.
func desktopHelperNotReady(result sandbox.ExecResult, err error) bool {
	if err == nil && result.StatusCode != nil && *result.StatusCode == desktopExitNotActivated {
		return true
	}
	message := strings.ToLower(strings.TrimSpace(result.Stderr))
	if err != nil {
		message += " " + strings.ToLower(err.Error())
	}
	return strings.Contains(message, "no such file or directory") ||
		strings.Contains(message, "smithers-desktop-passwd: helper not ready")
}

// workspaceDesktopViewerPath is the noVNC viewer URL under the relay:
// autoconnect to the websockify endpoint on the same relay path, remote
// resize (Xvnc accepts SetDesktopSize), reconnect on drops.
func workspaceDesktopViewerPath(workspaceID, token, password string) string {
	base := workspaceDesktopStreamPath(workspaceID) + url.PathEscape(token) + "/"
	query := url.Values{}
	query.Set("autoconnect", "1")
	query.Set("reconnect", "1")
	query.Set("resize", "remote")
	query.Set("path", strings.TrimPrefix(base, "/")+"websockify")
	query.Set("password", password)
	return base + "vnc.html?" + query.Encode()
}

// WorkspaceDesktopRelayTarget is the authenticated routing result for the
// desktop relay. The public client never sees the preview domain.
type WorkspaceDesktopRelayTarget struct {
	Domain       string
	WorkspaceID  string
	UserID       int64
	OwnerUserID  int64
	RepositoryID int64
}

// AuthorizeDesktopRelay verifies a session token before any bytes are
// relayed to the desktop. The token is the credential: no user session is
// involved (the viewer runs in an iframe / WebSocket without headers).
func (s *WorkspaceService) AuthorizeDesktopRelay(ctx context.Context, workspaceID, token string) (WorkspaceDesktopRelayTarget, error) {
	if s.q == nil {
		return WorkspaceDesktopRelayTarget{}, pkgerrors.Internal("workspace store unavailable")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	token = strings.TrimSpace(token)
	if workspaceID == "" || token == "" {
		return WorkspaceDesktopRelayTarget{}, pkgerrors.Unauthorized("invalid desktop session")
	}
	workspace, err := s.q.GetWorkspace(ctx, workspaceID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) || isInvalidTextRepresentation(err) {
			return WorkspaceDesktopRelayTarget{}, pkgerrors.Unauthorized("invalid desktop session")
		}
		return WorkspaceDesktopRelayTarget{}, pkgerrors.Internal("load workspace: " + err.Error())
	}
	sum := sha256.Sum256([]byte(token))
	want, decodeErr := hex.DecodeString(workspace.DesktopSessionTokenHash)
	if decodeErr != nil || len(want) != len(sum) || subtle.ConstantTimeCompare(want, sum[:]) != 1 {
		return WorkspaceDesktopRelayTarget{}, pkgerrors.Unauthorized("invalid desktop session")
	}
	if !workspace.DesktopSessionExpiresAt.Valid || time.Now().After(workspace.DesktopSessionExpiresAt.Time) {
		return WorkspaceDesktopRelayTarget{}, pkgerrors.Unauthorized("desktop session expired")
	}
	// Verify the full token's stored hash above before trusting its creator.
	creatorID, valid := desktopSessionCreator(token)
	if !valid {
		return WorkspaceDesktopRelayTarget{}, pkgerrors.Unauthorized("invalid desktop session")
	}
	if err := s.requireWorkspaceAccess(ctx, workspace.ID, workspace.UserID, creatorID, WorkspaceAccessWrite); err != nil {
		return WorkspaceDesktopRelayTarget{}, err
	}
	if normalizeWorkspaceKind(workspace.Kind) != "desktop" || workspace.Status != "running" || strings.TrimSpace(workspace.VmID) == "" {
		return WorkspaceDesktopRelayTarget{}, pkgerrors.Conflict("desktop workspace is not running")
	}
	_ = s.q.TouchWorkspaceActivity(ctx, workspace.ID)
	return WorkspaceDesktopRelayTarget{
		Domain:       workspaceDesktopDomain(workspace.VmID),
		WorkspaceID:  workspace.ID,
		UserID:       creatorID,
		OwnerUserID:  workspace.UserID,
		RepositoryID: workspace.RepositoryID,
	}, nil
}
