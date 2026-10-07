package microsandbox

import (
	"context"
	"errors"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
	"io"
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
	}{{"clean", []byte{5, 0, 0, 0, 0, 0}, 0}, {"failure", []byte{5, 0, 0, 0, 0, 42}, 42}, {"signal", []byte{5, 1, 9, 0}, 137}} {
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
	for _, frames := range [][][]byte{nil, {{7}}, {{255}}, {{}}, {{1}}, {{1, 3}}, {{5}}, {{5, 0}}, {{5, 2, 0, 0}}} {
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
