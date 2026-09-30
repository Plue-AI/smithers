package services

import (
	"context"
	stdErrors "errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/webhooks"
)

const (
	checkRunAnnotationLogPageSize  = int32(500)
	maxCheckRunAnnotationsFromLogs = 300
)

var (
	githubCommandAnnotationPattern = regexp.MustCompile(`^\s*::(error|warning|notice)\s*([^:]*)::(.*)$`)
	pathLineAnnotationPattern      = regexp.MustCompile(`^\s*([^:\s][^:]*):(\d+)(?::(\d+))?:\s*(.+)$`)
)

// WorkflowRunTerminalPublisher settles, outside the database, what a workflow
// run announced when it was created: the pending commit status, the
// in-progress GitHub check run, and the queued workflow_run webhook. It also
// fires downstream workflow_run triggers and counts the completion. The
// workflow run service implements it; the sandbox scheduler calls it after
// every terminal transition it wins.
type WorkflowRunTerminalPublisher interface {
	// PublishWorkflowRunTerminal is called once, by the caller whose write won
	// the run's transition to a terminal status, with the row that write
	// returned.
	PublishWorkflowRunTerminal(ctx context.Context, run db.WorkflowRun)
}

// workflowRunTerminalQuerier is the read surface terminal publication needs
// beyond WorkflowRunQuerier. *db.Queries implements it; a querier without it
// still settles the commit status, check run and webhook, but cannot name the
// source workflow for downstream triggers or collect log annotations.
type workflowRunTerminalQuerier interface {
	GetWorkflowDefinitionNameByRunID(ctx context.Context, id int64) (string, error)
	ListWorkflowLogsSince(ctx context.Context, arg db.ListWorkflowLogsSinceParams) ([]db.WorkflowLog, error)
}

// PublishWorkflowRunTerminal implements WorkflowRunTerminalPublisher.
func (s *workflowRunService) PublishWorkflowRunTerminal(ctx context.Context, run db.WorkflowRun) {
	if !IsTerminalWorkflowRunStatus(run.Status) {
		return
	}
	logger := middleware.LoggerWithWorkflowRun(ctx, run.ID)
	recordWorkflowRunCompletion(s.metrics, run, run.Status)
	if s.commitStatusWriter != nil {
		if _, err := s.commitStatusWriter.UpdateCommitStatusForWorkflowRun(ctx, run.ID, run.Status, WorkflowRunStatusDescription(run.Status), ""); err != nil {
			logger.Error("failed to update commit status for workflow run", "status", run.Status, "error", err)
		}
	}
	if err := s.completeGitHubCheckRun(ctx, run); err != nil {
		logger.Warn("failed to update github check run for workflow completion", "status", run.Status, "error", err)
	}
	if err := s.dispatchTerminalWorkflowRunEvent(ctx, run); err != nil {
		logger.Error("failed to dispatch workflow_run webhook", "status", run.Status, "error", err)
	}
	if err := s.dispatchTriggeredWorkflowRuns(ctx, run); err != nil {
		logger.Error("failed to dispatch downstream workflow_run triggers", "status", run.Status, "error", err)
	}
}

// workflowRunStatusToAction maps a run status onto the workflow_run event
// action used by webhooks and downstream triggers.
func workflowRunStatusToAction(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "queued":
		return "queued"
	case "running":
		return "in_progress"
	case "success":
		return "completed"
	case "failure", "error":
		return "failure"
	case "cancelled":
		return "cancelled"
	default:
		return ""
	}
}

func workflowRunStatusToCheckRunConclusion(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "success":
		return "success"
	case "cancelled":
		return "cancelled"
	default:
		// GitHub counts neutral as passing; anything else that is not a
		// success must fail closed.
		return "failure"
	}
}

func (s *workflowRunService) dispatchTerminalWorkflowRunEvent(ctx context.Context, run db.WorkflowRun) error {
	if s.dispatcher == nil {
		return nil
	}
	action := workflowRunStatusToAction(run.Status)
	if action == "" {
		return nil
	}
	payload := webhooks.WorkflowRunEventPayload{
		Action: action,
		WorkflowRun: webhooks.WorkflowRunPayload{
			ID:           run.ID,
			Status:       run.Status,
			TriggerEvent: run.TriggerEvent,
			TriggerRef:   run.TriggerRef,
			CommitSHA:    run.TriggerCommitSha,
			CreatedAt:    run.CreatedAt,
		},
		Repository: webhooks.RepositoryPayload{ID: run.RepositoryID},
	}
	if err := s.dispatcher.DispatchEvent(ctx, run.RepositoryID, webhooks.EventTypeWorkflowRun, payload); err != nil {
		return fmt.Errorf("dispatch workflow_run webhook: %w", err)
	}
	return nil
}

