package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// NotificationResponse is the API representation of a notification.
type NotificationResponse struct {
	ID         int64      `json:"id"`
	SourceType string     `json:"source_type"`
	SourceID   any        `json:"source_id"`
	Subject    string     `json:"subject"`
	Body       string     `json:"body"`
	Status     string     `json:"status"`
	ReadAt     *time.Time `json:"read_at"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
}

// NotificationPreferencesResponse is the API representation of per-user preferences.
type NotificationPreferencesResponse struct {
	NotifyIssues   bool `json:"notify_issues"`
	NotifyLandings bool `json:"notify_landings"`
	NotifyMentions bool `json:"notify_mentions"`
}

// NotificationQueries is the minimal subset of db.Queries needed by NotificationService.
type NotificationQueries interface {
	RepoPermQuerier
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetIssueByID(ctx context.Context, id int64) (db.Issue, error)
	GetLandingRequestByID(ctx context.Context, id int64) (db.LandingRequest, error)
	GetNotificationBranchLockRepository(ctx context.Context, id int64) (int64, error)
	GetNotificationByID(ctx context.Context, id int64) (db.Notification, error)
	ListNotificationsByUser(ctx context.Context, arg db.ListNotificationsByUserParams) ([]db.Notification, error)
	ListNotificationsByUserKeyset(ctx context.Context, arg db.ListNotificationsByUserKeysetParams) ([]db.Notification, error)
	ListNotificationsAfterID(ctx context.Context, arg db.ListNotificationsAfterIDParams) ([]db.Notification, error)
	CountNotificationsByUser(ctx context.Context, userID int64) (int64, error)
	MarkNotificationRead(ctx context.Context, arg db.MarkNotificationReadParams) error
	MarkAllNotificationsRead(ctx context.Context, userID int64) error
	CreateNotification(ctx context.Context, arg db.CreateNotificationParams) (db.Notification, error)
	NotifyUser(ctx context.Context, arg db.NotifyUserParams) error
	GetNotificationPreferences(ctx context.Context, userID int64) (db.UserNotificationPreference, error)
	UpsertNotificationPreferences(ctx context.Context, arg db.UpsertNotificationPreferencesParams) (db.UserNotificationPreference, error)
	ListActiveWatchersForRepo(ctx context.Context, repositoryID int64) ([]db.ListActiveWatchersForRepoRow, error)
}

type notificationCreateTx interface {
	CreateNotification(ctx context.Context, arg db.CreateNotificationParams) (db.Notification, error)
	NotifyUser(ctx context.Context, arg db.NotifyUserParams) error
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

type notificationCreateTxManager interface {
	BeginCreateTx(ctx context.Context) (notificationCreateTx, error)
}

type pgxNotificationCreateTxManager struct {
	pool *pgxpool.Pool
}

func (m *pgxNotificationCreateTxManager) BeginCreateTx(ctx context.Context) (notificationCreateTx, error) {
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &pgxNotificationCreateTx{
		tx: tx,
		q:  db.New(tx),
	}, nil
}

type pgxNotificationCreateTx struct {
	tx pgx.Tx
	q  *db.Queries
}

func (t *pgxNotificationCreateTx) CreateNotification(ctx context.Context, arg db.CreateNotificationParams) (db.Notification, error) {
	return t.q.CreateNotification(ctx, arg)
}

func (t *pgxNotificationCreateTx) NotifyUser(ctx context.Context, arg db.NotifyUserParams) error {
	return t.q.NotifyUser(ctx, arg)
}

func (t *pgxNotificationCreateTx) Commit(ctx context.Context) error {
	return t.tx.Commit(ctx)
}

func (t *pgxNotificationCreateTx) Rollback(ctx context.Context) error {
	return t.tx.Rollback(ctx)
}

// NotificationService handles reading and marking notifications for a user.
type NotificationService struct {
	install         *installAccountMutationStore
	installAdmitted bool
	q               NotificationQueries
	createTxManager notificationCreateTxManager
	// fanoutSem bounds how many watcher fan-outs perform DB work concurrently
	// so a burst of issue/landing creations on heavily-watched repositories
	// cannot exhaust the connection pool.
	fanoutSem chan struct{}
	// fanoutQueue bounds how many fan-outs may be pending at once, running or
	// waiting for fanoutSem. A fan-out that finds it full is dropped and
	// logged instead of parking another goroutine.
	fanoutQueue chan struct{}
}

// NewNotificationService returns a new NotificationService.
func NewNotificationService(q NotificationQueries) *NotificationService {
	return &NotificationService{
		q:           q,
		fanoutSem:   make(chan struct{}, maxConcurrentWatcherFanouts),
		fanoutQueue: make(chan struct{}, maxQueuedWatcherFanouts),
	}
}

// NewNotificationServiceWithPool returns a new NotificationService that wraps
// create+notify in a transaction when creating notifications.
func NewNotificationServiceWithPool(q NotificationQueries, pool *pgxpool.Pool) *NotificationService {
	if pool == nil {
		return NewNotificationService(q)
	}
	return &NotificationService{
		q: q,
		createTxManager: &pgxNotificationCreateTxManager{
			pool: pool,
		},
		fanoutSem:   make(chan struct{}, maxConcurrentWatcherFanouts),
		fanoutQueue: make(chan struct{}, maxQueuedWatcherFanouts),
	}
}

// ListNotifications returns a page of notifications using stable keyset pagination.
// beforeID is the exclusive upper bound on notification ID (DESC order); 0 means first page.
// limit controls the page size (clamped to [1, 100]).
// Returns items, next cursor (empty string if no more pages), total count, and error.
func (s *NotificationService) ListNotifications(ctx context.Context, userID int64, beforeID int64, limit int) ([]NotificationResponse, string, int64, error) {
	if limit < 1 || limit > 100 {
		limit = 30
	}

	rows, err := s.q.ListNotificationsByUserKeyset(ctx, db.ListNotificationsByUserKeysetParams{
		UserID:   userID,
		BeforeID: beforeID,
		PageSize: int32(limit),
	})
	if err != nil {
		return nil, "", 0, pkgerrors.Internal("list notifications: " + err.Error())
	}

	total, err := s.q.CountNotificationsByUser(ctx, userID)
	if err != nil {
		return nil, "", 0, pkgerrors.Internal("count notifications: " + err.Error())
	}

	visible, err := s.filterReadableNotifications(ctx, userID, rows)
	if err != nil {
		return nil, "", 0, err
	}

	result := make([]NotificationResponse, 0, len(visible))
	for _, n := range visible {
		result = append(result, toNotificationResponse(n))
	}

	var nextCursor string
	if len(rows) == limit {
		// Last item has the smallest ID (DESC order), encode it as next-page cursor
		// with the canonical base64 scheme decodeIDCursor consumes. A plain-decimal
		// cursor decodes as garbage base64url -> 0 and pins the client to page 1.
		lastID := rows[len(rows)-1].ID
		nextCursor = encodeIssueNumberCursor(lastID)
	}

	return result, nextCursor, total, nil
}

// maxReplayLimit bounds one notification catch-up page, not the total replay.
const maxReplayLimit = 1000

// ListNotificationsAfterID returns notifications with IDs greater than afterID
// for the given user, ordered ascending by ID. This is used by the SSE handler
// to replay missed events when a client reconnects with Last-Event-ID.
// The limit is clamped to maxReplayLimit (1000); stream callers drain further pages.
func (s *NotificationService) ListNotificationsAfterID(ctx context.Context, userID, afterID int64, limit int) ([]NotificationResponse, error) {
	page, err := s.ListNotificationStreamPage(ctx, userID, afterID, limit)
	return page.Items, err
}

// NotificationStreamPage advances over scanned rows, even when an entire page
// is hidden by authorization. The scan cursor is never a visible notification.
type NotificationStreamPage struct {
	Items  []NotificationResponse
	Cursor int64
	More   bool
}

func (s *NotificationService) ListNotificationStreamPage(ctx context.Context, userID, afterID int64, limit int) (NotificationStreamPage, error) {
	if limit < 1 || limit > maxReplayLimit {
		limit = maxReplayLimit
	}

	rows, err := s.q.ListNotificationsAfterID(ctx, db.ListNotificationsAfterIDParams{
		UserID:     userID,
		AfterID:    afterID,
		MaxResults: int32(limit),
	})
	if err != nil {
		return NotificationStreamPage{}, pkgerrors.Internal("list notifications after id: " + err.Error())
	}

	visible, err := s.filterReadableNotifications(ctx, userID, rows)
	if err != nil {
		return NotificationStreamPage{}, err
	}

	result := make([]NotificationResponse, 0, len(visible))
	for _, n := range visible {
		result = append(result, toNotificationResponse(n))
	}
	cursor := afterID
	if len(rows) > 0 {
		cursor = rows[len(rows)-1].ID
	}
	return NotificationStreamPage{Items: result, Cursor: cursor, More: len(rows) == limit}, nil
}

// filterReadableNotifications drops notifications whose source repository the
// user can no longer read. Notification rows store subject/body snippets but
// no repository reference, so each row is joined back through its source
// (issue, landing request, or mention target) and gated on the canonical
// repository read predicate. Rows whose source cannot be resolved are dropped
// (fail closed) — a snippet that cannot be re-authorized must not be replayed.
// Lookups are memoized per call so a page touching one repository costs one
// permission resolution.
func (s *NotificationService) filterReadableNotifications(ctx context.Context, userID int64, rows []db.Notification) ([]db.Notification, error) {
	if len(rows) == 0 {
		return rows, nil
	}
	checker := &notificationAccessChecker{
		q:               s.q,
		userID:          userID,
		issueRepos:      make(map[int64]int64),
		landingRepos:    make(map[int64]int64),
		branchLockRepos: make(map[int64]int64),
		repoReadable:    make(map[int64]bool),
	}
	visible := make([]db.Notification, 0, len(rows))
	for _, n := range rows {
		ok, err := checker.canSee(ctx, n)
		if err != nil {
			return nil, err
		}
		if ok {
			visible = append(visible, n)
		}
	}
	return visible, nil
}

// notificationAccessChecker memoizes source→repository resolution and
// repository readability for a single list/replay call.
type notificationAccessChecker struct {
	q      NotificationQueries
	userID int64
	// issueRepos / landingRepos map source ID → repository ID; missing sources
	// are cached as notificationSourceMissing.
	issueRepos      map[int64]int64
	landingRepos    map[int64]int64
	branchLockRepos map[int64]int64
	repoReadable    map[int64]bool
}

// notificationSourceMissing marks a memoized source lookup that returned no row.
const notificationSourceMissing = int64(-1)

func (c *notificationAccessChecker) canSee(ctx context.Context, n db.Notification) (bool, error) {
	if !n.SourceID.Valid {
		return false, nil
	}
	switch n.SourceType {
	case "issue", "mention_issue":
		repoID, err := c.issueRepo(ctx, n.SourceID.Int64)
		if err != nil || repoID == notificationSourceMissing {
			return false, err
		}
		return c.canReadRepoID(ctx, repoID)
	case "landing", "mention_landing":
		repoID, err := c.landingRepo(ctx, n.SourceID.Int64)
		if err != nil || repoID == notificationSourceMissing {
			return false, err
		}
		return c.canReadRepoID(ctx, repoID)
	case "mention":
		// Migration resolves historical mentions with an unambiguous context.
		// Remaining legacy rows cannot identify an authorization boundary.
		return false, nil
	case "branch_lock":
		// Branch-lock join requests/decisions reference the join-request row;
		// its repository is the readability boundary.
		repoID, err := c.branchLockRepo(ctx, n.SourceID.Int64)
		if err != nil || repoID == notificationSourceMissing {
			return false, err
		}
		return c.canReadRepoID(ctx, repoID)
	default:
		// Unknown source types cannot be re-authorized; fail closed.
		slog.Warn("notification list: unknown source type dropped", "source_type", n.SourceType, "notification_id", n.ID)
		return false, nil
	}
}

func (c *notificationAccessChecker) issueRepo(ctx context.Context, issueID int64) (int64, error) {
	if repoID, ok := c.issueRepos[issueID]; ok {
		return repoID, nil
	}
	issue, err := c.q.GetIssueByID(ctx, issueID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			c.issueRepos[issueID] = notificationSourceMissing
			return notificationSourceMissing, nil
		}
		return 0, pkgerrors.Internal("resolve notification issue: " + err.Error())
	}
	c.issueRepos[issueID] = issue.RepositoryID
	return issue.RepositoryID, nil
}

func (c *notificationAccessChecker) landingRepo(ctx context.Context, landingID int64) (int64, error) {
	if repoID, ok := c.landingRepos[landingID]; ok {
		return repoID, nil
	}
	landing, err := c.q.GetLandingRequestByID(ctx, landingID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			c.landingRepos[landingID] = notificationSourceMissing
			return notificationSourceMissing, nil
		}
		return 0, pkgerrors.Internal("resolve notification landing request: " + err.Error())
	}
	c.landingRepos[landingID] = landing.RepositoryID
	return landing.RepositoryID, nil
}

func (c *notificationAccessChecker) branchLockRepo(ctx context.Context, joinRequestID int64) (int64, error) {
	if repoID, ok := c.branchLockRepos[joinRequestID]; ok {
		return repoID, nil
	}
	repoID, err := c.q.GetNotificationBranchLockRepository(ctx, joinRequestID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			c.branchLockRepos[joinRequestID] = notificationSourceMissing
			return notificationSourceMissing, nil
		}
		return 0, pkgerrors.Internal("resolve notification branch-lock join request: " + err.Error())
	}
	c.branchLockRepos[joinRequestID] = repoID
	return repoID, nil
}

func (c *notificationAccessChecker) canReadRepoID(ctx context.Context, repoID int64) (bool, error) {
	if readable, ok := c.repoReadable[repoID]; ok {
		return readable, nil
	}
	repository, err := c.q.GetRepoByID(ctx, repoID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			c.repoReadable[repoID] = false
			return false, nil
		}
		return false, pkgerrors.Internal("resolve notification repository: " + err.Error())
	}
	readable, err := canReadRepo(ctx, c.q, repository, c.userID)
	if err != nil {
		return false, err
	}
	c.repoReadable[repoID] = readable
	return readable, nil
}

// MarkRead marks a single notification as read for the given user.
// Returns NotFound if the notification does not exist, Forbidden if it belongs
// to a different user.
func (s *NotificationService) MarkRead(ctx context.Context, userID, notificationID int64) error {
	if s.install != nil && !s.installAdmitted {
		_, err := withInstallAccountMutation(s.install, ctx, userID, "account.inbox.read", notificationID, struct{}{}, func(ctx context.Context, q *db.Queries) (struct{}, error) {
			scoped := *s
			scoped.q, scoped.installAdmitted = q, true
			return struct{}{}, scoped.MarkRead(ctx, userID, notificationID)
		})
		return err
	}
	notif, err := s.q.GetNotificationByID(ctx, notificationID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("notification not found")
		}
		return pkgerrors.Internal("get notification: " + err.Error())
	}
	if notif.UserID != userID {
		return pkgerrors.Forbidden("notification does not belong to the authenticated user")
	}

	if err := s.q.MarkNotificationRead(ctx, db.MarkNotificationReadParams{
		ID:     notificationID,
		UserID: userID,
	}); err != nil {
		return pkgerrors.Internal("mark notification read: " + err.Error())
	}
	return nil
}

// MarkAllRead marks all unread notifications for the given user as read.
func (s *NotificationService) MarkAllRead(ctx context.Context, userID int64) error {
	if s.install != nil && !s.installAdmitted {
		_, err := withInstallAccountMutation(s.install, ctx, userID, "account.inbox.read-all", 0, struct{}{}, func(ctx context.Context, q *db.Queries) (struct{}, error) {
			scoped := *s
			scoped.q, scoped.installAdmitted = q, true
			return struct{}{}, scoped.MarkAllRead(ctx, userID)
		})
		return err
	}
	if err := s.q.MarkAllNotificationsRead(ctx, userID); err != nil {
		return pkgerrors.Internal("mark all notifications read: " + err.Error())
	}
	return nil
}

// GetPreferences returns notification preferences for the given user.
// If no preferences row exists yet the defaults (all enabled) are returned.
func (s *NotificationService) GetPreferences(ctx context.Context, userID int64) (NotificationPreferencesResponse, error) {
	prefs, err := s.q.GetNotificationPreferences(ctx, userID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			// No row means "all defaults enabled".
			return NotificationPreferencesResponse{
				NotifyIssues:   true,
				NotifyLandings: true,
				NotifyMentions: true,
			}, nil
		}
		return NotificationPreferencesResponse{}, pkgerrors.Internal("get notification preferences: " + err.Error())
	}
	return toPreferencesResponse(prefs), nil
}

// UpdateInboxPreferencesRequest keeps omitted or null preferences unchanged.
type UpdateInboxPreferencesRequest struct {
	NotifyIssues   *bool `json:"notify_issues"`
	NotifyLandings *bool `json:"notify_landings"`
	NotifyMentions *bool `json:"notify_mentions"`
}

// UpdatePreferences applies the caller's partial preferences.
func (s *NotificationService) UpdatePreferences(ctx context.Context, userID int64, req UpdateInboxPreferencesRequest) (NotificationPreferencesResponse, error) {
	if s.install != nil && !s.installAdmitted {
		return withInstallAccountMutation(s.install, ctx, userID, "account.inbox.preferences", 0, req, func(ctx context.Context, q *db.Queries) (NotificationPreferencesResponse, error) {
			scoped := *s
			scoped.q, scoped.installAdmitted = q, true
			return scoped.UpdatePreferences(ctx, userID, req)
		})
	}
	// Merge omitted fields inside the guarded transaction, not in the handler.
	current := NotificationPreferencesResponse{}
	if req.NotifyIssues == nil || req.NotifyLandings == nil || req.NotifyMentions == nil {
		var err error
		current, err = s.GetPreferences(ctx, userID)
		if err != nil {
			return NotificationPreferencesResponse{}, err
		}
	}
	if req.NotifyIssues != nil {
		current.NotifyIssues = *req.NotifyIssues
	}
	if req.NotifyLandings != nil {
		current.NotifyLandings = *req.NotifyLandings
	}
	if req.NotifyMentions != nil {
		current.NotifyMentions = *req.NotifyMentions
	}

	prefs, err := s.q.UpsertNotificationPreferences(ctx, db.UpsertNotificationPreferencesParams{
		UserID:         userID,
		NotifyIssues:   current.NotifyIssues,
		NotifyLandings: current.NotifyLandings,
		NotifyMentions: current.NotifyMentions,
	})
	if err != nil {
		return NotificationPreferencesResponse{}, pkgerrors.Internal("upsert notification preferences: " + err.Error())
	}
	return toPreferencesResponse(prefs), nil
}

const (
	// maxNotificationSubjectLen matches the notifications.subject VARCHAR(255) column.
	maxNotificationSubjectLen = 255
	// maxNotificationPayloadBytes is one byte below PostgreSQL's 8000-byte
	// NOTIFY payload limit.
	maxNotificationPayloadBytes = 7999
	// maxNotificationPayloadBodyLen caps the body before final pg_notify
	// payload-size enforcement while preserving the full stored body.
	maxNotificationPayloadBodyLen = 4096
)

// Create inserts a notification, emits a pg_notify event, and returns the created record.
func (s *NotificationService) Create(ctx context.Context, arg db.CreateNotificationParams) (NotificationResponse, error) {
	// notifications.subject is VARCHAR(255). An over-long subject (e.g. a watcher
	// notification embedding a 255-char issue/landing title) would fail the INSERT
	// with SQLSTATE 22001 (string_data_right_truncation) and — because NotifyWatchers
	// swallows the error — be silently dropped for every watcher. Truncate defensively
	// so all callers are protected. truncateBody bounds bytes on a rune boundary, and
	// runes<=bytes, so <=255 bytes guarantees <=255 characters.
	arg.Subject = truncateBody(arg.Subject, maxNotificationSubjectLen)

	if s.createTxManager != nil {
		tx, err := s.createTxManager.BeginCreateTx(ctx)
		if err != nil {
			return NotificationResponse{}, pkgerrors.Internal("begin notification tx: " + err.Error())
		}

		created, err := tx.CreateNotification(ctx, arg)
		if err != nil {
			rollbackNotificationTx(ctx, tx)
			return NotificationResponse{}, pkgerrors.Internal("create notification: " + err.Error())
		}

		payload, err := buildNotificationPayload(created)
		if err != nil {
			rollbackNotificationTx(ctx, tx)
			return NotificationResponse{}, pkgerrors.Internal("marshal notification payload: " + err.Error())
		}

		if err := tx.NotifyUser(ctx, db.NotifyUserParams{
			UserID:  created.UserID,
			Payload: payload,
		}); err != nil {
			rollbackNotificationTx(ctx, tx)
			return NotificationResponse{}, pkgerrors.Internal("notify user: " + err.Error())
		}

		if err := tx.Commit(ctx); err != nil {
			rollbackNotificationTx(ctx, tx)
			return NotificationResponse{}, pkgerrors.Internal("commit notification tx: " + err.Error())
		}

		return toNotificationResponse(created), nil
	}

	created, err := s.q.CreateNotification(ctx, arg)
	if err != nil {
		return NotificationResponse{}, pkgerrors.Internal("create notification: " + err.Error())
	}

	payload, err := buildNotificationPayload(created)
	if err != nil {
		return NotificationResponse{}, pkgerrors.Internal("marshal notification payload: " + err.Error())
	}

	if err := s.q.NotifyUser(ctx, db.NotifyUserParams{
		UserID:  created.UserID,
		Payload: payload,
	}); err != nil {
		return NotificationResponse{}, pkgerrors.Internal("notify user: " + err.Error())
	}

	return toNotificationResponse(created), nil
}

const (
	// maxConcurrentWatcherFanouts bounds how many NotifyWatchers fan-outs run
	// concurrently across the whole service. Each fan-out processes watchers
	// sequentially, so total in-flight fan-out DB work is bounded regardless
	// of how many issues/landing requests are created at once.
	maxConcurrentWatcherFanouts = 4
	// maxQueuedWatcherFanouts bounds running plus waiting fan-outs, so a burst
	// of issue or landing creations cannot park unbounded goroutines.
	maxQueuedWatcherFanouts = 256
	// watcherFanoutTimeout bounds the total time a single watcher fan-out may
	// spend once it starts running.
	watcherFanoutTimeout = 5 * time.Minute
)

// NotifyWatchers fans out an in-app notification to all active watchers of a
// repository (mode = 'watching' or 'participating') who can still read the
// repository, filtered by each user's preferences. sourceType must be "issue"
// or "landing" to gate against the corresponding preference column.
//
// The fan-out runs in the background, detached from the request context, so a
// repository with many watchers cannot tie up the request worker; at most
// maxConcurrentWatcherFanouts fan-outs perform DB work at a time and at most
// maxQueuedWatcherFanouts are pending; beyond that the fan-out is dropped.
// Errors and panics are logged and never surfaced to the caller.
func (s *NotificationService) NotifyWatchers(ctx context.Context, repositoryID int64, sourceType string, sourceID int64, subject, body string) {
	select {
	case s.fanoutQueue <- struct{}{}:
	default:
		slog.Error("notify watchers: fan-out queue full, dropping notification",
			"repo_id", repositoryID, "source_type", sourceType, "source_id", sourceID)
		return
	}
	ctx = context.WithoutCancel(ctx)
	SafeGo("notify-watchers", func() {
		defer func() { <-s.fanoutQueue }()
		s.fanoutSem <- struct{}{}
		defer func() { <-s.fanoutSem }()
		ctx, cancel := context.WithTimeout(ctx, watcherFanoutTimeout)
		defer cancel()
		s.notifyWatchersSync(ctx, repositoryID, sourceType, sourceID, subject, body)
	})
}

// notifyWatchersSync performs the actual watcher fan-out. A watch row is not
// authorization: each watcher is re-checked against the canonical repository
// read predicate so users whose access was revoked stop receiving private
// repo notifications even when their stale watch row persists.
func (s *NotificationService) notifyWatchersSync(ctx context.Context, repositoryID int64, sourceType string, sourceID int64, subject, body string) {
	repository, err := s.q.GetRepoByID(ctx, repositoryID)
	if err != nil {
		slog.Warn("notify watchers: load repository failed", "repo_id", repositoryID, "error", err)
		return
	}
	watchers, err := s.q.ListActiveWatchersForRepo(ctx, repositoryID)
	if err != nil {
		slog.Warn("notify watchers: list watchers failed", "repo_id", repositoryID, "error", err)
		return
	}
	for _, w := range watchers {
		canRead, err := canReadRepo(ctx, s.q, repository, w.ID)
		if err != nil {
			slog.Warn("notify watchers: permission check failed", "user_id", w.ID, "repo_id", repositoryID, "error", err)
			continue
		}
		if !canRead {
			continue
		}
		if !s.watcherWantsSource(ctx, w.ID, sourceType) {
			continue
		}
		_, err = s.Create(ctx, db.CreateNotificationParams{
			UserID:     w.ID,
			SourceType: sourceType,
			SourceID:   pgtype.Int8{Int64: sourceID, Valid: true},
			Subject:    subject,
			Body:       body,
		})
		if err != nil {
			slog.Warn("notify watchers: create notification failed", "user_id", w.ID, "error", err)
		}
	}
}

// watcherWantsSource checks whether the user's preferences allow receiving
// notifications for the given sourceType ("issue" or "landing").
// Defaults to true when no preference row exists. Any other read error fails
// closed so a transient DB failure can never bypass an explicit opt-out.
func (s *NotificationService) watcherWantsSource(ctx context.Context, userID int64, sourceType string) bool {
	prefs, err := s.q.GetNotificationPreferences(ctx, userID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			// No row means "all defaults enabled".
			return true
		}
		slog.Warn("watcher notification preference lookup failed; skipping recipient", "user_id", userID, "error", err)
		return false
	}
	switch sourceType {
	case "issue":
		return prefs.NotifyIssues
	case "landing":
		return prefs.NotifyLandings
	default:
		return true
	}
}

// UserWantsMentionNotification returns true if the user's preferences allow
// mention notifications. Defaults to true when no preference row exists. Any
// other read error fails closed so a transient DB failure can never bypass an
// explicit opt-out.
func (s *NotificationService) UserWantsMentionNotification(ctx context.Context, userID int64) bool {
	prefs, err := s.q.GetNotificationPreferences(ctx, userID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return true
		}
		slog.Warn("mention notification preference lookup failed; skipping recipient", "user_id", userID, "error", err)
		return false
	}
	return prefs.NotifyMentions
}

func rollbackNotificationTx(ctx context.Context, tx notificationCreateTx) {
	_ = tx.Rollback(ctx)
}

func toNotificationResponse(n db.Notification) NotificationResponse {
	var sourceID any
	if n.SourceID.Valid {
		sourceID = n.SourceID.Int64
	}
	return NotificationResponse{
		ID:         n.ID,
		SourceType: n.SourceType,
		SourceID:   sourceID,
		Subject:    n.Subject,
		Body:       n.Body,
		Status:     n.Status,
		ReadAt:     readAtPointer(n.ReadAt),
		CreatedAt:  n.CreatedAt,
		UpdatedAt:  n.UpdatedAt,
	}
}

func toPreferencesResponse(p db.UserNotificationPreference) NotificationPreferencesResponse {
	return NotificationPreferencesResponse{
		NotifyIssues:   p.NotifyIssues,
		NotifyLandings: p.NotifyLandings,
		NotifyMentions: p.NotifyMentions,
	}
}

func readAtPointer(ts pgtype.Timestamptz) *time.Time {
	if !ts.Valid {
		return nil
	}
	t := ts.Time
	return &t
}

func buildNotificationPayload(n db.Notification) (string, error) {
	resp := toNotificationResponse(n)
	resp.Body = truncateBody(resp.Body, maxNotificationPayloadBodyLen)

	payload, err := json.Marshal(resp)
	if err != nil {
		return "", err
	}
	if len(payload) <= maxNotificationPayloadBytes {
		return string(payload), nil
	}

	low, high := 0, len(resp.Body)
	var best []byte
	for low <= high {
		mid := low + (high-low)/2
		candidate := resp
		candidate.Body = truncateBody(resp.Body, mid)

		payload, err = json.Marshal(candidate)
		if err != nil {
			return "", err
		}
		if len(payload) <= maxNotificationPayloadBytes {
			best = payload
			low = mid + 1
			continue
		}
		high = mid - 1
	}
	if best == nil {
		return "", stdErrors.New("notification payload exceeds pg_notify limit")
	}
	return string(best), nil
}
