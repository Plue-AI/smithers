package sandbox

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strings"
	"time"
)

// APIRequestObserver records provider API request durations and errors.
type APIRequestObserver interface {
	ObserveSandboxAPIRequest(method, endpoint string, seconds float64)
	IncSandboxAPIErrors(endpoint, errorCode string)
}

// APIRequestObserverBinder is implemented by a deployment-built provider whose
// API request telemetry belongs in the product metrics registry. The product
// binds its observer once, before any product service uses the provider.
type APIRequestObserverBinder interface {
	BindAPIRequestObserver(APIRequestObserver)
}

type idempotencyContextKey struct{}
type resourceLinkContextKey struct{}

const (
	ResourceKindHeader = "X-Plue-Resource-Kind"
	ResourceIDHeader   = "X-Plue-Resource-ID"
)

type ResourceLink struct {
	Kind string
	ID   string
}

// WithIdempotencyKey binds a stable product-operation key to controller
// mutations. Callers retrying the same logical operation must reuse the key.
func WithIdempotencyKey(ctx context.Context, key string) context.Context {
	return context.WithValue(ctx, idempotencyContextKey{}, strings.TrimSpace(key))
}

// WithResourceLink attributes a sandbox allocation to the durable product
// resource that requested it.
func WithResourceLink(ctx context.Context, kind, id string) context.Context {
	return context.WithValue(ctx, resourceLinkContextKey{}, ResourceLink{
		Kind: strings.TrimSpace(kind), ID: strings.TrimSpace(id),
	})
}

func RequestResourceLink(ctx context.Context) ResourceLink {
	link, _ := ctx.Value(resourceLinkContextKey{}).(ResourceLink)
	return link
}

func RequestIdempotencyKey(ctx context.Context) (string, error) {
	if key, _ := ctx.Value(idempotencyContextKey{}).(string); key != "" {
		return key, nil
	}
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate idempotency key: %w", err)
	}
	return hex.EncodeToString(buffer), nil
}

// StatusError captures a non-2xx provider response.
type StatusError struct {
	StatusCode int
	ErrorCode  string
	Provider   ProviderName
	// Code mirrors the optional machine-readable `code` field from the error
	// body. ErrorCode also accepts the structured controller envelope.
	Code    string
	Message string
}

func (e *StatusError) Error() string {
	provider := strings.TrimSpace(string(e.Provider))
	if provider == "" {
		provider = "sandbox"
	}
	switch {
	case e.ErrorCode != "" && e.Message != "":
		return fmt.Sprintf("%s api returned status %d (%s): %s", provider, e.StatusCode, e.ErrorCode, e.Message)
	case e.Message != "":
		return fmt.Sprintf("%s api returned status %d: %s", provider, e.StatusCode, e.Message)
	default:
		return fmt.Sprintf("%s api returned status %d", provider, e.StatusCode)
	}
}

// State is the sandbox lifecycle state.
type State string

const (
	StateStarting   State = "starting"
	StateRunning    State = "running"
	StateSuspending State = "suspending"
	StateStopped    State = "stopped"
)

// PersistenceMode controls sandbox persistence policy.
type PersistenceMode string

const (
	PersistenceEphemeral  PersistenceMode = "ephemeral"
	PersistencePersistent PersistenceMode = "persistent"
)

// SnapshotPersistenceType controls snapshot persistence.
type SnapshotPersistenceType string

const (
	SnapshotPersistencePersistent SnapshotPersistenceType = "persistent"
)

// DeleteTrigger configures when an ephemeral VM is deleted.
type DeleteTrigger string

const (
	DeleteOnStop    DeleteTrigger = "OnStop"
	DeleteOnSuspend DeleteTrigger = "OnSuspend"
)

// ServiceMode describes an init-managed guest service.
type ServiceMode string

const (
	ServiceModeOneshot ServiceMode = "oneshot"
	ServiceModeService ServiceMode = "service"
)

// RestartPolicyKind describes restart behavior.
type RestartPolicyKind string

