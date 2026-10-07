package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

const gitHubAppLocalOrigin = "http://localhost:4000"
const gitHubAppConversionLock int64 = 344001

var gitHubAppComponent = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$`)

// GitHubAppManifest is the browser POST contract defined by GitHub.
type GitHubAppManifest struct {
	Name               string                   `json:"name"`
	URL                string                   `json:"url"`
	RedirectURL        string                   `json:"redirect_url"`
	SetupURL           string                   `json:"setup_url"`
	CallbackURLs       []string                 `json:"callback_urls"`
	Public             bool                     `json:"public"`
	HookAttributes     *GitHubAppHookAttributes `json:"hook_attributes,omitempty"`
	DefaultPermissions map[string]string        `json:"default_permissions"`
	DefaultEvents      []string                 `json:"default_events,omitempty"`
	// SetupOnUpdate returns the owner to SetupURL after they change the
	// installation's repositories on GitHub, so the install lists them again
	// without the installation webhook a non-public address never receives.
	SetupOnUpdate bool `json:"setup_on_update"`
}
type GitHubAppHookAttributes struct {
	URL    string `json:"url"`
	Active bool   `json:"active"`
}
type GitHubAppManifestRequest struct {
	OwnerLogin string `json:"owner_login"`
	OwnerKind  string `json:"owner_kind"`
	Repository string `json:"repository"`
	Resume     bool   `json:"resume,omitempty"`
	Origin     string `json:"origin,omitempty"`
}
type GitHubAppManifestStart struct {
	InstallURL string            `json:"install_url,omitempty"`
	ActionURL  string            `json:"action_url"`
	Manifest   GitHubAppManifest `json:"manifest"`
	State      string            `json:"state"`
}

func gitHubAppPermissions() map[string]string {
	// emails: GitHub answers the owner's /user/emails read 403 without it. A
	// manifest names this permission "emails"; GitHub refuses the REST name
	// "email_addresses" ("Default permission records resource is not included
	// in the list"), proven on github.com 2026-10-05.
	return map[string]string{"contents": "write", "emails": "read", "workflows": "write", "pull_requests": "write", "issues": "write", "checks": "read", "statuses": "read", "administration": "read", "metadata": "read", "members": "read"}
}

func gitHubAppWebhookEvents() []string {
	return []string{"issues", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment", "push", "check_run", "check_suite", "status"}
}

// cgnat is RFC 6598 shared address space (Tailscale among others): never public.
var cgnat = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

// publicHTTPSOrigin reports whether GitHub can deliver webhooks to origin.
// GitHub refuses a manifest whose hook is not reachable over the public
// Internet, so loopback, private, .local and single-label hosts never qualify.
func publicHTTPSOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" {
		return false
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsGlobalUnicast() && !ip.IsPrivate() && !cgnat.Contains(ip)
	}
	if !strings.Contains(host, ".") {
		return false
	}
	for _, suffix := range []string{".localhost", ".local", ".internal", ".lan", ".home.arpa"} {
		if strings.HasSuffix(host, suffix) {
			return false
		}
	}
	return true
}

func normalizedGitHubAppOrigins(origins []string) ([]string, error) {
	result := make([]string, 0, len(origins)+1)
	seen := map[string]bool{}
	for _, origin := range append(append([]string(nil), origins...), gitHubAppLocalOrigin) {
		u, err := url.Parse(origin)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
			return nil, pkgerrors.BadRequest("invalid GitHub App callback origin")
		}
		origin = middleware.CanonicalOrigin(origin)
		if !seen[origin] {
			result = append(result, origin)
			seen[origin] = true
		}
	}
	if len(result) > 10 {
		return nil, pkgerrors.BadRequest("GitHub supports at most 10 callback URLs")
	}
	return result, nil
}

func BuildGitHubAppManifest(ownerLogin, ownerKind string, origins []string, state string) (GitHubAppManifest, string, error) {
	if !gitHubAppComponent.MatchString(ownerLogin) || (ownerKind != "user" && ownerKind != "org") {
		return GitHubAppManifest{}, "", pkgerrors.BadRequest("invalid GitHub repository owner")
	}
	callbacks, err := normalizedGitHubAppOrigins(origins)
	if err != nil {
		return GitHubAppManifest{}, "", err
	}
	// The first configured public https origin receives webhooks. Without one
	// the App has no hook and no events: GitHub refuses a hook it cannot reach.
	var hook *GitHubAppHookAttributes
	for _, origin := range callbacks {
		if publicHTTPSOrigin(origin) {
			hook = &GitHubAppHookAttributes{URL: origin + "/webhooks/github", Active: false}
			break
		}
	}
	for i := range callbacks {
		callbacks[i] += "/api/auth/github/callback"
	}
	suffix := make([]byte, 4)
	// crypto/rand.Read fills the buffer or terminates the process (Go 1.26).
	rand.Read(suffix)
	manifest := GitHubAppManifest{Name: "Smithers " + hex.EncodeToString(suffix), URL: gitHubAppLocalOrigin, RedirectURL: gitHubAppLocalOrigin + "/setup/github/callback", SetupURL: gitHubAppLocalOrigin + "/setup/github/installed", SetupOnUpdate: true, CallbackURLs: callbacks, HookAttributes: hook, DefaultPermissions: gitHubAppPermissions()}
	if hook != nil {
		manifest.DefaultEvents = gitHubAppWebhookEvents()
	}
	action := "https://github.com/settings/apps/new"
	if ownerKind == "org" {
		action = "https://github.com/organizations/" + url.PathEscape(ownerLogin) + "/settings/apps/new"
	}
	return manifest, action + "?state=" + url.QueryEscape(state), nil
}

type GitHubAppManifestService struct {
	Now        func() time.Time
	pool       *pgxpool.Pool
	store      *GitHubAppCredentialStore
	apiBaseURL string
	// origins are the install's known origins, read when an App is created
	// so its callback URLs follow the saved Address (M-28).
	origins func() []string
	client  *http.Client
}

type GitHubAppManifestOption func(*GitHubAppManifestService)

// WithGitHubAppManifestBudget preserves setup's redirect policy while sharing
// admission with other GitHub clients in this installation.
func WithGitHubAppManifestBudget(budget *BudgetTracker) GitHubAppManifestOption {
	return func(s *GitHubAppManifestService) { s.client = budget.WrapClient(s.client) }
}

func NewGitHubAppManifestService(pool *pgxpool.Pool, store *GitHubAppCredentialStore, apiBaseURL string, origins func() []string, options ...GitHubAppManifestOption) *GitHubAppManifestService {
	if apiBaseURL == "" {
		apiBaseURL = "https://api.github.com"
	}
	s := &GitHubAppManifestService{pool: pool, store: store, apiBaseURL: strings.TrimRight(apiBaseURL, "/"), origins: origins, client: &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	for _, option := range options {
		option(s)
	}
	return s
}

func (s *GitHubAppManifestService) knownOrigins() []string {
	if s.origins == nil {
		return nil
	}
	return s.origins()
}

// Setup session values are transient request context; only their digest is persisted.
type gitHubAppSetupSessionKey struct{}
type gitHubAppSetupSession struct {
	digest string
	origin string
}

func WithGitHubAppSetupSession(ctx context.Context, session, origin string) context.Context {
	return context.WithValue(ctx, gitHubAppSetupSessionKey{}, gitHubAppSetupSession{digest: GitHubAppStateDigest(session), origin: origin})
}
func GitHubAppStateDigest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func setupSession(ctx context.Context) (gitHubAppSetupSession, error) {
	session, ok := ctx.Value(gitHubAppSetupSessionKey{}).(gitHubAppSetupSession)
	if !ok || session.digest == GitHubAppStateDigest("") || session.origin == "" {
		return session, pkgerrors.Forbidden("setup session required")
	}
	return session, nil
}
func (s *GitHubAppManifestService) Begin(ctx context.Context, req GitHubAppManifestRequest) (GitHubAppManifestStart, error) {
	if s == nil || s.pool == nil || s.store == nil {
		return GitHubAppManifestStart{}, pkgerrors.Internal("GitHub App setup is unavailable")
	}
	if _, err := s.store.Load(ctx); err == nil {
		if !req.Resume {
			return GitHubAppManifestStart{}, pkgerrors.Conflict("GitHub App is already configured")
		}
		location, err := s.store.InstallURL(ctx)
		return GitHubAppManifestStart{InstallURL: location}, err
	} else if !errors.Is(err, ErrGitHubAppNotConfigured) {
		return GitHubAppManifestStart{}, err
	}
	if req.Repository != "" && !gitHubAppComponent.MatchString(req.Repository) {
		return GitHubAppManifestStart{}, pkgerrors.BadRequest("invalid GitHub repository")
	}
	session, err := setupSession(ctx)
	if err != nil {
		return GitHubAppManifestStart{}, err
	}
	origin := req.Origin
	if origin == "" {
		origin = gitHubAppLocalOrigin
	}
	known := s.knownOrigins()
	origins, err := normalizedGitHubAppOrigins(known)
	if err != nil {
		return GitHubAppManifestStart{}, err
	}
	allowed := false
	for _, value := range origins {
		if origin == value {
			allowed = true
		}
	}
	if !allowed {
		return GitHubAppManifestStart{}, pkgerrors.BadRequest("GitHub App setup origin is not configured")
	}
	random := make([]byte, 32)
	rand.Read(random)
	state := hex.EncodeToString(random)
	if req.OwnerKind == "" {
		var account struct {
			Type string `json:"type"`
		}
		if !gitHubAppComponent.MatchString(req.OwnerLogin) {
			return GitHubAppManifestStart{}, pkgerrors.BadRequest("invalid GitHub owner")
		}
		if err := requestGitHubApp(ctx, s.client, s.apiBaseURL, "", http.MethodGet, "/users/"+url.PathEscape(req.OwnerLogin), &account); err != nil {
			return GitHubAppManifestStart{}, err
		}
		switch account.Type {
		case "User":
			req.OwnerKind = "user"
		case "Organization":
			req.OwnerKind = "org"
		default:
			return GitHubAppManifestStart{}, pkgerrors.BadRequest("unsupported GitHub owner")
		}
	}
	manifest, action, err := BuildGitHubAppManifest(req.OwnerLogin, req.OwnerKind, known, state)
	if err != nil {
		return GitHubAppManifestStart{}, err
	}
	manifest.RedirectURL = origin + "/setup/github/callback"
	manifest.SetupURL = origin + "/setup/github/installed?state=" + url.QueryEscape(state)
	manifest.URL = origin
	callbackURLs, _ := json.Marshal(manifest.CallbackURLs) // A string slice always encodes.
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return GitHubAppManifestStart{}, err
	}
	defer tx.Rollback(context.Background())
	// Serialize expired-lease takeover with conversions through their remote exchange.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", gitHubAppConversionLock); err != nil {
		return GitHubAppManifestStart{}, err
	}

	_, err = tx.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES('setup.step.app_manifest','{"status":"pending"}') ON CONFLICT DO NOTHING`)
	if err != nil {
		return GitHubAppManifestStart{}, err
	}
	step, err := (&InstallSetupService{}).readStep(ctx, db.New(tx), "app_manifest")
	if err != nil {
		return GitHubAppManifestStart{}, err
	}
	if step.Error != nil && step.Error.Code == "outcome_unknown" {
		return GitHubAppManifestStart{}, pkgerrors.Conflict("Recover the existing GitHub App credentials")
	}
	if step.OperationID != "" {
		var live bool
		err = tx.QueryRow(ctx, installWorkerLive, step.OperationID).Scan(&live)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return GitHubAppManifestStart{}, err
		}
		if live {
			return GitHubAppManifestStart{}, pkgerrors.Conflict("GitHub App setup is already running or complete")
		}
	}
	if !installStepCanStart(step, setupNow(s.Now)) {
		return GitHubAppManifestStart{}, pkgerrors.Conflict("GitHub App setup is already running or complete")
	}
	jobStore, err := jobs.NewStore(s.pool)
	if err != nil {
		return GitHubAppManifestStart{}, err
	}
	operationID := step.OperationID
	if operationID == "" {
		payload, _ := json.Marshal(InstallSetupInput{Owner: req.OwnerLogin})
		receipt, err := jobStore.AdmitInTx(ctx, tx, jobs.Admission{Scope: jobs.Scope{TenantID: "install", PrincipalID: "owner"}, Operation: "install.setup.app_manifest", RequestID: GitHubAppStateDigest(state), Payload: payload, EffectPolicy: jobs.EffectReconcile})
		if err != nil {
			return GitHubAppManifestStart{}, err
		}
		operationID = receipt.OperationID
	}
	step.OperationID, step.Attempt = operationID, step.Attempt+1
	expires := setupNow(s.Now).Add(10 * time.Minute)
	result, err := tx.Exec(ctx, `UPDATE install_settings SET value=jsonb_build_object('status','running','digest',$1::text,'expires_at',$2::timestamptz,'operation_id',$3::text,'attempt',$4::int), updated_at=now() WHERE key='setup.step.app_manifest'`, GitHubAppStateDigest(state), expires, step.OperationID, step.Attempt)
	if err != nil {
		return GitHubAppManifestStart{}, err
	}
	if result.RowsAffected() != 1 {
		return GitHubAppManifestStart{}, pkgerrors.Conflict("GitHub App setup is already running or complete")
	}
	_, err = db.New(tx).CreateGithubAppManifestState(ctx, db.CreateGithubAppManifestStateParams{Digest: GitHubAppStateDigest(state), SetupSessionDigest: session.digest, OwnerLogin: req.OwnerLogin, OwnerKind: req.OwnerKind, RepositoryName: req.Repository, Origin: origin, CallbackUrls: callbackURLs, ExpiresAt: expires})
	if err != nil {
		return GitHubAppManifestStart{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return GitHubAppManifestStart{}, err
	}
	return GitHubAppManifestStart{ActionURL: action, Manifest: manifest, State: state}, nil
}