// dispatchTriggeredWorkflowRuns fires the workflow_run trigger for workflows
// that follow this one (CI -> build -> deploy).
func (s *workflowRunService) dispatchTriggeredWorkflowRuns(ctx context.Context, run db.WorkflowRun) error {
	// Recursion guard (mirrors GitHub Actions): a run that was itself
	// workflow_run-triggered must not emit another workflow_run trigger event,
	// otherwise a definition whose on.workflow_run.workflows filter matches its
	// own name (or a mutually-referential pair) chains runs forever.
	if NormalizeTriggerName(run.TriggerEvent) == "workflow_run" {
		return nil
	}
	if strings.TrimSpace(run.TriggerCommitSha) == "" {
		return nil
	}
	action := workflowRunStatusToAction(run.Status)
	if action == "" {
		return nil
	}
	reader, ok := s.queries.(workflowRunTerminalQuerier)
	if !ok {
		return nil
	}
	sourceWorkflow, err := reader.GetWorkflowDefinitionNameByRunID(ctx, run.ID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return fmt.Errorf("fetch workflow definition for run %d: %w", run.ID, err)
	}
	if _, err := s.DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID: run.RepositoryID,
		Event: TriggerEvent{
			Type:           "workflow_run",
			Ref:            run.TriggerRef,
			CommitSHA:      run.TriggerCommitSha,
			Action:         action,
			SourceWorkflow: sourceWorkflow,
		},
	}); err != nil {
		return fmt.Errorf("dispatch workflow_run trigger: %w", err)
	}
	return nil
}

// completeGitHubCheckRun completes the run's in-progress GitHub check run with
// its conclusion and the inline annotations its logs carry.
func (s *workflowRunService) completeGitHubCheckRun(ctx context.Context, run db.WorkflowRun) error {
	if s.checkRunService == nil || s.installationResolver == nil {
		return nil
	}
	if !run.CheckRunID.Valid || run.CheckRunID.Int64 <= 0 {
		return nil
	}
	repository, err := s.queries.GetRepoByID(ctx, run.RepositoryID)
	if err != nil {
		return nil
	}
	owner, repoName, installationID, ok := s.gitHubCheckRunTarget(ctx, repository, s.resolveRepoOwner(ctx, repository))
	if !ok {
		return nil
	}

	output := &GitHubCheckRunOutput{
		Title:   "Workflow completed",
		Summary: fmt.Sprintf("Workflow run #%d completed with status `%s`.", run.ID, run.Status),
	}
	annotations, err := s.collectCheckRunAnnotationsFromLogs(ctx, run.ID)
	if err != nil {
		middleware.LoggerWithWorkflowRun(ctx, run.ID).
			Warn("failed to load workflow log annotations for github check run", "error", err)
	} else if len(annotations) > 0 {
		output.Annotations = annotations
		output.Summary = fmt.Sprintf(
			"Workflow run #%d completed with status `%s`.\n\nDetected %d inline annotation(s) from workflow logs.",
			run.ID, run.Status, len(annotations),
		)
	}
	_, err = s.checkRunService.UpdateCheckRun(ctx, installationID, owner, repoName, run.CheckRunID.Int64, GitHubCheckRunUpdate{
		Status:     "completed",
		Conclusion: workflowRunStatusToCheckRunConclusion(run.Status),
		Output:     output,
	})
	return err
}

func (s *workflowRunService) collectCheckRunAnnotationsFromLogs(ctx context.Context, runID int64) ([]GitHubCheckRunAnnotation, error) {
	reader, ok := s.queries.(workflowRunTerminalQuerier)
	if !ok {
		return nil, nil
	}
	afterID := int64(0)
	annotations := make([]GitHubCheckRunAnnotation, 0, 16)
	seen := make(map[string]struct{})
	for len(annotations) < maxCheckRunAnnotationsFromLogs {
		logs, err := reader.ListWorkflowLogsSince(ctx, db.ListWorkflowLogsSinceParams{
			RunID:    runID,
			AfterID:  afterID,
			PageSize: checkRunAnnotationLogPageSize,
		})
		if err != nil {
			return nil, err
		}
		for _, logRow := range logs {
			afterID = logRow.ID
			for _, annotation := range parseCheckRunAnnotationsFromLogEntry(logRow.Entry) {
				key := checkRunAnnotationKey(annotation)
				if _, exists := seen[key]; exists {
					continue
				}
				seen[key] = struct{}{}
				annotations = append(annotations, annotation)
				if len(annotations) >= maxCheckRunAnnotationsFromLogs {
					return annotations, nil
				}
			}
		}
		if len(logs) < int(checkRunAnnotationLogPageSize) {
			break
		}
	}
	return annotations, nil
}

func parseCheckRunAnnotationsFromLogEntry(entry string) []GitHubCheckRunAnnotation {
	lines := strings.Split(strings.ReplaceAll(entry, "\r\n", "\n"), "\n")
	annotations := make([]GitHubCheckRunAnnotation, 0, len(lines))
	for _, line := range lines {
		if annotation, ok := parseGitHubCommandAnnotation(line); ok {
			annotations = append(annotations, annotation)
		} else if annotation, ok := parsePathLineAnnotation(line); ok {
			annotations = append(annotations, annotation)
		}
	}
	return annotations
}