const (
	RestartPolicyAlways    RestartPolicyKind = "always"
	RestartPolicyOnFailure RestartPolicyKind = "on-failure"
	RestartPolicyNo        RestartPolicyKind = "no"
)

// PortBinding exposes an internal sandbox port.
type PortBinding struct {
	Port       int32 `json:"port"`
	TargetPort int32 `json:"targetPort"`
}

// SandboxFile writes a file into the sandbox at creation time.
type SandboxFile struct {
	Content    string `json:"content"`
	Encoding   string `json:"encoding,omitempty"`
	Executable bool   `json:"executable,omitempty"`
}

// GitUser configures git author information.
type GitUser struct {
	Name  string `json:"name,omitempty"`
	Email string `json:"email,omitempty"`
}

// GitConfig configures the git environment inside the sandbox.
type GitConfig struct {
	User *GitUser `json:"user,omitempty"`
}

// Clone history windows. A guest almost never reads more history than the
// coding flows ask for (flows/coding/project-config.ts caps `historyLimit` at
// 100 native commits), while a full-history clone of a busy repository costs
// minutes and hundreds of megabytes: cloning smithersai/plue (3,603 commits,
// 5,200 files) from its GitHub mirror measured 154s / 435MB at full depth
// against 29s / 41MB at --depth 200 on 2026-09-15.
//
// jj tolerates a shallow colocated repo — it treats the shallow boundary as a
// root — but NOT a blobless partial clone: gix ignores git's promisor remote,
// so `jj diff` fails with "Object <id> of type file not found". Guests that
// run jj therefore get --depth, never --filter=blob:none.
const (
	// DefaultCloneDepth is the history window a guest clone takes when the
	// spec does not ask for a specific one. It covers the 100-commit coding
	// history window twice over; `git fetch --deepen` extends it on demand.
	DefaultCloneDepth = 200

	// FullCloneDepth opts a repository out of shallow cloning entirely.
	FullCloneDepth = -1
)

// GitRepositorySpec clones a repository into the sandbox.
type GitRepositorySpec struct {
	Repo string `json:"repo"`
	Path string `json:"path"`
	Rev  string `json:"rev,omitempty"`

	// Depth bounds how much history the guest clone fetches. Zero takes
	// DefaultCloneDepth, FullCloneDepth (or any negative value) clones every
	// commit, and a positive value is used as-is.
	Depth int `json:"depth,omitempty"`
}

// ResolveCloneDepth maps a spec's requested depth onto the git `--depth`
// argument to use: a positive result is the depth, and zero means "no --depth
// argument", i.e. full history.
func ResolveCloneDepth(depth int) int {
	switch {
	case depth == 0:
		return DefaultCloneDepth
	case depth < 0:
		return 0
	default:
		return depth
	}
}

// GitOptions configures repositories and git behavior.
type GitOptions struct {
	Config GitConfig           `json:"config"`
	Repos  []GitRepositorySpec `json:"repos,omitempty"`
}

// LinuxUserSpec creates a Linux user at boot.
type LinuxUserSpec struct {
	Name   string   `json:"name"`
	Gecos  string   `json:"gecos,omitempty"`
	Groups []string `json:"groups,omitempty"`
	Home   string   `json:"home,omitempty"`
	Shell  string   `json:"shell,omitempty"`
	System *bool    `json:"system,omitempty"`
	UID    *int32   `json:"uid,omitempty"`
}

// LinuxGroupSpec creates a Linux group at boot.
type LinuxGroupSpec struct {
	Name   string `json:"name"`
	GID    *int32 `json:"gid,omitempty"`
	System *bool  `json:"system,omitempty"`
}

// RestartPolicy configures init-managed service restart behavior.
type RestartPolicy struct {
	Kind RestartPolicyKind `json:"policy"`
	Sec  *int64            `json:"restartSec,omitempty"`
}

