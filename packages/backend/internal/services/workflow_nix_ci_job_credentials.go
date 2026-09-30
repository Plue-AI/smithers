package services

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// Workflow cache and artifact access for NixOS CI guests (smithers#1768).
//
// The retired runner handed each job a per-run agent token and a 0.x
// TypeScript step runtime that restored and saved `cache:` descriptors and
// uploaded artifacts. A NixOS guest gets neither. Instead the scheduler mints
// one job token per task (middleware.CIJobTokenPrefix) before it boots the
// task's guest, binds it to the guest's per-sandbox egress proxy for the
// control plane host's authorization header, and deletes it when the job ends.
// The guest only ever holds the placeholder (the variable's own name); the
// proxy swaps the real value in on the way out, exactly as it does for a
// workspace's bound secrets. The /internal cache and artifact routes accept
// the token through middleware.RequireWorkflowRunCredential, which resolves it
// to the task's run and rejects it unless the task is running, so the
// existing per-run and per-repository scoping of WorkflowCacheService and
// WorkflowArtifactService applies unchanged. The guest side is a small Python
// client (workflow_nix_ci_guest.py) that the start exec installs; the NixOS
// base image already ships python3.

//go:embed workflow_nix_ci_guest.py
var nixCIGuestHelper string

const (
	// nixCIToolDir holds the guest helper and its per-job cache files.
	nixCIToolDir          = "/var/lib/smithers-ci"
	nixCIToolBinDir       = nixCIToolDir + "/bin"
	nixCIToolHelperPath   = nixCIToolBinDir + "/smithers-ci"
	nixCICacheDescriptors = nixCIToolDir + "/cache.json"
	nixCICacheState       = nixCIToolDir + "/cache-state.json"
	// nixCIJobEnvPath holds the job's plain environment: repository
	// variables, service URLs, and egress-proxy placeholders. It never holds
	// a secret value.
	nixCIJobEnvPath = nixCIToolDir + "/job.env"

	// nixCIJobTokenGrace outlives the job's own ceiling slightly so a cache
	// save at the very end of a long job still authenticates. The token is
	// deleted when the job ends, and rejected once its task is not running,
	// whichever comes first.
	nixCIJobTokenGrace = 5 * time.Minute

	nixCIJobTokenEnv = "SMITHERS_CI_JOB_TOKEN"
)

// WorkflowCIJobCredentialStore persists job tokens. *db.Queries implements it.
type WorkflowCIJobCredentialStore interface {
	IssueWorkflowTaskGuestToken(ctx context.Context, arg db.IssueWorkflowTaskGuestTokenParams) (int64, error)
	RevokeWorkflowTaskGuestToken(ctx context.Context, workflowTaskID int64) error
}

// WithWorkflowSandboxSchedulerCIJobCredentials lets NixOS CI guests restore and
// save workflow caches and upload and download run artifacts. internalBaseURL
// is the control plane's /internal URL as a guest reaches it. Unset, jobs run
// without a job token and `cache:` descriptors are reported as unavailable.
func WithWorkflowSandboxSchedulerCIJobCredentials(store WorkflowCIJobCredentialStore, internalBaseURL string) WorkflowSandboxSchedulerOption {
	return func(w *WorkflowSandboxSchedulerWorker) {
		w.ciJobCredentials = store
		w.ciInternalBaseURL = strings.TrimRight(strings.TrimSpace(internalBaseURL), "/")
	}
}

// ErrCISecretChannelUnavailable is the sentinel every CISecretChannelError
// wraps: a secret was bound for a NixOS CI guest but no supported channel can
// carry it there.
var ErrCISecretChannelUnavailable = errors.New("no supported secret channel reaches the NixOS CI guest")

// CISecretChannelError refuses to deliver named secrets to a NixOS CI guest.
// The only supported channel is the guest's per-sandbox egress proxy, which
// needs a host to bind each value to; the exec environment persists plaintext
// in the sandbox runtime and the Microsandbox worker refuses it. It names the
// secrets, never their values.
type CISecretChannelError struct {
	Names  []string
	Reason string
}

func (e *CISecretChannelError) Error() string {
	return fmt.Sprintf("%s cannot reach the NixOS CI guest: %s", strings.Join(e.Names, ", "), e.Reason)
}

func (e *CISecretChannelError) Unwrap() error { return ErrCISecretChannelUnavailable }

// nixCIJobCredential is one task's job token: the plain guest environment
// that names it and the egress binding that carries its value.
type nixCIJobCredential struct {
	Env    map[string]string
	Secret sandbox.EgressProxySecret
}

// nixCIEgressSecret binds value to host for the authorization header, the
// only way a NixOS CI guest receives a credential.
func nixCIEgressSecret(name, value, host string) sandbox.EgressProxySecret {
	return sandbox.EgressProxySecret{Name: name, Value: value, Hosts: []string{host}, MatchHeaders: []string{"authorization"}}
}

