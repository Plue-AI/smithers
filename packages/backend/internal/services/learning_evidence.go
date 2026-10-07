package services

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

type LearningFailure struct {
	Signature string `json:"signature"`
	Text      string `json:"text"`
}
type LearningOutcome struct {
	Todo     int64             `json:"todo"`
	Failures []LearningFailure `json:"failures"`
}
type LearningJournalRow struct {
	Seq       int    `json:"seq"`
	EventType string `json:"eventType"`
	Payload   any    `json:"payload"`
}

// LearningEvidence matches the machine Binding's Snapshot, never a write grant.
type LearningEvidence struct {
	Repository string               `json:"repository"`
	Todo       int64                `json:"todo"`
	Run        string               `json:"run"`
	State      string               `json:"state"`
	Change     string               `json:"change"`
	Commit     string               `json:"commit"`
	Attempts   []string             `json:"attempts"`
	Journal    []LearningJournalRow `json:"journal"`
	Outcomes   []LearningOutcome    `json:"outcomes"`
}

func learningReadRefused() error {
	return &AccessError{Status: 403, Class: "permission", Code: "learning_binding", Message: "Learning evidence unavailable"}
}

// ReadLearningEvidence checks the stored dispatch, immutable pin and live host
// fence in one transaction. Browser/session/model tokens cannot select a TODO;
// the run's persisted target is the only subject and no source module is loaded.
func (s *MythicalService) ReadLearningEvidence(ctx context.Context, hostID, bearer, runID string) (LearningEvidence, error) {
	result := LearningEvidence{Attempts: []string{}, Journal: []LearningJournalRow{}, Outcomes: []LearningOutcome{}}
	if _, err := uuid.Parse(hostID); err != nil || bearer == "" || runID == "" || len(runID) > 512 {
		return result, learningReadRefused()
	}
	err := pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		var target flowruntime.Target
		var repo, actor, generation int64
		var source, artifact string
		var hash []byte
		err := tx.QueryRow(ctx, `SELECT h.tenant_id,h.principal_id,h.workspace_id::text,h.binding_kind,h.binding_id,h.repository_id,h.user_id,h.owner_generation,h.source_revision,h.runtime_artifact_digest,h.credential_hash
   FROM flow_runtime_host_bindings h JOIN workspaces w ON w.id=h.workspace_id
   WHERE h.id=$1 AND h.state='running' AND h.binding_kind='learning'
   AND w.status='running' AND w.deleted_at IS NULL AND w.repository_id=h.repository_id
   FOR SHARE OF h,w`, hostID).Scan(&target.TenantID, &target.PrincipalID, &target.WorkspaceID, &target.BindingKind, &target.BindingID, &repo, &actor, &generation, &source, &artifact, &hash)
		digest := sha256.Sum256([]byte(bearer))
		if err == pgx.ErrNoRows {
			return learningReadRefused()
		}
		if err != nil {
			return err
		}
		if subtle.ConstantTimeCompare(hash, digest[:]) != 1 || target.TenantID != fmt.Sprintf("repository:%d", repo) || target.PrincipalID != fmt.Sprintf("user:%d", actor) {
			return learningReadRefused()
		}
		role, err := InstallRoleOf(ctx, db.New(tx), actor)
		if err != nil {
			return err
		}
		if role == "" {
			return learningReadRefused()
		}
		var raw, checkpoint []byte
		err = tx.QueryRow(ctx, `SELECT r.payload,d.external_receipt FROM product_job_requests r JOIN product_job_dispatches d ON d.operation_id=r.id
   WHERE r.operation='flow.runtime.launch' AND r.tenant_id=$1 AND r.principal_id=$2 AND r.payload->'target'->>'BindingID'=$3 AND r.payload->>'flowId'='learning' AND d.external_receipt->>'runId'=$4 AND r.state NOT IN ('failed','cancelled','completed','uncertain')`, target.TenantID, target.PrincipalID, target.BindingID, runID).Scan(&raw, &checkpoint)
		if err == pgx.ErrNoRows {
			return learningReadRefused()
		}
		if err != nil {
			return err
		}
		var launch struct {
			Target  flowruntime.Target `json:"target"`
			Pin     *flowruntime.Pin   `json:"pin"`
			Payload struct {
				Todo int64 `json:"todo"`
			} `json:"payload"`
		}
		var cp flowdispatch.RuntimeCheckpoint
		if json.Unmarshal(raw, &launch) != nil || json.Unmarshal(checkpoint, &cp) != nil || launch.Target != target || launch.Pin == nil || !launch.Pin.Valid() || launch.Pin.Flow != "learning" || cp.Target != target || cp.FlowID != "learning" || cp.RunID != runID || cp.PinRefused || cp.ExecutionDigest != launch.Pin.ExecutionDigest || cp.Identity.SourceRevision != launch.Pin.SourceCommit || source != launch.Pin.SourceCommit || cp.Identity.OwnerGeneration != generation || cp.Identity.RuntimeArtifactDigest != artifact {
			return learningReadRefused()
		}
		q := db.New(tx)
		item, err := q.GetMythicalItemByNumber(ctx, repo, launch.Payload.Todo)
		if err != nil {
			return err
		}
		if uuidString(item.ID) != target.BindingID || item.Source != "todo" || todoState(item) != "merged" || item.PRState != "merged" || item.PRMergeCommit == "" || item.PRURL == "" {
			return learningReadRefused()
		}
		repository, err := q.GetRepoByID(ctx, repo)
		if err != nil {
			return err
		}
		owner, err := q.GetUserByID(ctx, repository.UserID.Int64)
		if err != nil {
			return err
		}
		result.Repository, result.Todo, result.Run, result.State = owner.Username+"/"+repository.Name, item.Number.Int64, runID, "merged"
		result.Change, result.Commit = item.PRURL, item.PRMergeCommit
		seen := map[string]bool{}
		for _, attempt := range mythicalChecksOf(item).Attempts {
			if attempt.RunID != "" && !seen[attempt.RunID] {
				seen[attempt.RunID] = true
				result.Attempts = append(result.Attempts, attempt.RunID)
			}
		}
		add := func(kind string, payload any) {
			result.Journal = append(result.Journal, LearningJournalRow{len(result.Journal) + 1, kind, payload})
		}
		for _, steer := range mythicalChecksOf(item).Steers {
			if steer.Text != "" {
				add("control.agent.steering-drained", map[string]any{"messages": []any{map[string]string{"role": "user", "text": steer.Text}}})
			}
		}
		for _, review := range mythicalChecksOf(item).GitHubInputs {
			if !review.Hidden && review.Text != "" {
				add("control.agent.steering-drained", map[string]any{"messages": []any{map[string]string{"role": "user", "text": review.Text}}})
			}
		}
		rows, err := tx.Query(ctx, `SELECT number,checks FROM mythical_items WHERE repository_id=$1 AND source='todo' AND state='landed' AND pr_state='merged' ORDER BY checks->'completion'->>'since' DESC NULLS LAST,id DESC LIMIT 20`, repo)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var number int64
			var checks []byte
			if err := rows.Scan(&number, &checks); err != nil {
				return err
			}
			var stored mythicalChecks
			if json.Unmarshal(checks, &stored) != nil {
				return ErrLearningBinding
			}
			failures := learningFailures(stored)
			result.Outcomes = append(result.Outcomes, LearningOutcome{number, failures})
			for _, failure := range failures {
				add("control.agent.model-settled", map[string]string{"text": failure.Text})
			}
		}
		return rows.Err()
	})
	return result, err
}