// ServiceSpec describes an init-managed guest service.
type ServiceSpec struct {
	Name string      `json:"name"`
	Mode ServiceMode `json:"mode"`
	// Exec is an argv. Use an explicit shell and -c argument for shell scripts.
	Exec               []string          `json:"exec"`
	After              []string          `json:"after,omitempty"`
	DeleteAfterSuccess *bool             `json:"deleteAfterSuccess,omitempty"`
	Enable             *bool             `json:"enable,omitempty"`
	Env                map[string]string `json:"env,omitempty"`
	Group              string            `json:"group,omitempty"`
	OnFailure          []string          `json:"onFailure,omitempty"`
	ReadySignal        *bool             `json:"readySignal,omitempty"`
	RemainAfterExit    *bool             `json:"remainAfterExit,omitempty"`
	Requires           []string          `json:"requires,omitempty"`
	RestartPolicy      *RestartPolicy    `json:"restartPolicy,omitempty"`
	TimeoutSec         *int64            `json:"timeoutSec,omitempty"`
	User               string            `json:"user,omitempty"`
	WantedBy           []string          `json:"wantedBy,omitempty"`
	WatchdogSec        *int64            `json:"watchdogSec,omitempty"`
	Workdir            string            `json:"workdir,omitempty"`
}

// ServiceConfig configures guest services during sandbox boot.
type ServiceConfig struct {
	Enabled         bool          `json:"enabled"`
	Services        []ServiceSpec `json:"services,omitempty"`
	PatchedServices []any         `json:"patchedServices,omitempty"`
}

// PersistencePolicy keeps a sandbox disk around between sessions.
type PersistencePolicy struct {
	Type        PersistenceMode `json:"type"`
	Priority    *int32          `json:"priority,omitempty"`
	DeleteEvent *DeleteTrigger  `json:"deleteEvent,omitempty"`
}

// SnapshotPersistence keeps a snapshot around for reuse.
type SnapshotPersistence struct {
	Type     SnapshotPersistenceType `json:"type"`
	Priority *int32                  `json:"priority,omitempty"`
}

// FirewallEgressRule allows outbound traffic to a specific host+port.
type FirewallEgressRule struct {
	Host     string `json:"host"`
	Port     int32  `json:"port"`
	Protocol string `json:"protocol,omitempty"`
}

// FirewallPolicy controls sandbox outbound traffic policy.
type FirewallPolicy struct {
	DefaultEgressAction string               `json:"defaultEgressAction,omitempty"`
	EgressAllow         []FirewallEgressRule `json:"egressAllow,omitempty"`
}

// EgressProxyCAGuestPath is where the provider writes the per-sandbox egress
// proxy's CA certificate inside the guest. The env bundle (SSL_CERT_FILE,
// CURL_CA_BUNDLE, REQUESTS_CA_BUNDLE, NODE_EXTRA_CA_CERTS, GIT_SSL_CAINFO)
// points at this file, so it works on any guest image; installing it into a
// distribution trust store is an image-kind hook on top of that.
const (
	EgressProxyCAGuestPath      = "/etc/smithers/egress-ca.pem"
	EgressProxyEnvGuestPath     = "/etc/smithers/egress.env"
	EgressProxyProfileGuestPath = "/etc/profile.d/00-smithers-runtime.sh"
)

// EgressProxyPlaceholder is the value a guest sees for a proxy-bound secret.
// The guest only ever holds the NAME; the per-sandbox egress proxy swaps it
// for the real value on requests to the bound hosts and locations.
func EgressProxyPlaceholder(name string) string { return strings.TrimSpace(name) }

// EgressProxySecret binds one credential to the upstream hosts and request
// locations where the per-sandbox egress proxy may substitute it. Value is an
// in-flight field: it travels once, API -> controller -> worker, over mTLS and
// is consumed into the proxy process. It must never be persisted, logged, or
// written into the guest; SanitizeCreateRequest redacts it before any durable
// controller write.
type EgressProxySecret struct {
	Name         string   `json:"name"`
	Value        string   `json:"value,omitempty"`
	Hosts        []string `json:"hosts"`
	MatchHeaders []string `json:"matchHeaders,omitempty"`
	MatchQuery   bool     `json:"matchQuery,omitempty"`
	MatchPath    bool     `json:"matchPath,omitempty"`
}

