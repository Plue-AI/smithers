package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox/sandboxfake"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// isolationCanary marks every string alice owns. No response to bob may
// contain it, whatever its status.
const isolationCanary = "zq-alice-private-canary"

func canary(kind string) string { return isolationCanary + "-" + kind }

// isolationTenant is one account and every resource the sweep aims at.
type isolationTenant struct {
	user          db.User
	token         string
	repo          db.Repository
	org           db.Organization
	orgRepo       db.Repository
	team          db.Team
	issue         db.Issue
	landing       db.LandingRequest
	label         db.Label
	wiki          db.WikiPage
	webhook       db.Webhook
	run           db.WorkflowRun
	definition    db.WorkflowDefinition
	workspace     db.Workspace
	agentSession  db.AgentSession
	timeline      db.AppTimeline
	notification  db.Notification
	sshKey        db.SshKey
	tokenRow      db.AccessToken
	emailID       int64
	connection    db.ProviderConnection
	transfer      db.RepositoryTransferRequest
	changeset     db.Changeset
	secretName    string
	variableName  string
	orgSecretName string
}

// isolationRepoHost is the remote repository engine. It records every path so
// the sweep can prove no denied request reached alice's repository storage.
type isolationRepoHost struct {
	mu    sync.Mutex
	paths []string
}

func (h *isolationRepoHost) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/health" {
		w.WriteHeader(http.StatusOK)
		return
	}
	h.mu.Lock()
	h.paths = append(h.paths, r.Method+" "+r.URL.RequestURI())
	h.mu.Unlock()
	http.NotFound(w, r)
}

func (h *isolationRepoHost) take() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	paths := h.paths
	h.paths = nil
	return paths
}

// startIsolationProduct runs the full multitenant product composition over a
// fresh product database, with every feature family mounted.
func startIsolationProduct(t *testing.T) (*pgxpool.Pool, *httptest.Server, *isolationRepoHost) {
	t.Helper()
	pool, databaseURL := postgresfixture.NewProductDatabase(t)
	repoHost := &isolationRepoHost{}
	repoHostServer := httptest.NewServer(repoHost)
	t.Cleanup(repoHostServer.Close)
	env := map[string]string{
		"SMITHERS_AUTH_MODE":                     "multitenant",
		"SMITHERS_BILLING_MODE":                  "metered",
		"SMITHERS_DATABASE_URL":                  databaseURL,
		"SMITHERS_PUBLIC_URL":                    "http://127.0.0.1:4000",
		"SMITHERS_AUTH_GITHUB_REDIRECT_URL":      "http://localhost:4000/api/auth/github/callback",
		"SMITHERS_SERVER_ADDR":                   "127.0.0.1:0",
		"SMITHERS_SERVER_SHUTDOWN_TIMEOUT":       "10s",
		"SMITHERS_REPO_HOST_URL":                 repoHostServer.URL,
		"SMITHERS_REPO_HOST_AUTH_TOKEN":          "isolation-repo",
		"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN":      "isolation-callback",
		"SMITHERS_AUTH_SESSION_SECRET":           "isolation-session-secret",
		"SMITHERS_LFS_SIGNING_SECRET":            "isolation-lfs-secret",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "isolation-webhook-key",
		"SMITHERS_BLOB_DATA_DIR":                 t.TempDir(),
		"SMITHERS_OTEL_EXPORTER":                 "none",
		"SMITHERS_METRICS_TOKEN":                 "isolation-metrics",
		"SMITHERS_METRICS_ADDR":                  "",
		"SMITHERS_REMOTE_SANDBOX_ENABLED":        "true",
		"SMITHERS_APPROVALS_FLOW_ENABLED":        "true",
		"SMITHERS_DEVTOOLS_SNAPSHOT_ENABLED":     "true",
		"SMITHERS_RUN_SHAPE_ENABLED":             "true",
		"SMITHERS_SANDBOX_AGENT_SNAPSHOT_ID":     "isolation-agent-snapshot",
	}
	for _, flag := range []string{"READOUT_DASHBOARD", "LANDING_QUEUE", "TOOL_SKILLS", "TOOL_POLICIES", "REPO_SNAPSHOTS",
		"INTEGRATIONS", "SESSION_REPLAY", "SECRETS_MANAGER", "WEB_EDITOR", "STACKED_PRS", "WORKFLOWS", "SANDBOXES",
		"AUTO_PUSH", "ISSUES", "SEARCH", "WORKSPACES", "AGENTS", "WEB_DASHBOARD", "CHANGESETS", "SUBSCRIPTION_CONNECTIONS",
		"PROTECTED_BOOKMARKS", "NOTIFICATIONS", "WIKI", "LABELS", "RELEASES", "SECRETS", "WEBHOOKS_USER", "BOT_COMMANDS",
		"DRAFT_PRS", "REVIEWERS", "MULTI_AUTH", "PRIVATE_REPOS"} {
		env["SMITHERS_FEATURE_FLAGS_"+flag] = "true"
	}
	for name, value := range env {
		t.Setenv(name, value)
	}
	policy, err := admission.NewMetered(pool, admission.Config{Usage: admission.ProductUsage})
	require.NoError(t, err)
	handler := startSplitProcess(t, Options{Admission: policy, ComputeProvider: sandboxfake.New()})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return pool, server, repoHost
}

