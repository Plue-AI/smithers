package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// InstallReadinessSettings supplies the persistence seam of the restored
// install_machine_ready.go (T-INS-06; delta §1). It stores no parallel readiness
// record: source and machine live in the same setup.step.* settings as setup.
// Execution remains unmounted until the ticket's guest preparation proofs pass.
type InstallReadinessSettings struct{ Pool *pgxpool.Pool }

var _ InstallReadinessPersistence = (*InstallReadinessSettings)(nil)

type installReadinessSetting struct {
	Status           string                 `json:"status"`
	Pct              int                    `json:"pct"`
	Error            *InstallReadinessError `json:"error,omitempty"`
	Repository       string                 `json:"repository"`
	Revision         string                 `json:"revision"`
	LayerKey         string                 `json:"layer_key"`
	ReadinessAttempt uint64                 `json:"readiness_attempt"`
}

// Update locks both existing settings, preserving the setup operation's
// identity/lease and unrelated fields. The pair commits together or not at all.
// Attempt is the readiness computation's fence, distinct from the jobs lease.
func (p *InstallReadinessSettings) Update(ctx context.Context, repository string, mutate func(InstallReadiness) (InstallReadiness, error)) (InstallReadiness, error) {
	var current InstallReadiness
	if p == nil || p.Pool == nil || repository == "" || mutate == nil {
		return current, errors.New("install readiness persistence unavailable")
	}
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return current, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	// All install readiness updates share one identity, including a repository
	// change. The install wraps exactly one repository (product M-09).
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('install-readiness',0))`); err != nil {
		return current, err
	}
	queries := db.New(tx)
	settings := make([]db.InstallSetting, 2)
	values := make([]installReadinessSetting, 2)
	for i, id := range []string{"source", "machine"} {
		key := "setup.step." + id
		if _, err = tx.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES($1,'{"status":"pending"}') ON CONFLICT DO NOTHING`, key); err != nil {
			return current, err
		}
		// GetInstallSetting is reused after acquiring its row lock, so the generated
		// settings shape stays the authority for sealed/updated_by metadata.
		if _, err = tx.Exec(ctx, `SELECT key FROM install_settings WHERE key=$1 FOR UPDATE`, key); err != nil {
			return current, err
		}
		settings[i], err = queries.GetInstallSetting(ctx, key)
		if err != nil {
			return current, err
		}
		if settings[i].Sealed {
			return current, errors.New("setup readiness setting cannot be sealed")
		}
		if err = json.Unmarshal(settings[i].Value, &values[i]); err != nil {
			return current, fmt.Errorf("invalid setup readiness: %w", err)
		}
		if values[i].Repository != "" && values[i].Repository != repository {
			return current, errors.New("install readiness repository differs")
		}
	}
	if values[0].ReadinessAttempt != values[1].ReadinessAttempt || values[0].Revision != values[1].Revision || values[0].LayerKey != values[1].LayerKey {
		return current, errors.New("install readiness receipts differ")
	}
	source, err := readinessFromSetting(values[0])
	if err != nil {
		return current, err
	}
	machine, err := readinessFromSetting(values[1])
	if err != nil {
		return current, err
	}
	current = InstallReadiness{Source: source, Machine: machine, Revision: values[0].Revision, LayerKey: values[0].LayerKey, Attempt: values[0].ReadinessAttempt}
	next, err := mutate(current)
	if err != nil {
		return current, err
	}
	for i, step := range []InstallReadinessStep{next.Source, next.Machine} {
		state := string(step.State)
		switch step.State {
		case "", InstallPending:
			state = "pending"
		case InstallReady:
			state = "done"
		case InstallRunning, InstallFailed:
		default:
			return current, errors.New("invalid install readiness state")
		}
		if step.Pct < 0 || step.Pct > 100 {
			return current, errors.New("invalid install readiness progress")
		}
		value := installReadinessSetting{Status: state, Pct: step.Pct, Error: step.Error, Repository: repository, Revision: next.Revision, LayerKey: next.LayerKey, ReadinessAttempt: next.Attempt}
		patch, err := json.Marshal(value)
		if err != nil {
			return current, err
		}
		var fields map[string]json.RawMessage
		if err = json.Unmarshal(settings[i].Value, &fields); err != nil {
			return current, err
		}
		var replacement map[string]json.RawMessage
		if err = json.Unmarshal(patch, &replacement); err != nil {
			return current, err
		}
		// A recovered successful attempt removes the previous failure, while keeping
		// operation_id, attempt and expires_at owned by the setup job.
		delete(fields, "error")
		for key, value := range replacement {
			fields[key] = value
		}
		raw, err := json.Marshal(fields)
		if err != nil {
			return current, err
		}
		if err = queries.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: settings[i].Key, Value: raw, Sealed: settings[i].Sealed, UpdatedBy: settings[i].UpdatedBy}); err != nil {
			return current, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return current, err
	}
	return next, nil
}

func readinessFromSetting(value installReadinessSetting) (InstallReadinessStep, error) {
	state := InstallStepState(value.Status)
	switch value.Status {
	case "pending", "running", "failed":
	case "done":
		state = InstallReady
	default:
		return InstallReadinessStep{}, errors.New("invalid persisted readiness state")
	}
	if value.Pct < 0 || value.Pct > 100 {
		return InstallReadinessStep{}, errors.New("invalid persisted readiness progress")
	}
	return InstallReadinessStep{State: state, Pct: value.Pct, Error: value.Error}, nil
}