// Validate rejects a binding the proxy could not enforce: a secret with no
// host would substitute anywhere, one bound to a wildcard or CIDR would
// substitute on every host it covers, and one with no location would scan
// every header. All fail closed.
func (s EgressProxySecret) Validate() error {
	name := strings.TrimSpace(s.Name)
	if name == "" || !egressSecretNamePattern.MatchString(name) {
		return fmt.Errorf("egress proxy secret name %q is invalid", s.Name)
	}
	if strings.TrimSpace(s.Value) == "" {
		return fmt.Errorf("egress proxy secret %s has no value", name)
	}
	if len(s.Hosts) == 0 {
		return fmt.Errorf("egress proxy secret %s is not bound to any host", name)
	}
	for _, host := range s.Hosts {
		if ValidExactEgressHost(host) {
			continue
		}
		if ValidEgressHost(host) {
			return fmt.Errorf("%w: egress proxy secret %s host %q", ErrEgressSecretHostNotExact, name, host)
		}
		return fmt.Errorf("egress proxy secret %s host %q is invalid", name, host)
	}
	if len(s.MatchHeaders) == 0 && !s.MatchQuery && !s.MatchPath {
		return fmt.Errorf("egress proxy secret %s has no match location", name)
	}
	return nil
}

var (
	egressSecretNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	egressMethodPattern     = regexp.MustCompile(`^[A-Za-z]+$`)
	egressHostPattern       = regexp.MustCompile(`^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`)
)

// ErrEgressSecretHostNotExact refuses a secret bound to a "*.suffix" wildcard
// or a CIDR: the proxy would swap the value into requests to every host the
// pattern covers, including ones an outsider controls.
var ErrEgressSecretHostNotExact = errors.New("a secret binding host must be one exact host name")

// ValidExactEgressHost accepts one host: a DNS name that is neither a
// "*.suffix" wildcard nor a CIDR, or one IPv4 or IPv6 address literal (no
// brackets, port or zone). Secret bindings and host rules name exactly the
// host a value or rule applies to.
func ValidExactEgressHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if net.ParseIP(host) != nil {
		return true
	}
	if strings.HasPrefix(host, "*.") || !ValidEgressHost(host) {
		return false
	}
	_, _, err := net.ParseCIDR(host)
	return err != nil
}

// CanonicalExactEgressHost is host's comparable spelling: lower case, and an
// address literal in net.IP's canonical form, so "0:0::1" and "::1" or
// "::ffff:10.0.0.1" and "10.0.0.1" name the same host.
func CanonicalExactEgressHost(host string) string {
	host = strings.ToLower(strings.TrimSpace(host))
	if ip := net.ParseIP(host); ip != nil {
		return ip.String()
	}
	return host
}

// ValidEgressHost accepts a DNS name, a "*.suffix" wildcard, or a CIDR. A
// scheme, port, path, or userinfo is rejected: the binding names a host, and
// anything else would silently widen or narrow where a value may be swapped.
func ValidEgressHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" || len(host) > 253 {
		return false
	}
	if _, _, err := net.ParseCIDR(host); err == nil {
		return true
	}
	return egressHostPattern.MatchString(host)
}

// EgressQuota is a billing user's aggregate grant for each UTC day.
// DailyBytes counts proxy bytes in both directions; -1 is unlimited, 0 denies.
type EgressQuota struct {
	BillingUserID int64 `json:"billingUserId"`
	DailyBytes    int64 `json:"dailyBytes"`
}

// DefaultEgressDailyQuotaBytes bounds infrastructure sandboxes with no billing user.
const DefaultEgressDailyQuotaBytes int64 = 10 << 30