// parseGitHubCommandAnnotation reads a GitHub workflow command such as
// `::error file=a.go,line=3::message`.
func parseGitHubCommandAnnotation(line string) (GitHubCheckRunAnnotation, bool) {
	matches := githubCommandAnnotationPattern.FindStringSubmatch(line)
	if len(matches) != 4 {
		return GitHubCheckRunAnnotation{}, false
	}
	params := parseGitHubCommandAnnotationParams(matches[2])
	path := normalizeCheckRunAnnotationPath(params["file"])
	if path == "" {
		return GitHubCheckRunAnnotation{}, false
	}
	startLine := parsePositiveInt(params["line"], 1)
	endLine := parsePositiveInt(params["endline"], startLine)
	if endLine < startLine {
		endLine = startLine
	}
	message := strings.TrimSpace(unescapeGitHubCommandValue(matches[3]))
	if message == "" {
		return GitHubCheckRunAnnotation{}, false
	}
	return GitHubCheckRunAnnotation{
		Path:            path,
		StartLine:       startLine,
		EndLine:         endLine,
		AnnotationLevel: normalizeCheckRunAnnotationLevel(matches[1]),
		Message:         message,
	}, true
}

// parsePathLineAnnotation reads a compiler-style `path:line[:col]: message`.
func parsePathLineAnnotation(line string) (GitHubCheckRunAnnotation, bool) {
	matches := pathLineAnnotationPattern.FindStringSubmatch(line)
	if len(matches) != 5 {
		return GitHubCheckRunAnnotation{}, false
	}
	path := normalizeCheckRunAnnotationPath(matches[1])
	if path == "" {
		return GitHubCheckRunAnnotation{}, false
	}
	startLine := parsePositiveInt(matches[2], 0)
	if startLine <= 0 {
		return GitHubCheckRunAnnotation{}, false
	}
	// matches[3] is the optional column, never an end line.
	level, message := splitAnnotationLevelAndMessage(matches[4])
	if level == "" || strings.TrimSpace(message) == "" {
		return GitHubCheckRunAnnotation{}, false
	}
	return GitHubCheckRunAnnotation{
		Path:            path,
		StartLine:       startLine,
		EndLine:         startLine,
		AnnotationLevel: level,
		Message:         strings.TrimSpace(message),
	}, true
}

func parseGitHubCommandAnnotationParams(raw string) map[string]string {
	params := make(map[string]string)
	for _, token := range strings.Split(strings.TrimSpace(raw), ",") {
		pair := strings.SplitN(strings.TrimSpace(token), "=", 2)
		if len(pair) != 2 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(pair[0]))
		if key == "" {
			continue
		}
		params[key] = unescapeGitHubCommandValue(strings.TrimSpace(pair[1]))
	}
	return params
}

func unescapeGitHubCommandValue(value string) string {
	return strings.NewReplacer(
		"%0D", "\r",
		"%0A", "\n",
		"%2C", ",",
		"%3A", ":",
		"%25", "%",
	).Replace(value)
}

// normalizeCheckRunAnnotationPath makes a logged path repository-relative. CI
// guests check the repository out under /workspace/repo.
func normalizeCheckRunAnnotationPath(rawPath string) string {
	path := strings.Trim(strings.TrimSpace(rawPath), `"'`)
	if path == "" {
		return ""
	}
	path = strings.ReplaceAll(path, "\\", "/")
	path = strings.TrimPrefix(path, "./")
	if strings.HasPrefix(path, nixCITaskWorkdir+"/") {
		path = strings.TrimPrefix(path, nixCITaskWorkdir+"/")
	} else if idx := strings.Index(path, "/workspace/"); idx >= 0 {
		path = path[idx+len("/workspace/"):]
	}
	path = strings.TrimSpace(strings.TrimPrefix(path, "/"))
	if path == "" || strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://") {
		return ""
	}
	return path
}

func parsePositiveInt(raw string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func normalizeCheckRunAnnotationLevel(rawLevel string) string {
	switch strings.ToLower(strings.TrimSpace(rawLevel)) {
	case "failure", "error":
		return "failure"
	case "warning", "warn":
		return "warning"
	default:
		return "notice"
	}
}

func splitAnnotationLevelAndMessage(raw string) (string, string) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", ""
	}
	lower := strings.ToLower(trimmed)
	switch {
	case strings.HasPrefix(lower, "error:"):
		return "failure", strings.TrimSpace(trimmed[len("error:"):])
	case strings.HasPrefix(lower, "warning:"):
		return "warning", strings.TrimSpace(trimmed[len("warning:"):])
	case strings.HasPrefix(lower, "notice:"):
		return "notice", strings.TrimSpace(trimmed[len("notice:"):])
	case strings.Contains(lower, "error"), strings.Contains(lower, "failed"):
		return "failure", trimmed
	case strings.Contains(lower, "warn"):
		return "warning", trimmed
	default:
		return "notice", trimmed
	}
}

func checkRunAnnotationKey(annotation GitHubCheckRunAnnotation) string {
	return fmt.Sprintf("%s|%d|%d|%s|%s",
		annotation.Path, annotation.StartLine, annotation.EndLine, annotation.AnnotationLevel, annotation.Message)
}
