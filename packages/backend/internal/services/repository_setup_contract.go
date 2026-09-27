package services

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf16"

	"github.com/google/uuid"
)

// These are the public RepositorySetup.ts wire types. The field order in Draft
// is part of its existing JSON.stringify candidate digest, not a new identity.
type SetupStep struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Mode   string `json:"mode"`
	Prompt string `json:"prompt"`
}
type SetupCheck struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Kind   string   `json:"kind"`
	Rule   string   `json:"rule"`
	Paths  []string `json:"paths"`
	Policy string   `json:"policy"`
}
type SetupCase struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Input    string  `json:"input"`
	Expected string  `json:"expected"`
	Source   *string `json:"source,omitempty"`
	Edited   *bool   `json:"edited,omitempty"`
	Required *bool   `json:"required"`
}
type SetupDraft struct {
	Steps         []SetupStep  `json:"steps"`
	Checks        []SetupCheck `json:"checks"`
	Cases         []SetupCase  `json:"cases"`
	Replies       string       `json:"replies"`
	Landing       string       `json:"landing"`
	Scope         string       `json:"scope"`
	Label         string       `json:"label"`
	Schedule      string       `json:"schedule"`
	ChoreEvent    string       `json:"choreEvent"`
	BudgetMinutes int          `json:"budgetMinutes"`
	ConnectIssues *bool        `json:"connectIssues"`
	TrialTitle    string       `json:"trialTitle"`
	TrialBody     string       `json:"trialBody"`
}
type SetupSubject struct {
	Source string `json:"source"`
	Kind   string `json:"kind"`
	Number int64  `json:"number"`
}
type SetupManual struct {
	StepID  string        `json:"stepId"`
	Prompt  string        `json:"prompt"`
	Subject *SetupSubject `json:"subject,omitempty"`
}
type SetupInput struct {
	RequestID   string       `json:"requestId"`
	Repo        string       `json:"repo"`
	Job         string       `json:"job"`
	Revision    int64        `json:"revision"`
	Digest      string       `json:"digest"`
	Draft       SetupDraft   `json:"draft"`
	WorkspaceID string       `json:"workspaceId,omitempty"`
	Manual      *SetupManual `json:"manual,omitempty"`
	Operation   string       `json:"operation"`
}
type SetupEvalResult struct {
	CaseID      string   `json:"caseId"`
	Status      string   `json:"status"`
	Observed    string   `json:"observed"`
	Evidence    []string `json:"evidence"`
	ExecutionID string   `json:"executionId"`
}
type SetupTrialIssue struct {
	Source string `json:"source"`
	Number int64  `json:"number"`
	URL    string `json:"url,omitempty"`
}
type SetupReceipt struct {
	RequestID      string            `json:"requestId"`
	RunID          string            `json:"runId,omitempty"`
	JobRunID       string            `json:"jobRunId,omitempty"`
	Revision       int64             `json:"revision"`
	Operation      string            `json:"operation"`
	Phase          string            `json:"phase"`
	Digest         string            `json:"digest"`
	UpdatedAt      int64             `json:"updatedAt"`
	Results        []SetupEvalResult `json:"results"`
	Evidence       []string          `json:"evidence"`
	Error          string            `json:"error,omitempty"`
	TrialIssue     *SetupTrialIssue  `json:"trialIssue,omitempty"`
	RegistrationID string            `json:"registrationId,omitempty"`
	SourceRevision string            `json:"sourceRevision,omitempty"`
}
type SetupSource struct {
	Path     string `json:"path"`
	Status   string `json:"status"`
	Summary  string `json:"summary"`
	Revision string `json:"revision,omitempty"`
}
type SetupInspection struct {
	Sources        []SetupSource `json:"sources"`
	SuggestedDraft SetupDraft    `json:"suggestedDraft"`
	InspectedAt    int64         `json:"inspectedAt"`
}
type SetupResponse struct {
	RequestID   string           `json:"requestId"`
	Revision    int64            `json:"revision"`
	Digest      string           `json:"digest"`
	WorkspaceID string           `json:"workspaceId,omitempty"`
	Receipt     *SetupReceipt    `json:"receipt,omitempty"`
	Inspection  *SetupInspection `json:"inspection,omitempty"`
}