func isolationToken(t *testing.T, q *db.Queries, user db.User, name string) (string, db.AccessToken) {
	t.Helper()
	sum := sha256.Sum256([]byte("isolation-token-" + name))
	token := "smithers_" + hex.EncodeToString(sum[:])[:40]
	hash := sha256.Sum256([]byte(token))
	hashString := hex.EncodeToString(hash[:])
	row, err := q.CreateAccessToken(context.Background(), db.CreateAccessTokenParams{
		UserID: user.ID, Name: name, TokenHash: hashString, TokenLastEight: hashString[len(hashString)-8:],
		Scopes: "all", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
	})
	require.NoError(t, err)
	return token, row
}

// seedIsolationTenant gives one account a private repository, an organization
// and one row of every resource family the HTTP API addresses by identifier.
// The strings of the victim carry the canary; the attacker's carry none.
func seedIsolationTenant(t *testing.T, pool *pgxpool.Pool, name string, transferTo int64, mark func(string) string) isolationTenant {
	t.Helper()
	ctx := context.Background()
	q := db.New(pool)
	var tenant isolationTenant
	var err error
	tenant.user, err = q.CreateUser(ctx, db.CreateUserParams{Username: name, LowerUsername: name, DisplayName: name})
	require.NoError(t, err)
	tenant.token, tenant.tokenRow = isolationToken(t, q, tenant.user, name+"-all")
	tenant.repo, err = q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: tenant.user.ID, Valid: true},
		Name: name + "-repo", LowerName: name + "-repo", Description: mark("repo"), DefaultBookmark: "main"})
	require.NoError(t, err)
	tenant.org, err = q.CreateOrganization(ctx, db.CreateOrganizationParams{Name: name + "-org", LowerName: name + "-org", Description: mark("org"), Visibility: "private"})
	require.NoError(t, err)
	_, err = q.AddOrgMember(ctx, db.AddOrgMemberParams{OrganizationID: tenant.org.ID, UserID: tenant.user.ID, Role: "owner"})
	require.NoError(t, err)
	tenant.orgRepo, err = q.CreateOrgRepo(ctx, db.CreateOrgRepoParams{OrgID: pgtype.Int8{Int64: tenant.org.ID, Valid: true},
		Name: name + "-org-repo", LowerName: name + "-org-repo", Description: mark("org-repo"), DefaultBookmark: "main"})
	require.NoError(t, err)
	tenant.team, err = q.CreateTeam(ctx, db.CreateTeamParams{OrganizationID: tenant.org.ID, Name: name + "-team", LowerName: name + "-team", Description: mark("team"), Permission: "read"})
	require.NoError(t, err)
	tenant.issue, err = q.CreateIssue(ctx, db.CreateIssueParams{RepositoryID: tenant.repo.ID, Title: mark("issue"), Body: mark("issue-body"), AuthorID: tenant.user.ID, Kind: "issue", IdempotencyKey: name + "-issue"})
	require.NoError(t, err)
	tenant.landing, err = q.CreateLandingRequest(ctx, db.CreateLandingRequestParams{RepositoryID: tenant.repo.ID, Title: mark("landing"), Body: mark("landing-body"),
		AuthorID: tenant.user.ID, TargetBookmark: "main", SourceBookmark: "feature", StackSize: 1})
	require.NoError(t, err)
	tenant.label, err = q.CreateLabel(ctx, db.CreateLabelParams{RepositoryID: tenant.repo.ID, Name: mark("label"), Color: "#ff0000", Description: mark("label-description")})
	require.NoError(t, err)
	tenant.wiki, err = q.CreateWikiPage(ctx, db.CreateWikiPageParams{RepositoryID: tenant.repo.ID, Slug: name + "-page", Title: mark("wiki"), Body: mark("wiki-body"),
		AuthorID: tenant.user.ID, Visibility: "private", Path: name + "-page.md"})
	require.NoError(t, err)
	tenant.webhook, err = q.CreateWebhook(ctx, db.CreateWebhookParams{RepositoryID: tenant.repo.ID, Url: "https://hooks.example/" + mark("webhook"), Secret: mark("webhook-secret"), Events: []string{"push"}, IsActive: true})
	require.NoError(t, err)
	tenant.secretName = strings.ToUpper(strings.ReplaceAll(mark("secret"), "-", "_"))
	_, err = q.CreateOrUpdateSecret(ctx, db.CreateOrUpdateSecretParams{RepositoryID: tenant.repo.ID, Name: tenant.secretName, ValueEncrypted: []byte(mark("secret-value"))})
	require.NoError(t, err)
	tenant.variableName = strings.ToUpper(strings.ReplaceAll(mark("variable"), "-", "_"))
	_, err = q.CreateOrUpdateVariable(ctx, db.CreateOrUpdateVariableParams{RepositoryID: tenant.repo.ID, Name: tenant.variableName, Value: mark("variable-value")})
	require.NoError(t, err)
	tenant.orgSecretName = strings.ToUpper(strings.ReplaceAll(mark("org-secret"), "-", "_"))
	_, err = q.CreateOrUpdateOrgSecret(ctx, db.CreateOrUpdateOrgSecretParams{OrganizationID: tenant.org.ID, Name: tenant.orgSecretName, ValueEncrypted: []byte(mark("org-secret-value"))})
	require.NoError(t, err)
	_, err = q.CreateOrUpdateOrgVariable(ctx, db.CreateOrUpdateOrgVariableParams{OrganizationID: tenant.org.ID, Name: strings.ToUpper(strings.ReplaceAll(mark("org-variable"), "-", "_")), Value: mark("org-variable-value")})
	require.NoError(t, err)
	tenant.definition, err = q.CreateWorkflowDefinition(ctx, db.CreateWorkflowDefinitionParams{RepositoryID: tenant.repo.ID, Name: mark("workflow"), Path: ".smithers/" + name + ".ts", Config: json.RawMessage(`{}`)})
	require.NoError(t, err)
	tenant.run, err = q.CreateWorkflowRun(ctx, db.CreateWorkflowRunParams{RepositoryID: tenant.repo.ID, WorkflowDefinitionID: tenant.definition.ID, Status: "running",
		TriggerEvent: "manual", TriggerRef: mark("run-ref"), TriggerCommitSha: strings.Repeat("a", 40), DispatchInputs: []byte(`{}`), ExecutionPlane: "sandbox"})
	require.NoError(t, err)
	tenant.workspace, err = q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: tenant.repo.ID, UserID: tenant.user.ID, Name: mark("workspace"),
		TargetBookmark: "main", Kind: "container", EnvironmentSource: ".smithers/environment.nix", Status: "running"})
	require.NoError(t, err)
	tenant.agentSession, err = q.CreateAgentSession(ctx, db.CreateAgentSessionParams{ID: uuid.NewString(), RepositoryID: tenant.repo.ID, UserID: tenant.user.ID, Title: mark("agent-session"), Status: "active", Metadata: []byte(`{}`)})
	require.NoError(t, err)
	tenant.timeline, err = q.CreateAppTimeline(ctx, db.CreateAppTimelineParams{OwnerUserID: tenant.user.ID, ClientKey: mark("timeline")})
	require.NoError(t, err)
	tenant.notification, err = q.CreateNotification(ctx, db.CreateNotificationParams{SourceType: "issue", SourceID: pgtype.Int8{Int64: tenant.issue.ID, Valid: true}, Subject: mark("notification"), Body: mark("notification-body"), UserID: tenant.user.ID})
	require.NoError(t, err)
	tenant.sshKey, err = q.CreateSSHKey(ctx, db.CreateSSHKeyParams{UserID: tenant.user.ID, Name: mark("ssh-key"), PublicKey: "ssh-ed25519 AAAA" + name, Fingerprint: "SHA256:" + name, KeyType: "ssh-ed25519"})
	require.NoError(t, err)
	email, err := q.UpsertEmailAddress(ctx, db.UpsertEmailAddressParams{UserID: tenant.user.ID, Email: mark("email") + "@example.com", LowerEmail: mark("email") + "@example.com", IsPrimary: true, IsActivated: true})
	require.NoError(t, err)
	tenant.emailID = email.ID
	tenant.connection, err = q.CreateProviderConnection(ctx, db.CreateProviderConnectionParams{OwnerType: "user", UserID: pgtype.Int8{Int64: tenant.user.ID, Valid: true}, Provider: "claude", Kind: "api_key",
		Label: mark("connection"), AccountEmail: mark("connection-email"), AccessTokenEncrypted: []byte(mark("connection-token")), CreatedBy: pgtype.Int8{Int64: tenant.user.ID, Valid: true}})
	require.NoError(t, err)
	if transferTo != 0 {
		tenant.transfer, err = q.CreateRepositoryTransferRequest(ctx, db.CreateRepositoryTransferRequestParams{RepositoryID: tenant.orgRepo.ID, SenderID: tenant.user.ID, RecipientID: transferTo,
			SourceOrgID: pgtype.Int8{Int64: tenant.org.ID, Valid: true}, SourceOwner: tenant.org.Name, SourceName: tenant.orgRepo.Name})
		require.NoError(t, err)
	}
	tenant.changeset, err = q.CreateChangeset(ctx, db.CreateChangesetParams{OrganizationID: tenant.org.ID, SuperprojectRepositoryID: tenant.orgRepo.ID, ChangeID: "kkkkkkkk" + name,
		CommitID: strings.Repeat("b", 40), ParentChangeIds: json.RawMessage(`[]`), TargetBookmark: "main", Description: mark("changeset"), CreatedBy: pgtype.Int8{Int64: tenant.user.ID, Valid: true}})
	require.NoError(t, err)
	return tenant
}