func validateGitHubAppBrowserState(state, browserState string) error {
	if len(state) != 64 || len(browserState) != 64 || subtle.ConstantTimeCompare([]byte(state), []byte(browserState)) != 1 {
		return pkgerrors.Forbidden("invalid GitHub App setup state")
	}
	return nil
}

// ValidateCallbackOrigin binds a browser round trip to its original listener,
// including the port, which host cookies alone cannot distinguish.
func (s *GitHubAppManifestService) ValidateCallbackOrigin(ctx context.Context, state, origin string) error {
	if s == nil || s.pool == nil {
		return pkgerrors.Internal("GitHub App setup is unavailable")
	}
	attempt, err := db.New(s.pool).GetGithubAppManifestState(ctx, GitHubAppStateDigest(state))
	if errors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.Forbidden("invalid GitHub App setup state")
	}
	if err != nil {
		return err
	}
	session, sessionErr := setupSession(ctx)
	if sessionErr != nil {
		return sessionErr
	}
	if subtle.ConstantTimeCompare([]byte(attempt.SetupSessionDigest), []byte(session.digest)) != 1 || installStepCanStart(InstallStep{Status: InstallRunning, ExpiresAt: attempt.ExpiresAt}, setupNow(s.Now)) {
		return pkgerrors.Forbidden("invalid or expired setup session")
	}
	if subtle.ConstantTimeCompare([]byte(attempt.Digest), []byte(GitHubAppStateDigest(state))) != 1 {
		return pkgerrors.Forbidden("invalid GitHub App setup state")
	}
	if !attempt.UsedAt.Valid {
		if err := s.validateAttemptLease(ctx, db.New(s.pool), state); err != nil {
			return err
		}
	}
	if attempt.Origin != origin || session.origin != origin {
		return pkgerrors.Forbidden("GitHub App setup callback origin changed")
	}
	return nil
}

