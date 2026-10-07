package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/crypto/ssh"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

// A terminal-only reference campaign. It records actual numbers but cannot
// certify the VS Code requirement or turn missing cgroup observations into 0.
func runMeasurements(ctx context.Context, a *installedAuthority, root string, config installedConfig, hostKey ssh.PublicKey) error {
	private, err := readState(filepath.Join(root, "ben-fixture.key"), 65536)
	if err != nil {
		return err
	}
	signer, err := ssh.ParsePrivateKey(private)
	if err != nil {
		return err
	}
	expected, _, _, _, err := ssh.ParseAuthorizedKey([]byte(config.BenKey))
	if err != nil || !bytes.Equal(expected.Marshal(), signer.PublicKey().Marshal()) {
		return errAuthority
	}
	evidence := filepath.Join(root, "evidence", time.Now().UTC().Format("20060102T150405.000000000Z"))
	if err = os.MkdirAll(evidence, 0700); err != nil {
		return err
	}
	csv, err := os.OpenFile(filepath.Join(evidence, "revoke.csv"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer csv.Close()
	fmt.Fprintln(csv, "run,invoked_utc,disconnect_ms,independent_empty_ms,gateway_error,zero_observed")
	passed := 0
	for run := 1; run <= 10; run++ {
		result, err := measurementRun(ctx, a, root, config, signer, hostKey, run == 1, evidence, run)
		if err != nil {
			result["failure"] = err.Error()
		}
		body, _ := json.MarshalIndent(result, "", "  ")
		_ = os.WriteFile(filepath.Join(evidence, fmt.Sprintf("run-%02d.json", run)), body, 0600)
		fmt.Fprintf(csv, "%d,%v,%v,%v,%v,%v\n", run, result["invoked_utc"], result["disconnect_ms"], result["independent_empty_ms"], result["gateway_error"], result["zero_observed"])
		if err == nil {
			passed++
		}
	}
	body, _ := json.Marshal(map[string]any{"runs": 10, "supplemental_passed": passed, "vs_code_recording": false, "C-SPK-08": "pending"})
	_ = os.WriteFile(filepath.Join(evidence, "result.json"), body, 0600)
	fmt.Printf("{\"runs\":10,\"supplemental_passed\":%d,\"evidence\":%q,\"C-SPK-08\":\"pending\"}\n", passed, evidence)
	if passed != 10 {
		return errors.New("reference campaign retained NO samples")
	}
	return nil
}
func measurementRun(ctx context.Context, a *installedAuthority, root string, config installedConfig, signer ssh.Signer, hostKey ssh.PublicKey, restart bool, evidence string, run int) (result map[string]any, runErr error) {
	result = map[string]any{"run": run, "vs_code_recording": false, "zero_observed": false}
	if err := a.recheck(); err != nil {
		return result, err
	}
	execution, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	command := exec.CommandContext(execution, "/bin/sh", "/usr/local/lib/smithers/current/share/trm06/run.sh")
	command.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin"}
	command.Cancel = func() error { return command.Process.Signal(syscall.SIGTERM) }
	command.WaitDelay = 65 * time.Second
	output, err := command.StdoutPipe()
	if err != nil {
		return result, err
	}
	log, err := os.OpenFile(filepath.Join(evidence, fmt.Sprintf("run-%02d.log", run)), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return result, err
	}
	defer log.Close()
	command.Stderr = log
	if err = command.Start(); err != nil {
		return result, err
	}
	done := make(chan error, 1)
	ready := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(output)
		if scanner.Scan() {
			line := scanner.Bytes()
			fmt.Fprintln(log, string(line))
			var receipt struct {
				Ready bool `json:"ready"`
			}
			if json.Unmarshal(line, &receipt) != nil || !receipt.Ready {
				ready <- errors.New("installed launcher did not report authenticated readiness")
			} else {
				ready <- nil
			}
		} else {
			ready <- errors.New("installed launcher ended before readiness")
		}
		for scanner.Scan() {
			fmt.Fprintln(log, scanner.Text())
		}
		done <- command.Wait()
	}()
	defer func() { cancel(); <-done }()
	select {
	case err = <-ready:
		if err != nil {
			return result, err
		}
	case <-execution.Done():
		return result, execution.Err()
	}
	client, err := ssh.Dial("tcp", config.Listen, &ssh.ClientConfig{User: "ben", Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)}, HostKeyCallback: ssh.FixedHostKey(hostKey), Timeout: 5 * time.Second})
	if err != nil {
		return result, err
	}
	defer client.Close()
	startSession := func() (*ssh.Session, error) {
		session, err := client.NewSession()
		if err != nil {
			return nil, err
		}
		if err = session.Start("nohup sleep 10000 >/dev/null 2>&1 & exec sleep 100"); err != nil {
			session.Close()
			return nil, err
		}
		return session, nil
	}
	session, err := startSession()
	if err != nil {
		return result, err
	}
	defer session.Close()
	before, err := ownerObservation(execution, root, "sample")
	if err != nil {
		return result, err
	}
	result["before"] = json.RawMessage(before)
	if restart {
		armed, err := ownerObservation(execution, root, "arm")
		if err != nil {
			return result, err
		}
		result["restart_observer_armed"] = json.RawMessage(armed)
		invoked := time.Now()
		killed, err := ownerObservation(execution, root, "restart")
		result["restart_before"] = json.RawMessage(killed)
		if err != nil {
			return result, err
		}
		attempts, firstSubmission, admissionErr := restartAdmissionRace(execution, config.Listen, &ssh.ClientConfig{User: "ben", Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)}, HostKeyCallback: ssh.FixedHostKey(hostKey)}, invoked)
		result["restart_admission_attempts"] = attempts
		result["restart_first_submission_utc"] = firstSubmission
		result["restart_admissions_finished_ms"] = time.Since(invoked).Milliseconds()
		if admissionErr != nil {
			return result, admissionErr
		}
		rawDrain, err := ownerObservation(execution, root, "drain")
		if err != nil {
			return result, err
		}
		result["restart_drain"] = json.RawMessage(rawDrain)
		var old guestSnapshot
		if json.Unmarshal(before, &old) != nil {
			return result, errors.New("invalid pre-restart sample")
		}
		if err = validateRestartDrain(rawDrain, old.Cgroups, invoked, firstSubmission); err != nil {
			return result, err
		}
		result["restart_zero_observed"] = true
		session, err = startSession()
		if err != nil {
			return result, err
		}
		defer session.Close()
		before, err = ownerObservation(execution, root, "sample")
		if err != nil {
			return result, err
		}
		result["before"] = json.RawMessage(before)
	}
	armed, err := ownerObservation(execution, root, "arm")
	if err != nil {
		return result, err
	}
	result["observer_armed"] = json.RawMessage(armed)
	disconnected := make(chan time.Time, 1)
	go func() { _ = session.Wait(); disconnected <- time.Now() }()
	invoked := time.Now()
	result["invoked_utc"] = invoked.UTC().Format(time.RFC3339Nano)
	err = requestInstalledRevocation(execution, filepath.Join(root, "control.sock"))
	result["gateway_error"] = ""
	if err != nil {
		result["gateway_error"] = err.Error()
	}
	select {
	case timestamp := <-disconnected:
		result["disconnect_ms"] = timestamp.Sub(invoked).Milliseconds()
	case <-time.After(5 * time.Second):
		return result, errors.New("SSH disconnect not observed within five seconds")
	}
	// Wait for the provider's independent snapshot taken before VM deletion.
	// Its timestamp includes observation overhead; do not subtract that overhead.
	var drain struct {
		Sample        json.RawMessage `json:"sample"`
		GatewayError  string          `json:"gateway_error"`
		ObserverError string          `json:"observer_error"`
		Observed      string          `json:"observed_utc"`
	}
	for {
		data, readErr := readState(filepath.Join(root, "last-drain.json"), 4<<20)
		if readErr == nil && json.Unmarshal(data, &drain) == nil {
			observed, _ := time.Parse(time.RFC3339Nano, drain.Observed)
			if !observed.Before(invoked) {
				result["independent_empty_ms"] = observed.Sub(invoked).Milliseconds()
				break
			}
		}
		if time.Since(invoked) > 5*time.Second {
			return result, errors.New("independent drain sample not observed within five seconds")
		}
		time.Sleep(20 * time.Millisecond)
	}
	result["drain"] = drain
	var observed struct {
		Sample      guestSnapshot `json:"sample"`
		Observation struct {
			Zero    map[string]string `json:"zero"`
			Groups  []string          `json:"groups"`
			Samples []json.RawMessage `json:"samples"`
		} `json:"observation"`
	}
	var old guestSnapshot
	if json.Unmarshal(drain.Sample, &observed) != nil || json.Unmarshal(before, &old) != nil || drain.GatewayError != "" || drain.ObserverError != "" || len(observed.Sample.Processes) != 0 {
		return result, errors.New("independent drain observation failed")
	}
	zero := len(old.Cgroups) > 0
	for name := range old.Cgroups {
		stamp, exists := observed.Observation.Zero[name]
		timestamp, parseErr := time.Parse(time.RFC3339Nano, stamp)
		if !exists || parseErr != nil || timestamp.Before(invoked) || timestamp.Sub(invoked) > 5*time.Second || !zeroHasRawSample(name, stamp, observed.Observation.Samples) {
			zero = false
		}

	}
	result["zero_observed"] = zero
	if err != nil || !zero {
		return result, errors.New("no direct populated 0 observation for every old cgroup; retain raw removed-group evidence")
	}
	if result["disconnect_ms"].(int64) > 5000 || result["independent_empty_ms"].(int64) > 5000 {
		return result, errors.New("revocation exceeded five seconds")
	}
	return result, nil
}