type isolationResponse struct {
	status int
	body   string
}

// isolationRequest sends one request over real HTTP. Streams are cut after
// their first second: a denied stream never answers 200 at all.
func isolationRequest(t *testing.T, server *httptest.Server, token, method, path string, body []byte) isolationResponse {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, strings.ToUpper(method), server.URL+path, reader)
	require.NoError(t, err)
	// Address the configured browser origin through the ephemeral real HTTP
	// listener. Otherwise OAuth canonicalization leaves this fixture for port
	// 4000, and the transport error echoes our query rather than API data.
	req.Host = "localhost:4000"
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	// Inspect the actual route response; an OAuth handoff must not send our
	// account token to another listener or to GitHub.
	client := *server.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	require.NoError(t, err, "isolation probe must reach the real API")
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return isolationResponse{status: resp.StatusCode, body: string(data)}
}

var isolationParam = regexp.MustCompile(`\{([^}]+)\}`)

// fillIsolationPath replaces each {param} with the value the resolver picks
// for the path segment before it.
func fillIsolationPath(path string, value func(segment, param string) string) string {
	var out strings.Builder
	last := 0
	for _, match := range isolationParam.FindAllStringSubmatchIndex(path, -1) {
		prefix := strings.TrimSuffix(path[:match[0]], "/")
		segment := prefix[strings.LastIndex(prefix, "/")+1:]
		out.WriteString(path[last:match[0]])
		out.WriteString(value(segment, path[match[2]:match[3]]))
		last = match[1]
	}
	out.WriteString(path[last:])
	return out.String()
}

