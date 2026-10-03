package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const (
	// githubRepoListingFreshness is how long a cached listing is served
	// without scheduling a background refresh.
	githubRepoListingFreshness = 5 * time.Minute
	// githubRepoListingSyncBudget bounds one full background refresh
	// (up to githubRepoListingMaxPages sequential GitHub calls).
	githubRepoListingSyncBudget = 60 * time.Second
	// githubRepoListingPageSize is GitHub's maximum per_page for /user/repos.
	githubRepoListingPageSize = 100
	// githubRepoListingMaxPages caps the canonical full listing at 1000 repos
	// (multi's own client pages at per_page=100 with the same 10-page bound).
	githubRepoListingMaxPages = 10
	// githubRepoListingDefaultPerPage mirrors GitHub's default page size when
	// the client does not ask for one.
	githubRepoListingDefaultPerPage = 30
)

type GitHubUserReposDB interface {
	ListUserOAuthAccounts(ctx context.Context, userID int64) ([]db.OauthAccount, error)
	GetGitHubRepoListing(ctx context.Context, userID int64) (db.GithubRepoListing, error)
	UpsertGitHubRepoListing(ctx context.Context, arg db.UpsertGitHubRepoListingParams) (db.GithubRepoListing, error)
	ClaimGitHubRepoListingSync(ctx context.Context, userID int64) (int64, error)
	SetGitHubRepoListingSyncError(ctx context.Context, arg db.SetGitHubRepoListingSyncErrorParams) error
	DeleteGitHubRepoListing(ctx context.Context, userID int64) error
}

type OAuthAccessTokenDecrypter interface {
	DecryptOAuthAccessToken(ciphertext []byte) (string, error)
}

// GitHubUserTokenRefresher renews an expired GitHub App user-to-server access
// token from the refresh token stored on the oauth account, persists the
// rotated tokens, and returns the new access token. Implemented by
// *AuthService.RefreshUserGitHubToken. When no refresh token is stored it
// returns the credential-gone error unchanged so callers keep today's fallback.
type GitHubUserTokenRefresher interface {
	RefreshUserGitHubToken(ctx context.Context, account db.OauthAccount) (string, error)
}

// githubUserTokenProactiveRefresher renews a token whose PERSISTED expiry says it
// is already dead (or within the skew window) before it is ever spent, turning
// the ~8h GitHub App expiry into a no-op instead of one guaranteed 401 per cycle.
// Implemented by *AuthService.RefreshUserGitHubTokenIfExpiring.
//
// Feature-detected off the wired refresher rather than added to
// GitHubUserTokenRefresher so existing fakes keep compiling and simply keep the
// reactive-only behavior.
type githubUserTokenProactiveRefresher interface {
	RefreshUserGitHubTokenIfExpiring(ctx context.Context, account db.OauthAccount, currentToken string) (string, error)
}

type GitHubUserReposService struct {
	githubAppCredentials GitHubAppCredentialReader
	queries              GitHubUserReposDB
	decrypter            OAuthAccessTokenDecrypter
	refresher            GitHubUserTokenRefresher
	httpClient           *http.Client
	now                  func() time.Time
	// syncedRepos is the continuously-synced GitHub metadata store. When wired,
	// the issues/pulls proxy serves from it stale-while-revalidate and only
	// falls back to the live GitHub passthrough. Nil keeps the pure-passthrough
	// behavior (and is what every pre-mirror test constructs).
	syncedRepos *GitHubSyncedRepoService
	// syncDone, when set, is invoked after every background refresh attempt
	// (success or failure). Test seam — nil in production.
	syncDone func(userID int64, err error)
	// enrollDone, when set, fires after every lazy enrollment. Test seam.
	enrollDone func(owner, repo string)
	// pushProofs remembers which users proved GitHub push access, gating
	// every platform-token write made on a user's behalf (the git mirror).
	pushProofs githubPushProofs
}

type GitHubUserReposOption func(*GitHubUserReposService)

func WithGitHubUserReposCredentialStore(store GitHubAppCredentialReader) GitHubUserReposOption {
	return func(s *GitHubUserReposService) { s.githubAppCredentials = store }
}

func WithGitHubUserReposHTTPClient(client *http.Client) GitHubUserReposOption {
	return func(s *GitHubUserReposService) {
		if client != nil {
			s.httpClient = client
		}
	}
}

