package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

type restartAttempt struct {
	Worker    int       `json:"worker"`
	Submitted time.Time `json:"submitted_utc"`
	Completed time.Time `json:"completed_utc"`
	Failure   string    `json:"failure,omitempty"`
}

// Race ordinary authenticated SSH sessions against init's replacement. A
// successful attempt's submission is a conservative lower bound on admission,
// not its later exit response. Keep refusals and require all four probes to
// finish within the original two-second restart budget.
func restartAdmissionRace(ctx context.Context, address string, config *ssh.ClientConfig, invoked time.Time) ([]restartAttempt, time.Time, error) {
	ctx, cancel := context.WithDeadline(ctx, invoked.Add(2*time.Second))
	defer cancel()
	var mu sync.Mutex
	var attempts []restartAttempt
	var first time.Time
	var workers sync.WaitGroup
	successful := 0
	for worker := 0; worker < 4; worker++ {
		workers.Add(1)
		go func(worker int) {
			defer workers.Done()
			for ctx.Err() == nil {
				attempt := restartAttempt{Worker: worker, Submitted: time.Now().UTC()}
				err := restartSSHProbe(ctx, address, config)
				attempt.Completed = time.Now().UTC()
				if err != nil {
					attempt.Failure = err.Error()
				}
				mu.Lock()
				attempts = append(attempts, attempt)
				if err == nil && !attempt.Completed.After(invoked.Add(2*time.Second)) {
					successful++
					if first.IsZero() || attempt.Submitted.Before(first) {
						first = attempt.Submitted
					}
					mu.Unlock()
					return
				}
				mu.Unlock()
				select {
				case <-ctx.Done():
					return
				case <-time.After(20 * time.Millisecond):
				}
			}
		}(worker)
	}
	workers.Wait()
	if successful != 4 {
		return attempts, first, errors.New("concurrent SSH restart admissions did not complete within two seconds")
	}
	return attempts, first, nil
}

func restartSSHProbe(ctx context.Context, address string, config *ssh.ClientConfig) error {
	connection, err := (&net.Dialer{}).DialContext(ctx, "tcp", address)
	if err != nil {
		return err
	}
	defer connection.Close()
	stop := context.AfterFunc(ctx, func() { connection.Close() })
	defer stop()
	if deadline, ok := ctx.Deadline(); ok {
		if err = connection.SetDeadline(deadline); err != nil {
			return err
		}
	}
	transport, channels, requests, err := ssh.NewClientConn(connection, address, config)
	if err != nil {
		return err
	}
	client := ssh.NewClient(transport, channels, requests)
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		return err
	}
	defer session.Close()
	if err = session.Run("exit 0"); err != nil {
		return err
	}
	return ctx.Err()
}

// This runs only inside the installed root campaign, using its actual SSH
// listener, authenticated DialWorkspacePort transport and independent fixture.
func validateRestartBoundary(ctx context.Context, client *ssh.Client, address string, config *ssh.ClientConfig, observe func(string) ([]byte, error), evidence string) error {
	session, err := client.NewSession()
	if err != nil {
		return err
	}
	defer session.Close()
	stop := context.AfterFunc(ctx, func() { session.Close() })
	defer stop()
	output, err := session.StdoutPipe()
	if err != nil {
		return err
	}
	if err = session.Start("nohup sleep 10000 >/dev/null 2>&1 & printf ready; exec sleep 100"); err != nil {
		return err
	}
	var ready [5]byte
	if _, err = io.ReadFull(output, ready[:]); err != nil || string(ready[:]) != "ready" {
		return errors.New("restart foreground/background fixture did not start")
	}
	before, err := observe("sample")
	if err != nil {
		return err
	}
	var old guestSnapshot
	if json.Unmarshal(before, &old) != nil || len(old.Processes) < 2 || len(old.Cgroups) == 0 {
		return errors.New("independent live restart fixture unavailable")
	}
	if err = os.WriteFile(filepath.Join(evidence, "restart-before.json"), before, 0600); err != nil {
		return err
	}
	armed, err := observe("arm")
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(evidence, "restart-arm.json"), armed, 0600); err != nil {
		return err
	}
	invoked := time.Now()
	killed, err := observe("restart")
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(evidence, "restart-killed.json"), killed, 0600); err != nil {
		return err
	}
	attempts, first, probeErr := restartAdmissionRace(ctx, address, config, invoked)
	result, err := json.Marshal(map[string]any{"invoked_utc": invoked.UTC(), "first_successful_submission_utc": first, "attempts": attempts})
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(evidence, "restart-admissions.json"), result, 0600); err != nil {
		return err
	}
	// Preserve drain evidence even when all concurrent probes refuse or time
	// out. A failed race never becomes a positive restart receipt.
	drain, err := observe("drain")
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(evidence, "restart-drain.json"), drain, 0600); err != nil {
		return err
	}
	if probeErr != nil {
		return probeErr
	}
	return validateRestartDrain(drain, old.Cgroups, invoked, first)
}
