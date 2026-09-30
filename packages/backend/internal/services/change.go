package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"net/http"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/diffview"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

const changeSyncPageSize = 100

// ChangeRevisionQuerier is the database surface used by ChangeService.
type ChangeRevisionQuerier interface {
	UpsertChange(ctx context.Context, arg db.UpsertChangeParams) (db.Change, error)
	RecordChangeRevision(ctx context.Context, arg db.RecordChangeRevisionParams) (db.ChangeRevision, error)
	UpdateLandingRequestsTurnForRevision(ctx context.Context, arg db.UpdateLandingRequestsTurnForRevisionParams) error
	UpsertConflict(ctx context.Context, arg db.UpsertConflictParams) (db.Conflict, error)
	GetConflictByPath(ctx context.Context, arg db.GetConflictByPathParams) (db.Conflict, error)
	DeleteConflictsByChangeID(ctx context.Context, arg db.DeleteConflictsByChangeIDParams) (int64, error)
	ListChangeRevisions(ctx context.Context, arg db.ListChangeRevisionsParams) ([]db.ChangeRevision, error)
	ListFindingsForChange(ctx context.Context, arg db.ListFindingsForChangeParams) ([]db.Finding, error)
	ListFindingFeedbackForChange(ctx context.Context, arg db.ListFindingFeedbackForChangeParams) ([]db.ListFindingFeedbackForChangeRow, error)
	GetFindingForChange(ctx context.Context, arg db.GetFindingForChangeParams) (db.Finding, error)
	UpsertFindingFeedback(ctx context.Context, arg db.UpsertFindingFeedbackParams) (db.FindingFeedback, error)
	GetWorkspaceBookmarkForChange(ctx context.Context, arg db.GetWorkspaceBookmarkForChangeParams) (string, error)
	GetActiveFindingDispatch(ctx context.Context, arg db.GetActiveFindingDispatchParams) (db.AgentSession, error)
	ListAnalyzerRunsForChange(ctx context.Context, arg db.ListAnalyzerRunsForChangeParams) ([]db.AnalyzerRun, error)
	ListChangeReviews(ctx context.Context, arg db.ListChangeReviewsParams) ([]db.ListChangeReviewsRow, error)
	GetChangeLandingProvenance(ctx context.Context, arg db.GetChangeLandingProvenanceParams) (db.GetChangeLandingProvenanceRow, error)
	GetLandedChangesetForChange(ctx context.Context, arg db.GetLandedChangesetForChangeParams) (db.Changeset, error)
	ListChangeLandingApprovers(ctx context.Context, arg db.ListChangeLandingApproversParams) ([]db.ListChangeLandingApproversRow, error)
	GetChangeRevisionForWalkthrough(ctx context.Context, arg db.GetChangeRevisionForWalkthroughParams) (db.ChangeRevision, error)
	UpsertChangeWalkthrough(ctx context.Context, arg db.UpsertChangeWalkthroughParams) (db.ChangeWalkthrough, error)
	GetChangeWalkthrough(ctx context.Context, arg db.GetChangeWalkthroughParams) (db.ChangeWalkthrough, error)
	NotifyChangeEvent(ctx context.Context, arg db.NotifyChangeEventParams) error
	GetChangeStack(ctx context.Context, arg db.GetChangeStackParams) (db.GetChangeStackRow, error)
	GetAgentSession(ctx context.Context, id string) (db.AgentSession, error)
	GetWorkspaceSnapshotByRepo(ctx context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error)
	DeleteIssueChangeLinksByChange(ctx context.Context, arg db.DeleteIssueChangeLinksByChangeParams) error
	CreateIssueChangeLink(ctx context.Context, arg db.CreateIssueChangeLinkParams) error
	ListLinkedIssuesForChange(ctx context.Context, arg db.ListLinkedIssuesForChangeParams) ([]db.ListLinkedIssuesForChangeRow, error)
	// Ownership resolution (path owners, submitted approvals, recent editors)
	// reads the landing request the change is queued behind and the approving
	// principals' identities.
	GetLatestLandingRequestForChange(ctx context.Context, arg db.GetLatestLandingRequestForChangeParams) (db.LandingRequest, error)
	ListSubmittedLandingApprovals(ctx context.Context, landingRequestID int64) ([]db.LandingRequestReview, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	ListTeamNamesForUserByRepository(ctx context.Context, arg db.ListTeamNamesForUserByRepositoryParams) ([]string, error)
	GetUserByLowerEmail(ctx context.Context, lowerEmail pgtype.Text) (db.User, error)
}

// ChangeRepoHost is the live repository surface used by ChangeService.
type ChangeRepoHost interface {
	ListChanges(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Change, string, error)
	GetChange(ctx context.Context, owner, repo, changeID string) (repohost.Change, error)
	GetChangeDiff(ctx context.Context, owner, repo, changeID string) (repohost.ChangeDiff, error)
	GetChangeConflicts(ctx context.Context, owner, repo, changeID string) ([]repohost.Conflict, error)
	GetChangeFiles(ctx context.Context, owner, repo, changeID string) ([]repohost.ChangeFile, error)
	GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error)
	GetRevisionDiff(ctx context.Context, owner, repo, changeID, fromCommitID, toCommitID, path string) (repohost.ChangeDiff, error)
	SplitChange(ctx context.Context, owner, repo, changeID string, req repohost.SplitChangeRequest) (repohost.SplitChangeResult, error)
}

type ChangeDiffRequest struct {
	From             string
	To               string
	Path             string
	IgnoreWhitespace bool
}

type ChangeRevisionResponse struct {
	Seq                 int64     `json:"seq"`
	CommitID            string    `json:"commit_id"`
	ParentCommitID      string    `json:"parent_commit_id"`
	Source              string    `json:"source"`
	AgentSessionID      string    `json:"agent_session_id,omitempty"`
	WorkspaceSnapshotID string    `json:"workspace_snapshot_id,omitempty"`
	OperationIDs        []string  `json:"operation_ids"`
	CreatedAt           time.Time `json:"created_at"`
}

type ChangeConflictSummary struct {
	Path  string `json:"path"`
	State string `json:"state"`
}

type ChangeStackSummary struct {
	LandingRequestID     int64              `json:"landing_request_id"`
	LandingRequestNumber int64              `json:"landing_request_number"`
	Position             int64              `json:"position"`
	Size                 int64              `json:"size"`
	Turn                 LandingRequestTurn `json:"turn"`
}

// ChangeFindingResponse is one analyzer or reviewer finding pinned to the
// revision where it was produced. State is relative to the live change head;
// old findings remain in the response and are marked stale rather than hidden.
type ChangeFindingResponse struct {
	ID             int64                    `json:"id"`
	Seq            int64                    `json:"seq"`
	CommitID       string                   `json:"commit_id"`
	Analyzer       string                   `json:"analyzer"`
	Source         string                   `json:"source"`
	Path           string                   `json:"path"`
	Line           int64                    `json:"line"`
	Side           string                   `json:"side"`
	Severity       string                   `json:"severity"`
	Text           string                   `json:"text"`
	Suggestion     *string                  `json:"suggestion,omitempty"`
	AnchorHash     *string                  `json:"anchor_hash,omitempty"`
	Feedback       *FindingFeedbackResponse `json:"feedback,omitempty"`
	FeedbackCounts FindingFeedbackCounts    `json:"feedback_counts"`
	State          string                   `json:"state"`
	CreatedAt      time.Time                `json:"created_at"`
}

type FindingFeedbackResponse struct {
	Useful   bool    `json:"useful"`
	Note     *string `json:"note,omitempty"`
	ByUserID int64   `json:"by_user_id"`
}

type FindingFeedbackCounts struct {
	Useful    int64 `json:"useful"`
	NotUseful int64 `json:"not_useful"`
}

type SubmitFindingFeedbackInput struct {
	RepositoryID int64
	ChangeID     string
	FindingID    int64
	UserID       int64
	Useful       bool
	Note         *string
}