// WithGitHubUserReposTokenRefresher wires the reactive refresh-on-401 capability
// (renew an expired GitHub user token and retry). Without it the service keeps
// today's behavior: a rejected token surfaces as an honest 401.
func WithGitHubUserReposTokenRefresher(refresher GitHubUserTokenRefresher) GitHubUserReposOption {
	return func(s *GitHubUserReposService) {
		s.refresher = refresher
	}
}

// WithGitHubUserReposSyncedStore wires the continuously-synced GitHub metadata
// store, turning the issues/pulls proxy from a live passthrough into a
// store-first read with live as the fallback.
func WithGitHubUserReposSyncedStore(syncedRepos *GitHubSyncedRepoService) GitHubUserReposOption {
	return func(s *GitHubUserReposService) {
		s.syncedRepos = syncedRepos
	}
}

// WithGitHubUserReposEnrollNotify registers a callback fired after every lazy
// registry enrollment (tests only — lets tests wait for the goroutine).
func WithGitHubUserReposEnrollNotify(fn func(owner, repo string)) GitHubUserReposOption {
	return func(s *GitHubUserReposService) { s.enrollDone = fn }
}

// WithGitHubUserReposNow overrides the clock (tests only).
func WithGitHubUserReposNow(now func() time.Time) GitHubUserReposOption {
	return func(s *GitHubUserReposService) {
		if now != nil {
			s.now = now
		}
	}
}

// WithGitHubUserReposSyncNotify registers a callback fired after every
// background refresh attempt (tests only — lets tests wait for the goroutine).
func WithGitHubUserReposSyncNotify(fn func(userID int64, err error)) GitHubUserReposOption {
	return func(s *GitHubUserReposService) {
		s.syncDone = fn
	}
}

