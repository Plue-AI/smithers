package native

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/hostbackup"
)

// This is the CLI side of the installing-user socket, not a second database
// or quiesce implementation. Missing owner providers refuse in Check.
type maintenanceAuthority struct {
	state       string
	version     hostbackup.Version
	op          string
	checkVolume func(string) error
	leaseMu     sync.Mutex
	leaseSince  map[string]time.Time
}

func (a *maintenanceAuthority) request(ctx context.Context, method, path string, body io.Reader, timeout time.Duration) (*http.Response, error) {
	client, err := newMaintenanceClient(a.state)
	if err != nil {
		return nil, err
	}
	client.Timeout = timeout
	request, err := http.NewRequestWithContext(ctx, method, "http://install"+path, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	return client.Do(request) // Connections do not keep alive; Body.Close releases them.
}
func (a *maintenanceAuthority) Check(ctx context.Context) error {
	response, err := a.request(ctx, http.MethodGet, "/maintenance/backup/check", nil, 5*time.Second)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return maintenanceRefusal(response)
	}
	installed, err := ReadVersion(filepath.Join(a.state, "version.env"))
	if err != nil {
		return fmt.Errorf("host_maintenance_unavailable: install version: %w", err)
	}
	if installed.Version != a.version.Release || installed.Schema != fmt.Sprint(a.version.Schema) || installed.Postgres != fmt.Sprint(a.version.PostgresMajor) {
		return errors.New("wrong_version: maintenance binary must match the running install")
	}
	check := a.checkVolume
	if check == nil {
		check = hostbackup.CheckAPFSVolume
	}
	return check(a.state)
}
func (a *maintenanceAuthority) DatabaseSize(ctx context.Context) (uint64, error) {
	return MaintenanceDatabaseSize(ctx, a.state)
}
func (a *maintenanceAuthority) freeze(ctx context.Context, op string, renewalOnly bool) (time.Time, bool, error) {
	body, err := json.Marshal(struct {
		Op    string `json:"op"`
		Renew bool   `json:"renew,omitempty"`
	}{op, renewalOnly})
	if err != nil {
		return time.Time{}, false, err
	}
	response, err := a.request(ctx, http.MethodPost, "/maintenance/quiesce", bytes.NewReader(body), 70*time.Second)
	if err != nil {
		return time.Time{}, false, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return time.Time{}, false, maintenanceRefusal(response)
	}
	var row struct {
		Op    string    `json:"op"`
		Since time.Time `json:"since"`
		Ready bool      `json:"ready"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&row); err != nil || row.Op != op || row.Since.IsZero() {
		return time.Time{}, false, errors.New("host_maintenance_unavailable: invalid owner freeze response")
	}
	// The same operation ID can be presented after an expired lease reopens.
	// Pin the first response, including an initial-drain renewal, so neither
	// response ordering nor reacquisition can join two different snapshots.
	a.leaseMu.Lock()
	defer a.leaseMu.Unlock()
	if a.leaseSince == nil {
		a.leaseSince = make(map[string]time.Time)
	}
	if since, exists := a.leaseSince[op]; exists && !since.Equal(row.Since) {
		return time.Time{}, false, errors.New("host_maintenance_unavailable: owner quiesce lease changed")
	}
	a.leaseSince[op] = row.Since
	return row.Since, row.Ready, nil
}
func (a *maintenanceAuthority) Freeze(ctx context.Context, op string) (time.Time, error) {
	a.op = op
	since, ready, err := a.freeze(ctx, op, false)
	if err == nil && !ready {
		err = errors.New("host_maintenance_unavailable: owner quiesce drain incomplete")
	}
	return since, err
}
func (a *maintenanceAuthority) Renew(ctx context.Context, op string) error {
	// Initial-drain renewals can observe ready=false; they must not recapture.
	_, _, err := a.freeze(ctx, op, true)
	return err
}
func (a *maintenanceAuthority) Dump(ctx context.Context, target io.Writer) error {
	return MaintenanceDump(ctx, a.state, a.op, target)
}
func (a *maintenanceAuthority) Summary(ctx context.Context) (hostbackup.Manifest, error) {
	var out hostbackup.Manifest
	response, err := a.request(ctx, http.MethodGet, "/maintenance/summary?op="+url.QueryEscape(a.op), nil, 5*time.Second)
	if err != nil {
		return out, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return out, maintenanceRefusal(response)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(&out); err != nil {
		return out, err
	}
	if err := hostbackup.ValidateSummary(out); err != nil {
		return out, err
	}
	return out, nil
}
func (a *maintenanceAuthority) Reopen(ctx context.Context, op string) error {
	response, err := a.request(ctx, http.MethodDelete, "/maintenance/quiesce?op="+url.QueryEscape(op), nil, 5*time.Second)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return maintenanceRefusal(response)
	}
	return nil
}