type guestSnapshot struct {
	Processes   []json.RawMessage `json:"processes"`
	Supervisors []int             `json:"supervisors"`
	Cgroups     map[string]string `json:"cgroups"`
}

func containsPopulatedZero(events string) bool {
	for _, line := range bytes.Split([]byte(events), []byte("\n")) {
		if bytes.Equal(line, []byte("populated 0")) {
			return true
		}
	}
	return false
}
func ownerObservation(ctx context.Context, root, operation string) ([]byte, error) {
	if operation != "sample" && operation != "restart" && operation != "arm" && operation != "drain" {
		return nil, errAuthority
	}
	connection, err := (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(root, "control.sock"))
	if err != nil {
		return nil, err
	}
	defer connection.Close()
	connection.SetDeadline(time.Now().Add(6 * time.Second))
	if err = writeAll(connection, []byte(operation+"\n")); err != nil {
		return nil, err
	}
	body, err := io.ReadAll(io.LimitReader(connection, 4<<20))
	if err != nil {
		return nil, err
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal(body, &envelope) != nil || envelope["class"] != nil {
		return nil, errors.New("independent guest observation unavailable")
	}
	return body, nil
}

// A summary timestamp alone is not a population observation. Match it to the
// actual independent kernel-events sample; absence/removal/error cannot pass.
func zeroHasRawSample(name, stamp string, rows []json.RawMessage) bool {
	for _, raw := range rows {
		var row struct {
			UTC    string                     `json:"utc"`
			Events map[string]json.RawMessage `json:"events"`
		}
		if json.Unmarshal(raw, &row) != nil || row.UTC != stamp {
			continue
		}
		var events string
		if json.Unmarshal(row.Events[name], &events) == nil && containsPopulatedZero(events) {
			return true
		}
	}
	return false
}

func validateRestartDrain(raw []byte, groups map[string]string, invoked, beforeAdmission time.Time) error {
	var drain struct {
		Sample      guestSnapshot `json:"sample"`
		Observation struct {
			Zero    map[string]string `json:"zero"`
			Samples []json.RawMessage `json:"samples"`
		} `json:"observation"`
	}
	if json.Unmarshal(raw, &drain) != nil || len(groups) == 0 || len(drain.Sample.Processes) != 0 {
		return errors.New("independent restart drain unavailable")
	}
	for name := range groups {
		stamp, ok := drain.Observation.Zero[name]
		zero, err := time.Parse(time.RFC3339Nano, stamp)
		if !ok || err != nil || (zero.Before(invoked) && !containsPopulatedZero(groups[name])) || zero.After(beforeAdmission) || zero.Sub(invoked) > 2*time.Second || !zeroHasRawSample(name, stamp, drain.Observation.Samples) {
			return errors.New("old cgroup lacks timed independent populated 0 before restart admission")
		}
	}
	return nil
}