func NewGitHubUserReposService(queries GitHubUserReposDB, decrypter OAuthAccessTokenDecrypter, opts ...GitHubUserReposOption) *GitHubUserReposService {
	s := &GitHubUserReposService{
		queries:    queries,
		decrypter:  decrypter,
		httpClient: observability.NewHTTPClient(15 * time.Second),
		now:        time.Now,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

// ListAuthenticatedUserGitHubRepos serves the signed-in user's GitHub repo
// listing stale-while-revalidate:
//
//   - cache hit: the last-good cached listing is returned immediately (sliced
//     to the requested page); if it is older than githubRepoListingFreshness
//     and no refresh is already in flight (singleflight via the syncing_since
//     claim, with a 2-minute staleness takeover), a background goroutine
//     re-fetches the full listing from GitHub and upserts the cache.
//   - cache miss: the first sync blocks on the live GitHub fetch, stores the
//     result, and returns it — so first-time errors (token rejected, not
//     connected) surface exactly as before.
//
// Requests whose parameters don't match the canonical cached shape (custom
// visibility/affiliation/direction/sort) are proxied live to GitHub unchanged.
func (s *GitHubUserReposService) ListAuthenticatedUserGitHubRepos(ctx context.Context, userID int64, rawQuery url.Values) (GitHubRepoListResult, error) {
	if s == nil || s.queries == nil || s.decrypter == nil {
		return GitHubRepoListResult{}, pkgerrors.Internal("github user repos service unavailable")
	}
	if userID <= 0 {
		return GitHubRepoListResult{}, pkgerrors.Unauthorized("authentication required")
	}

	if !cacheableGitHubRepoListQuery(rawQuery) {
		return s.listLiveGitHubRepos(ctx, userID, rawQuery)
	}

	row, err := s.queries.GetGitHubRepoListing(ctx, userID)
	if err != nil && !stdErrors.Is(err, pgx.ErrNoRows) {
		// Cache INFRASTRUCTURE failure (missing table, DB blip) — not a cache
		// miss. The boot-path listing must not 500 while live GitHub works:
		// degrade to the live passthrough and let the cache heal later.
		slog.Warn("github repo listing cache unreadable; serving live", "user_id", userID, "error", err)
		return s.listLiveGitHubRepos(ctx, userID, rawQuery)
	}

	if err == nil {
		var cached []GitHubRepoListItem
		if decodeErr := json.Unmarshal(row.Payload, &cached); decodeErr == nil {
			if s.now().Sub(row.SyncedAt) > githubRepoListingFreshness {
				if claimed, claimErr := s.queries.ClaimGitHubRepoListingSync(ctx, userID); claimErr == nil && claimed > 0 {
					go s.refreshGitHubRepoListing(userID)
				}
			}
			return pageGitHubRepoListing(cached, rawQuery, row.SyncedAt, row.SyncError.String), nil
		}
		// Corrupt payload: fall through to a blocking re-sync that overwrites it.
	}

	// First sync (or corrupt cache): block on the live fetch so the caller
	// gets real data — and real errors — immediately.
	items, fetchErr := s.fetchFullGitHubRepoListing(ctx, userID)
	if fetchErr != nil {
		return GitHubRepoListResult{}, fetchErr
	}
	syncedAt := s.now()
	if payload, marshalErr := json.Marshal(items); marshalErr == nil {
		if stored, upsertErr := s.queries.UpsertGitHubRepoListing(ctx, db.UpsertGitHubRepoListingParams{
			UserID:  userID,
			Payload: payload,
		}); upsertErr == nil {
			syncedAt = stored.SyncedAt
		} else {
			slog.Warn("github repo listing cache store failed", "user_id", userID, "error", upsertErr)
		}
	}
	return pageGitHubRepoListing(items, rawQuery, syncedAt, ""), nil
}

// WarmGitHubRepoListing refreshes the user's cached listing in the background
// (used as a free cache warm right after a successful login token exchange).
// Fresh caches are left alone; a missing cache row triggers a background first
// sync; a stale row is refreshed only if the singleflight claim is won.
func (s *GitHubUserReposService) WarmGitHubRepoListing(userID int64) {
	if s == nil || s.queries == nil || s.decrypter == nil || userID <= 0 {
		return
	}
	go func() {
		defer recoverGitHubRepoListingPanic(userID)

		ctx, cancel := context.WithTimeout(context.Background(), githubRepoListingSyncBudget)
		defer cancel()

		row, err := s.queries.GetGitHubRepoListing(ctx, userID)
		switch {
		case err != nil && stdErrors.Is(err, pgx.ErrNoRows):
			err = s.syncGitHubRepoListing(ctx, userID)
		case err != nil:
			// Cache unreadable — skip the warm; the next listing request
			// degrades to the blocking path anyway.
		case s.now().Sub(row.SyncedAt) > githubRepoListingFreshness:
			var claimed int64
			if claimed, err = s.queries.ClaimGitHubRepoListingSync(ctx, userID); err == nil && claimed > 0 {
				err = s.syncGitHubRepoListing(ctx, userID)
			}
		default:
			// Fresh — nothing to do.
		}
		if s.syncDone != nil {
			s.syncDone(userID, err)
		}
	}()
}

// refreshGitHubRepoListing runs one background refresh for a user that already
// holds the singleflight claim. Never uses a request context: the request that
// scheduled it has long returned.
func (s *GitHubUserReposService) refreshGitHubRepoListing(userID int64) {
	defer recoverGitHubRepoListingPanic(userID)

	ctx, cancel := context.WithTimeout(context.Background(), githubRepoListingSyncBudget)
	defer cancel()

	err := s.syncGitHubRepoListing(ctx, userID)
	if s.syncDone != nil {
		s.syncDone(userID, err)
	}
}

// syncGitHubRepoListing fetches the canonical full listing and upserts the
// cache. On failure the last-good payload is preserved and only sync_error is
// recorded (which also releases the singleflight claim).
func (s *GitHubUserReposService) syncGitHubRepoListing(ctx context.Context, userID int64) error {
	items, err := s.fetchFullGitHubRepoListing(ctx, userID)
	if err == nil {
		var payload []byte
		if payload, err = json.Marshal(items); err == nil {
			if _, err = s.queries.UpsertGitHubRepoListing(ctx, db.UpsertGitHubRepoListingParams{
				UserID:  userID,
				Payload: payload,
			}); err == nil {
				return nil
			}
		}
	}

	// Record the failure on a fresh context: the sync context may already be
	// expired (that expiry is often the failure being recorded).
	errCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if isGitHubTokenExpired(err) {
		// Only a 401 means the stored credential is definitively gone (unlinked
		// or revoked upstream). Serving last-good repos forever would mask the
		// explicit 401 that clients key their reconnect CTA off — drop the cache
		// so the next request blocks on the live path and surfaces that honest
		// error. A 403 (rate limit / SAML) is transient and must NOT drop the
		// cache: it falls through to sync_error so last-good repos are preserved.
		if delErr := s.queries.DeleteGitHubRepoListing(errCtx, userID); delErr != nil {
			slog.Warn("github repo listing cache invalidation failed", "user_id", userID, "error", delErr)
		}
		// The same credential proved this user's store read grants; drop them so
		// the shared metadata store stops answering for a user GitHub rejects.
		if revokeErr := s.syncedRepos.RevokeReadGrants(errCtx, userID); revokeErr != nil {
			slog.Warn("github synced repo read grants not revoked", "user_id", userID, "error", revokeErr)
		}
		slog.Warn("github credential gone; repo listing cache invalidated", "user_id", userID, "error", err)
		return err
	}
	if recordErr := s.queries.SetGitHubRepoListingSyncError(errCtx, db.SetGitHubRepoListingSyncErrorParams{
		// Persist only a sanitized message: sync_error is echoed back to clients
		// in the X-Repos-Sync-Error header, and err may be a raw pg/network error
		// carrying internal detail (hostnames, constraint names). The full error
		// is logged below for operators.
		SyncError: sanitizedSyncErrorMessage(err),
		UserID:    userID,
	}); recordErr != nil {
		slog.Warn("github repo listing sync error not recorded", "user_id", userID, "error", recordErr)
	}
	slog.Warn("github repo listing refresh failed; serving last-good cache", "user_id", userID, "error", err)
	return err
}

// sanitizedSyncErrorMessage returns a client-safe string for the sync_error
// column (surfaced in the X-Repos-Sync-Error response header): an *APIError's
// curated message, or a generic fallback for raw driver/network errors.
func sanitizedSyncErrorMessage(err error) string {
	var apiErr *pkgerrors.APIError
	if stdErrors.As(err, &apiErr) && apiErr.Message != "" {
		return apiErr.Message
	}
	return "repo listing refresh failed"
}

// isGitHubTokenExpired reports whether the failure was specifically a 401 — the
// ONLY status that means the stored access token is expired and a refresh could
// help, and the only status that should drop the last-good listing cache. A 403
// (rate limit / SAML) is transient: it must neither trigger a refresh (GitHub
// App refresh tokens are single-use, so rotating them during a rate-limit storm
// produces spurious "reconnect GitHub" errors) nor drop the cache.
func isGitHubTokenExpired(err error) bool {
	var apiErr *pkgerrors.APIError
	return stdErrors.As(err, &apiErr) && apiErr.Status == http.StatusUnauthorized
}

func recoverGitHubRepoListingPanic(userID int64) {
	if r := recover(); r != nil {
		slog.Error("github repo listing refresh panicked", "user_id", userID, "panic", fmt.Sprint(r))
	}
}

// cacheableGitHubRepoListQuery reports whether a request matches the canonical
// cached listing shape (the full sort=pushed listing; multi's boot path).
// page/per_page/cursor are always served by slicing the cache. Anything else
// (visibility filters, affiliation, direction, other sorts) proxies live.
func cacheableGitHubRepoListQuery(rawQuery url.Values) bool {
	if visibility := strings.TrimSpace(rawQuery.Get("visibility")); visibility != "" && visibility != "all" {
		return false
	}
	if strings.TrimSpace(rawQuery.Get("affiliation")) != "" {
		return false
	}
	if strings.TrimSpace(rawQuery.Get("direction")) != "" {
		return false
	}
	if sort := strings.TrimSpace(rawQuery.Get("sort")); sort != "" && sort != "pushed" {
		return false
	}
	return true
}

// pageGitHubRepoListing slices the cached full listing to the requested page
// and synthesizes a rel="next" Link (cursor-form, which multi's parser reads)
// when more pages remain.
func pageGitHubRepoListing(items []GitHubRepoListItem, rawQuery url.Values, syncedAt time.Time, syncError string) GitHubRepoListResult {
	page := 1
	if raw := strings.TrimSpace(rawQuery.Get("page")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			page = parsed
		}
	}
	if raw := strings.TrimSpace(rawQuery.Get("cursor")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			page = parsed
		}
	}
	perPage := githubRepoListingDefaultPerPage
	if raw := strings.TrimSpace(rawQuery.Get("per_page")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			perPage = parsed
		}
	}
	if perPage > githubRepoListingPageSize {
		perPage = githubRepoListingPageSize
	}

	maxPage := (len(items) + perPage - 1) / perPage
	start, end := len(items), len(items)
	if page <= maxPage {
		start = (page - 1) * perPage
		end = start + perPage
		if end > len(items) {
			end = len(items)
		}
	}

	repos := items[start:end]
	if repos == nil {
		repos = []GitHubRepoListItem{}
	}
	result := GitHubRepoListResult{
		Repos:          repos,
		CacheSyncedAt:  &syncedAt,
		CacheSyncError: syncError,
	}
	if page < maxPage {
		result.Link = fmt.Sprintf("</api/user/github-repos?cursor=%d&per_page=%d>; rel=\"next\"", page+1, perPage)
	}
	return result
}

