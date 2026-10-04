package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode"

	"github.com/jackc/pgx/v5"
	"golang.org/x/text/unicode/norm"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// TODO publication: the install's GitHub App pushes a verified candidate to
// the TODO's smithers/<slug> branch and opens its pull request (§12.5.1).
// Every guard reads facts the install already holds and mints no token;
// lookup, send and settlement use the claimed pass's own GitHub destination
// and controlled bare-object transport. Merge stays a person's command: its
// readiness decision (MergeDecision) is composed by the merge route's owner.

// MythicalPublicationConnections resolves a repository's GitHub destination
// and the App installation that serves it.
type MythicalPublicationConnections interface {
	RepoSyncConnectionChecker
	GetGitHubInstallationIDForRepositoryOwner(ctx context.Context, ownerUserID, ownerOrgID int64, owner, repo string) (int64, error)
}

type mythicalPublication struct {
	app         GitHubAppCredentialReader
	connections MythicalPublicationConnections
	budget      *BudgetTracker
}

// EnableTodoPublication composes TODO pull-request publication for the
// install. Without it every TODO-branch write is held (publicationAuthority).
func (s *MythicalService) EnableTodoPublication(app GitHubAppCredentialReader, connections MythicalPublicationConnections, budget *BudgetTracker) {
	s.publication = &mythicalPublication{app: app, connections: connections, budget: budget}
	s.prFacts = s.todoPRFacts
	s.outbound = MythicalOutboundProviders{
		CanonicalApp: s.canonicalApp, StackLease: s.stackLease, Budget: s.githubBudget, Membership: s.currentMembership,
		Authorization: mythicalCommandAuthorization, AcceptedGeneration: s.acceptedGeneration,
	}
}

// mythicalPublicationTarget is where a repository's TODOs are published.
type mythicalPublicationTarget struct {
	repository              db.Repository
	owner                   string
	actor                   int64
	githubOwner, githubRepo string
	installation            int64
}

func (s *MythicalService) publicationTarget(ctx context.Context, repositoryID int64) (mythicalPublicationTarget, error) {
	p := s.publication
	if p == nil || p.connections == nil {
		return mythicalPublicationTarget{}, errors.New(mythicalPublicationUnavailable)
	}
	repository, owner, err := s.repository(ctx, repositoryID)
	if err != nil {
		return mythicalPublicationTarget{}, err
	}
	stack, err := s.queries().GetMythicalStack(ctx, repositoryID)
	if err != nil {
		return mythicalPublicationTarget{}, fmt.Errorf("read the repository's stack: %w", err)
	}
	if !stack.ActorUserID.Valid {
		return mythicalPublicationTarget{}, errors.New("the repository's stack has no account to publish as")
	}
	githubOwner, githubRepo, err := resolveGitHubDestination(ctx, s.queries(), p.connections, stack.ActorUserID.Int64, repositoryID, owner, repository.Name)
	if err != nil {
		return mythicalPublicationTarget{}, err
	}
	installation, err := p.connections.GetGitHubInstallationIDForRepositoryOwner(ctx, repository.UserID.Int64, repository.OrgID.Int64, githubOwner, githubRepo)
	if err != nil {
		return mythicalPublicationTarget{}, err
	}
	if installation <= 0 {
		return mythicalPublicationTarget{}, fmt.Errorf("the install's GitHub App is not installed on %s/%s", githubOwner, githubRepo)
	}
	return mythicalPublicationTarget{repository: repository, owner: owner, actor: stack.ActorUserID.Int64,
		githubOwner: githubOwner, githubRepo: githubRepo, installation: installation}, nil
}

// canonicalApp: the install's own App is configured and installed on the
// repository's GitHub destination.
func (s *MythicalService) canonicalApp(ctx context.Context, item db.MythicalItem, _ string) error {
	if s.publication == nil {
		return errors.New(mythicalPublicationUnavailable)
	}
	credentials, err := loadGitHubAppCredentials(ctx, s.publication.app)
	if err != nil {
		return fmt.Errorf("the install's GitHub App is unavailable: %w", err)
	}
	if credentials.ID <= 0 {
		return ErrGitHubAppNotConfigured
	}
	_, err = s.publicationTarget(ctx, item.RepositoryID)
	return err
}