type DispatchFindingInput struct {
	RepositoryID int64
	UserID       int64
	Owner        string
	Repo         string
	ChangeID     string
	FindingID    int64
}

// AnalyzerRunResponse makes the absence of findings unambiguous. In
// particular, paused and failed analyzers carry their reason instead of being
// rendered as successful empty runs.
type AnalyzerRunResponse struct {
	Name          string     `json:"name"`
	State         string     `json:"state"`
	Seq           int64      `json:"seq"`
	StartedAt     *time.Time `json:"started_at"`
	FinishedAt    *time.Time `json:"finished_at"`
	PausedBy      *string    `json:"paused_by,omitempty"`
	PausedReason  *string    `json:"paused_reason,omitempty"`
	FailureReason *string    `json:"failure_reason,omitempty"`
}

type ChangeFindingsResponse struct {
	ChangeID   string                  `json:"change_id"`
	CurrentSeq int64                   `json:"current_seq"`
	Findings   []ChangeFindingResponse `json:"findings"`
	Analyzers  []AnalyzerRunResponse   `json:"analyzers"`
}

// ResolveChangeConflictInput identifies one unresolved path and the actor who
// requested an agent-assisted resolution.
type ResolveChangeConflictInput struct {
	RepositoryID int64
	UserID       int64
	Owner        string
	Repo         string
	ChangeID     string
	Path         string
}

// ResolveChangeConflictResponse is returned as soon as the agent session and
// its task message are durable. Sandbox provisioning continues asynchronously.
type ResolveChangeConflictResponse struct {
	AgentSessionID string `json:"agent_session_id"`
}

type SplitChangeInput struct {
	Paths       []string `json:"paths"`
	Description string   `json:"description,omitempty"`
}

type SplitChangeResponse struct {
	Original repohost.Change `json:"original"`
	Split    repohost.Change `json:"split"`
}

// ChangeConflictAgent is the existing agent-session path used to resolve a
// conflicted change. Keeping the dependency narrow makes the change service
// responsible for orchestration without duplicating the agent runtime.
type ChangeConflictAgent interface {
	CreateSession(ctx context.Context, input CreateAgentSessionInput) (AgentSessionResponse, error)
	AppendMessageAndDispatch(ctx context.Context, input DispatchAgentRunInput, parts []db.CreateAgentPartParams) (AgentMessageResponse, error)
	DeleteSession(ctx context.Context, sessionID string, userID int64) error
}

// ChangeReviewResponse is one submitted review anchored to a stable change
// revision. Human reviews carry Type (approve, request_changes, or comment).
// Agent reviews carry ReviewerKind "agent" and Verdict lgtm or concerns, or,
// for an agent's comment or change request, that type and no confidence.
// Confidence is otherwise a server-validated bucket for agent reviews and
// nullable for human reviews.
type ChangeReviewResponse struct {
	Reviewer         string  `json:"reviewer"`
	ReviewerLogin    string  `json:"reviewer_login"`
	ReviewerKind     string  `json:"reviewer_kind"`
	Type             string  `json:"type"`
	Verdict          string  `json:"verdict"`
	ConfidenceBucket *string `json:"confidence_bucket"`
	Summary          string  `json:"summary"`
	CommitID         string  `json:"commit_id"`
	Seq              int64   `json:"seq"`
	LastReviewedSeq  int64   `json:"last_reviewed_seq"`
}

type ChangeLandingApprover struct {
	Login string `json:"login"`
	Seq   int64  `json:"seq"`
}

type ChangeLandingProvenance struct {
	LandingRequestID     int64                   `json:"landing_request_id"`
	LandingRequestNumber int64                   `json:"landing_request_number"`
	At                   time.Time               `json:"at"`
	By                   string                  `json:"by"`
	ApprovedBy           []ChangeLandingApprover `json:"approved_by"`
}

type ChangeLinkedIssue struct {
	ID       int64  `json:"id"`
	Number   int64  `json:"number"`
	Title    string `json:"title"`
	State    string `json:"state"`
	LinkType string `json:"link_type"`
}

// ChangeDetailResponse is the revision-aware representation returned by the
// canonical change detail endpoint.
type ChangeDetailResponse struct {
	ChangeID        string                   `json:"change_id"`
	CommitID        string                   `json:"commit_id"`
	Description     string                   `json:"description"`
	AuthorName      string                   `json:"author_name"`
	AuthorEmail     string                   `json:"author_email"`
	Timestamp       string                   `json:"timestamp"`
	HasConflict     bool                     `json:"has_conflict"`
	IsEmpty         bool                     `json:"is_empty"`
	ParentChangeIDs []string                 `json:"parent_change_ids"`
	ParentChangeID  string                   `json:"parent_change_id"`
	Revisions       []ChangeRevisionResponse `json:"revisions"`
	Reviews         []ChangeReviewResponse   `json:"reviews"`
	CurrentSeq      int64                    `json:"current_seq"`
	Conflicts       []ChangeConflictSummary  `json:"conflicts"`
	Stack           *ChangeStackSummary      `json:"stack"`
	Turn            *LandingRequestTurn      `json:"turn"`
	RevisionSeq     int64                    `json:"revision_seq"`
	Owners          ChangeOwnership          `json:"owners"`
	Landed          *ChangeLandingProvenance `json:"landed"`
	LinkedIssues    []ChangeLinkedIssue      `json:"linked_issues"`
}

type ChangeService struct {
	queries  ChangeRevisionQuerier
	repoHost ChangeRepoHost
	pool     *pgxpool.Pool
	agent    ChangeConflictAgent
}

type ChangeServiceOption func(*ChangeService)

// WithChangeConflictAgent enables agent-assisted conflict resolution through
// the standard agent session and dispatch implementation.
func WithChangeConflictAgent(agent ChangeConflictAgent) ChangeServiceOption {
	return func(service *ChangeService) {
		service.agent = agent
	}
}

func NewChangeService(queries ChangeRevisionQuerier, repoHost ChangeRepoHost, pool *pgxpool.Pool, opts ...ChangeServiceOption) *ChangeService {
	service := &ChangeService{queries: queries, repoHost: repoHost, pool: pool}
	for _, opt := range opts {
		opt(service)
	}
	return service
}

// RecordPush snapshots every current stable change after repo-host has accepted
// and imported a push. Commit uniqueness makes repeated callbacks idempotent;
// scanning all heads also captures every member of a newly pushed stack, not
// only the ref's tip commit.
func (s *ChangeService) RecordPush(ctx context.Context, repositoryID int64, owner, repo string) error {
	if s == nil || s.queries == nil || s.repoHost == nil {
		return pkgerrors.Internal("change revision service not configured")
	}

	cursor := ""
	for {
		changes, nextCursor, err := s.repoHost.ListChanges(ctx, owner, repo, cursor, changeSyncPageSize)
		if err != nil {
			return mapChangeRepoHostError(err, "failed to load pushed changes")
		}
		for _, change := range changes {
			if strings.TrimSpace(change.ChangeID) == "" || strings.TrimSpace(change.CommitID) == "" {
				continue
			}
			if err := s.recordRepoHostChange(ctx, repositoryID, owner, repo, change); err != nil {
				return err
			}
		}
		if nextCursor == "" {
			return nil
		}
		if nextCursor == cursor {
			return pkgerrors.Internal("failed to paginate pushed changes")
		}
		cursor = nextCursor
	}
}

// recordRepoHostChange snapshots one repo-host change exactly as a push
// callback would, including its conflicts when it has any.
func (s *ChangeService) recordRepoHostChange(ctx context.Context, repositoryID int64, owner, repo string, change repohost.Change) error {
	var conflicts []repohost.Conflict
	if change.HasConflict {
		var err error
		conflicts, err = s.repoHost.GetChangeConflicts(ctx, owner, repo, change.ChangeID)
		if err != nil {
			return mapChangeRepoHostError(err, "failed to load pushed change conflicts")
		}
	}
	return s.recordPushedChange(ctx, repositoryID, change, conflicts)
}