var setupKey = regexp.MustCompile(`^[a-zA-Z0-9:_-]{1,128}$`)
var setupStepKey = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`)
var setupRepo = regexp.MustCompile(`^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$`)
var setupDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

func SetupJobValid(job string) bool {
	return slices.Contains([]string{"issues", "review", "ci", "feature", "chores"}, job)
}
func SetupOperationValid(operation string) bool {
	return slices.Contains([]string{"inspect", "evaluate", "trial", "apply", "pause", "run"}, operation)
}
func SetupRequestIDValid(id string) bool { return setupKey.MatchString(id) }
func SetupRepoValid(repo string) bool    { return setupRepo.MatchString(repo) && setupText(repo, 3, 201) }
func setupText(value string, min, max int) bool {
	n := len(utf16.Encode([]rune(value)))
	return n >= min && n <= max
}
func setupOne(value string, choices ...string) bool { return slices.Contains(choices, value) }
func (draft *SetupDraft) validate() error {
	if draft.ChoreEvent == "" {
		draft.ChoreEvent = "none"
	}
	if draft.Steps == nil || len(draft.Steps) > 30 || draft.Checks == nil || len(draft.Checks) > 50 || draft.Cases == nil || len(draft.Cases) > 100 || !setupOne(draft.Replies, "draft", "automatic") || !setupOne(draft.Landing, "ask", "checks") || !setupOne(draft.Scope, "future", "label") || !setupText(draft.Label, 0, 100) || !setupText(draft.Schedule, 0, 200) || !setupOne(draft.ChoreEvent, "none", "push", "labeled") || draft.BudgetMinutes < 1 || draft.BudgetMinutes > 360 || draft.ConnectIssues == nil || !setupText(draft.TrialTitle, 1, 240) || !setupText(draft.TrialBody, 0, 16000) {
		return fmt.Errorf("invalid setup draft")
	}
	ids := map[string]bool{}
	for _, step := range draft.Steps {
		if !setupStepKey.MatchString(step.ID) || ids[step.ID] || !setupText(step.Name, 1, 120) || !setupOne(step.Mode, "automatic", "manual", "off", "approved") || !setupText(step.Prompt, 0, 16000) {
			return fmt.Errorf("invalid setup step")
		}
		ids[step.ID] = true
	}
	ids = map[string]bool{}
	for _, check := range draft.Checks {
		if !setupText(check.ID, 1, 100) || ids[check.ID] || !setupText(check.Name, 1, 120) || !setupOne(check.Kind, "command", "ai") || !setupText(check.Rule, 0, 16000) || check.Paths == nil || len(check.Paths) > 100 || !setupOne(check.Policy, "report", "required") {
			return fmt.Errorf("invalid setup check")
		}
		for _, path := range check.Paths {
			if !setupText(path, 1, 500) {
				return fmt.Errorf("invalid setup check path")
			}
		}
		ids[check.ID] = true
	}
	ids = map[string]bool{}
	for _, test := range draft.Cases {
		if !setupText(test.ID, 1, 100) || ids[test.ID] || !setupText(test.Name, 1, 160) || !setupText(test.Input, 0, 16000) || !setupText(test.Expected, 1, 8000) || (test.Source != nil && !setupText(*test.Source, 0, 1000)) || test.Required == nil {
			return fmt.Errorf("invalid setup case")
		}
		ids[test.ID] = true
	}
	return nil
}
func setupJSON(value any) ([]byte, error) {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	encoded := bytes.TrimSuffix(out.Bytes(), []byte("\n"))
	encoded = bytes.ReplaceAll(encoded, []byte(`\u2028`), []byte("\u2028"))
	encoded = bytes.ReplaceAll(encoded, []byte(`\u2029`), []byte("\u2029"))
	return encoded, nil
}

// Build the ordered draft from its canonical typed encoding; maps would reorder
// keys and create a different identity from the shared browser/host contract.
func setupCandidateDigest(input SetupInput, legacy bool) string {
	raw, _ := setupJSON(input.Draft)
	var ordered bytes.Buffer
	ordered.WriteByte('{')
	decoder := json.NewDecoder(bytes.NewReader(raw))
	_, _ = decoder.Token()
	first := true
	for decoder.More() {
		key, _ := decoder.Token()
		var value json.RawMessage
		_ = decoder.Decode(&value)
		name := key.(string)
		if (name == "choreEvent" && input.Draft.ChoreEvent == "none") || (!legacy && (name == "trialTitle" || name == "trialBody")) {
			continue
		}
		if !first {
			ordered.WriteByte(',')
		}
		first = false
		k, _ := setupJSON(name)
		ordered.Write(k)
		ordered.WriteByte(':')
		ordered.Write(value)
	}
	ordered.WriteByte('}')
	value := struct {
		Repo     string          `json:"repo"`
		Job      string          `json:"job"`
		Revision int64           `json:"revision"`
		Draft    json.RawMessage `json:"draft"`
	}{input.Repo, input.Job, input.Revision, ordered.Bytes()}
	encoded, _ := setupJSON(value)
	return fmt.Sprintf("%x", sha256.Sum256(encoded))
}
func ValidateSetupInput(input *SetupInput) error {
	if !SetupRequestIDValid(input.RequestID) || !SetupRepoValid(input.Repo) || !SetupJobValid(input.Job) || !SetupOperationValid(input.Operation) || input.Revision < 1 || input.Revision > 9007199254740991 || !setupDigest.MatchString(input.Digest) {
		return fmt.Errorf("invalid setup request")
	}
	if input.WorkspaceID != "" {
		id, err := uuid.Parse(input.WorkspaceID)
		if err != nil || id.String() != input.WorkspaceID {
			return fmt.Errorf("invalid setup workspace")
		}
	}
	if err := input.Draft.validate(); err != nil {
		return err
	}
	if input.Digest != setupCandidateDigest(*input, false) && input.Digest != setupCandidateDigest(*input, true) {
		return fmt.Errorf("setup candidate digest differs")
	}
	if input.Operation != "run" {
		if input.Manual != nil {
			return fmt.Errorf("only run accepts manual work")
		}
		return nil
	}
	manual := input.Manual
	if manual == nil || !setupStepKey.MatchString(manual.StepID) || !setupText(manual.Prompt, 0, 16000) {
		return fmt.Errorf("invalid manual setup work")
	}
	enabled := false
	for _, step := range input.Draft.Steps {
		if step.ID == manual.StepID && step.Mode != "off" {
			enabled = true
		}
	}
	if !enabled {
		return fmt.Errorf("manual step is not enabled")
	}
	if manual.Subject != nil && (!setupOne(manual.Subject.Source, "github", "smithers-cloud") || !setupOne(manual.Subject.Kind, "issue", "pr") || manual.Subject.Number < 1 || manual.Subject.Number > 9007199254740991) {
		return fmt.Errorf("invalid manual subject")
	}
	if input.Job == "issues" && (manual.Subject == nil || manual.Subject.Kind != "issue") || setupOne(input.Job, "review", "ci") && (manual.Subject == nil || manual.Subject.Kind != "pr") || setupOne(input.Job, "feature", "chores") && strings.TrimSpace(manual.Prompt) == "" {
		return fmt.Errorf("manual work does not match job")
	}
	return nil
}
func validateSetupOutput(input SetupInput, workspaceID, runID string, raw string) (SetupResponse, error) {
	var output SetupResponse
	if len(raw) > 120000 || json.Unmarshal([]byte(raw), &output) != nil || output.RequestID != input.RequestID || output.Revision != input.Revision || output.Digest != input.Digest || (output.WorkspaceID != "" && output.WorkspaceID != workspaceID) || (output.Receipt == nil && output.Inspection == nil) {
		return output, fmt.Errorf("setup result identity differs")
	}
	if output.Inspection != nil {
		if input.Operation != "inspect" || output.Inspection.Sources == nil || output.Inspection.InspectedAt <= 0 || output.Inspection.SuggestedDraft.validate() != nil {
			return output, fmt.Errorf("invalid setup inspection")
		}
		for _, source := range output.Inspection.Sources {
			if !setupOne(source.Status, "read", "missing", "failed") {
				return output, fmt.Errorf("invalid setup source")
			}
		}
	}
	if receipt := output.Receipt; receipt != nil {
		if receipt.RequestID != input.RequestID || receipt.Revision != input.Revision || receipt.Digest != input.Digest || receipt.Operation != input.Operation || receipt.RunID != runID || receipt.Results == nil || receipt.Evidence == nil || receipt.UpdatedAt <= 0 || !setupOne(receipt.Phase, "completed", "failed", "stopped") {
			return output, fmt.Errorf("setup receipt identity differs")
		}
		if input.Operation == "run" && receipt.Phase == "completed" && receipt.JobRunID == "" {
			return output, fmt.Errorf("manual completion lacks job run")
		}
		for _, result := range receipt.Results {
			if !setupOne(result.Status, "passed", "failed", "review", "error") || result.ExecutionID == "" || result.Evidence == nil {
				return output, fmt.Errorf("invalid evaluation result")
			}
		}
	}
	output.WorkspaceID = workspaceID
	return output, nil
}
