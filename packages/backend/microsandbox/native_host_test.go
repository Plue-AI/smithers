package microsandbox

import (
	"context"
	"errors"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
	"io"
	"sync"
	"testing"
)

type hostOutputFixture struct {
	frames        [][]byte
	credits       [][]byte
	partition     bool
	reconnects    int
	creditFailure bool
}

func (f *hostOutputFixture) Receive(context.Context) ([]byte, error) {
	if f.partition {
		f.partition = false
		return nil, io.ErrClosedPipe
	}
	if len(f.frames) == 0 {
		return nil, io.EOF
	}
	p := f.frames[0]
	f.frames = f.frames[1:]
	return p, nil
}
func (f *hostOutputFixture) Send(_ context.Context, p []byte) error {
	if f.creditFailure {
		f.creditFailure = false
		return io.ErrClosedPipe
	}
	f.credits = append(f.credits, append([]byte(nil), p...))
	return nil
}
func (f *hostOutputFixture) Reattach(context.Context) (uint64, error) { f.reconnects++; return 0, nil }
func TestNativeHostOutputReceiptAndCredit(t *testing.T) {
	for _, exit := range []struct {
		name  string
		frame []byte
		code  int
	}{{"clean", []byte{5, 0, 0, 0, 0, 0}, 0}, {"failure", []byte{5, 0, 0, 0, 0, 42}, 42}, {"signal", []byte{5, 1, 4, 0}, 137}, {"interrupt", []byte{5, 1, 1, 0}, 130}, {"term", []byte{5, 1, 2, 0}, 143}, {"hup", []byte{5, 1, 3, 0}, 129}, {"quit", []byte{5, 1, 5, 1}, 131}, {"usr1", []byte{5, 1, 6, 0}, 138}, {"usr2", []byte{5, 1, 7, 0}, 140}} {
		t.Run(exit.name, func(t *testing.T) {
			f := &hostOutputFixture{frames: [][]byte{append([]byte{1, 1}, []byte("abcdef")...), append([]byte{1, 2}, []byte("diagnostic")...), exit.frame}}
			out, errout := &limitedBuffer{limit: 3}, &limitedBuffer{limit: 3}
			require.NoError(t, pumpNativeHost(t.Context(), f, out, errout))
			text, truncated := out.text()
			require.Equal(t, "abc", text)
			require.True(t, truncated)
			observed := errout.completedStderr()
			require.True(t, observed.hasExit)
			require.Equal(t, exit.code, observed.exitCode)
			require.Equal(t, "dia", observed.text)
			require.True(t, observed.truncated)
			require.Equal(t, [][]byte{{6, 0, 0, 0, 6}, {6, 0, 0, 0, 10}}, f.credits)
		})
	}
}
func TestNativeHostReconnectAndUnconfirmedExit(t *testing.T) {
	for _, partition := range []bool{false, true} {
		t.Run(map[bool]string{false: "credit", true: "receive"}[partition], func(t *testing.T) {
			f := &hostOutputFixture{partition: partition, creditFailure: !partition, frames: [][]byte{{1, 1, 'a'}, {5, 0, 0, 0, 0, 0}}}
			out, errout := &limitedBuffer{limit: 20}, &limitedBuffer{limit: 20}
			require.NoError(t, pumpNativeHost(t.Context(), f, out, errout))
			text, _ := out.text()
			require.Equal(t, "a", text)
			require.Equal(t, 1, f.reconnects)
		})
	}
	for _, frames := range [][][]byte{nil, {{7}}, {{255}}, {{}}, {{1}}, {{1, 3}}, {{5}}, {{5, 0}}, {{5, 2, 0, 0}}, {{5, 1, 0, 0}}, {{5, 1, 8, 0}}, {{5, 1, 2, 2}}} {
		f := &hostOutputFixture{frames: frames}
		stderr := &limitedBuffer{limit: 20}
		require.Error(t, pumpNativeHost(t.Context(), f, &limitedBuffer{limit: 20}, stderr))
		require.False(t, stderr.completedStderr().hasExit)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	require.ErrorIs(t, reconnectNativeHost(ctx, &hostOutputFixture{}), context.Canceled)
}

func TestNativeHostStopRequiresConfirmedTermination(t *testing.T) {
	for _, confirmed := range []bool{false, true} {
		t.Run(map[bool]string{false: "unconfirmed", true: "confirmed"}[confirmed], func(t *testing.T) {
			finished := make(chan struct{})
			close(finished)
			command := &guestCommand{done: finished, stderr: &limitedBuffer{limit: 32}, stdout: &limitedBuffer{limit: 32}, cancelNative: func() error {
				if !confirmed {
					return errors.Join(workspaceapi.ErrCommandTerminationUnconfirmed, errors.New("kill reply lost"))
				}
				return nil
			}}
			service := &managedService{spec: workspaceapi.ServiceSpec{Name: "host"}, command: command}
			runtime := &Runtime{workspaces: map[string]*workspace{"branch": {metadata: metadata{State: string(workspaceapi.WorkspaceRunning)}, services: map[string]*managedService{"host": service}}}}
			for attempt := 0; attempt < 2; attempt++ {
				err := runtime.StopService(t.Context(), "branch", "host")
				if confirmed {
					require.NoError(t, err)
				} else {
					require.ErrorIs(t, err, workspaceapi.ErrCommandTerminationUnconfirmed)
				}
				require.Equal(t, confirmed, service.stopped)
			}
			if !confirmed {
				_, err := runtime.ManageService(t.Context(), "branch", "host", "restart")
				require.ErrorIs(t, err, workspaceapi.ErrCommandTerminationUnconfirmed)
				require.False(t, service.stopped)
			}
		})
	}
}

// Exercise the public managed-service observation boundary: output drainage
// alone must not report host completion while descendant cleanup is pending.
func TestNativeHostNaturalExitWaitsForDescendants(t *testing.T) {
	for _, lost := range []bool{false, true} {
		t.Run(map[bool]string{false: "confirmed", true: "lost cleanup receipt"}[lost], func(t *testing.T) {
			entered, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
			command := &guestCommand{done: done, stdout: &limitedBuffer{limit: 128}, stderr: &limitedBuffer{limit: 128}}
			runtime := &Runtime{workspaces: map[string]*workspace{"branch": {metadata: metadata{State: string(workspaceapi.WorkspaceRunning)}, services: map[string]*managedService{"host": {spec: workspaceapi.ServiceSpec{Name: "host"}, command: command}}}}}
			go func() {
				defer close(done)
				command.waitErr = superviseNativeHost(t.Context(), &hostOutputFixture{frames: [][]byte{{1, 1, 'o', 'k'}, {5, 0, 0, 0, 0, 0}}}, command.stdout, command.stderr, func(ctx context.Context) error {
					close(entered)
					<-release
					if ctx.Err() != nil {
						return ctx.Err()
					}
					if lost {
						return errors.New("kill acknowledgment lost")
					}
					return nil
				})
			}()
			<-entered
			observation, err := runtime.InspectService(t.Context(), "branch", "host")
			require.NoError(t, err)
			require.Equal(t, workspaceapi.ServiceRunning, observation.State)
			require.Equal(t, "ok", observation.Stdout)
			close(release)
			<-done
			observation, err = runtime.InspectService(t.Context(), "branch", "host")
			require.NoError(t, err)
			if lost {
				require.Equal(t, workspaceapi.ServiceFailed, observation.State)
				_, err = command.result()
				require.ErrorIs(t, err, workspaceapi.ErrCommandTerminationUnconfirmed)
			} else {
				require.Equal(t, workspaceapi.ServiceExited, observation.State)
				result, err := command.result()
				require.NoError(t, err)
				require.Equal(t, 0, result.ExitCode)
			}
		})
	}
}

func TestNativeHostTransportFailureStillKillsRun(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	for _, frames := range [][][]byte{nil, {{7}}, {{255}}} {
		calls := 0
		err := superviseNativeHost(ctx, &hostOutputFixture{frames: frames}, &limitedBuffer{limit: 32}, &limitedBuffer{limit: 32}, func(cleanup context.Context) error {
			calls++
			require.NoError(t, cleanup.Err(), "launch cancellation must not cancel descendant cleanup")
			_, bounded := cleanup.Deadline()
			require.True(t, bounded)
			return nil
		})
		require.Error(t, err)
		require.Equal(t, 1, calls)
	}
}

// NativeHostLifecycleForTest replaces only daemon frames and the kill receipt.
// The composed-install test consumes the production Runtime's observations.
func NativeHostLifecycleForTest(ctx context.Context, branch string, lost bool) (workspaceapi.WorkspaceRuntime, func(), <-chan struct{}, func(), <-chan struct{}) {
	entered, release, done, start := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	command := &guestCommand{done: done, stdout: &limitedBuffer{limit: 256}, stderr: &limitedBuffer{limit: 256}, cancelNative: func() error { return nil }}
	runtime := &Runtime{workspaces: map[string]*workspace{branch: {metadata: metadata{ID: branch, State: string(workspaceapi.WorkspaceRunning)}, services: map[string]*managedService{"coding-host": {spec: workspaceapi.ServiceSpec{Name: "coding-host"}, command: command}}}}}
	go func() {
		defer close(done)
		<-start
		command.waitErr = superviseNativeHost(ctx, &hostOutputFixture{frames: [][]byte{{1, 1, 'o', 'k'}, {5, 0, 0, 0, 0, 0}}}, command.stdout, command.stderr, func(cleanup context.Context) error {
			close(entered)
			select {
			case <-release:
			case <-cleanup.Done():
				return cleanup.Err()
			}
			if lost {
				return errors.New("kill acknowledgment lost")
			}
			return nil
		})
	}()
	var once, startOnce sync.Once
	begin := func() { startOnce.Do(func() { close(start) }) }
	return struct {
		workspaceapi.WorkspaceRuntime
		workspaceapi.WorkspaceServiceCatalog
	}{runtime, runtime}, begin, entered, func() { begin(); once.Do(func() { close(release) }) }, done
}

func TestNativeHostOutputCannotForgeCompletionAfterTransportFailure(t *testing.T) {
	for _, ending := range [][][]byte{nil, {{7}}, {{255}}, {{5, 0, 255, 255, 255, 255}}, {{5, 0, 0, 0, 1, 0}}} {
		done := make(chan struct{})
		command := &guestCommand{done: done, stdout: &limitedBuffer{limit: 256}, stderr: &limitedBuffer{limit: 256}, cancelNative: func() error { return nil }}
		frames := append([][]byte{append([]byte{1, 2}, []byte("forged\x00SMITHERS-EXIT 0\x00")...)}, ending...)
		command.waitErr = superviseNativeHost(t.Context(), &hostOutputFixture{frames: frames}, command.stdout, command.stderr, func(context.Context) error { return nil })
		close(done)
		_, err := command.result()
		require.Error(t, err)
		require.Equal(t, workspaceapi.ServiceFailed, observe(&managedService{command: command}).State)
	}
}