// stackLease: writes happen only on an active stack whose current claim, if
// any, is live. Every slot save also checks the claim (SaveMythicalItemUnderLease).
func (s *MythicalService) stackLease(ctx context.Context, item db.MythicalItem, _ string) error {
	stack, err := s.queries().GetMythicalStack(ctx, item.RepositoryID)
	if err != nil {
		return fmt.Errorf("read the repository's stack: %w", err)
	}
	if stack.State != "active" {
		return fmt.Errorf("the repository's stack is %s", stack.State)
	}
	if stack.Running && (!stack.LeaseExpiresAt.Valid || !stack.LeaseExpiresAt.Time.After(s.now())) {
		return errors.New("the stack's lease expired")
	}
	return nil
}

// githubBudget: the installation's shared GitHub budget is not spent.
func (s *MythicalService) githubBudget(ctx context.Context, item db.MythicalItem, _ string) error {
	if s.publication == nil || s.publication.budget == nil {
		return errors.New("GitHub's budgeted transport is unavailable")
	}
	target, err := s.publicationTarget(ctx, item.RepositoryID)
	if err != nil {
		return err
	}
	status := s.publication.budget.Status(target.installation)
	if status.Limit > 0 && status.Remaining <= 0 && status.ResetAt.After(s.now()) {
		return fmt.Errorf("the GitHub budget for %s/%s is spent until %s", target.githubOwner, target.githubRepo, status.ResetAt.UTC().Format("15:04 UTC"))
	}
	return nil
}

// currentMembership: the person the TODO is for, and the account the stack
// publishes as, are this install's current owner.
func (s *MythicalService) currentMembership(ctx context.Context, item db.MythicalItem, _ string) error {
	owner, err := s.queries().GetSelfHostOwner(ctx)
	if err != nil || owner.ProhibitLogin {
		return errors.New("the install has no current owner")
	}
	stack, err := s.queries().GetMythicalStack(ctx, item.RepositoryID)
	if err != nil {
		return fmt.Errorf("read the repository's stack: %w", err)
	}
	person := stack.ActorUserID
	switch {
	case item.OwnerID.Valid:
		person = item.OwnerID
	case item.CreatedBy.Valid:
		person = item.CreatedBy
	}
	if !person.Valid || person.Int64 != owner.ID || !stack.ActorUserID.Valid || stack.ActorUserID.Int64 != owner.ID {
		return errors.New("the TODO's person is no longer a member of this install")
	}
	return nil
}

// mythicalCommandAuthorization: the system publishes a TODO's own change and
// closes its pull request; it never merges. A merge is authorized only by a
// person's browser session, or a Land that session recorded (M-05, M-39).
func mythicalCommandAuthorization(ctx context.Context, item db.MythicalItem, kind string) error {
	switch kind {
	case "push", "open", "body":
		if item.Source != "todo" && item.Source != "issue" {
			return errors.New("only a TODO's own change is published to GitHub")
		}
		return nil
	case "close":
		return nil
	case "merge":
		if info := middleware.AuthInfoFromContext(ctx); info != nil && info.User != nil && !info.IsTokenAuth && info.SessionHash != "" && !info.IsAgent() {
			return nil
		}
		if land := mythicalChecksOf(item).Land; land != nil && land.Session != "" {
			return nil
		}
		return errors.New("a person merges a TODO; Smithers never merges on its own")
	}
	return fmt.Errorf("GitHub operation %q is not authorized", kind)
}

// acceptedGeneration: the operation was prepared from the item as it is now
// (the TODO fence), and a publication carries a verified candidate.
func (s *MythicalService) acceptedGeneration(ctx context.Context, item db.MythicalItem, kind string) error {
	persisted, err := s.queries().GetMythicalItem(ctx, item.ID)
	if err != nil {
		return fmt.Errorf("read the TODO: %w", err)
	}
	if persisted.Version != item.Version || persisted.Generation != item.Generation {
		return errors.New("the TODO changed while its GitHub operation was prepared")
	}
	switch kind {
	case "push", "open", "body":
		if persisted.State == "cancelled" || persisted.State == "dropped" || mythicalSettledStates[persisted.State] {
			return errors.New("the TODO is " + persisted.State)
		}
		if !persisted.CandidateVerified || persisted.CandidateHead == "" {
			return errors.New("the TODO has no verified candidate to publish")
		}
	}
	return nil
}