// EgressProxyPolicy asks the provider to run a credential-substituting egress
// proxy dedicated to this sandbox. The provider makes that proxy the guest's
// only egress path: guest firewall default deny, allow only the proxy
// endpoint, HTTP(S)_PROXY and CA-bundle env injected into every service and
// exec, CA written to EgressProxyCAGuestPath.
type EgressProxyPolicy struct {
	// Quota, when present, overrides the provider default.
	Quota   *EgressQuota `json:"quota,omitempty"`
	Enabled bool         `json:"enabled"`
	// AllowDomains is the proxy-level domain allowlist. Empty leaves the list
	// to the provider: the hosted Microsandbox worker uses its deployment
	// allowlist, else a default-deny list of package registries and model
	// APIs. A reload naming "*" is refused unless the deployment allowlist
	// opts in with "*"; a list sent at creation is enforced as given. Hosts a
	// secret is bound to are always added. Private, link-local, and metadata
	// ranges are always denied regardless of this list. (ironproxy.Render
	// alone still renders an empty list with no AllowCIDRs as "*".)
	AllowDomains []string            `json:"allowDomains,omitempty"`
	Secrets      []EgressProxySecret `json:"secrets,omitempty"`
	// HostRules narrows hosts: a host a rule names is reachable only by the
	// methods and paths its rules match, whatever the allowlist says.
	HostRules []EgressHostRule `json:"hostRules,omitempty"`
}

// EgressHostRule admits requests to one exact host whose method (any when
// Methods is empty) and path match. Paths use the proxy's syntax: path.Match
// globs ("?*" is one non-empty segment), or a literal prefix ending in "/*".
type EgressHostRule struct {
	Host    string   `json:"host"`
	Methods []string `json:"methods,omitempty"`
	Paths   []string `json:"paths"`
}

// Validate rejects a rule the proxy could not enforce exactly: a wildcard or
// CIDR host, or a rule with no path.
func (r EgressHostRule) Validate() error {
	host := strings.ToLower(strings.TrimSpace(r.Host))
	if !ValidExactEgressHost(host) {
		return fmt.Errorf("egress host rule host %q is not an exact host name", r.Host)
	}
	if len(r.Paths) == 0 {
		return fmt.Errorf("egress host rule for %s has no path", host)
	}
	for _, path := range r.Paths {
		if !strings.HasPrefix(path, "/") {
			return fmt.Errorf("egress host rule for %s path %q must start with /", host, path)
		}
		// The proxy reads a trailing "/*" as a literal prefix: a wildcard
		// before it would match only itself.
		if strings.HasSuffix(path, "/*") && strings.ContainsAny(path[:len(path)-2], "*?[\\") {
			return fmt.Errorf("egress host rule for %s path %q mixes a glob with a /* prefix", host, path)
		}
	}
	for _, method := range r.Methods {
		if !egressMethodPattern.MatchString(method) {
			return fmt.Errorf("egress host rule for %s method %q is invalid", host, method)
		}
	}
	return nil
}

// ConversationWithheldHostRules is the egress of a workspace that ran work
// started from an outsider's approved text: that work reads its pinned copy,
// never the live issue, so GitHub is reachable only for git fetches,
// repository metadata, releases and archives. No issue, comment, pull
// request, search or GraphQL endpoint of any repository matches.
func ConversationWithheldHostRules() []EgressHostRule {
	read := []string{"GET", "HEAD"}
	return []EgressHostRule{
		{Host: "api.github.com", Methods: read, Paths: []string{
			"/repos/?*/?*", "/repos/?*/?*/releases", "/repos/?*/?*/releases/?*", "/repos/?*/?*/releases/tags/?*",
			"/repos/?*/?*/releases/assets/?*", "/repos/?*/?*/tags", "/repos/?*/?*/branches", "/repos/?*/?*/tarball/?*",
			"/repos/?*/?*/zipball/?*", "/repos/?*/?*/commits/?*", "/rate_limit", "/meta",
		}},
		{Host: "github.com", Methods: read, Paths: []string{
			"/?*/?*/info/refs", "/?*/?*/releases/download/?*/?*", "/?*/?*/releases/latest/download/?*",
			"/?*/?*/archive/?*", "/?*/?*/archive/refs/tags/?*", "/?*/?*/archive/refs/heads/?*",
		}},
		{Host: "github.com", Methods: []string{"POST"}, Paths: []string{"/?*/?*/git-upload-pack"}},
	}
}