// fetchFullGitHubRepoListing pulls the canonical listing live from GitHub:
// sort=pushed, per_page=100, following pages until a short page (bounded at
// githubRepoListingMaxPages). Error taxonomy matches the passthrough path.
func (s *GitHubUserReposService) fetchFullGitHubRepoListing(ctx context.Context, userID int64) ([]GitHubRepoListItem, error) {
	accessToken, account, err := s.resolveUserGitHubAccessToken(ctx, userID)
	if err != nil {
		return nil, err
	}

	refreshed := false
	all := make([]GitHubRepoListItem, 0, githubRepoListingPageSize)
	for page := 1; page <= githubRepoListingMaxPages; page++ {
		q := url.Values{}
		q.Set("sort", "pushed")
		q.Set("per_page", strconv.Itoa(githubRepoListingPageSize))
		q.Set("page", strconv.Itoa(page))
		repos, _, err := s.requestGitHubUserRepos(ctx, accessToken, q)
		if err != nil && !refreshed && isGitHubTokenExpired(err) {
			// The stored token expired (~8h after connect). Refresh once and
			// retry this page with the rotated token; refresh failures fall
			// through to the honest 401 below.
			if newToken, refreshErr := s.refreshUserGitHubToken(ctx, account); refreshErr == nil {
				accessToken = newToken
				refreshed = true
				repos, _, err = s.requestGitHubUserRepos(ctx, accessToken, q)
			}
		}
		if err != nil {
			return nil, err
		}
		all = append(all, repos...)
		if len(repos) < githubRepoListingPageSize {
			break
		}
	}
	return all, nil
}

