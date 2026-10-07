package native

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// MaintenancePreflight authenticates as the installing user over the private
// host socket. It is read-only: no freeze or subprocess is started.
func MaintenancePreflight(ctx context.Context, state string) error {
	client, err := newMaintenanceClient(state)
	if err != nil {
		return err
	}
	defer client.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://install/maintenance/check", nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("host_maintenance_unavailable: installing-owner socket: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent {
		return nil
	}
	return maintenanceRefusal(response)
}

func newMaintenanceClient(state string) (*http.Client, error) {
	if !filepath.IsAbs(state) {
		return nil, errors.New("host_owner_required: absolute install state directory required")
	}
	if os.Geteuid() == 0 {
		return nil, errors.New("host_owner_required: maintenance requires an unprivileged installing user")
	}
	for _, path := range []string{state, filepath.Join(state, "run"), filepath.Join(state, "run/host.sock")} {
		info, err := os.Lstat(path)
		if err != nil {
			return nil, fmt.Errorf("host_maintenance_unavailable: installing-owner socket: %w", err)
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		socket := path == filepath.Join(state, "run/host.sock")
		if !ok || stat.Uid != uint32(os.Getuid()) || (!socket && (!info.IsDir() || info.Mode().Perm() != 0700)) || (socket && (info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0600)) {
			return nil, errors.New("host_owner_required: unsafe installing-owner socket")
		}
	}
	transport := &http.Transport{DisableKeepAlives: true, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(state, "run/host.sock"))
	}}
	return &http.Client{Transport: transport, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, nil
}

func maintenanceRefusal(response *http.Response) error {
	var refusal struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&refusal); err != nil || refusal.Message == "" {
		return errors.New("host_maintenance_unavailable: invalid installing-owner response")
	}
	return fmt.Errorf("host_maintenance_unavailable: %s", refusal.Message)
}

// MaintenanceDatabaseSize reads the supervised database's size before freezing.
func MaintenanceDatabaseSize(ctx context.Context, state string) (uint64, error) {
	client, err := newMaintenanceClient(state)
	if err != nil {
		return 0, err
	}
	defer client.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://install/maintenance/database/size", nil)
	if err != nil {
		return 0, err
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 0, maintenanceRefusal(response)
	}
	var size struct {
		Bytes *uint64 `json:"bytes"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&size); err != nil || size.Bytes == nil {
		return 0, errors.New("host_maintenance_unavailable: invalid database size response")
	}
	return *size.Bytes, nil
}

// MaintenanceDump streams only the installing owner's existing ready operation.
// Its caller renews the freeze separately and discards partial output on error.
func MaintenanceDump(ctx context.Context, state, op string, target io.Writer) error {
	if op == "" || len(op) > 256 || target == nil {
		return errors.New("backup dump operation and destination required")
	}
	client, err := newMaintenanceClient(state)
	if err != nil {
		return err
	}
	defer client.CloseIdleConnections()
	client.Timeout = 0 // Dump duration is bounded by the caller's renewable lease context.
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://install/maintenance/database/dump?op="+url.QueryEscape(op), nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return maintenanceRefusal(response)
	}
	if response.Header.Get("Content-Type") != "application/octet-stream" {
		return errors.New("host_maintenance_unavailable: invalid dump response")
	}
	header := make([]byte, 5)
	if _, err := io.ReadFull(response.Body, header); err != nil {
		return fmt.Errorf("invalid database dump: %w", err)
	}
	if string(header) != "PGDMP" {
		return errors.New("invalid database dump format")
	}
	_, err = io.Copy(target, io.MultiReader(bytes.NewReader(header), response.Body))
	return err
}