// Validate checks every bound secret and rejects duplicate names, which would
// make the placeholder ambiguous.
func (p *EgressProxyPolicy) Validate() error {
	if p == nil || !p.Enabled {
		return nil
	}
	if p.Quota != nil && (p.Quota.BillingUserID <= 0 || p.Quota.DailyBytes < -1) {
		return fmt.Errorf("invalid egress quota")
	}
	seen := make(map[string]struct{}, len(p.Secrets))
	for _, secret := range p.Secrets {
		if err := secret.Validate(); err != nil {
			return err
		}
		name := strings.TrimSpace(secret.Name)
		if _, duplicate := seen[name]; duplicate {
			return fmt.Errorf("egress proxy secret %s is bound twice", name)
		}
		seen[name] = struct{}{}
	}
	for _, rule := range p.HostRules {
		if err := rule.Validate(); err != nil {
			return err
		}
	}
	return nil
}

// SecretNames lists the placeholder-bearing names, sorted, for callers that
// need to recognize a placeholder without the values.
func (p *EgressProxyPolicy) SecretNames() []string {
	if p == nil {
		return nil
	}
	names := make([]string, 0, len(p.Secrets))
	for _, secret := range p.Secrets {
		names = append(names, strings.TrimSpace(secret.Name))
	}
	sort.Strings(names)
	return names
}

// Template creates a reusable template-backed snapshot.
type Template struct {
	Files               map[string]SandboxFile `json:"files,omitempty"`
	Packages            []string               `json:"packages,omitempty"`
	Discriminator       string                 `json:"discriminator,omitempty"`
	Image               string                 `json:"image,omitempty"`
	Git                 *GitOptions            `json:"git,omitempty"`
	GitRepos            []GitRepositorySpec    `json:"gitRepos,omitempty"`
	Groups              []LinuxGroupSpec       `json:"groups,omitempty"`
	IdleTimeoutSeconds  *int64                 `json:"idleTimeoutSeconds,omitempty"`
	MemSizeMB           *int32                 `json:"memSizeMb,omitempty"`
	Firewall            *FirewallPolicy        `json:"firewall,omitempty"`
	Persistence         *PersistencePolicy     `json:"persistence,omitempty"`
	Ports               []PortBinding          `json:"ports,omitempty"`
	ReadyTimeoutSeconds *int64                 `json:"readyTimeoutSeconds,omitempty"`
	RootfsSizeMB        *int64                 `json:"rootfsSizeMb,omitempty"`
	SnapshotID          string                 `json:"snapshotId,omitempty"`
	Init                *ServiceConfig         `json:"init,omitempty"`
	Users               []LinuxUserSpec        `json:"users,omitempty"`
	VCPUCount           *int32                 `json:"vcpuCount,omitempty"`
	WaitForReady        *bool                  `json:"waitForReady,omitempty"`
	Workdir             string                 `json:"workdir,omitempty"`
}