// listLiveGitHubRepos is the original passthrough: one GitHub call with the
// whitelisted request params, GitHub's Link header echoed verbatim.
func (s *GitHubUserReposService) listLiveGitHubRepos(ctx context.Context, userID int64, rawQuery url.Values) (GitHubRepoListResult, error) {
	accessToken, account, err := s.resolveUserGitHubAccessToken(ctx, userID)
	if err != nil {
		return GitHubRepoListResult{}, err
	}

	q := url.Values{}
	for _, key := range []string{"visibility", "affiliation", "sort", "direction", "per_page", "page"} {
		if value := strings.TrimSpace(rawQuery.Get(key)); value != "" {
			q.Set(key, value)
		}
	}
	if cursor := strings.TrimSpace(rawQuery.Get("cursor")); cursor != "" {
		q.Set("page", cursor)
	}

	repos, link, err := s.requestGitHubUserRepos(ctx, accessToken, q)
	if err != nil && isGitHubTokenExpired(err) {
		// Reactive refresh-on-401: renew the expired token once and retry.
		if newToken, refreshErr := s.refreshUserGitHubToken(ctx, account); refreshErr == nil {
			repos, link, err = s.requestGitHubUserRepos(ctx, newToken, q)
		}
	}
	if err != nil {
		return GitHubRepoListResult{}, err
	}
	return GitHubRepoListResult{Repos: repos, Link: link}, nil
}

// UserGitHubReadToken returns the user's own GitHub credential for a read the
// App cannot serve. Keep it server-side.
func (s *GitHubUserReposService) UserGitHubReadToken(ctx context.Context, userID int64) (string, db.OauthAccount, error) {
	if s == nil || s.queries == nil || s.decrypter == nil {
		return "", db.OauthAccount{}, pkgerrors.Internal("github user token service unavailable")
	}
	return s.resolveUserGitHubAccessToken(ctx, userID)
}

// RefreshUserGitHubReadToken rotates the credential UserGitHubReadToken
// returned, once, after GitHub answered 401.
func (s *GitHubUserReposService) RefreshUserGitHubReadToken(ctx context.Context, account db.OauthAccount) (string, error) {
	return s.refreshUserGitHubToken(ctx, account)
}

