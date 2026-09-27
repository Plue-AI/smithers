package chatconnector

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

// IssueCredential is supplied by the backend's existing token service. The
// bootstrap remains in the parent; the child only gets a short-lived sync token.
type IssueCredential func(ctx context.Context, owner, repo, bootstrap string) (token string, revoke func(), err error)

func (host *Host) withCredential(ctx context.Context, issue IssueCredential, run func(context.Context, string) error) error {
	raw, err := os.ReadFile(host.config)
	if err != nil {
		return errors.New("cannot read chat connector configuration")
	}
	var config struct {
		Owner string `json:"owner"`
		Repo  string `json:"repo"`
	}
	if json.Unmarshal(raw, &config) != nil || config.Owner == "" || config.Repo == "" {
		return errors.New("invalid chat connector repository")
	}
	if err := os.MkdirAll(host.stateRoot, 0700); err != nil {
		return err
	}
	directory, err := os.MkdirTemp(host.stateRoot, "credential-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	path := filepath.Join(directory, "token")
	var revoke, previous func()
	defer func() {
		if revoke != nil {
			revoke()
		}
		if previous != nil {
			previous()
		}
	}()
	refresh := func() error {
		bootstrap, err := os.ReadFile(host.bootstrap)
		if err != nil {
			return errors.New("cannot read chat connector bootstrap credential")
		}
		token, cleanup, err := issue(ctx, config.Owner, config.Repo, string(bootstrap))
		if err != nil {
			return errors.New("cannot authorize chat connector credential")
		}
		if err := os.WriteFile(path+".next", []byte(token), 0600); err != nil {
			cleanup()
			return err
		}
		if err := os.Rename(path+".next", path); err != nil {
			cleanup()
			return err
		}
		// Keep one overlapping generation for in-flight requests and the open
		// stream. Both generations expire after one hour even after a hard kill.
		if previous != nil {
			previous()
		}
		previous, revoke = revoke, cleanup
		return nil
	}
	if err := refresh(); err != nil {
		return err
	}
	childCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- run(childCtx, path) }()
	ticker := time.NewTicker(host.refreshInterval)
	defer ticker.Stop()
	for {
		select {
		case err := <-done:
			return err
		case <-ctx.Done():
			cancel()
			<-done
			return nil
		case <-ticker.C:
			if err := refresh(); err != nil {
				cancel()
				<-done
				return err
			}
		}
	}
}
