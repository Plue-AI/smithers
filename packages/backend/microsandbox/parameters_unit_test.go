package microsandbox

import (
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"strings"
	"testing"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestMicrosandboxUnitCancelledOperationsReturnNoWork(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	ws := newWorkspace(metadata{ID: "workspace", State: "running"}, "")
	runtime := &Runtime{cli: &cli{binary: "/unit/msb-must-not-launch", home: "/unit/home"},
		workspaces: map[string]*workspace{"workspace": ws}, semaphore: make(chan struct{}, 1)}
	for _, operation := range []struct {
		name string
		run  func(*testing.T) error
	}{
		{"inspect workspace", func(t *testing.T) error {
			value, err := runtime.InspectWorkspace(ctx, "workspace")
			require.Equal(t, workspaceapi.Workspace{}, value)
			return err
		}},
		{"inspect service", func(t *testing.T) error {
			value, err := runtime.InspectService(ctx, "workspace", "app")
			require.Equal(t, workspaceapi.ServiceObservation{}, value)
			return err
		}},
		{"list services", func(t *testing.T) error {
			value, err := runtime.ListServices(ctx, "workspace")
			require.Nil(t, value)
			return err
		}},
		{"read", func(t *testing.T) error {
			value, err := runtime.ReadFile(ctx, "workspace", "file")
			require.Nil(t, value)
			return err
		}},
		{"write", func(t *testing.T) error { return runtime.WriteFile(ctx, "workspace", "file", []byte("content"), 0) }},
		{"list files", func(t *testing.T) error {
			value, err := runtime.ListFiles(ctx, "workspace", ".")
			require.Nil(t, value)
			return err
		}},
		{"remove", func(t *testing.T) error { return runtime.RemoveFile(ctx, "workspace", "file") }},
		{"preview", func(t *testing.T) error {
			value, err := runtime.PreviewTarget(ctx, "workspace", 3000)
			require.Equal(t, workspaceapi.PreviewTarget{}, value)
			return err
		}},
		{"terminal", func(t *testing.T) error {
			value, err := runtime.OpenWorkspaceTerminal(ctx, "workspace", workspaceapi.Command{})
			require.Nil(t, value)
			return err
		}},
		{"start service", func(t *testing.T) error {
			value, err := runtime.StartService(ctx, "workspace", workspaceapi.ServiceSpec{Name: "app"})
			require.Equal(t, workspaceapi.Service{}, value)
			return err
		}},
		{"stop service", func(t *testing.T) error { return runtime.StopService(ctx, "workspace", "app") }},
	} {
		t.Run(operation.name, func(t *testing.T) { require.ErrorIs(t, operation.run(t), context.Canceled) })
	}
	// A cancelled caller waiting for a full concurrency budget cannot acquire
	// another slot or release the slot owned by existing work.
	runtime.semaphore <- struct{}{}
	result, err := runtime.ExecuteCommand(ctx, "workspace", workspaceapi.Command{Args: []string{"tool"}})
	require.ErrorIs(t, err, context.Canceled)
	require.Equal(t, workspaceapi.CommandResult{}, result)
	require.Len(t, runtime.semaphore, 1)
	require.Empty(t, ws.commands)
	require.Empty(t, ws.services)
	require.Empty(t, ws.previews)
}

func TestMicrosandboxUnitCommandRequestSealsGuestPathsAndEnvironment(t *testing.T) {
	runtime := &Runtime{config: Config{Environment: map[string]string{"PATH": "/opt/bin", "CONFIG": "base", "HOME": "/host/home"}}}
	command := workspaceapi.Command{Args: []string{"tool", "argument with spaces"}, Directory: " apps/../src ",
		Environment: map[string]string{"CONFIG": "override", "CUSTOM": "héllo", "HOME": "/caller/home", "TMPDIR": "/caller/tmp"}}
	request, err := runtime.request(command)
	require.NoError(t, err)
	require.Regexp(t, `^x[0-9a-f]{24}$`, request.ID)
	require.Equal(t, []string{"tool", "argument with spaces"}, request.Argv)
	require.Equal(t, "/workspace/src", request.Cwd)
	require.Equal(t, "/workspace", request.Root)
	require.Equal(t, "agent", request.User)
	require.Equal(t, map[string]string{
		"PATH": "/opt/bin", "CONFIG": "override", "CUSTOM": "héllo", "HOME": "/home/agent", "USER": "agent",
		"XDG_CONFIG_HOME": "/home/agent/.config", "XDG_CACHE_HOME": "/home/agent/.cache", "XDG_DATA_HOME": "/home/agent/.local/share",
		"TMPDIR": "/var/tmp/smithers", "SMITHERS_WORKSPACE_ROOT": "/workspace", "SMITHERS_WORKSPACE_STATE_DIR": "/var/lib/smithers/state",
	}, request.Env)
	encoded, err := json.Marshal(request)
	require.NoError(t, err)
	var wire map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(encoded, &wire))
	require.NotContains(t, wire, "stdin", "a non-terminal command does not inherit host stdin")
	require.JSONEq(t, `["tool","argument with spaces"]`, string(wire["argv"]))
	require.Equal(t, "/host/home", runtime.config.Environment["HOME"])
	require.Equal(t, "/caller/home", command.Environment["HOME"])
	command.Args[0], command.Environment["CUSTOM"] = "changed", "changed"
	runtime.config.Environment["PATH"] = "changed"
	require.Equal(t, "tool", request.Argv[0], "retained request is isolated from caller mutation")
	require.Equal(t, "héllo", request.Env["CUSTOM"])
	require.Equal(t, "/opt/bin", request.Env["PATH"])
}