func (s *GitHubUserReposService) resolveUserGitHubAccessToken(ctx context.Context, userID int64) (string, db.OauthAccount, error) {
	accounts, err := s.queries.ListUserOAuthAccounts(ctx, userID)
	if err != nil {
		return "", db.OauthAccount{}, pkgerrors.Internal("failed to load github oauth account").WithCause(err)
	}

	// Prefer a real provider="github" account. Fall back to "workos" ONLY
	// because plue's WorkOS path is GitHub-backed (it stores a gho_* token
	// under "workos"); a WorkOS account created before a later GitHub connect
	// must never shadow the real GitHub credential.
	var selected *db.OauthAccount
	for i := range accounts {
		switch strings.ToLower(strings.TrimSpace(accounts[i].Provider)) {
		case "github":
			selected = &accounts[i]
		case "workos":
			if selected == nil {
				selected = &accounts[i]
			}
		}
		if selected != nil && strings.EqualFold(strings.TrimSpace(selected.Provider), "github") {
			break
		}
	}
	if selected == nil {
		return "", db.OauthAccount{}, pkgerrors.Unauthorized("github oauth account is not connected")
	}

	accessToken, err := s.decrypter.DecryptOAuthAccessToken(selected.AccessTokenEncrypted)
	if err != nil {
		return "", db.OauthAccount{}, err
	}
	accessToken = strings.TrimSpace(accessToken)
	if accessToken == "" {
		return "", db.OauthAccount{}, pkgerrors.Internal("github oauth access token is empty")
	}

	// Renew before spending, when the stored expiry says the token is dead or
	// nearly so. Accounts with no persisted expiry are left alone and fall
	// through to the reactive refresh-on-401 retries at the call sites.
	accessToken, err = s.proactivelyRefreshGitHubToken(ctx, *selected, accessToken)
	if err != nil {
		return "", db.OauthAccount{}, err
	}
	return accessToken, *selected, nil
}

// proactivelyRefreshGitHubToken is a no-op unless a proactive-capable refresher
// is wired AND the account carries a persisted expiry that has (nearly) passed.
func (s *GitHubUserReposService) proactivelyRefreshGitHubToken(ctx context.Context, account db.OauthAccount, token string) (string, error) {
	proactive, ok := s.refresher.(githubUserTokenProactiveRefresher)
	if !ok {
		return token, nil
	}
	return proactive.RefreshUserGitHubTokenIfExpiring(ctx, account, token)
}

// refreshUserGitHubToken performs a single reactive refresh of the user's GitHub
// token after a credential-gone (401/403) response and returns the rotated
// access token. It returns an error — leaving the caller on today's fallback —
// when no refresher is wired or no refresh token is stored for the account.
func (s *GitHubUserReposService) refreshUserGitHubToken(ctx context.Context, account db.OauthAccount) (string, error) {
	if s.refresher == nil {
		return "", pkgerrors.Unauthorized("github oauth token was rejected")
	}
	token, err := s.refresher.RefreshUserGitHubToken(ctx, account)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(token) == "" {
		return "", pkgerrors.Unauthorized("github oauth token was rejected")
	}
	return token, nil
}

// VerifyUserCanPushToGitHubRepo proves the caller's own connected GitHub
// identity has push access to owner/repo. It backs ConnectRepo's trust
// boundary: repo_connections rows gate GitHub App installation-token
// issuance, so a row must never be created from unverified owner/repo
// strings. Returns nil only when GitHub reports push (or higher) permission
// for the user's token.
func (s *GitHubUserReposService) VerifyUserCanPushToGitHubRepo(ctx context.Context, userID int64, owner string, repo string) error {
	_, err := s.GitHubPushToken(ctx, userID, owner, repo)
	return err
}