// isolationValues resolves path parameters to a tenant's resources. With
// missing set, every identifier names nothing at all.
func isolationValues(tenant isolationTenant, owner, repo string, missing bool) func(segment, param string) string {
	return func(segment, param string) string {
		pick := func(existing, absent string) string {
			if missing {
				return absent
			}
			return existing
		}
		switch param {
		case "owner":
			return owner
		case "repo":
			return repo
		case "org":
			return pick(tenant.org.Name, "missing-org")
		case "team":
			return pick(tenant.team.Name, "missing-team")
		case "username":
			return tenant.user.Username
		case "number":
			if segment == "landings" {
				return pick(fmt.Sprint(tenant.landing.Number), "987654")
			}
			return pick(fmt.Sprint(tenant.issue.Number), "987654")
		case "slug":
			return pick(tenant.wiki.Slug, "missing-page")
		case "name":
			switch segment {
			case "secrets":
				if strings.Contains(owner, "org") {
					return pick(tenant.orgSecretName, "MISSING_SECRET")
				}
				return pick(tenant.secretName, "MISSING_SECRET")
			case "variables":
				return pick(tenant.variableName, "MISSING_VARIABLE")
			case "workflows":
				return pick(tenant.definition.Name, "missing-workflow")
			}
			return "artifact"
		case "transfer_id":
			return pick(fmt.Sprint(tenant.transfer.ID), "987654")
		case "hostID":
			return "isolation-host"
		case "path":
			return "v1/messages"
		case "id":
			switch segment {
			case "workspaces", "sessions":
				return pick(tenant.workspace.ID, uuid.Nil.String())
			case "workflows":
				return pick(fmt.Sprint(tenant.definition.ID), "987654")
			case "runs":
				return pick(fmt.Sprint(tenant.run.ID), "987654")
			case "agent-sessions":
				return pick(tenant.agentSession.ID, uuid.Nil.String())
			case "app-timelines":
				return pick(tenant.timeline.ID, uuid.Nil.String())
			case "hooks":
				return pick(fmt.Sprint(tenant.webhook.ID), "987654")
			case "labels":
				return pick(fmt.Sprint(tenant.label.ID), "987654")
			case "keys":
				return pick(fmt.Sprint(tenant.sshKey.ID), "987654")
			case "tokens":
				return pick(fmt.Sprint(tenant.tokenRow.ID), "987654")
			case "emails":
				return pick(fmt.Sprint(tenant.emailID), "987654")
			case "provider-connections", "connections":
				return pick(tenant.connection.ID, uuid.Nil.String())
			case "notifications":
				return pick(fmt.Sprint(tenant.notification.ID), "987654")
			case "changesets":
				return pick(fmt.Sprint(tenant.changeset.ID), "987654")
			}
			return pick("1", "987654")
		}
		if strings.HasSuffix(strings.ToLower(param), "id") {
			return pick(uuid.NewSHA1(uuid.NameSpaceOID, []byte(tenant.user.Username+param)).String(), uuid.Nil.String())
		}
		return pick("1", "987654")
	}
}