// CreateRequest declares the provider-neutral sandbox boot contract.
type CreateRequest struct {
	// Kind selects the guest execution model. container preserves the legacy
	// workload entrypoint; vm and desktop hand PID 1 to the image's init.
	Kind string `json:"kind,omitempty"`
	// Image is the provider-neutral OCI image reference. The Microsandbox client
	// fills the deployment-pinned default when callers omit it.
	Image                  string                 `json:"image,omitempty"`
	ActivityThresholdBytes *int64                 `json:"activityThresholdBytes,omitempty"`
	Files                  map[string]SandboxFile `json:"files,omitempty"`
	Packages               []string               `json:"packages,omitempty"`
	Firewall               *FirewallPolicy        `json:"firewall,omitempty"`
	Git                    *GitOptions            `json:"git,omitempty"`
	GitRepos               []GitRepositorySpec    `json:"gitRepos,omitempty"`
	Groups                 []LinuxGroupSpec       `json:"groups,omitempty"`
	IdleTimeoutSeconds     *int64                 `json:"idleTimeoutSeconds,omitempty"`
	Internet               string                 `json:"internet,omitempty"`
	MemSizeMB              *int32                 `json:"memSizeMb,omitempty"`
	Persistence            *PersistencePolicy     `json:"persistence,omitempty"`
	Ports                  []PortBinding          `json:"ports,omitempty"`
	ReadyTimeoutSeconds    *int64                 `json:"readyTimeoutSeconds,omitempty"`
	Recreate               *bool                  `json:"recreate,omitempty"`
	RootfsSizeMB           *int64                 `json:"rootfsSizeMb,omitempty"`
	SnapshotID             string                 `json:"snapshotId,omitempty"`
	Init                   *ServiceConfig         `json:"init,omitempty"`
	Template               *Template              `json:"template,omitempty"`
	Users                  []LinuxUserSpec        `json:"users,omitempty"`
	VCPUCount              *int32                 `json:"vcpuCount,omitempty"`
	WaitForReady           *bool                  `json:"waitForReady,omitempty"`
	Workdir                string                 `json:"workdir,omitempty"`
	// EgressProxy, when enabled, makes a per-sandbox credential-substituting
	// proxy the guest's only egress path. See EgressProxyPolicy.
	EgressProxy *EgressProxyPolicy `json:"egressProxy,omitempty"`
}

// ForkRequest creates a sandbox from a stopped sandbox disk.
type ForkRequest struct {
	IdleTimeoutSeconds *int64             `json:"idleTimeoutSeconds,omitempty"`
	Persistence        *PersistencePolicy `json:"persistence,omitempty"`
	Workdir            string             `json:"workdir,omitempty"`
	// EgressProxy is the child's own proxy policy (RFD-004). A fork child is
	// a fresh sandbox with a fresh network: without this the child boots with
	// no proxy and an open network, and every later exec fails requireEgress.
	// The bound values travel once, to the worker, like CreateRequest's.
	EgressProxy *EgressProxyPolicy `json:"egressProxy,omitempty"`
	// Files are written into the child before its services start, on top of
	// the inherited disk (placeholder-only files, never credentials).
	Files map[string]SandboxFile `json:"files,omitempty"`
	// MemSizeMB, VCPUCount and Kind size and type the child. A fork child is
	// a fresh sandbox: without them it is admitted and booted at the provider
	// defaults (512 MiB, 1 vCPU), not at the size of the workspace it serves.
	MemSizeMB *int32 `json:"memSizeMB,omitempty"`
	VCPUCount *int32 `json:"vcpuCount,omitempty"`
	Kind      string `json:"kind,omitempty"`
}

// CreateResult is returned after sandbox creation.
type CreateResult struct {
	ID string `json:"id"`
}

// Sandbox reports current sandbox state.
type Sandbox struct {
	ID                  string    `json:"id"`
	RuntimeID           string    `json:"runtimeId,omitempty"`
	LastNetworkActivity time.Time `json:"lastNetworkActivity,omitempty"`
	State               State     `json:"state,omitempty"`
	CPUTimeSeconds      *float64  `json:"cpuTimeSeconds,omitempty"`
}

// PublishIngressRequest maps a public hostname to a sandbox port.
type PublishIngressRequest struct {
	SandboxID string `json:"sandboxId"`
	Port      int32  `json:"port"`
}

// IngressRoute records a public hostname to sandbox-port route.
type IngressRoute struct {
	ID        string `json:"id"`
	Hostname  string `json:"hostname"`
	SandboxID string `json:"sandboxId"`
	Port      int32  `json:"port"`
}

// ExecRequest executes a command in the sandbox and waits for completion.
//
// Secrets is the operation-scoped secret surface. A provider may honor it only
// through a channel that never persists plaintext to guest disk, snapshots,
// image layers, process arguments, controller request state, logs, errors, or
// runtime metadata. A provider without such a channel must fail the operation
// closed instead of injecting the values.
type ExecRequest struct {
	Command   string            `json:"command"`
	Terminal  string            `json:"terminal,omitempty"`
	TimeoutMS *int64            `json:"timeoutMs,omitempty"`
	Secrets   map[string]string `json:"secrets,omitempty"`
}