// nixCIEgressHost is the host a credential for baseURL binds to. A host the
// proxy cannot bind (a dotless development host) is refused for name.
func nixCIEgressHost(name, baseURL string) (string, error) {
	host := apiHost(baseURL)
	if !sandbox.ValidEgressHost(host) {
		return "", &CISecretChannelError{
			Names:  []string{name},
			Reason: fmt.Sprintf("host %q cannot be bound to the egress proxy", host),
		}
	}
	return host, nil
}

// issueNixCIJobToken mints the task's job token before its guest boots, so
// the value can travel in the create request's egress policy. The token only
// authenticates while the task is running. revoke is always safe to call;
// with no store configured the credential is nil.
func (w *WorkflowSandboxSchedulerWorker) issueNixCIJobToken(ctx context.Context, task nixCITask, repositoryID int64) (*nixCIJobCredential, func(), error) {
	noop := func() {}
	if w.ciJobCredentials == nil || w.ciInternalBaseURL == "" {
		return nil, noop, nil
	}
	host, err := nixCIEgressHost(nixCIJobTokenEnv, w.ciInternalBaseURL)
	if err != nil {
		return nil, noop, err
	}
	var raw [20]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return nil, noop, fmt.Errorf("generate job token: %w", err)
	}
	token := middleware.CIJobTokenPrefix + hex.EncodeToString(raw[:])
	issued, err := w.ciJobCredentials.IssueWorkflowTaskGuestToken(ctx, db.IssueWorkflowTaskGuestTokenParams{
		TokenHash:      middleware.HashCIJobToken(token),
		ExpiresAt:      time.Now().UTC().Add(w.nixCITaskTimeout() + nixCIJobTokenGrace),
		WorkflowTaskID: task.ID,
		WorkflowRunID:  task.WorkflowRunID,
		RepositoryID:   repositoryID,
	})
	if err != nil {
		return nil, noop, fmt.Errorf("store job token: %w", err)
	}
	if issued != 1 {
		return nil, noop, fmt.Errorf("task %d is no longer runnable", task.ID)
	}
	revoke := func() {
		revokeCtx, cancel := w.finalizeContext(ctx)
		defer cancel()
		if err := w.ciJobCredentials.RevokeWorkflowTaskGuestToken(revokeCtx, task.ID); err != nil {
			w.logger.Warn("failed to revoke NixOS CI job token", "task_id", task.ID, "error", err)
		}
	}
	return &nixCIJobCredential{
		Env: map[string]string{
			"SMITHERS_CI_API_URL":      w.ciInternalBaseURL,
			"SMITHERS_WORKFLOW_RUN_ID": strconv.FormatInt(task.WorkflowRunID, 10),
		},
		Secret: nixCIEgressSecret(nixCIJobTokenEnv, token, host),
	}, revoke, nil
}

// bindNixCIGuestSecrets adds bound to the guest's egress policy and returns
// the names of every secret the policy now carries, whose placeholders the
// job environment exports. A guest without an egress proxy has no channel.
func bindNixCIGuestSecrets(req *sandbox.CreateRequest, bound []sandbox.EgressProxySecret) ([]string, error) {
	if len(bound) > 0 && (req.EgressProxy == nil || !req.EgressProxy.Enabled) {
		names := make([]string, 0, len(bound))
		for _, secret := range bound {
			names = append(names, secret.Name)
		}
		sort.Strings(names)
		return nil, &CISecretChannelError{Names: names, Reason: "the guest has no egress proxy"}
	}
	if req.EgressProxy == nil {
		return nil, nil
	}
	policy := *req.EgressProxy
	policy.Secrets = mergeEgressSecrets(policy.Secrets, bound)
	if err := policy.Validate(); err != nil {
		return nil, fmt.Errorf("NixOS CI guest egress policy: %w", err)
	}
	req.EgressProxy = &policy
	return policy.SecretNames(), nil
}

// nixCIJobEnvFile renders the job's plain environment and placeholders as a
// sourceable file. Every value is single-quoted, so no value can end the
// assignment. Names are validated upstream (IsInjectedSecretName, the egress
// secret name pattern).
func nixCIJobEnvFile(env map[string]string) string {
	names := make([]string, 0, len(env))
	for name := range env {
		names = append(names, name)
	}
	sort.Strings(names)
	var out strings.Builder
	for _, name := range names {
		out.WriteString("export " + name + "=" + shellQuote(env[name]) + "\n")
	}
	return out.String()
}

// nixCICacheDescriptorsJSON is the job's `cache:` list as the guest helper
// reads it. JSON has no raw newline, so it is safe inside a heredoc.
func nixCICacheDescriptorsJSON(task nixCITask) string {
	descriptors := task.Cache
	if descriptors == nil {
		descriptors = []WorkflowCacheDescriptor{}
	}
	raw, _ := json.Marshal(descriptors)
	return string(raw)
}

func nixCIHasCacheAction(task nixCITask, action string) bool {
	for _, descriptor := range task.Cache {
		if descriptor.Action == action && strings.TrimSpace(descriptor.Key) != "" {
			return true
		}
	}
	return false
}