func (s *ChangeService) recordPushedChange(ctx context.Context, repositoryID int64, change repohost.Change, conflicts []repohost.Conflict) error {
	agentSessionID, workspaceSnapshotID, workspaceID, source, err := s.resolvePushProvenance(ctx, repositoryID, change.Description)
	if err != nil {
		return err
	}
	return s.recordChange(ctx, repositoryID, change, source, agentSessionID, workspaceSnapshotID, workspaceID, conflicts, parseIssueTrailers(change.Description), true)
}

// RecordGeneratedChange records a server-created first revision, such as a
// product-level revert, without treating copied description trailers as the
// provenance of the new server operation.
func (s *ChangeService) RecordGeneratedChange(ctx context.Context, repositoryID int64, change repohost.Change, source string) error {
	if s == nil || s.queries == nil {
		return pkgerrors.Internal("change revision service not configured")
	}
	if source != "revert" {
		return pkgerrors.Internal("invalid generated change source")
	}
	return s.recordChange(ctx, repositoryID, change, source, "", "", "", nil, nil, false)
}

// SplitChange rejects landed or conflicted changes, asks repo-host to perform
// the atomic jj rewrite, then records a split revision for both resulting
// stable change IDs.
func (s *ChangeService) SplitChange(
	ctx context.Context,
	repositoryID int64,
	owner, repo, changeID string,
	input SplitChangeInput,
) (SplitChangeResponse, error) {
	if s == nil || s.queries == nil || s.repoHost == nil {
		return SplitChangeResponse{}, pkgerrors.Internal("change split service not configured")
	}
	changeID = strings.TrimSpace(changeID)
	if changeID == "" {
		return SplitChangeResponse{}, pkgerrors.BadRequest("change_id is required")
	}
	if len(input.Paths) == 0 {
		return SplitChangeResponse{}, pkgerrors.BadRequest("paths must not be empty")
	}
	for _, filePath := range input.Paths {
		if strings.TrimSpace(filePath) == "" {
			return SplitChangeResponse{}, pkgerrors.BadRequest("paths must not contain empty values")
		}
	}

	if _, err := s.queries.GetChangeLandingProvenance(ctx, db.GetChangeLandingProvenanceParams{
		RepositoryID: repositoryID,
		ChangeID:     changeID,
	}); err == nil {
		return SplitChangeResponse{}, pkgerrors.Conflict("landed changes cannot be split")
	} else if !stdErrors.Is(err, pgx.ErrNoRows) {
		return SplitChangeResponse{}, pkgerrors.Internal("failed to check whether change is landed")
	}
	if _, err := s.queries.GetLandedChangesetForChange(ctx, db.GetLandedChangesetForChangeParams{
		RepositoryID: repositoryID,
		ChangeID:     changeID,
	}); err == nil {
		return SplitChangeResponse{}, pkgerrors.Conflict("landed changes cannot be split")
	} else if !stdErrors.Is(err, pgx.ErrNoRows) {
		return SplitChangeResponse{}, pkgerrors.Internal("failed to check whether change is in a landed changeset")
	}

	current, err := s.repoHost.GetChange(ctx, owner, repo, changeID)
	if err != nil {
		return SplitChangeResponse{}, mapChangeRepoHostError(err, "failed to get change")
	}
	// A change of the mythical stack is rewritten only by the stack service;
	// splitting it here would rewrite its descendants and move the bookmark.
	// The check uses the resolved id, so a unique prefix cannot slip past it.
	if s.pool != nil {
		owned, err := db.New(s.pool).IsMythicalChange(ctx, repositoryID, current.ChangeID)
		if err != nil {
			return SplitChangeResponse{}, pkgerrors.Internal("failed to check whether change is on the mythical stack").WithCause(err)
		}
		if owned {
			return SplitChangeResponse{}, errMythicalBookmarkOwned
		}
	}
	if current.HasConflict {
		return SplitChangeResponse{}, pkgerrors.Conflict("conflicted changes cannot be split")
	}

	result, err := s.repoHost.SplitChange(ctx, owner, repo, changeID, repohost.SplitChangeRequest{
		Paths:       input.Paths,
		Description: input.Description,
	})
	if err != nil {
		return SplitChangeResponse{}, mapChangeRepoHostError(err, "failed to split change")
	}
	if result.Original.ChangeID != current.ChangeID || strings.TrimSpace(result.Split.ChangeID) == "" || result.Split.ChangeID == result.Original.ChangeID {
		return SplitChangeResponse{}, pkgerrors.Internal("repo-host returned an invalid split result")
	}
	if err := s.recordChange(ctx, repositoryID, result.Original, "split", "", "", "", nil, nil, false); err != nil {
		return SplitChangeResponse{}, err
	}
	if err := s.recordChange(ctx, repositoryID, result.Split, "split", "", "", "", nil, nil, false); err != nil {
		return SplitChangeResponse{}, err
	}
	return SplitChangeResponse{Original: result.Original, Split: result.Split}, nil
}