// todoPRFacts reads the accepted publication facts of one item: its branch,
// title, latest prompt, evidence, link back, requester and the repository's
// draft support. Stack-order facts come from the claimed pass (shape).
func (s *MythicalService) todoPRFacts(ctx context.Context, item db.MythicalItem) (mythicalPRShape, error) {
	target, err := s.publicationTarget(ctx, item.RepositoryID)
	if err != nil {
		return mythicalPRShape{}, err
	}
	q := s.queries()
	requester := target.actor
	if item.OwnerID.Valid {
		requester = item.OwnerID.Int64
	}
	person, err := q.GetUserByID(ctx, requester)
	if err != nil {
		return mythicalPRShape{}, fmt.Errorf("read the TODO's person: %w", err)
	}
	if s.publicURL == "" {
		return mythicalPRShape{}, errors.New("the install's address is unset; the pull request cannot link back")
	}
	branch, err := s.todoBranch(ctx, item)
	if err != nil {
		return mythicalPRShape{}, err
	}
	shape := mythicalPRShape{Branch: branch, Title: mythicalTodoTitle(item), Owner: person.Username,
		URL:        s.publicURL + "/" + target.owner + "/" + target.repository.Name,
		FixesIssue: item.Source == "issue" && item.IssueNumber.Valid}
	shape.Prompt, shape.Acceptance = mythicalTodoPrompt(item)
	shape.Evidence, shape.Review = mythicalTodoEvidenceText(item)
	var private bool
	err = s.store.QueryRow(ctx, `SELECT is_private FROM github_app_installation_repositories
 WHERE installation_id = $1 AND owner_login_lower = lower($2) AND repo_name_lower = lower($3)`,
		target.installation, target.githubOwner, target.githubRepo).Scan(&private)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return mythicalPRShape{}, err
	}
	// GitHub offers drafts on every public repository; a private one may be
	// on a plan without them, so a later item opens ready with its wait named.
	shape.DraftsAvailable = err == nil && !private
	return shape, nil
}

func mythicalTodoTitle(item db.MythicalItem) string {
	if title := strings.TrimSpace(item.Title.String); title != "" {
		return title
	}
	return strings.TrimSpace(item.IssueTitle)
}

func mythicalItemNumber(item db.MythicalItem) int64 {
	if item.Number.Valid {
		return item.Number.Int64
	}
	return item.IssueNumber.Int64
}

// mythicalTodoPrompt is the latest prompt revision and its acceptance; an
// issue's approved body stands in for an issue-made item.
func mythicalTodoPrompt(item db.MythicalItem) (string, string) {
	var revisions []struct {
		Text       string   `json:"text"`
		Acceptance []string `json:"acceptance"`
	}
	if json.Unmarshal(item.Revisions, &revisions) != nil || len(revisions) == 0 {
		return item.IssueBody, ""
	}
	latest := revisions[len(revisions)-1]
	acceptance := ""
	if len(latest.Acceptance) > 0 {
		acceptance = "Acceptance:\n- " + strings.Join(latest.Acceptance, "\n- ")
	}
	return latest.Text, acceptance
}

// mythicalTodoEvidenceText renders the candidate's check receipts and flow
// version, and its review verdict, as the card's evidence shows them.
func mythicalTodoEvidenceText(item db.MythicalItem) (string, string) {
	var lines []string
	review := ""
	for _, entry := range currentTodoEvidence(item).Items {
		switch entry["kind"] {
		case "check":
			line := fmt.Sprintf("- %v: %v", entry["name"], entry["state"])
			if took, ok := entry["took_s"].(float64); ok {
				line += " (" + strconv.FormatFloat(took, 'f', 1, 64) + "s)"
			}
			lines = append(lines, line)
		case "flow":
			lines = append(lines, fmt.Sprintf("- flow %v %v", entry["name"], entry["version"]))
		case "review":
			review = fmt.Sprintf("Review: %v", entry["summary"])
		}
	}
	if len(lines) == 0 {
		return "", review
	}
	return "Checks:\n" + strings.Join(lines, "\n"), review
}

