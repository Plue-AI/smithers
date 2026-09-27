// Package chatconnector supervises the shared durable Slack/Telegram host.
package chatconnector

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

type Host struct {
	node, bundle                 string
	environment                  []string
	config, bootstrap, stateRoot string
	refreshInterval              time.Duration
}

// FromEnvironment is opt-in. Credentials stay in the host process environment,
// never argv, persisted flow inputs, logs, or an agent machine.
func FromEnvironment(get func(string) string, dataRoot, address string) (*Host, error) {
	config := get("SMITHERS_CHAT_CONNECTOR_CONFIG")
	if config == "" {
		return nil, nil
	}
	node, bundle, credential := get("SMITHERS_NODE_BINARY"), get("SMITHERS_CHAT_CONNECTOR_BUNDLE"), get("SMITHERS_CHAT_CONNECTOR_TOKEN_FILE")
	for _, path := range []string{config, node, bundle, credential, dataRoot} {
		if !filepath.IsAbs(path) {
			return nil, errors.New("chat connector requires absolute config, bundle, Node, credential and data paths")
		}
	}
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, errors.New("chat connector requires a backend listen port")
	}
	host := &Host{node: node, bundle: bundle, config: config, bootstrap: credential, stateRoot: filepath.Join(dataRoot, "chat-connectors"), refreshInterval: 30 * time.Minute}
	for _, key := range []string{"HOME", "PATH", "SMITHERS_JJ_PATH", "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", "SMITHERS_CHAT_CONNECTOR_CONFIG", "SMITHERS_SLACK_BOT_TOKEN", "SMITHERS_SLACK_APP_TOKEN", "SMITHERS_TELEGRAM_BOT_TOKEN"} {
		if value := get(key); value != "" {
			host.environment = append(host.environment, key+"="+value)
		}
	}
	host.environment = append(host.environment,
		"SMITHERS_CHAT_CONNECTOR_URL=http://127.0.0.1:"+port,
		"SMITHERS_CHAT_CONNECTOR_STATE="+filepath.Join(dataRoot, "chat-connectors"))
	return host, nil
}

func (host *Host) Run(ctx context.Context, issue IssueCredential) error {
	return host.withCredential(ctx, issue, host.run)
}

func (host *Host) run(ctx context.Context, credential string) error {
	// EOF also stops the child after SIGKILL of the backend, where no signal
	// handler can run. Otherwise an orphan would keep consuming Socket Mode.
	reader, writer, err := os.Pipe()
	if err != nil {
		return err
	}
	defer reader.Close()
	defer writer.Close()
	cmd := exec.CommandContext(ctx, host.node, host.bundle)
	cmd.Stdin = reader
	cmd.Env = append(append([]string{}, host.environment...), "SMITHERS_CHAT_CONNECTOR_TOKEN_FILE="+credential)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = 10 * time.Second
	if err := cmd.Run(); err != nil && ctx.Err() == nil {
		// Do not include child output or environment in errors.
		return fmt.Errorf("chat connector host exited: %w", err)
	}
	if ctx.Err() != nil {
		return nil
	}
	return errors.New("chat connector host stopped unexpectedly")
}