// The conversion lock serializes this check with Begin's takeover. Refusal
// leaves the durable step and the single-use conversion state untouched.
func (s *GitHubAppManifestService) validateAttemptLease(ctx context.Context, q *db.Queries, state string) error {
	row, err := q.GetInstallSetting(ctx, "setup.step.app_manifest")
	if err != nil {
		return err
	}
	var step struct {
		InstallStep
		Digest string `json:"digest"`
	}
	if err = json.Unmarshal(row.Value, &step); err != nil {
		return err
	}
	if step.Status != InstallRunning || installStepCanStart(step.InstallStep, setupNow(s.Now)) || step.Digest != GitHubAppStateDigest(state) {
		return pkgerrors.Forbidden("GitHub App setup state is used or expired")
	}
	return nil
}

type gitHubAppConversion struct {
	ID            int64  `json:"id"`
	Slug          string `json:"slug"`
	PEM           string `json:"pem"`
	ClientID      string `json:"client_id"`
	ClientSecret  string `json:"client_secret"`
	WebhookSecret string `json:"webhook_secret"`
	Owner         struct {
		Login string `json:"login"`
		Type  string `json:"type"`
	} `json:"owner"`
}

// Convert runs the browser conversion under its admitted Go job lease. State
// consumption precedes GitHub; sealed outcomes reconcile without another call.
func (s *GitHubAppManifestService) Convert(ctx context.Context, code, state, browserState string) (string, error) {
	if err := validateGitHubAppBrowserState(state, browserState); err != nil {
		return "", err
	}
	if strings.TrimSpace(code) == "" || len(code) > 512 {
		return "", pkgerrors.BadRequest("invalid GitHub App conversion code")
	}
	if s == nil || s.pool == nil || s.store == nil {
		return "", pkgerrors.Internal("GitHub App setup is unavailable")
	}
	// A Go job claim serializes conversion and fences its completion. No
	// connection remains occupied across GitHub, including a one-connection pool.
	conn := s.pool
	jobStore, err := jobs.NewStore(s.pool)
	if err != nil {
		return "", err
	}
	if _, err = jobStore.RecoverExpiredForOperations(ctx, []string{"install.setup.app_manifest"}, 1); err != nil {
		return "", err
	}
	store := *s.store
	store.q = db.New(conn)
	if _, err = store.Load(ctx); err == nil {
		return "", pkgerrors.Conflict("GitHub App is already configured")
	} else if !errors.Is(err, ErrGitHubAppNotConfigured) {
		return "", err
	}
	session, err := setupSession(ctx)
	if err != nil {
		return "", err
	}
	if err = s.validateAttemptLease(ctx, db.New(conn), state); err != nil {
		return "", err
	}
	step, err := (&InstallSetupService{}).readStep(ctx, db.New(conn), "app_manifest")
	if err != nil {
		return "", err
	}
	stateRecord, err := db.New(conn).GetGithubAppManifestState(ctx, GitHubAppStateDigest(state))
	if err == nil && stateRecord.SetupSessionDigest == session.digest && stateRecord.Origin == session.origin && stateRecord.UsedAt.Valid {
		var live bool
		if liveErr := conn.QueryRow(ctx, installWorkerLive, step.OperationID).Scan(&live); liveErr == nil && live {
			return "", pkgerrors.Conflict("GitHub App conversion is already running")
		}
	}
	if err != nil || stateRecord.SetupSessionDigest != session.digest || stateRecord.Origin != session.origin || stateRecord.UsedAt.Valid || !stateRecord.ExpiresAt.After(time.Now()) {
		return "", pkgerrors.Forbidden("GitHub App setup state is used or expired")
	}
	claim, err := jobStore.ClaimOperation(ctx, "app-conversion-"+uuid.NewString(), time.Minute, step.OperationID)
	if errors.Is(err, jobs.ErrNoWork) {
		return "", pkgerrors.Conflict("GitHub App conversion is already running")
	}
	if err != nil {
		return "", err
	}
	if claim.OperationID != step.OperationID {
		return "", jobs.ErrClaimLost
	}
	if _, err = jobStore.BeginExternal(ctx, claim, json.RawMessage(`{"phase":"app_conversion"}`)); err != nil {
		return "", err
	}
	// Recheck browser authority after the admission lock wait, before consuming.
	admission, err := conn.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer admission.Rollback(context.Background())
	if _, err = admission.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", gitHubAppConversionLock); err != nil {
		return "", err
	}
	if err = s.validateAttemptLease(ctx, db.New(admission), state); err != nil {
		return "", err
	}
	attempt, err := db.New(admission).ConsumeGithubAppManifestState(ctx, db.ConsumeGithubAppManifestStateParams{Digest: GitHubAppStateDigest(state), SetupSessionDigest: session.digest, Origin: session.origin})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", pkgerrors.Forbidden("GitHub App setup state is used or expired")
	}
	if err != nil {
		return "", err
	}

	if err = admission.Commit(ctx); err != nil {
		return "", err
	}
	var callbackURLs []string
	if json.Unmarshal(attempt.CallbackUrls, &callbackURLs) != nil || len(callbackURLs) == 0 {
		return "", pkgerrors.Internal("invalid GitHub App manifest state")
	}
	if _, err := validateGitHubAppCallbackURLs(callbackURLs); err != nil {
		return "", pkgerrors.Internal("invalid GitHub App manifest state").WithCause(err)
	}
	var converted gitHubAppConversion
	if err = requestGitHubApp(ctx, s.client, s.apiBaseURL, "", http.MethodPost, "/app-manifests/"+url.PathEscape(code)+"/conversions", &converted); err != nil {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if parkErr := jobStore.Park(cleanup, claim, json.RawMessage(`{"phase":"outcome_unknown"}`), 24*time.Hour); parkErr != nil {
			return "", parkErr
		}
		return "", err
	}
	convertedJSON, err := json.Marshal(converted)
	if err != nil {
		return "", err
	}
	sealed, err := s.store.codec.EncryptString(string(convertedJSON))
	if err != nil {
		return "", err
	}
	checkpoint, _ := json.Marshal(map[string]string{"sealed_conversion": sealed})
	if _, err = jobStore.Checkpoint(ctx, claim, checkpoint); err != nil {
		return "", err
	}
	return s.completeConversion(ctx, jobStore, claim, step, converted)
}