// isolationDenied reports whether a status refuses the caller.
func isolationDenied(status int) bool {
	return status == http.StatusUnauthorized || status == http.StatusForbidden || status == http.StatusNotFound
}

// tenantFingerprint hashes every row of every product table so any change a
// denied request makes to alice's state is caught, whichever table it lands in.
func tenantFingerprint(t *testing.T, pool *pgxpool.Pool) map[string]string {
	t.Helper()
	ctx := context.Background()
	rows, err := pool.Query(ctx, `SELECT quote_ident(table_name) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)
	require.NoError(t, err)
	var tables []string
	for rows.Next() {
		var name string
		require.NoError(t, rows.Scan(&name))
		tables = append(tables, name)
	}
	require.NoError(t, rows.Err())
	out := map[string]string{}
	for _, table := range tables {
		var digest string
		require.NoError(t, pool.QueryRow(ctx, `SELECT coalesce(md5(string_agg(md5(t::text), '' ORDER BY md5(t::text))), '') FROM `+table+` t`).Scan(&digest))
		out[table] = digest
	}
	return out
}

// leaksCanary reports whether a body carries any of alice's strings, in any
// case and with identifiers' underscores.
func leaksCanary(body string) bool {
	return strings.Contains(strings.ReplaceAll(strings.ToLower(body), "_", "-"), isolationCanary)
}

var (
	isolationStreamPath     = regexp.MustCompile(`/(stream|events|logs|terminal)(/|$)|/sse`)
	isolationCredentialPath = regexp.MustCompile(`/(secrets|variables|keys|tokens|provider-connections|connections|emails|sessions|oauth2|credential|hooks|github-access|installations)(/|$)`)
	isolationJobPath        = regexp.MustCompile(`/(runs|workflows|workflow|repository-jobs|agent|agent-sessions|workspaces|workspace|workspace-snapshots|repository-setup|import|sync|gateways|command-runs|operations|mythical|app-timelines|changesets|approvals)(/|$)`)
)

// isolationFamily names the acceptance family a route belongs to.
func isolationFamily(path string) string {
	switch {
	case isolationStreamPath.MatchString(path):
		return "streams"
	case isolationCredentialPath.MatchString(path) && !strings.Contains(path, "/agent/sessions") && !strings.Contains(path, "/workspace/sessions"):
		return "credentials"
	case isolationJobPath.MatchString(path):
		return "jobs"
	}
	return "repositories"
}

// isolationGlobalID reports whether a path parameter names a row across all
// accounts, as opposed to a per-repository number, name or slug.
func isolationGlobalID(param string) bool {
	return param == "id" || strings.HasSuffix(param, "_id") || strings.HasSuffix(param, "Id") || strings.HasSuffix(param, "ID")
}

// TestAccountIsolationAcrossEveryRouteFamilyPostgres runs the complete
// multitenant composition over PostgreSQL and aims every served API route at
// another account's repositories, jobs, credentials and streams. Bob holds an
// all-scope token; alice owns every resource. For each route bob's answer must
// be a denial or indistinguishable from the same request for a resource that
// does not exist, must never carry alice's data, and must leave every row in
// the database untouched.
func TestAccountIsolationAcrossEveryRouteFamilyPostgres(t *testing.T) {
	pool, server, repoHost := startIsolationProduct(t)
	ctx := context.Background()
	carol, err := db.New(pool).CreateUser(ctx, db.CreateUserParams{Username: "carol", LowerUsername: "carol", DisplayName: "carol"})
	require.NoError(t, err)
	alice := seedIsolationTenant(t, pool, "alice", carol.ID, canary)
	bob := seedIsolationTenant(t, pool, "bob", 0, func(kind string) string { return "bob-" + kind })
	served := servedAPIRoutes(t)
	keys := make([]string, 0, len(served))
	for key := range served {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	bodyFor := func(method string) []byte {
		if method == "get" || method == "head" || method == "delete" {
			return nil
		}
		return []byte(`{}`)
	}
	aliceRepo := func(missing bool) func(segment, param string) string {
		if missing {
			return isolationValues(alice, alice.user.Username, "missing-repo", true)
		}
		return isolationValues(alice, alice.user.Username, alice.repo.Name, false)
	}

	// The owner reaches her data through the same routes, so a denial below
	// is authorization and not an unseeded or unmounted route.
	reached := map[string]int{}
	for _, key := range keys {
		route := served[key]
		if route.method != "get" || !strings.Contains(route.path, "{") {
			continue
		}
		own := isolationRequest(t, server, alice.token, route.method, fillIsolationPath(route.path, aliceRepo(false)), nil)
		if own.status == http.StatusOK && leaksCanary(own.body) {
			reached[isolationFamily(route.path)]++
		}
	}
	for _, family := range []string{"repositories", "jobs", "credentials", "streams"} {
		require.Positive(t, reached[family], "alice reads no %s through the API; the sweep would prove nothing", family)
	}

	var violations []string
	swept := map[string]int{}
	check := func(sweep, key string, probe, baseline isolationResponse) {
		if leaksCanary(probe.body) {
			violations = append(violations, fmt.Sprintf("%s %s: bob read alice's data (status %d): %.300s", sweep, key, probe.status, probe.body))
			return
		}
		if !isolationDenied(probe.status) && probe.status != baseline.status {
			violations = append(violations, fmt.Sprintf("%s %s: bob got %d for alice's resource but %d for a missing one: %.300s", sweep, key, probe.status, baseline.status, probe.body))
		}
	}
	before := tenantFingerprint(t, pool)
	aliceTokenBefore, err := db.New(pool).GetAccessTokenByID(ctx, alice.tokenRow.ID)
	require.NoError(t, err)
	repoHost.take()

	// Sweep 1: every parameterized route aimed at alice's own resources.
	for _, key := range keys {
		route := served[key]
		if !strings.Contains(route.path, "{") {
			continue
		}
		probe := isolationRequest(t, server, bob.token, route.method, fillIsolationPath(route.path, aliceRepo(false)), bodyFor(route.method))
		baseline := isolationRequest(t, server, bob.token, route.method, fillIsolationPath(route.path, aliceRepo(true)), bodyFor(route.method))
		check("alice-resource", key, probe, baseline)
		swept[isolationFamily(route.path)]++
	}
	for _, path := range repoHost.take() {
		if strings.Contains(path, "alice") || strings.Contains(path, fmt.Sprintf("/%d/", alice.repo.ID)) {
			violations = append(violations, "a denied request reached alice's repository storage: "+path)
		}
	}
	after := tenantFingerprint(t, pool)
	for table, digest := range before {
		// Bob's own token records its use and search counts bob's queries.
		if table == "access_tokens" || table == "search_rate_limits" {
			continue
		}
		if after[table] != digest {
			violations = append(violations, "bob's requests changed rows of "+table)
		}
	}
	aliceTokenAfter, err := db.New(pool).GetAccessTokenByID(ctx, alice.tokenRow.ID)
	require.NoError(t, err)
	require.Equal(t, aliceTokenBefore, aliceTokenAfter, "bob's requests changed alice's token")

	// Sweep 2: alice's identifiers smuggled into bob's own repository and
	// organization, where bob is fully authorized.
	bobOwn := func(missing bool) func(segment, param string) string {
		alices := isolationValues(alice, bob.user.Username, bob.repo.Name, missing)
		absent := isolationValues(alice, bob.user.Username, bob.repo.Name, true)
		return func(segment, param string) string {
			switch {
			case param == "org":
				return bob.org.Name
			case param == "team":
				return bob.team.Name
			case isolationGlobalID(param):
				return alices(segment, param)
			}
			return absent(segment, param)
		}
	}
	for _, key := range keys {
		route := served[key]
		if !strings.Contains(route.path, "{owner}/{repo}") && !strings.Contains(route.path, "{org}") {
			continue
		}
		global := false
		for _, match := range isolationParam.FindAllStringSubmatch(route.path, -1) {
			global = global || isolationGlobalID(match[1])
		}
		if !global {
			continue
		}
		probe := isolationRequest(t, server, bob.token, route.method, fillIsolationPath(route.path, bobOwn(false)), bodyFor(route.method))
		baseline := isolationRequest(t, server, bob.token, route.method, fillIsolationPath(route.path, bobOwn(true)), bodyFor(route.method))
		check("bob-scope", key, probe, baseline)
	}

	// Sweep 3: bob's own listings, feeds and searches never include alice.
	for _, key := range keys {
		route := served[key]
		if route.method != "get" || strings.Contains(route.path, "{") {
			continue
		}
		path := route.path + "?q=" + isolationCanary + "&query=" + isolationCanary
		if response := isolationRequest(t, server, bob.token, route.method, path, nil); leaksCanary(response.body) {
			violations = append(violations, fmt.Sprintf("caller-scoped %s: bob read alice's data (status %d): %.300s", key, response.status, response.body))
		}
	}

	// Streams authenticated by a short-lived ticket carry bob's identity and
	// no more: every stream route refuses alice's resources to it.
	for _, key := range keys {
		route := served[key]
		if route.method != "get" || isolationFamily(route.path) != "streams" || !strings.Contains(route.path, "{") {
			continue
		}
		ticketResponse := isolationRequest(t, server, bob.token, http.MethodPost, "/api/v1/sse/ticket", []byte(`{}`))
		require.Equal(t, http.StatusOK, ticketResponse.status, ticketResponse.body)
		var ticket struct {
			Ticket string `json:"ticket"`
		}
		require.NoError(t, json.Unmarshal([]byte(ticketResponse.body), &ticket))
		require.NotEmpty(t, ticket.Ticket)
		probe := isolationRequest(t, server, "", route.method, fillIsolationPath(route.path, aliceRepo(false))+"?ticket="+ticket.Ticket, nil)
		if !isolationDenied(probe.status) || leaksCanary(probe.body) {
			violations = append(violations, fmt.Sprintf("ticket %s: bob's ticket opened alice's stream (status %d): %.300s", key, probe.status, probe.body))
		}
	}

	for _, family := range []string{"repositories", "jobs", "credentials", "streams"} {
		require.Positive(t, swept[family], "no %s route was swept", family)
	}
	slices.Sort(violations)
	require.Empty(t, violations, "account isolation violations:\n%s", strings.Join(violations, "\n"))
	t.Logf("swept %d routes (%v); alice reached her data through %v", len(keys), swept, reached)
}