func TestMicrosandboxUnitCommandAdmissionRefusesInvalidBoundaries(t *testing.T) {
	runtime := &Runtime{}
	for _, row := range []struct {
		name    string
		command workspaceapi.Command
		message string
	}{
		{"missing argv", workspaceapi.Command{}, "command argv is required"},
		{"blank executable", workspaceapi.Command{Args: []string{" \t"}}, "command argv is required"},
		{"absolute directory", workspaceapi.Command{Args: []string{"tool"}, Directory: "/workspace"}, "command directory must be relative to the workspace root"},
		{"nul directory", workspaceapi.Command{Args: []string{"tool"}, Directory: "a\x00b"}, "command directory must be relative to the workspace root"},
		{"parent escape", workspaceapi.Command{Args: []string{"tool"}, Directory: "a/../../b"}, "command directory escapes the workspace root"},
		{"empty environment name", workspaceapi.Command{Args: []string{"tool"}, Environment: map[string]string{"": "value"}}, `invalid environment variable ""`},
		{"assignment name", workspaceapi.Command{Args: []string{"tool"}, Environment: map[string]string{"A=B": "value"}}, `invalid environment variable "A=B"`},
		{"nul name", workspaceapi.Command{Args: []string{"tool"}, Environment: map[string]string{"A\x00B": "value"}}, `invalid environment variable "A\x00B"`},
		{"nul value", workspaceapi.Command{Args: []string{"tool"}, Environment: map[string]string{"A": "v\x00"}}, `invalid environment variable "A"`},
	} {
		t.Run(row.name, func(t *testing.T) {
			request, err := runtime.request(row.command)
			require.EqualError(t, err, row.message)
			require.Equal(t, execRequest{}, request, "invalid request yields no executable work")
		})
	}
}

func TestMicrosandboxUnitServiceReadinessAcceptsOnlyGuestLoopbackPorts(t *testing.T) {
	for _, row := range []struct {
		input, normalized string
		port              uint16
	}{
		{"", "", 0}, {" \t ", "", 0}, {"127.0.0.1:1", "127.0.0.1:1", 1},
		{" localhost:65535 ", "localhost:65535", 65535}, {"[::1]:3000", "[::1]:3000", 3000},
	} {
		port, normalized, err := guestReadyPort(row.input)
		require.NoError(t, err)
		require.Equal(t, row.port, port)
		require.Equal(t, row.normalized, normalized)
	}
	for _, input := range []string{"host:3000", "0.0.0.0:3000", "[::]:3000", "127.0.0.2:3000", "3000", "::1:3000"} {
		port, address, err := guestReadyPort(input)
		require.EqualError(t, err, "service ready address must be loopback host:port")
		require.Zero(t, port)
		require.Empty(t, address)
	}
	for _, input := range []string{"127.0.0.1:0", "localhost:65536", "localhost:-1", "localhost:http", "localhost:"} {
		port, address, err := guestReadyPort(input)
		require.EqualError(t, err, "service ready address has an invalid port")
		require.Zero(t, port)
		require.Empty(t, address)
	}
}

func TestMicrosandboxUnitDefaultsPreserveExplicitLimits(t *testing.T) {
	for _, initial := range []int{-1, 0} {
		config := Config{CPUs: initial, MemoryMiB: initial, DiskMiB: initial, MaxConcurrent: initial, MaxRunningVMs: initial,
			OutputLimit: initial, FileReadLimit: int64(initial), CommandTimeout: time.Duration(initial)}
		applyDefaults(&config)
		require.Equal(t, 4, config.CPUs)
		require.Equal(t, 8192, config.MemoryMiB)
		require.Equal(t, 32768, config.DiskMiB)
		require.Equal(t, 32, config.MaxConcurrent)
		require.Equal(t, 3, config.MaxRunningVMs)
		require.Equal(t, 4_194_304, config.OutputLimit)
		require.Equal(t, int64(16_777_216), config.FileReadLimit)
		require.Equal(t, time.Hour, config.CommandTimeout)
		require.Regexp(t, `^node@sha256:[0-9a-f]{64}$`, config.Image)
	}
	explicit := Config{Image: "custom@sha256:declared", CPUs: 1, MemoryMiB: 1, DiskMiB: 1, MaxConcurrent: 1,
		MaxRunningVMs: 1, OutputLimit: 1, FileReadLimit: 1, CommandTimeout: time.Nanosecond}
	before := explicit
	applyDefaults(&explicit)
	require.Equal(t, before, explicit)
}