// ECMAScript whitespace and full Unicode lowercase match MemoryMine.normalize.
var learningWhitespace = regexp.MustCompile("[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")

func learningNormalize(text string) string {
	return strings.Trim(learningWhitespace.ReplaceAllString(cases.Lower(language.Und).String(norm.NFKC.String(text)), " "), " ")
}
func learningFailures(checks mythicalChecks) []LearningFailure {
	result := []LearningFailure{}
	seen := map[string]bool{}
	add := func(signature, text string) {
		if text != "" && !seen[signature] {
			seen[signature] = true
			result = append(result, LearningFailure{signature, text})
		}
	}
	for _, attempt := range checks.Attempts {
		for _, failure := range attempt.Failures {
			add(failure.Signature, failure.Text)
		}

		items := attempt.Items
		if attempt.Previous != nil {
			items = append(append([]map[string]any{}, items...), attempt.Previous.Items...)
		}
		for _, item := range items {
			if item["kind"] != "check" || item["state"] != "failed" || item["fault"] == "infra" {
				continue
			}
			name, _ := item["name"].(string)
			if name == "" {
				continue
			}
			recorded := false
			for _, failure := range attempt.Failures {
				if strings.HasPrefix(failure.Signature, "check:"+learningNormalize(name)+"@") {
					recorded = true
					break
				}
			}
			if recorded {
				continue
			}

			tier, _ := item["tier"].(string)
			text, _ := item["evidence"].(string)
			failure := learningCheckFailure(name, tier, text)
			add(failure.Signature, failure.Text)
		}
	}
	for _, review := range checks.GitHubInputs {
		if review.Hidden || !strings.EqualFold(review.ReviewState, "CHANGES_REQUESTED") || review.Text == "" {
			continue
		}
		sum := sha256.Sum256([]byte(learningNormalize(review.Text)))
		add("review:"+hex.EncodeToString(sum[:]), review.Text)
	}
	return result
}

func learningCheckFailure(name, tier, text string) LearningFailure {
	phase := "check"
	if tier == "slow" {
		phase = "review"
	}
	if text == "" {
		text = fmt.Sprintf("Check %s failed.", name)
	}
	return LearningFailure{Signature: "check:" + learningNormalize(name) + "@" + phase, Text: text}
}
func mergeLearningFailures(before, after []LearningFailure) []LearningFailure {
	result := []LearningFailure{}
	seen := map[string]bool{}
	for _, failures := range [][]LearningFailure{before, after} {
		for _, failure := range failures {
			if !seen[failure.Signature] {
				seen[failure.Signature] = true
				result = append(result, failure)
			}
		}
	}
	return result
}
