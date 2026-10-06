package db

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

var ErrInstallRepositoryUnavailable = errors.New("Repository unavailable")

// InstallRepositoryBinding is the persisted setup selection. ID is local once
// setup finishes; older installs may retain a GitHub ID and resolve by slug.
type InstallRepositoryBinding struct {
	Owner     string `json:"owner_login"`
	Name      string `json:"repository_name"`
	ID        int64  `json:"repository_id"`
	OwnerKind string `json:"owner_kind"`
}

// ReadInstallRepositoryBinding also serves setup before repository selection.
func (q *Queries) ReadInstallRepositoryBinding(ctx context.Context) (InstallRepositoryBinding, error) {
	return ReadInstallRepositoryBinding(ctx, q)
}

// ReadInstallRepositoryBinding decodes the binding for adapters that expose settings.
func ReadInstallRepositoryBinding(ctx context.Context, q interface {
	GetInstallSetting(context.Context, string) (InstallSetting, error)
}) (InstallRepositoryBinding, error) {
	setting, err := q.GetInstallSetting(ctx, "github.repository")
	var binding InstallRepositoryBinding
	if err == nil {
		err = json.Unmarshal(setting.Value, &binding)
	}
	return binding, err
}

// InstallRepositoryID resolves the singleton repository for every layer,
// including identity and database callers that cannot depend on services.
func (q *Queries) InstallRepositoryID(ctx context.Context) (int64, error) {
	binding, err := q.ReadInstallRepositoryBinding(ctx)
	if err != nil {
		var invalid *json.SyntaxError
		var wrongType *json.UnmarshalTypeError
		if errors.As(err, &invalid) || errors.As(err, &wrongType) {
			return 0, ErrInstallRepositoryUnavailable
		}
		return 0, err
	}
	if binding.Owner == "" || binding.Name == "" {
		return 0, ErrInstallRepositoryUnavailable
	}
	if binding.ID > 0 {
		var id int64
		err := q.db.QueryRow(ctx, `SELECT id FROM repositories WHERE id=$1`, binding.ID).Scan(&id)
		if !errors.Is(err, pgx.ErrNoRows) {
			return id, err
		}
	}
	row, err := q.GetRepoByOwnerAndName(ctx, GetRepoByOwnerAndNameParams{Owner: binding.Owner, Name: binding.Name})
	return row.ID, err
}

// LockInstallRepositoryBinding keeps setup selection stable through a write.
// Roster callers acquire the owner row first, preserving their lock order.
func (q *Queries) LockInstallRepositoryBinding(ctx context.Context) (InstallRepositoryBinding, error) {
	var raw []byte
	err := q.db.QueryRow(ctx, `SELECT value FROM install_settings WHERE key=$1 FOR SHARE`, "github.repository").Scan(&raw)
	var binding InstallRepositoryBinding
	if err == nil {
		err = json.Unmarshal(raw, &binding)
	}
	return binding, err
}