// mythicalTodoSlugMax bounds a TODO branch slug (§8.1.1).
const mythicalTodoSlugMax = 48

// mythicalTodoSlug derives a branch slug from a TODO title: letters and
// digits folded to ASCII, lowercased, every other run one hyphen, at most
// mythicalTodoSlugMax characters. Empty when the title has no letter or digit.
func mythicalTodoSlug(title string) string {
	var b strings.Builder
	gap := false
	for _, r := range norm.NFKD.String(strings.ToLower(title)) {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			if gap && b.Len() > 0 {
				b.WriteByte('-')
			}
			b.WriteRune(r)
			gap = false
		case unicode.Is(unicode.Mn, r):
			// A combining mark folds into its letter: é is e.
		default:
			gap = true
		}
	}
	slug := b.String()
	if len(slug) > mythicalTodoSlugMax {
		slug = strings.TrimRight(slug[:mythicalTodoSlugMax], "-")
	}
	return slug
}

// mythicalUniqueBranch names the branch for slug that no other item holds:
// the slug itself, else the slug with the TODO number, else with a counter.
func mythicalUniqueBranch(slug string, number int64, taken map[string]bool) string {
	if slug == "" {
		slug = "todo-" + strconv.FormatInt(number, 10)
	}
	fit := func(suffix string) string {
		base := slug
		if len(base)+len(suffix) > mythicalTodoSlugMax {
			base = strings.TrimRight(base[:mythicalTodoSlugMax-len(suffix)], "-")
		}
		return "smithers/" + base + suffix
	}
	if candidate := fit(""); !taken[candidate] {
		return candidate
	}
	for k := 0; ; k++ {
		suffix := "-" + strconv.FormatInt(number, 10)
		if k > 0 {
			suffix += "-" + strconv.Itoa(k+1)
		}
		if candidate := fit(suffix); !taken[candidate] {
			return candidate
		}
	}
}

// todoBranch is the item's recorded branch, or the unique one its title
// derives before its first publication records it.
func (s *MythicalService) todoBranch(ctx context.Context, item db.MythicalItem) (string, error) {
	if recorded := mythicalChecksOf(item).Branch; recorded != "" {
		return recorded, nil
	}
	rows, err := s.store.Query(ctx, `SELECT checks->>'branch' FROM mythical_items
 WHERE repository_id = $1 AND id <> $2 AND checks ? 'branch'`, item.RepositoryID, item.ID)
	if err != nil {
		return "", err
	}
	taken, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (string, error) {
		var branch string
		return branch, row.Scan(&branch)
	})
	if err != nil {
		return "", err
	}
	held := map[string]bool{}
	for _, branch := range taken {
		held[branch] = true
	}
	return mythicalUniqueBranch(mythicalTodoSlug(mythicalTodoTitle(item)), mythicalItemNumber(item), held), nil
}

// shape completes the provider's facts with the claimed pass's own: whether
// the item is first among unsettled items, the earlier verified candidates
// its prefix includes, and its diff stat against that prefix.
func (st *mythicalItemStep) shape(ctx context.Context, item db.MythicalItem) (mythicalPRShape, error) {
	shape, err := st.s.prFacts(ctx, item)
	if err != nil {
		return mythicalPRShape{}, err
	}
	shape.First, shape.FirstNumber, shape.Included = true, mythicalItemNumber(item), nil
	base := ""
	if st.r != nil {
		base = st.r.mainTip
	}
	for _, earlier := range st.items {
		if earlier.ID == item.ID {
			break
		}
		if mythicalSettledStates[earlier.State] {
			continue
		}
		if shape.First {
			shape.First, shape.FirstNumber = false, mythicalItemNumber(earlier)
		}
		if earlier.CandidateVerified && earlier.CandidateHead != "" && earlier.CandidateBase == base {
			shape.Included = append(shape.Included, mythicalPRIncluded{Number: mythicalItemNumber(earlier), URL: earlier.PRURL})
			base = earlier.CandidateHead
		}
	}
	if st.r != nil && item.CandidateHead != "" && st.fetchCandidate(ctx, item) == nil {
		if stat, err := st.r.g.git(ctx, "diff", "--shortstat", "--no-ext-diff", "--no-textconv", st.prefix(item), item.CandidateHead); err == nil {
			shape.DiffStat = stat
		}
	}
	return shape, nil
}