// ExecResult returns command output.
type ExecResult struct {
	Stdout     string `json:"stdout,omitempty"`
	Stderr     string `json:"stderr,omitempty"`
	StatusCode *int32 `json:"statusCode,omitempty"`
}

// StartRequest configures resume/start behavior.
type StartRequest struct {
	// EgressProxy reauthorizes a retained sandbox with operation-scoped secrets.
	// The controller forwards it to the worker without persisting the values.
	EgressProxy            *EgressProxyPolicy `json:"egressProxy,omitempty"`
	ActivityThresholdBytes *int64             `json:"activityThresholdBytes,omitempty"`
	IdleTimeoutSeconds     *int64             `json:"idleTimeoutSeconds,omitempty"`
	ReadyTimeoutSeconds    *int64             `json:"readyTimeoutSeconds,omitempty"`
	WaitForReady           *bool              `json:"waitForReady,omitempty"`
}

// StartResult is returned when a sandbox is resumed or started.
type StartResult struct {
	ID            string        `json:"id"`
	RuntimeID     string        `json:"runtimeId"`
	GuestIP       string        `json:"guestIp,omitempty"`
	HostIP        string        `json:"hostIp,omitempty"`
	NetNS         string        `json:"netns,omitempty"`
	IngressIP     string        `json:"ingressIp,omitempty"`
	IngressIPv6   string        `json:"ingressIpv6,omitempty"`
	Ports         []PortBinding `json:"ports,omitempty"`
	PostBootError string        `json:"postBootError,omitempty"`
}

// StopResult is returned when a sandbox is stopped.
type StopResult struct {
	SandboxID string `json:"sandboxId"`
	RuntimeID string `json:"runtimeId"`
}

// SuspendResult is returned when a sandbox is suspended.
type SuspendResult struct {
	ID                string `json:"id"`
	RuntimeID         string `json:"runtimeId"`
	RuntimeSnapshotID string `json:"runtimeSnapshotId,omitempty"`
}

// SnapshotRequest creates a reusable snapshot from a stopped sandbox.
type SnapshotRequest struct {
	Name string `json:"name,omitempty"`
}

// SnapshotResult is returned after snapshotting a VM.
type SnapshotResult struct {
	SnapshotID      string `json:"snapshotId"`
	SourceSandboxID string `json:"sourceSandboxId"`
	SourceRuntimeID string `json:"sourceRuntimeId,omitempty"`
}

// CreateSnapshotRequest creates a snapshot from a template.
type CreateSnapshotRequest struct {
	Name                string               `json:"name,omitempty"`
	SnapshotPersistence *SnapshotPersistence `json:"snapshotPersistence,omitempty"`
	Template            Template             `json:"template"`
}

// CreateSnapshotResponse returns the created snapshot identifier.
type CreateSnapshotResponse struct {
	SnapshotID string `json:"snapshotId"`
}

// WriteFileRequest writes a file into an existing sandbox.
type WriteFileRequest struct {
	Content string `json:"content"`
}

// CreateServiceResult is returned after creating a service.
type CreateServiceResult struct {
	Success     bool   `json:"success"`
	Message     string `json:"message"`
	ServiceName string `json:"serviceName"`
}

// Identity represents a sandbox access identity.
type Identity struct {
	ID      string `json:"id"`
	Managed bool   `json:"managed"`
}

// CreatedToken is returned after minting an identity token.
type CreatedToken struct {
	ID    string `json:"id"`
	Token string `json:"token"`
}

// GrantAccessRequest scopes an identity to a sandbox.
type GrantAccessRequest struct {
	AllowedUsers []string `json:"allowedUsers,omitempty"`
}

// AccessGrant describes identity access to a sandbox.
type AccessGrant struct {
	ID           string   `json:"id,omitempty"`
	AllowedUsers []string `json:"allowedUsers,omitempty"`
}