func (s *GitHubAppManifestService) completeConversion(ctx context.Context, jobStore *jobs.Store, claim jobs.Claim, step InstallStep, converted gitHubAppConversion) (string, error) {
	conn := s.pool
	store := *s.store
	store.q = db.New(conn)
	attempt, err := db.New(conn).GetGithubAppManifestState(ctx, step.Digest)
	if err != nil {
		return "", err
	}
	var callbackURLs []string
	if json.Unmarshal(attempt.CallbackUrls, &callbackURLs) != nil || len(callbackURLs) == 0 {
		return "", pkgerrors.Internal("invalid GitHub App manifest state")
	}
	if _, err = validateGitHubAppCallbackURLs(callbackURLs); err != nil {
		return "", err
	}
	var kind string
	switch converted.Owner.Type {
	case "User":
		kind = "user"
	case "Organization":
		kind = "org"
	default:
		return "", pkgerrors.New(pkgerrors.CodeGitHubUnavailable, "invalid GitHub App owner")
	}
	if !strings.EqualFold(attempt.OwnerLogin, converted.Owner.Login) || attempt.OwnerKind != kind {
		return "", pkgerrors.Forbidden("GitHub App belongs to another repository owner")
	}
	// GitHub returns no webhook secret for an App created without a hook. The
	// install seals its own, so a later hook configuration can verify deliveries.
	if converted.WebhookSecret == "" {
		secret := make([]byte, 32)
		rand.Read(secret)
		converted.WebhookSecret = hex.EncodeToString(secret)
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(context.Background())

	// Completion may write only while this attempt still owns the durable step.
	result, err := tx.Exec(ctx, `UPDATE install_settings SET value='{"status":"done"}',updated_at=now() WHERE key='setup.step.app_manifest' AND value->>'status'='running' AND value->>'digest'=$1`, step.Digest)
	if err != nil {
		return "", err
	}
	if result.RowsAffected() != 1 {
		return "", pkgerrors.Conflict("GitHub App setup attempt was replaced")
	}
	store.q = db.New(tx)
	if err = store.Save(ctx, GitHubAppCredentials{ID: converted.ID, Slug: converted.Slug, OwnerLogin: converted.Owner.Login, OwnerKind: kind, ClientID: converted.ClientID, PEM: converted.PEM, ClientSecret: converted.ClientSecret, WebhookSecret: converted.WebhookSecret}); err != nil {
		return "", err
	}
	if err = store.SaveCallbackURLs(ctx, callbackURLs); err != nil {
		return "", err
	}
	// Once the singleton App exists, only its successful attempt may record
	// the installation. Failed or pending attempts for the same owner must not
	// choose a different repository for this App.
	if err = db.New(tx).DeleteOtherGithubAppManifestStates(ctx, step.Digest); err != nil {
		return "", err
	}
	repository, _ := json.Marshal(map[string]string{"owner_login": attempt.OwnerLogin, "owner_kind": attempt.OwnerKind, "repository_name": attempt.RepositoryName})
	if err = db.New(tx).UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: repository}); err != nil {
		return "", err
	}
	step.Status, step.ExpiresAt, step.Error = InstallReady, time.Time{}, nil
	step.Attempt = claim.Attempt
	completion, _ := json.Marshal(step)
	if err = jobStore.SettleInTx(ctx, tx, claim, completion, false); err != nil {
		return "", err
	}
	if err = saveInstallStep(ctx, tx, step); err != nil {
		return "", err
	}
	if err = db.New(tx).UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.projection.app_manifest", Value: []byte(`{"status":"done"}`)}); err != nil {
		return "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	store.q = db.New(conn)
	return store.InstallURL(ctx)
}