// GitHubPushToken returns only the caller's own credential after GitHub verifies write access.
// Keep it server-side; mirror jobs must never substitute an installation-wide credential.
func (s *GitHubUserReposService) GitHubPushToken(ctx context.Context, userID int64, owner string, repo string) (string, error) {
	trimmedOwner := strings.TrimSpace(owner)
	trimmedRepo := strings.TrimSpace(repo)
	if trimmedOwner == "" || trimmedRepo == "" {
		return "", pkgerrors.BadRequest("owner and repository name are required")
	}

	accessToken, account, err := s.resolveUserGitHubAccessToken(ctx, userID)
	if err != nil {
		return "", err
	}

	canPush, err := s.requestGitHubRepoPushPermission(ctx, accessToken, trimmedOwner, trimmedRepo)
	if err != nil && isGitHubTokenExpired(err) {
		// Reactive refresh-on-401: renew the expired token once and retry.
		if newToken, refreshErr := s.refreshUserGitHubToken(ctx, account); refreshErr == nil {
			accessToken = newToken
			canPush, err = s.requestGitHubRepoPushPermission(ctx, accessToken, trimmedOwner, trimmedRepo)
		}
	}
	if err != nil {
		return "", err
	}
	if !canPush {
		return "", pkgerrors.Forbidden("your github account does not have push access to this repository")
	}
	return accessToken, nil
}

// requestGitHubRepoPushPermission performs one GET /repos/{owner}/{repo} call
// with the user's token and reports whether the authenticated user holds push
// (or higher) permission. A 404 means the repo does not exist or the user
// cannot see it — both are "no access", not errors.
func (s *GitHubUserReposService) requestGitHubRepoPushPermission(ctx context.Context, accessToken string, owner string, repo string) (bool, error) {
	endpoint := strings.TrimRight(githubAPIBaseURL(), "/") + "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return false, pkgerrors.Internal("failed to build github repository request").WithCause(err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "smithers-server")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return false, pkgerrors.Internal("github repository request failed").WithCause(err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return false, pkgerrors.Unauthorized("github oauth token was rejected")
	case resp.StatusCode == http.StatusNotFound:
		return false, nil
	case resp.StatusCode == http.StatusForbidden:
		// Rate limit / SAML-SSO / access denial — fail closed without
		// consuming a single-use refresh token (see requestGitHubUserRepos).
		return false, pkgerrors.Forbidden("github denied the repository access check")
	case resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices:
		return false, pkgerrors.Internal("github repository request was rejected")
	}

	var payload struct {
		Permissions struct {
			Admin    bool `json:"admin"`
			Maintain bool `json:"maintain"`
			Push     bool `json:"push"`
		} `json:"permissions"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return false, pkgerrors.Internal("failed to decode github repository response").WithCause(err)
	}
	return payload.Permissions.Push || payload.Permissions.Maintain || payload.Permissions.Admin, nil
}

// requestGitHubUserRepos performs one GET /user/repos call and returns the
// decoded page plus GitHub's Link header.
func (s *GitHubUserReposService) requestGitHubUserRepos(ctx context.Context, accessToken string, q url.Values) ([]GitHubRepoListItem, string, error) {
	upstreamURL := strings.TrimRight(githubAPIBaseURL(), "/") + "/user/repos"
	if encoded := q.Encode(); encoded != "" {
		upstreamURL += "?" + encoded
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, upstreamURL, nil)
	if err != nil {
		return nil, "", pkgerrors.Internal("failed to build github user repositories request").WithCause(err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "smithers-server")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, "", pkgerrors.Internal("github user repositories request failed").WithCause(err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode == http.StatusUnauthorized {
		return nil, "", pkgerrors.Unauthorized("github oauth token was rejected")
	}
	if resp.StatusCode == http.StatusForbidden {
		// 403 is a rate limit / SAML-SSO / access denial — NOT an expired token.
		// It stays in the credential-gone bucket (serve last-good) but must map to
		// a DISTINCT status so it does not trigger a token refresh: GitHub App
		// refresh tokens are single-use, and rotating them under a rate-limit storm
		// is what caused the 2026-07-04 reconnect cascade.
		return nil, "", pkgerrors.Forbidden("github denied the user repositories request")
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, "", pkgerrors.Internal("github user repositories request was rejected")
	}

	var repos []GitHubRepoListItem
	if err := json.Unmarshal(body, &repos); err != nil {
		return nil, "", pkgerrors.Internal("failed to decode github user repositories response").WithCause(err)
	}

	return repos, resp.Header.Get("Link"), nil
}

func (s *GitHubUserReposService) GitHubAppInstallURL(ctx context.Context) (string, error) {
	if s.githubAppCredentials == nil {
		return "", nil
	}
	value, err := s.githubAppCredentials.InstallURL(ctx)
	if stdErrors.Is(err, ErrGitHubAppNotConfigured) {
		return "", nil
	}
	return value, err
}