func TestMicrosandboxUnitCLICommandsKeepLocalScrubbedAuthority(t *testing.T) {
	t.Setenv("MSB_BACKEND", "cloud")
	t.Setenv("MSB_API_KEY", "unit-only-secret")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "unit-only-secret")
	client := &cli{binary: "/unit/msb", home: "/unit/home"}
	for _, row := range []struct{ input, want []string }{
		{[]string{"exec", "vm", "--", "cat"}, []string{"/unit/msb", "exec", "--stream", "vm", "--", "cat"}},
		{[]string{"exec", "--stream", "vm", "--", "cat"}, []string{"/unit/msb", "exec", "--stream", "vm", "--", "cat"}},
		{[]string{"exec", "-t", "vm", "--", "sh"}, []string{"/unit/msb", "exec", "-t", "vm", "--", "sh"}},
		{[]string{"exec", "vm", "--", "tool", "-t"}, []string{"/unit/msb", "exec", "--stream", "vm", "--", "tool", "-t"}},
		{nil, []string{"/unit/msb"}},
	} {
		command := client.command(row.input...)
		require.Equal(t, row.want, command.Args)
		require.Equal(t, []string{"HOME=/unit/home", "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "MSB_BACKEND=local", "NO_COLOR=1"}, command.Env)
		input, err := io.ReadAll(command.Stdin)
		require.NoError(t, err)
		require.Empty(t, input, "the child receives EOF rather than ambient host stdin")
		require.NotContains(t, strings.Join(command.Env, "\n"), "unit-only-secret")
	}
}

func TestMicrosandboxUnitFileModesPreserveLinuxTypesAndSpecialBits(t *testing.T) {
	for _, row := range []struct {
		raw  uint32
		want fs.FileMode
	}{
		{0o010640, fs.ModeNamedPipe | 0o640},
		{0o140600, fs.ModeSocket | 0o600},
		{0o020660, fs.ModeDevice | fs.ModeCharDevice | 0o660},
		{0o060640, fs.ModeDevice | 0o640},
		{0o104755, fs.ModeSetuid | 0o755},
		{0o102750, fs.ModeSetgid | 0o750},
		{0o041777, fs.ModeDir | fs.ModeSticky | 0o777},
		{0o107777, fs.ModeSetuid | fs.ModeSetgid | fs.ModeSticky | 0o777},
	} {
		require.Equal(t, row.want, unixMode(row.raw))
	}
}

func TestMicrosandboxUnitWorkspaceIdentitiesUseByteBoundsAndOwnedNames(t *testing.T) {
	for _, row := range []struct{ input, want string }{
		{" workspace ", "workspace"},
		{strings.Repeat("x", 512), strings.Repeat("x", 512)},
		{strings.Repeat("é", 256), strings.Repeat("é", 256)},
	} {
		id, err := validWorkspaceID(row.input)
		require.NoError(t, err)
		require.Equal(t, row.want, id)
	}
	for _, input := range []string{"", " \t", "a\x00b", strings.Repeat("x", 513), strings.Repeat("é", 257)} {
		id, err := validWorkspaceID(input)
		require.EqualError(t, err, "workspace id is required")
		require.Empty(t, id)
	}
	// SHA-256("abc") is the standard known-answer vector, independent of the
	// naming helper. Workspace and cold-snapshot names share ownership hashing.
	runtime := &Runtime{owner: "smithers-backend-0123456789abcdef", holder: "backend-holder"}
	require.Equal(t, "smthrs-ws-01234567-ba7816bf8f01cfea4141", runtime.machineName("abc"))
	require.Equal(t, "smthrs-cs-01234567-ba7816bf8f01cfea4141", runtime.snapshotName("abc"))
	require.Equal(t, map[string]string{"smithers.provider": "microsandbox", "smithers.owner": "smithers-backend-0123456789abcdef",
		"smithers.holder": "backend-holder", "smithers.workspace": "ba7816bf8f01cfea4141"}, runtime.ownership("abc"))
	require.Equal(t, map[string]string{"smithers.provider": "microsandbox", "smithers.owner": "smithers-backend-0123456789abcdef",
		"smithers.holder": "backend-holder"}, runtime.ownership(""))
	require.Equal(t, "smithers-backend-0123456789abcdef", runtime.Owner())
}

func TestMicrosandboxUnitServiceStatesAndListingKeepInternalServicesPrivate(t *testing.T) {
	for _, row := range []struct {
		name, trailer     string
		finished, stopped bool
		state             workspaceapi.ServiceState
		code              int
	}{
		{"running", "", false, false, workspaceapi.ServiceRunning, 0},
		{"clean exit", "\x00SMITHERS-EXIT 0\x00", true, false, workspaceapi.ServiceExited, 0},
		{"failed exit", "\x00SMITHERS-EXIT 3\x00", true, false, workspaceapi.ServiceFailed, 3},
		{"unknown exit", "", true, false, workspaceapi.ServiceFailed, 0},
		{"stopped nonzero", "\x00SMITHERS-EXIT -9\x00", true, true, workspaceapi.ServiceStopped, -9},
	} {
		t.Run(row.name, func(t *testing.T) {
			done := make(chan struct{})
			if row.finished {
				close(done)
			}
			stdout, stderr := &limitedBuffer{limit: 1024}, &limitedBuffer{limit: 1024}
			_, err := stdout.Write([]byte("out"))
			require.NoError(t, err)
			_, err = stderr.Write([]byte("err" + row.trailer))
			require.NoError(t, err)
			service := &managedService{spec: workspaceapi.ServiceSpec{Name: "app", ReadyAddress: "127.0.0.1:3000"},
				stopped: row.stopped, command: &guestCommand{done: done, stdout: stdout, stderr: stderr}}
			require.Equal(t, workspaceapi.ServiceObservation{Service: workspaceapi.Service{Name: "app", Address: "127.0.0.1:3000"},
				State: row.state, ExitCode: row.code, Stdout: "out", Stderr: "err"}, observe(service))
		})
	}
	ws := newWorkspace(metadata{ID: "workspace", State: "running"}, "")
	for _, name := range []string{"zeta", "alpha", "bridge"} {
		ws.services[name] = &managedService{spec: workspaceapi.ServiceSpec{Name: name}, internal: name == "bridge",
			command: &guestCommand{done: make(chan struct{}), stdout: &limitedBuffer{}, stderr: &limitedBuffer{}}}
	}
	runtime := &Runtime{workspaces: map[string]*workspace{"workspace": ws}}
	listed, err := runtime.ListServices(t.Context(), "workspace")
	require.NoError(t, err)
	require.Equal(t, []workspaceapi.ServiceObservation{
		{Service: workspaceapi.Service{Name: "alpha"}, State: workspaceapi.ServiceRunning},
		{Service: workspaceapi.Service{Name: "zeta"}, State: workspaceapi.ServiceRunning},
	}, listed)
	_, err = runtime.InspectService(t.Context(), "workspace", "bridge")
	require.EqualError(t, err, `service "bridge" is not found`)
	_, err = runtime.InspectService(t.Context(), "workspace", "missing")
	require.EqualError(t, err, `service "missing" is not found`)
}

func TestMicrosandboxUnitExitEvidenceRequiresCompleteFinalTrailer(t *testing.T) {
	for _, row := range []struct {
		chunks []string
		code   int
		text   string
	}{
		{[]string{"warning\n\x00SMITHERS-EX", "IT 255\x00"}, 255, "warning\n"},
		{[]string{"\x00SMITHERS-EXIT -9\x00"}, -9, ""},
	} {
		buffer := &limitedBuffer{limit: 1024}
		for _, chunk := range row.chunks {
			n, err := buffer.Write([]byte(chunk))
			require.NoError(t, err)
			require.Equal(t, len(chunk), n)
		}
		snapshot := buffer.completedStderr()
		require.True(t, snapshot.hasExit)
		require.Equal(t, row.code, snapshot.exitCode)
		text, truncated := snapshot.text, snapshot.truncated
		require.Equal(t, row.text, text)
		require.False(t, truncated)
	}
	for _, raw := range []string{"", "\x00SMITHERS-EXIT 0", "\x00SMITHERS-EXIT 0\x00trailing", "\x00SMITHERS-EXIT nope\x00", "\x00SMITHERS-EXIT 99999999999999999999999999\x00"} {
		buffer := &limitedBuffer{limit: 1024}
		_, err := buffer.Write([]byte(raw))
		require.NoError(t, err)
		snapshot := buffer.completedStderr()
		require.False(t, snapshot.hasExit)
		require.Zero(t, snapshot.exitCode)
		text, truncated := snapshot.text, snapshot.truncated
		require.Equal(t, raw, text, "unknown exit evidence is preserved for diagnosis")
		require.False(t, truncated)
	}
}