// ResumeInstallation never extends or replays conversion state. The repository
// binding is written only by the successful local conversion transaction.
func (s *GitHubAppManifestService) ResumeInstallation(ctx context.Context) error {
	if s == nil || s.pool == nil || s.store == nil {
		return pkgerrors.Internal("GitHub App setup is unavailable")
	}
	repository, err := db.New(s.pool).ReadInstallRepositoryBinding(ctx)
	if err != nil {
		return err
	}
	if !gitHubAppComponent.MatchString(repository.Owner) || (repository.Name != "" && !gitHubAppComponent.MatchString(repository.Name)) {
		return pkgerrors.Internal("invalid GitHub repository binding")
	}
	if repository.Name == "" {
		return nil
	} // Repository selection discovers the installation server-side.
	return s.discoverInstallation(ctx, db.GithubAppManifestState{OwnerLogin: repository.Owner, OwnerKind: repository.OwnerKind, RepositoryName: repository.Name})
}
func (s *GitHubAppManifestService) discoverInstallation(ctx context.Context, attempt db.GithubAppManifestState) error {
	creds, err := s.store.Load(ctx)
	if err != nil {
		return err
	}
	if !strings.EqualFold(creds.OwnerLogin, attempt.OwnerLogin) || creds.OwnerKind != attempt.OwnerKind {
		return pkgerrors.Forbidden("GitHub App belongs to another repository owner")
	}
	jwt, err := s.store.AppJWT(ctx)
	if err != nil {
		return err
	}
	installation, found, err := fetchRepoInstallation(ctx, s.client, s.apiBaseURL, jwt, attempt.OwnerLogin, attempt.RepositoryName)
	if err != nil {
		return err
	}
	if found && strings.EqualFold(installation.Account.Login, attempt.OwnerLogin) {
		return s.store.SetInstallation(ctx, installation.ID)
	}
	return pkgerrors.Forbidden("GitHub App is not installed on the repository")
}

