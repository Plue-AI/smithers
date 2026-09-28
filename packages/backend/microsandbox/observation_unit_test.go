package microsandbox

import (
	"testing"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestMicrosandboxUnitRepeatedServiceObservationPreservesOutput(t *testing.T) {
	// Model a completed guest command using the documented stderr trailer.
	// No VM or process is launched; every buffer byte is actual protocol input.
	for _, row := range []struct {
		name, diagnostic, retained string
		limit                      int
		truncated                  bool
	}{
		{"complete diagnostic", "independent service diagnostic: tool configuration missing\n", "independent service diagnostic: tool configuration missing\n", 1024, false},
		{"short diagnostic", "short\n", "short\n", 1024, false},
		{"bounded diagnostic", "independent diagnostic\n", "inde", 4, true},
		{"below diagnostic length", "short\n", "short", 5, true},
		{"exact diagnostic length", "short\n", "short\n", 6, false},
		{"one protocol byte fits", "short\n", "short\n", 7, false},
		{"partial protocol fits", "short\n", "short\n", 15, false},
		{"complete protocol fits", "short\n", "short\n", 23, false},
	} {
		t.Run(row.name, func(t *testing.T) {
			stderr := &limitedBuffer{limit: row.limit}
			_, err := stderr.Write([]byte(row.diagnostic + "\x00SMITHERS-EXIT 3\x00"))
			require.NoError(t, err)
			stdout := &limitedBuffer{limit: 1024}
			_, err = stdout.Write([]byte("service started\n"))
			require.NoError(t, err)
			done := make(chan struct{})
			close(done)
			service := &managedService{spec: workspaceapi.ServiceSpec{Name: "app", ReadyAddress: "127.0.0.1:3000"},
				command: &guestCommand{done: done, stdout: stdout, stderr: stderr}}
			ws := newWorkspace(metadata{ID: "workspace", State: "running"}, "")
			ws.services["app"] = service
			runtime := &Runtime{workspaces: map[string]*workspace{"workspace": ws}}
			want := workspaceapi.ServiceObservation{Service: workspaceapi.Service{Name: "app", Address: "127.0.0.1:3000"},
				State: workspaceapi.ServiceFailed, ExitCode: 3, Stdout: "service started\n",
				Stderr: row.retained, OutputTruncated: row.truncated}
			for attempt := 0; attempt < 3; attempt++ {
				got, err := runtime.InspectService(t.Context(), "workspace", "app")
				require.NoError(t, err)
				require.Equal(t, want, got, "inspection must not consume saved diagnostic bytes")
				listed, err := runtime.ListServices(t.Context(), "workspace")
				require.NoError(t, err)
				require.Equal(t, []workspaceapi.ServiceObservation{want}, listed, "listing and inspection expose the same retained evidence")
			}
		})
	}
}
