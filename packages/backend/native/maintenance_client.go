package native

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// MaintenancePreflight authenticates as the installing user over the private
// host socket. It is read-only: no freeze or subprocess is started.
func MaintenancePreflight(ctx context.Context, state string) error {
	for _, path := range []string{state, filepath.Join(state, "run"), filepath.Join(state, "run/host.sock")} {
		info, err := os.Lstat(path)
		if err != nil {
			return fmt.Errorf("host_maintenance_unavailable: installing-owner socket: %w", err)
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		socket := path == filepath.Join(state, "run/host.sock")
		if !ok || stat.Uid != uint32(os.Getuid()) || (!socket && (!info.IsDir() || info.Mode().Perm() != 0700)) || (socket && (info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0600)) {
			return errors.New("host_owner_required: unsafe installing-owner socket")
		}
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(state, "run/host.sock"))
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
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
	var refusal struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&refusal); err != nil || refusal.Message == "" {
		return errors.New("host_maintenance_unavailable: invalid installing-owner response")
	}
	return fmt.Errorf("host_maintenance_unavailable: %s", refusal.Message)
}