// ReconcileConversion commits a sealed post-effect receipt after process loss.
// It never exchanges the one-time code again and never steals a live claim.
func (s *GitHubAppManifestService) ReconcileConversion(ctx context.Context) error {
	var operation string
	err := s.pool.QueryRow(ctx, `SELECT operation_id FROM product_job_dispatches WHERE operation_id=(SELECT (value->>'operation_id')::uuid FROM install_settings WHERE key='setup.step.app_manifest') AND external_receipt ? 'sealed_conversion' AND (status='ready' OR (status='claimed' AND lease_expires_at<=clock_timestamp()))`).Scan(&operation)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	store, err := jobs.NewStore(s.pool)
	if err != nil {
		return err
	}
	if _, err = store.RecoverExpiredForOperations(ctx, []string{"install.setup.app_manifest"}, 1); err != nil {
		return err
	}
	claim, err := store.ClaimOperation(ctx, "app-reconcile-"+uuid.NewString(), time.Minute, operation)
	if err != nil {
		return err
	}
	if claim.OperationID != operation {
		return jobs.ErrClaimLost
	}
	var checkpoint struct {
		Sealed string `json:"sealed_conversion"`
	}
	if json.Unmarshal(claim.ExternalReceipt, &checkpoint) != nil || checkpoint.Sealed == "" {
		return pkgerrors.Internal("invalid App conversion receipt")
	}
	raw, err := s.store.codec.DecryptString(checkpoint.Sealed)
	if err != nil {
		return pkgerrors.Internal("unreadable App conversion receipt")
	}
	var converted gitHubAppConversion
	if json.Unmarshal([]byte(raw), &converted) != nil {
		return pkgerrors.Internal("invalid App conversion receipt")
	}
	row, err := db.New(s.pool).GetInstallSetting(ctx, "setup.step.app_manifest")
	if err != nil {
		return err
	}
	var step InstallStep
	if err = json.Unmarshal(row.Value, &step); err != nil {
		return err
	}
	if step.OperationID != claim.OperationID {
		return jobs.ErrClaimLost
	}
	_, err = s.completeConversion(ctx, store, claim, step, converted)
	return err
}