func (s *ChangeService) recordChange(ctx context.Context, repositoryID int64, change repohost.Change, source, agentSessionID, workspaceSnapshotID, workspaceID string, conflicts []repohost.Conflict, issueLinks []issueTrailerLink, syncIssueLinks bool) error {
	if change.ParentChangeIDs == nil {
		change.ParentChangeIDs = []string{}
	}
	parentChangeIDs, err := json.Marshal(change.ParentChangeIDs)
	if err != nil {
		return pkgerrors.Internal("failed to encode change parents").WithCause(err)
	}

	upsert := db.UpsertChangeParams{
		RepositoryID:    repositoryID,
		ChangeID:        change.ChangeID,
		CommitID:        change.CommitID,
		Description:     change.Description,
		AuthorName:      change.AuthorName,
		AuthorEmail:     change.AuthorEmail,
		HasConflict:     change.HasConflict,
		IsEmpty:         change.IsEmpty,
		ParentChangeIds: parentChangeIDs,
	}
	revision := db.RecordChangeRevisionParams{
		RepositoryID:        repositoryID,
		ChangeID:            change.ChangeID,
		CommitID:            change.CommitID,
		ParentCommitID:      change.ParentCommitID,
		Source:              source,
		AgentSessionID:      agentSessionID,
		WorkspaceSnapshotID: workspaceSnapshotID,
		WorkspaceID:         workspaceID,
		OperationIds:        []string{},
	}

	if s.pool == nil {
		if _, err := s.queries.UpsertChange(ctx, upsert); err != nil {
			return pkgerrors.Internal("failed to store pushed change").WithCause(err)
		}
		if _, err := s.queries.RecordChangeRevision(ctx, revision); err != nil {
			return pkgerrors.Internal("failed to store change revision").WithCause(err)
		}
		if syncIssueLinks {
			if err := replaceIssueChangeLinks(ctx, s.queries, repositoryID, change.ChangeID, issueLinks); err != nil {
				return err
			}
		}
		if err := replaceChangeConflicts(ctx, s.queries, repositoryID, change.ChangeID, conflicts); err != nil {
			return err
		}
		return s.updateLandingTurnsForRevision(ctx, revision)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return pkgerrors.Internal("failed to begin change revision transaction").WithCause(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	txQueries := db.New(tx)
	if _, err := txQueries.UpsertChange(ctx, upsert); err != nil {
		return pkgerrors.Internal("failed to store pushed change").WithCause(err)
	}
	if _, err := txQueries.RecordChangeRevision(ctx, revision); err != nil {
		return pkgerrors.Internal("failed to store change revision").WithCause(err)
	}
	if syncIssueLinks {
		if err := replaceIssueChangeLinks(ctx, txQueries, repositoryID, change.ChangeID, issueLinks); err != nil {
			return err
		}
	}
	if err := updateLandingTurnsForRevision(ctx, txQueries, revision); err != nil {
		return err
	}
	if err := replaceChangeConflicts(ctx, txQueries, repositoryID, change.ChangeID, conflicts); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return pkgerrors.Internal("failed to commit change revision").WithCause(err)
	}
	return nil
}

type issueTrailerLink struct {
	Number   int64
	LinkType string
}

var (
	issueTrailerLinePattern = regexp.MustCompile(`(?i)^(issue\s*:|closes\s*:?)\s*(.+)$`)
	issueNumberPattern      = regexp.MustCompile(`#([1-9][0-9]*)`)
)

// parseIssueTrailers extracts repository-local issue references. Repeated
// trailers are deduplicated, with the stronger Closes spelling winning when a
// description contains both forms for the same issue.
func parseIssueTrailers(description string) []issueTrailerLink {
	links := make(map[int64]string)
	for _, rawLine := range strings.Split(description, "\n") {
		match := issueTrailerLinePattern.FindStringSubmatch(strings.TrimSpace(rawLine))
		if len(match) != 3 {
			continue
		}
		linkType := "issue"
		if strings.HasPrefix(strings.ToLower(match[1]), "closes") {
			linkType = "closes"
		}
		for _, numberMatch := range issueNumberPattern.FindAllStringSubmatch(match[2], -1) {
			number, err := strconv.ParseInt(numberMatch[1], 10, 64)
			if err != nil || number <= 0 {
				continue
			}
			if previous := links[number]; previous != "closes" {
				links[number] = linkType
			}
		}
	}

	numbers := make([]int64, 0, len(links))
	for number := range links {
		numbers = append(numbers, number)
	}
	sort.Slice(numbers, func(i, j int) bool { return numbers[i] < numbers[j] })
	result := make([]issueTrailerLink, 0, len(numbers))
	for _, number := range numbers {
		result = append(result, issueTrailerLink{Number: number, LinkType: links[number]})
	}
	return result
}

type issueChangeLinkWriter interface {
	DeleteIssueChangeLinksByChange(context.Context, db.DeleteIssueChangeLinksByChangeParams) error
	CreateIssueChangeLink(context.Context, db.CreateIssueChangeLinkParams) error
}

func replaceIssueChangeLinks(ctx context.Context, writer issueChangeLinkWriter, repositoryID int64, changeID string, links []issueTrailerLink) error {
	if err := writer.DeleteIssueChangeLinksByChange(ctx, db.DeleteIssueChangeLinksByChangeParams{
		RepositoryID: repositoryID,
		ChangeID:     changeID,
	}); err != nil {
		return pkgerrors.Internal("failed to refresh change issue links").WithCause(err)
	}
	for _, link := range links {
		if err := writer.CreateIssueChangeLink(ctx, db.CreateIssueChangeLinkParams{
			RepositoryID: repositoryID,
			ChangeID:     changeID,
			LinkType:     link.LinkType,
			IssueNumber:  link.Number,
		}); err != nil {
			return pkgerrors.Internal("failed to refresh change issue links").WithCause(err)
		}
	}
	return nil
}

func (s *ChangeService) updateLandingTurnsForRevision(ctx context.Context, revision db.RecordChangeRevisionParams) error {
	return updateLandingTurnsForRevision(ctx, s.queries, revision)
}

type landingRevisionTurnQuerier interface {
	UpdateLandingRequestsTurnForRevision(context.Context, db.UpdateLandingRequestsTurnForRevisionParams) error
}

func updateLandingTurnsForRevision(ctx context.Context, queries landingRevisionTurnQuerier, revision db.RecordChangeRevisionParams) error {
	if err := queries.UpdateLandingRequestsTurnForRevision(ctx, db.UpdateLandingRequestsTurnForRevisionParams{
		RepositoryID: revision.RepositoryID,
		ChangeID:     revision.ChangeID,
		CommitID:     revision.CommitID,
	}); err != nil {
		return pkgerrors.Internal("failed to update landing request turn").WithCause(err)
	}
	return nil
}

type changeConflictWriter interface {
	UpsertConflict(ctx context.Context, arg db.UpsertConflictParams) (db.Conflict, error)
	DeleteConflictsByChangeID(ctx context.Context, arg db.DeleteConflictsByChangeIDParams) (int64, error)
}

// replaceChangeConflicts makes the database cache describe the current change
// revision. A clean rewrite removes rows from the prior conflicted revision;
// a still-conflicted rewrite reopens exactly the paths repo-host reports.
func replaceChangeConflicts(ctx context.Context, writer changeConflictWriter, repositoryID int64, changeID string, conflicts []repohost.Conflict) error {
	normalized := make([]db.UpsertConflictParams, 0, len(conflicts))
	for _, conflict := range conflicts {
		if strings.EqualFold(strings.TrimSpace(conflict.ResolutionStatus), "resolved") {
			continue
		}
		conflictType := strings.ToLower(strings.TrimSpace(conflict.ConflictType))
		if conflictType == "" {
			conflictType = "content"
		}
		switch conflictType {
		case "content", "rename", "delete":
		default:
			return pkgerrors.Internal("failed to refresh change conflicts")
		}
		normalized = append(normalized, db.UpsertConflictParams{
			RepositoryID: repositoryID,
			ChangeID:     changeID,
			FilePath:     conflict.FilePath,
			ConflictType: conflictType,
		})
	}

	if _, err := writer.DeleteConflictsByChangeID(ctx, db.DeleteConflictsByChangeIDParams{
		RepositoryID: repositoryID,
		ChangeID:     changeID,
	}); err != nil {
		return pkgerrors.Internal("failed to refresh change conflicts").WithCause(err)
	}

	for _, conflict := range normalized {
		if _, err := writer.UpsertConflict(ctx, conflict); err != nil {
			return pkgerrors.Internal("failed to refresh change conflicts").WithCause(err)
		}
	}
	return nil
}

func (s *ChangeService) refreshChangeConflicts(ctx context.Context, repositoryID int64, changeID string, conflicts []repohost.Conflict) error {
	if s.pool == nil {
		return replaceChangeConflicts(ctx, s.queries, repositoryID, changeID, conflicts)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return pkgerrors.Internal("failed to begin change conflict transaction").WithCause(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := replaceChangeConflicts(ctx, db.New(tx), repositoryID, changeID, conflicts); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return pkgerrors.Internal("failed to commit change conflicts").WithCause(err)
	}
	return nil
}

func (s *ChangeService) resolvePushProvenance(ctx context.Context, repositoryID int64, description string) (string, string, string, string, error) {
	agentCandidate := validUUIDTrailer(description, "Agent-Session")
	workspaceCandidate := validUUIDTrailer(description, "Workspace-Snapshot")

	agentSessionID := ""
	workspaceID := ""
	if agentCandidate != "" {
		session, err := s.queries.GetAgentSession(ctx, agentCandidate)
		switch {
		case err == nil && session.RepositoryID == repositoryID:
			agentSessionID = agentCandidate
			// RFD-004: the run's computer, when it executed in a workspace.
			workspaceID = UUIDString(session.WorkspaceID)
		case err == nil, stdErrors.Is(err, pgx.ErrNoRows):
			// Untrusted commit text must not be able to forge provenance or make
			// an otherwise valid push callback fail.
		default:
			return "", "", "", "", pkgerrors.Internal("failed to resolve change agent provenance")
		}
	}

	workspaceSnapshotID := ""
	if workspaceCandidate != "" {
		_, err := s.queries.GetWorkspaceSnapshotByRepo(ctx, db.GetWorkspaceSnapshotByRepoParams{
			ID:           workspaceCandidate,
			RepositoryID: repositoryID,
		})
		switch {
		case err == nil:
			workspaceSnapshotID = workspaceCandidate
		case stdErrors.Is(err, pgx.ErrNoRows):
			// Ignore an unverified trailer for the same reason as above.
		default:
			return "", "", "", "", pkgerrors.Internal("failed to resolve change workspace provenance")
		}
	}

	source := "push"
	if agentSessionID != "" {
		source = "agent"
	}
	return agentSessionID, workspaceSnapshotID, workspaceID, source, nil
}

func validUUIDTrailer(description, name string) string {
	prefix := strings.ToLower(name) + ":"
	lines := strings.Split(description, "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		line := strings.TrimSpace(lines[index])
		if !strings.HasPrefix(strings.ToLower(line), prefix) {
			continue
		}
		value := strings.TrimSpace(line[len(prefix):])
		parsed, err := uuid.Parse(value)
		if err != nil {
			return ""
		}
		return parsed.String()
	}
	return ""
}

func (s *ChangeService) GetChange(ctx context.Context, repositoryID int64, owner, repo, changeID string) (ChangeDetailResponse, error) {
	if s == nil || s.queries == nil || s.repoHost == nil {
		return ChangeDetailResponse{}, pkgerrors.Internal("change revision service not configured")
	}

	change, err := s.repoHost.GetChange(ctx, owner, repo, changeID)
	if err != nil {
		return ChangeDetailResponse{}, mapChangeRepoHostError(err, "failed to get change")
	}
	revisions, err := s.queries.ListChangeRevisions(ctx, db.ListChangeRevisionsParams{
		RepositoryID: repositoryID,
		ChangeID:     change.ChangeID,
	})
	if err != nil {
		return ChangeDetailResponse{}, pkgerrors.Internal("failed to list change revisions").WithCause(err)
	}
	reviews, err := s.queries.ListChangeReviews(ctx, db.ListChangeReviewsParams{
		RepositoryID: repositoryID,
		ChangeID:     change.ChangeID,
	})
	if err != nil {
		return ChangeDetailResponse{}, pkgerrors.Internal("failed to list change reviews").WithCause(err)
	}
	conflicts, err := s.repoHost.GetChangeConflicts(ctx, owner, repo, change.ChangeID)
	if err != nil {
		return ChangeDetailResponse{}, mapChangeRepoHostError(err, "failed to get change conflicts")
	}

	response := ChangeDetailResponse{
		ChangeID:        change.ChangeID,
		CommitID:        change.CommitID,
		Description:     change.Description,
		AuthorName:      change.AuthorName,
		AuthorEmail:     change.AuthorEmail,
		Timestamp:       change.Timestamp,
		HasConflict:     change.HasConflict,
		IsEmpty:         change.IsEmpty,
		ParentChangeIDs: change.ParentChangeIDs,
		Revisions:       make([]ChangeRevisionResponse, 0, len(revisions)),
		Reviews:         make([]ChangeReviewResponse, 0, len(reviews)),
		Conflicts:       make([]ChangeConflictSummary, 0, len(conflicts)),
		LinkedIssues:    []ChangeLinkedIssue{},
	}
	actorLogins := make(map[string]string, len(reviews)+1)
	linkedIssues, err := s.queries.ListLinkedIssuesForChange(ctx, db.ListLinkedIssuesForChangeParams{
		RepositoryID: repositoryID,
		ChangeID:     change.ChangeID,
	})
	if err != nil {
		return ChangeDetailResponse{}, pkgerrors.Internal("failed to list linked issues").WithCause(err)
	}
	for _, linked := range linkedIssues {
		response.LinkedIssues = append(response.LinkedIssues, ChangeLinkedIssue{
			ID: linked.ID, Number: linked.Number, Title: linked.Title,
			State: linked.State, LinkType: linked.LinkType,
		})
	}
	if len(change.ParentChangeIDs) > 0 {
		response.ParentChangeID = change.ParentChangeIDs[0]
	}
	for _, revision := range revisions {
		operationIDs := revision.OperationIds
		if operationIDs == nil {
			operationIDs = []string{}
		}
		response.Revisions = append(response.Revisions, ChangeRevisionResponse{
			Seq:                 revision.Seq,
			CommitID:            revision.CommitID,
			ParentCommitID:      revision.ParentCommitID,
			Source:              revision.Source,
			AgentSessionID:      uuidString(revision.AgentSessionID),
			WorkspaceSnapshotID: uuidString(revision.WorkspaceSnapshotID),
			OperationIDs:        operationIDs,
			CreatedAt:           revision.CreatedAt,
		})
		if revision.CommitID == change.CommitID {
			response.CurrentSeq = revision.Seq
		}
	}
	for _, review := range reviews {
		var confidenceBucket *string
		if review.ConfidenceBucket.Valid {
			bucket := review.ConfidenceBucket.String
			confidenceBucket = &bucket
		}
		response.Reviews = append(response.Reviews, ChangeReviewResponse{
			Reviewer:         review.Reviewer,
			ReviewerLogin:    resolveActorLoginWithCache(ctx, s.queries, review.ReviewerKey, actorLogins),
			ReviewerKind:     review.ReviewerKind,
			Type:             review.Type,
			Verdict:          review.Verdict,
			ConfidenceBucket: confidenceBucket,
			Summary:          review.Summary,
			CommitID:         review.CommitID,
			Seq:              review.Seq,
			LastReviewedSeq:  review.LastReviewedSeq,
		})
	}
	for _, conflict := range conflicts {
		state := strings.TrimSpace(conflict.ResolutionStatus)
		if state == "" {
			state = "unresolved"
		}
		response.Conflicts = append(response.Conflicts, ChangeConflictSummary{
			Path:  conflict.FilePath,
			State: state,
		})
	}

	landed, err := s.queries.GetChangeLandingProvenance(ctx, db.GetChangeLandingProvenanceParams{
		RepositoryID: repositoryID,
		ChangeID:     change.ChangeID,
	})
	if err == nil {
		approvers, approvalsErr := s.queries.ListChangeLandingApprovers(ctx, db.ListChangeLandingApproversParams{
			LandingRequestID: landed.LandingRequestID,
			ChangeID:         change.ChangeID,
		})
		if approvalsErr != nil {
			return ChangeDetailResponse{}, pkgerrors.Internal("failed to load change landing approvers").WithCause(approvalsErr)
		}
		response.Landed = &ChangeLandingProvenance{
			LandingRequestID:     landed.LandingRequestID,
			LandingRequestNumber: landed.LandingRequestNumber,
			At:                   landed.LandedAt,
			By:                   landed.LandedBy,
			ApprovedBy:           make([]ChangeLandingApprover, 0, len(approvers)),
		}
		for _, approver := range approvers {
			response.Landed.ApprovedBy = append(response.Landed.ApprovedBy, ChangeLandingApprover{
				Login: approver.Login,
				Seq:   approver.Seq,
			})
		}
	} else if !stdErrors.Is(err, pgx.ErrNoRows) {
		return ChangeDetailResponse{}, pkgerrors.Internal("failed to load change landing provenance")
	}

	stack, err := s.queries.GetChangeStack(ctx, db.GetChangeStackParams{
		RepositoryID: repositoryID,
		ChangeID:     change.ChangeID,
	})
	if err == nil {
		turn := resolveLandingTurnWithCache(ctx, s.queries, stack.TurnParty, stack.TurnActorID, stack.TurnSince, stack.TurnReason, actorLogins)
		response.Stack = &ChangeStackSummary{
			LandingRequestID:     stack.LandingRequestID,
			LandingRequestNumber: stack.LandingRequestNumber,
			Position:             stack.Position,
			Size:                 stack.Size,
			Turn:                 turn,
		}
		response.Turn = &turn
	} else if !stdErrors.Is(err, pgx.ErrNoRows) {
		return ChangeDetailResponse{}, pkgerrors.Internal("failed to load change stack")
	}

	// Path ownership: the change detail carries who owns every touched path,
	// which approvals already satisfy them, and who is still missing, so the
	// landing gate and the UI read the same answer.
	files, err := s.repoHost.GetChangeFiles(ctx, owner, repo, change.ChangeID)
	if err != nil {
		return ChangeDetailResponse{}, mapChangeRepoHostError(err, "failed to get change files")
	}
	parentIDs, err := json.Marshal(change.ParentChangeIDs)
	if err != nil {
		return ChangeDetailResponse{}, pkgerrors.Internal("failed to encode change parents").WithCause(err)
	}
	persisted, err := s.queries.UpsertChange(ctx, db.UpsertChangeParams{
		RepositoryID: repositoryID, ChangeID: change.ChangeID, CommitID: change.CommitID,
		Description: change.Description, AuthorName: change.AuthorName, AuthorEmail: change.AuthorEmail,
		HasConflict: change.HasConflict, IsEmpty: change.IsEmpty, ParentChangeIds: parentIDs,
	})
	if err != nil {
		return ChangeDetailResponse{}, pkgerrors.Internal("failed to record change revision").WithCause(err)
	}
	if err := s.refreshChangeConflicts(ctx, repositoryID, change.ChangeID, conflicts); err != nil {
		return ChangeDetailResponse{}, err
	}
	landingID, err := latestLandingID(ctx, s.queries, repositoryID, change.ChangeID)
	if err != nil {
		return ChangeDetailResponse{}, pkgerrors.Internal("failed to load change landing request").WithCause(err)
	}
	touched := make([]OwnershipTouchedFile, 0, len(files))
	for _, file := range files {
		touched = append(touched, OwnershipTouchedFile{Path: file.Path, ChangeID: change.ChangeID, CommitID: change.CommitID, RevisionSeq: persisted.RevisionSeq})
	}
	resolved, err := resolveChangeOwnership(ctx, s.queries, s.repoHost, repositoryID, owner, repo, change.ChangeID, touched, landingID)
	if err != nil {
		return ChangeDetailResponse{}, pkgerrors.UnprocessableEntity("invalid ownership configuration: " + err.Error())
	}
	resolved.SuggestedReviewers = appendUniqueReviewers(resolved.SuggestedReviewers, s.recentEditors(ctx, owner, repo, change, files)...)
	response.RevisionSeq = persisted.RevisionSeq
	response.Owners = resolved
	return response, nil
}

// GetChangeDiff resolves public revision sequence selectors to immutable
// commits and delegates tree comparison to repo-host. Revision pairs use jj's
// interdiff semantics in repo-host; `from=parent` compares the selected
// revision against the parent recorded by that immutable commit.
func (s *ChangeService) GetChangeDiff(
	ctx context.Context,
	repositoryID int64,
	owner string,
	repo string,
	changeID string,
	request ChangeDiffRequest,
) (repohost.ChangeDiff, error) {
	if s == nil || s.repoHost == nil {
		return repohost.ChangeDiff{}, pkgerrors.Internal("change revision service not configured")
	}

	request.From = strings.TrimSpace(request.From)
	request.To = strings.TrimSpace(request.To)
	hasRevisionSelector := request.From != "" || request.To != ""
	if !hasRevisionSelector {
		diff, err := diffview.BuildChangeDiff(ctx, s.repoHost, owner, repo, changeID, diffview.BuildOptions{
			IgnoreWhitespace: request.IgnoreWhitespace,
		})
		if err != nil {
			return repohost.ChangeDiff{}, mapChangeRepoHostError(err, "failed to get change diff")
		}
		if request.Path != "" {
			filtered := make([]repohost.FileDiff, 0, 1)
			for _, file := range diff.FileDiffs {
				if file.Path == request.Path {
					filtered = append(filtered, file)
				}
			}
			diff.FileDiffs = filtered
		}
		return diff, nil
	}
	if request.From == "" || request.To == "" {
		return repohost.ChangeDiff{}, pkgerrors.BadRequest("from and to are required for a revision diff")
	}
	if s.queries == nil {
		return repohost.ChangeDiff{}, pkgerrors.Internal("change revision service not configured")
	}

	toSeq, err := parseChangeRevisionSeq(request.To, "to")
	if err != nil {
		return repohost.ChangeDiff{}, err
	}
	var fromSeq int64
	if request.From != "parent" {
		fromSeq, err = parseChangeRevisionSeq(request.From, "from")
		if err != nil {
			return repohost.ChangeDiff{}, err
		}
	}

	change, err := s.repoHost.GetChange(ctx, owner, repo, changeID)
	if err != nil {
		return repohost.ChangeDiff{}, mapChangeRepoHostError(err, "failed to get change")
	}
	revisions, err := s.queries.ListChangeRevisions(ctx, db.ListChangeRevisionsParams{
		RepositoryID: repositoryID,
		ChangeID:     change.ChangeID,
	})
	if err != nil {
		return repohost.ChangeDiff{}, pkgerrors.Internal("failed to list change revisions").WithCause(err)
	}

	var toRevision *db.ChangeRevision
	var fromRevision *db.ChangeRevision
	for index := range revisions {
		revision := &revisions[index]
		if revision.Seq == toSeq {
			toRevision = revision
		}
		if request.From != "parent" && revision.Seq == fromSeq {
			fromRevision = revision
		}
	}
	if toRevision == nil {
		return repohost.ChangeDiff{}, pkgerrors.NotFound("to revision not found")
	}
	if request.From != "parent" && fromRevision == nil {
		return repohost.ChangeDiff{}, pkgerrors.NotFound("from revision not found")
	}

	fromCommitID := ""
	if fromRevision != nil {
		fromCommitID = fromRevision.CommitID
	}
	diff, err := diffview.BuildRevisionDiff(
		ctx,
		s.repoHost,
		owner,
		repo,
		change.ChangeID,
		fromCommitID,
		toRevision.CommitID,
		request.Path,
		diffview.BuildOptions{IgnoreWhitespace: request.IgnoreWhitespace},
	)
	if err != nil {
		return repohost.ChangeDiff{}, mapChangeRepoHostError(err, "failed to get change revision diff")
	}
	return diff, nil
}

func parseChangeRevisionSeq(value, field string) (int64, error) {
	seq, err := strconv.ParseInt(value, 10, 64)
	if err != nil || seq <= 0 {
		return 0, pkgerrors.BadRequest(field + " must be a positive revision sequence")
	}
	return seq, nil
}

// GetFindings returns every revision by default so callers can keep stale
// findings visible. A non-empty revision selects exactly one recorded
// revision and returns 404 rather than silently falling back to the head.
func (s *ChangeService) GetFindings(ctx context.Context, repositoryID int64, owner, repo, changeID, revision string, userID int64) (ChangeFindingsResponse, error) {
	if s == nil || s.queries == nil || s.repoHost == nil {
		return ChangeFindingsResponse{}, pkgerrors.Internal("change findings service not configured")
	}

	var revisionFilter pgtype.Int8
	if value := strings.TrimSpace(revision); value != "" {
		seq, err := strconv.ParseInt(value, 10, 64)
		if err != nil || seq <= 0 {
			return ChangeFindingsResponse{}, pkgerrors.BadRequest("rev must be a positive integer")
		}
		revisionFilter = pgtype.Int8{Int64: seq, Valid: true}
	}

	change, err := s.repoHost.GetChange(ctx, owner, repo, changeID)
	if err != nil {
		return ChangeFindingsResponse{}, mapChangeRepoHostError(err, "failed to get change")
	}
	commitBySeq, currentSeq, err := s.listFindingRevisions(ctx, repositoryID, change)
	if err != nil {
		return ChangeFindingsResponse{}, err
	}
	if currentSeq == 0 {
		// Repo-host commits that never passed through a push callback, such
		// as a new repository's initial change, have no recorded revision
		// yet. Record the current one so it gets a real sequence.
		if strings.TrimSpace(change.ChangeID) == "" || strings.TrimSpace(change.CommitID) == "" {
			return ChangeFindingsResponse{}, pkgerrors.Internal("repo-host returned a change without an identity")
		}
		if err := s.recordRepoHostChange(ctx, repositoryID, owner, repo, change); err != nil {
			return ChangeFindingsResponse{}, err
		}
		commitBySeq, currentSeq, err = s.listFindingRevisions(ctx, repositoryID, change)
		if err != nil {
			return ChangeFindingsResponse{}, err
		}
		if currentSeq == 0 {
			return ChangeFindingsResponse{}, pkgerrors.Internal("current change revision not recorded")
		}
	}
	if revisionFilter.Valid {
		if _, ok := commitBySeq[revisionFilter.Int64]; !ok {
			return ChangeFindingsResponse{}, pkgerrors.NotFound("change revision not found")
		}
	}

	findings, err := s.queries.ListFindingsForChange(ctx, db.ListFindingsForChangeParams{
		RepositoryID: repositoryID,
		ChangeID:     change.ChangeID,
		RevisionSeq:  revisionFilter,
	})
	if err != nil {
		return ChangeFindingsResponse{}, pkgerrors.Internal("failed to list change findings").WithCause(err)
	}
	feedbackRows, err := s.queries.ListFindingFeedbackForChange(ctx, db.ListFindingFeedbackForChangeParams{
		RepositoryID: repositoryID,
		ChangeID:     change.ChangeID,
		RevisionSeq:  revisionFilter,
		UserID:       pgtype.Int8{Int64: userID, Valid: userID > 0},
	})
	if err != nil {
		return ChangeFindingsResponse{}, pkgerrors.Internal("failed to list finding feedback").WithCause(err)
	}
	feedbackByFinding := make(map[int64]db.ListFindingFeedbackForChangeRow, len(feedbackRows))
	for _, row := range feedbackRows {
		feedbackByFinding[row.FindingID] = row
	}
	analyzers, err := s.queries.ListAnalyzerRunsForChange(ctx, db.ListAnalyzerRunsForChangeParams{
		RepositoryID: repositoryID,
		ChangeID:     change.ChangeID,
		RevisionSeq:  revisionFilter,
	})
	if err != nil {
		return ChangeFindingsResponse{}, pkgerrors.Internal("failed to list analyzer runs").WithCause(err)
	}

	response := ChangeFindingsResponse{
		ChangeID:   change.ChangeID,
		CurrentSeq: currentSeq,
		Findings:   make([]ChangeFindingResponse, 0, len(findings)),
		Analyzers:  make([]AnalyzerRunResponse, 0, len(analyzers)),
	}
	for _, finding := range findings {
		state := "stale"
		if finding.RevisionSeq == currentSeq {
			state = "current"
		}
		feedbackRow := feedbackByFinding[finding.ID]
		var callerFeedback *FindingFeedbackResponse
		if feedbackRow.CallerUserID.Valid && feedbackRow.CallerUseful.Valid {
			callerFeedback = &FindingFeedbackResponse{
				Useful:   feedbackRow.CallerUseful.Bool,
				Note:     optionalText(feedbackRow.CallerNote),
				ByUserID: feedbackRow.CallerUserID.Int64,
			}
		}
		response.Findings = append(response.Findings, ChangeFindingResponse{
			ID: finding.ID, Seq: finding.RevisionSeq, CommitID: commitBySeq[finding.RevisionSeq],
			Analyzer: finding.Analyzer, Source: finding.Source, Path: finding.Path, Line: finding.Line,
			Side: finding.Side, Severity: finding.Severity, Text: finding.Text,
			Suggestion: optionalText(finding.Suggestion), AnchorHash: optionalText(finding.AnchorHash),
			Feedback:       callerFeedback,
			FeedbackCounts: FindingFeedbackCounts{Useful: feedbackRow.UsefulCount, NotUseful: feedbackRow.NotUsefulCount},
			State:          state, CreatedAt: finding.CreatedAt,
		})
	}
	for _, analyzer := range analyzers {
		response.Analyzers = append(response.Analyzers, AnalyzerRunResponse{
			Name: analyzer.Name, State: analyzer.State, Seq: analyzer.RevisionSeq,
			StartedAt: optionalTime(analyzer.StartedAt), FinishedAt: optionalTime(analyzer.FinishedAt),
			PausedBy: optionalText(analyzer.PausedBy), PausedReason: optionalText(analyzer.PausedReason),
			FailureReason: optionalText(analyzer.FailureReason),
		})
	}
	return response, nil
}

func (s *ChangeService) listFindingRevisions(ctx context.Context, repositoryID int64, change repohost.Change) (map[int64]string, int64, error) {
	revisions, err := s.queries.ListChangeRevisions(ctx, db.ListChangeRevisionsParams{
		RepositoryID: repositoryID,
		ChangeID:     change.ChangeID,
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to list change revisions").WithCause(err)
	}
	commitBySeq := make(map[int64]string, len(revisions))
	var currentSeq int64
	for _, recorded := range revisions {
		commitBySeq[recorded.Seq] = recorded.CommitID
		if recorded.CommitID == change.CommitID {
			currentSeq = recorded.Seq
		}
	}
	return commitBySeq, currentSeq, nil
}

// SubmitFindingFeedback records the caller's latest useful/not-useful verdict
// for one finding. The database key makes repeat submissions an upsert.
func (s *ChangeService) SubmitFindingFeedback(ctx context.Context, input SubmitFindingFeedbackInput) (FindingFeedbackResponse, error) {
	if s == nil || s.queries == nil {
		return FindingFeedbackResponse{}, pkgerrors.Internal("change findings service not configured")
	}
	if input.FindingID <= 0 {
		return FindingFeedbackResponse{}, pkgerrors.BadRequest("finding_id must be a positive integer")
	}
	if input.UserID <= 0 {
		return FindingFeedbackResponse{}, pkgerrors.Unauthorized("authentication required")
	}
	if _, err := s.queries.GetFindingForChange(ctx, db.GetFindingForChangeParams{
		ID: input.FindingID, RepositoryID: input.RepositoryID, ChangeID: input.ChangeID,
	}); err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return FindingFeedbackResponse{}, pkgerrors.NotFound("finding not found")
		}
		return FindingFeedbackResponse{}, pkgerrors.Internal("failed to load change finding").WithCause(err)
	}

	note := pgtype.Text{}
	if input.Note != nil {
		note = pgtype.Text{String: *input.Note, Valid: true}
	}
	stored, err := s.queries.UpsertFindingFeedback(ctx, db.UpsertFindingFeedbackParams{
		FindingID: input.FindingID,
		UserID:    input.UserID,
		Useful:    input.Useful,
		Note:      note,
	})
	if err != nil {
		return FindingFeedbackResponse{}, pkgerrors.Internal("failed to store finding feedback").WithCause(err)
	}
	return FindingFeedbackResponse{Useful: stored.Useful, Note: optionalText(stored.Note), ByUserID: stored.UserID}, nil
}

// DispatchFinding starts the standard agent-session flow with the finding text
// as its durable task. Session metadata and a partial unique index preserve the
// finding origin and prevent concurrent active dispatches for the same row.
func (s *ChangeService) DispatchFinding(ctx context.Context, input DispatchFindingInput) (AgentSessionResponse, error) {
	if s == nil || s.queries == nil {
		return AgentSessionResponse{}, pkgerrors.Internal("change findings service not configured")
	}
	if s.agent == nil {
		return AgentSessionResponse{}, pkgerrors.Internal("agent service unavailable")
	}
	if input.FindingID <= 0 {
		return AgentSessionResponse{}, pkgerrors.BadRequest("finding_id must be a positive integer")
	}
	finding, err := s.queries.GetFindingForChange(ctx, db.GetFindingForChangeParams{
		ID: input.FindingID, RepositoryID: input.RepositoryID, ChangeID: input.ChangeID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return AgentSessionResponse{}, pkgerrors.NotFound("finding not found")
		}
		return AgentSessionResponse{}, pkgerrors.Internal("failed to load change finding").WithCause(err)
	}
	if _, err := s.queries.GetActiveFindingDispatch(ctx, db.GetActiveFindingDispatchParams{
		RepositoryID: input.RepositoryID, FindingID: input.FindingID,
	}); err == nil {
		return AgentSessionResponse{}, pkgerrors.Conflict("finding dispatch already running")
	} else if !stdErrors.Is(err, pgx.ErrNoRows) {
		return AgentSessionResponse{}, pkgerrors.Internal("failed to check finding dispatch")
	}

	metadata, err := json.Marshal(map[string]int64{"finding_id": input.FindingID})
	if err != nil {
		return AgentSessionResponse{}, pkgerrors.Internal("failed to encode finding dispatch metadata").WithCause(err)
	}
	session, err := s.agent.CreateSession(ctx, CreateAgentSessionInput{
		RepositoryID: input.RepositoryID,
		UserID:       input.UserID,
		Title:        fmt.Sprintf("Fix finding #%d", input.FindingID),
		Metadata:     metadata,
	})
	if err != nil {
		return AgentSessionResponse{}, err
	}
	content, err := json.Marshal(map[string]string{"value": finding.Text})
	if err != nil {
		return AgentSessionResponse{}, pkgerrors.Internal("failed to encode finding task").WithCause(err)
	}

	sourceBookmark, bookmarkErr := s.queries.GetWorkspaceBookmarkForChange(ctx, db.GetWorkspaceBookmarkForChangeParams{
		RepositoryID: input.RepositoryID, UserID: input.UserID, ChangeID: input.ChangeID,
	})
	if bookmarkErr != nil && !stdErrors.Is(bookmarkErr, pgx.ErrNoRows) {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		_ = s.agent.DeleteSession(cleanupCtx, session.ID, input.UserID)
		return AgentSessionResponse{}, pkgerrors.Internal("failed to resolve change workspace").WithCause(bookmarkErr)
	}

	dispatchInput := DispatchAgentRunInput{
		SessionID: session.ID, RepositoryID: input.RepositoryID, UserID: input.UserID,
		RepoOwner: input.Owner, RepoName: input.Repo,
		AgentProvider: "smithers", AgentTransport: "workflow", SourceBookmark: sourceBookmark,
	}
	if _, err := s.agent.AppendMessageAndDispatch(ctx, dispatchInput, []db.CreateAgentPartParams{{PartType: "text", Content: content}}); err != nil {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		_ = s.agent.DeleteSession(cleanupCtx, session.ID, input.UserID)
		return AgentSessionResponse{}, err
	}
	return session, nil
}

// ResolveConflict creates a repo-scoped agent session, records a precise task
// for one unresolved path, and dispatches it through the ordinary agent run
// path. The run token is restricted to that path, so the resolver cannot push
// unrelated file changes. The pushed commit's Agent-Session trailer is later
// verified by RecordPush and records the next revision with source=agent.
func (s *ChangeService) ResolveConflict(ctx context.Context, input ResolveChangeConflictInput) (ResolveChangeConflictResponse, error) {
	if s == nil || s.queries == nil {
		return ResolveChangeConflictResponse{}, pkgerrors.Internal("change revision service not configured")
	}
	if s.agent == nil {
		return ResolveChangeConflictResponse{}, pkgerrors.Internal("agent service unavailable")
	}

	input.ChangeID = strings.TrimSpace(input.ChangeID)
	input.Path = strings.TrimSpace(input.Path)
	if input.ChangeID == "" {
		return ResolveChangeConflictResponse{}, pkgerrors.BadRequest("change_id is required")
	}
	if input.Path == "" {
		return ResolveChangeConflictResponse{}, pkgerrors.BadRequest("path is required")
	}
	cleanPath := path.Clean(input.Path)
	if len(input.Path) > 1024 || strings.HasPrefix(input.Path, "/") || cleanPath == "." || cleanPath == ".." || strings.HasPrefix(cleanPath, "../") || strings.Contains(input.Path, "\x00") || strings.ContainsAny(input.Path, "*?") {
		return ResolveChangeConflictResponse{}, pkgerrors.BadRequest("path must be a safe repository-relative path without glob characters")
	}

	conflict, err := s.queries.GetConflictByPath(ctx, db.GetConflictByPathParams{
		RepositoryID: input.RepositoryID,
		ChangeID:     input.ChangeID,
		FilePath:     input.Path,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return ResolveChangeConflictResponse{}, pkgerrors.NotFound("conflict not found")
		}
		return ResolveChangeConflictResponse{}, pkgerrors.Internal("failed to load change conflict").WithCause(err)
	}
	if conflict.Resolved {
		return ResolveChangeConflictResponse{}, pkgerrors.Conflict("conflict is already resolved")
	}

	session, err := s.agent.CreateSession(ctx, CreateAgentSessionInput{
		RepositoryID: input.RepositoryID,
		UserID:       input.UserID,
		Title:        "Resolve change conflict",
	})
	if err != nil {
		return ResolveChangeConflictResponse{}, err
	}

	prompt := fmt.Sprintf(
		"Resolve the conflict in path %q on jj change %q in repository %s/%s. Modify only that path, preserve the stable change ID, run relevant tests, and push the resolved rewrite. Ensure the pushed commit description includes this trailer exactly: Agent-Session: %s",
		conflict.FilePath,
		conflict.ChangeID,
		input.Owner,
		input.Repo,
		session.ID,
	)
	content, err := json.Marshal(map[string]string{"value": prompt})
	if err != nil {
		return ResolveChangeConflictResponse{}, pkgerrors.Internal("failed to encode conflict resolution task").WithCause(err)
	}

	dispatchInput := DispatchAgentRunInput{
		SessionID:      session.ID,
		RepositoryID:   input.RepositoryID,
		UserID:         input.UserID,
		RepoOwner:      input.Owner,
		RepoName:       input.Repo,
		AgentProvider:  "smithers",
		AgentTransport: "workflow",
		AllowedPaths:   []string{conflict.FilePath},
	}
	if _, err := s.agent.AppendMessageAndDispatch(ctx, dispatchInput, []db.CreateAgentPartParams{{PartType: "text", Content: content}}); err != nil {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		_ = s.agent.DeleteSession(cleanupCtx, session.ID, input.UserID)
		return ResolveChangeConflictResponse{}, err
	}

	return ResolveChangeConflictResponse{AgentSessionID: session.ID}, nil
}

// recentEditors names the other authors who recently touched the same paths, as
// suggested reviewers alongside the declared owners.
func (s *ChangeService) recentEditors(ctx context.Context, owner, repo string, current repohost.Change, touched []repohost.ChangeFile) []string {
	wanted := make(map[string]struct{}, len(touched))
	for _, file := range touched {
		wanted[file.Path] = struct{}{}
	}
	changes, _, err := s.repoHost.ListChanges(ctx, owner, repo, "", 50)
	if err != nil {
		return nil
	}
	var editors []string
	for _, change := range changes {
		if change.ChangeID == current.ChangeID || strings.EqualFold(change.AuthorName, current.AuthorName) {
			continue
		}
		files, err := s.repoHost.GetChangeFiles(ctx, owner, repo, change.ChangeID)
		if err != nil {
			continue
		}
		for _, file := range files {
			if _, ok := wanted[file.Path]; ok {
				if email := strings.ToLower(strings.TrimSpace(change.AuthorEmail)); email != "" {
					user, lookupErr := s.queries.GetUserByLowerEmail(ctx, pgtype.Text{String: email, Valid: true})
					if lookupErr == nil {
						editors = append(editors, user.Username)
					}
				}
				break
			}
		}
	}
	return appendUniqueReviewers(nil, editors...)
}

func uuidString(value pgtype.UUID) string {
	if !value.Valid {
		return ""
	}
	return uuid.UUID(value.Bytes).String()
}

func optionalText(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	text := value.String
	return &text
}

func optionalTime(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	timestamp := value.Time
	return &timestamp
}

func mapChangeRepoHostError(err error, fallback string) error {
	if status, ok := repohost.IsStatusError(err); ok {
		message := strings.TrimSpace(status.Message)
		if message == "" {
			message = fallback
		}
		switch status.StatusCode {
		case http.StatusBadRequest:
			return pkgerrors.BadRequest(message)
		case http.StatusUnauthorized:
			return pkgerrors.Unauthorized("repo-host authorization failed")
		case http.StatusForbidden:
			return pkgerrors.Forbidden("repo-host permission denied")
		case http.StatusNotFound:
			return pkgerrors.NotFound(message)
		case http.StatusConflict:
			return pkgerrors.Conflict(message)
		case http.StatusUnprocessableEntity:
			return pkgerrors.UnprocessableEntity(message)
		}
	}
	return pkgerrors.Internal(fallback)
}