// resolveGitHub resolves the stack's GitHub destination once per pass. A
// resolution failure is kept in ghErr for each caller's own handling; only
// a failure to read the repository is returned.
func (st *mythicalItemStep) resolveGitHub(ctx context.Context) error {
	if st.gh != nil || st.ghErr != nil {
		return nil
	}
	repository, owner, err := st.s.repository(ctx, st.r.row.RepositoryID)
	if err != nil {
		return err
	}
	gh, err := st.s.github.Resolve(ctx, repository, owner, st.r.row.ActorUserID.Int64)
	st.gh, st.ghErr = &gh, err
	return nil
}

func (st *mythicalItemStep) publicationGitHub(ctx context.Context) (mythicalGitHubRepo, error) {
	if st.s.github == nil || st.r == nil || !st.r.row.ActorUserID.Valid {
		return mythicalGitHubRepo{}, errors.New(mythicalPublicationUnavailable)
	}
	if err := st.resolveGitHub(ctx); err != nil {
		return mythicalGitHubRepo{}, err
	}
	if st.ghErr != nil {
		return mythicalGitHubRepo{}, st.ghErr
	}
	return *st.gh, nil
}

// appLookup observes an operation's target on GitHub: the branch head for a
// push, the open pull request's head for an open.
func (st *mythicalItemStep) appLookup(ctx context.Context, _ db.MythicalItem, op MythicalOutboundOp) (string, bool, error) {
	gh, err := st.publicationGitHub(ctx)
	if err != nil {
		return "", false, err
	}
	switch op.Kind {
	case "push":
		remote, err := st.r.g.lsRemote(ctx, gh.GitURL)
		if err != nil {
			return "", false, fmt.Errorf("read the pull request branch: %s", sanitizeMirrorError(err, gh.GitURL))
		}
		return remote["refs/heads/"+op.Target], false, nil
	case "open":
		pull, err := st.s.github.FindPull(ctx, gh, op.Target)
		if err != nil {
			return "", false, err
		}
		if pull == nil || pull.State != "open" {
			return "", false, nil
		}
		return pull.HeadSHA, false, nil
	}
	return "", false, fmt.Errorf("GitHub %s reconciliation is not composed", op.Kind)
}

// appSend repeats an operation whose lookup proved it never took effect.
func (st *mythicalItemStep) appSend(ctx context.Context, item db.MythicalItem, op MythicalOutboundOp) error {
	gh, err := st.publicationGitHub(ctx)
	if err != nil {
		return err
	}
	switch op.Kind {
	case "push":
		return st.pushProposal(ctx, gh, mythicalProposalOp{Branch: op.Target, Expected: op.Precondition, Head: op.Desired})
	case "open":
		return st.createPull(ctx, item, gh, op.Target)
	}
	return fmt.Errorf("GitHub %s dispatch is not composed", op.Kind)
}

// appSettle binds an opened pull request from GitHub's own answer at the
// proposed head; a push settles from lookup alone.
func (st *mythicalItemStep) appSettle(ctx context.Context, item db.MythicalItem, op MythicalOutboundOp) (db.MythicalItem, error) {
	if op.Kind != "open" {
		return item, fmt.Errorf("GitHub %s settlement is not composed", op.Kind)
	}
	gh, err := st.publicationGitHub(ctx)
	if err != nil {
		return item, err
	}
	pull, err := st.s.github.FindPull(ctx, gh, op.Target)
	if err != nil {
		return item, err
	}
	if pull == nil || pull.State != "open" || pull.HeadSHA != op.Desired {
		return item, errors.New("GitHub shows no open pull request at the proposed head")
	}
	return *st.proposedFrom(item, *pull), nil
}
