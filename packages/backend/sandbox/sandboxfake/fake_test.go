package sandboxfake

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestSnapshotsCarryTheTreeIntoNewMachines(t *testing.T) {
	ctx := context.Background()
	p := New()
	require.Equal(t, Name, p.Name())
	require.True(t, p.Capabilities().Supports(sandbox.CapabilityColdSnapshots))
	parent := p.Boot(map[string]string{"/repo/a": "1"})
	require.NoError(t, p.WriteFile(ctx, parent, "/repo/b", sandbox.WriteFileRequest{Content: "2"}))

	snap, err := p.SnapshotSandbox(ctx, parent, sandbox.SnapshotRequest{})
	require.NoError(t, err)
	require.Equal(t, parent, snap.SourceSandboxID)
	require.NoError(t, p.WriteFile(ctx, parent, "/repo/c", sandbox.WriteFileRequest{Content: "after"}))

	child, err := p.CreateSandbox(ctx, sandbox.CreateRequest{SnapshotID: snap.SnapshotID,
		Files: map[string]sandbox.SandboxFile{"/etc/owner": {Content: "child"}}})
	require.NoError(t, err)
	machine, ok := p.Machine(child.ID)
	require.True(t, ok)
	require.Equal(t, map[string]string{"/repo/a": "1", "/repo/b": "2", "/etc/owner": "child"}, machine.Files)
	require.Equal(t, snap.SnapshotID, p.Creates()[0].SnapshotID)

	machine.Files["/repo/a"] = "edited copy"
	again, _ := p.Machine(child.ID)
	require.Equal(t, "1", again.Files["/repo/a"], "Machine returns a copy")

	_, err = p.CreateSandbox(ctx, sandbox.CreateRequest{SnapshotID: "missing"})
	require.ErrorIs(t, err, sandbox.ErrNotFound)

	fork, err := p.ForkSandbox(ctx, parent, sandbox.ForkRequest{Files: map[string]sandbox.SandboxFile{"/x": {Content: "y"}}})
	require.NoError(t, err)
	forked, _ := p.Machine(fork.ID)
	require.Equal(t, "after", forked.Files["/repo/c"])
	require.Equal(t, "y", forked.Files["/x"])
	_, err = p.ForkSandbox(ctx, "missing", sandbox.ForkRequest{})
	require.ErrorIs(t, err, sandbox.ErrNotFound)

	template, err := p.CreateSnapshot(ctx, sandbox.CreateSnapshotRequest{Template: sandbox.Template{
		Files: map[string]sandbox.SandboxFile{"/t": {Content: "template"}}}})
	require.NoError(t, err)
	require.ElementsMatch(t, []string{snap.SnapshotID, template.SnapshotID}, p.Snapshots())
	require.NoError(t, p.DeleteSnapshot(ctx, template.SnapshotID))
	require.ErrorIs(t, p.DeleteSnapshot(ctx, template.SnapshotID), sandbox.ErrNotFound)
	require.Equal(t, []string{template.SnapshotID}, p.Released())
	p.DeleteSnapshotErr = errors.New("refused")
	require.ErrorContains(t, p.DeleteSnapshot(ctx, snap.SnapshotID), "refused")

	_, err = p.SnapshotSandbox(ctx, "missing", sandbox.SnapshotRequest{})
	require.ErrorIs(t, err, sandbox.ErrNotFound)
	p.SnapshotErr = errors.New("draining")
	_, err = p.SnapshotSandbox(ctx, parent, sandbox.SnapshotRequest{})
	require.ErrorContains(t, err, "draining")
}

func TestLifecycleExecAndDeletion(t *testing.T) {
	ctx := context.Background()
	p := New()
	id := p.Boot(nil)

	for _, step := range []struct {
		call func() error
		want sandbox.State
	}{
		{func() error { _, err := p.StopSandbox(ctx, id); return err }, sandbox.StateStopped},
		{func() error { _, err := p.StartSandbox(ctx, id, sandbox.StartRequest{}); return err }, sandbox.StateRunning},
		{func() error { _, err := p.SuspendSandbox(ctx, id); return err }, sandbox.StateStopped},
	} {
		require.NoError(t, step.call())
		got, err := p.InspectSandbox(ctx, id)
		require.NoError(t, err)
		require.Equal(t, step.want, got.State)
	}

	result, err := p.Execute(ctx, id, sandbox.ExecRequest{Command: "true"})
	require.NoError(t, err)
	require.Equal(t, int32(0), *result.StatusCode)
	p.ExecFunc = func(machine *Machine, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
		machine.Files["/ran"] = req.Command
		return sandbox.ExecResult{Stdout: "ok"}, nil
	}
	result, err = p.Execute(ctx, id, sandbox.ExecRequest{Command: "touch"})
	require.NoError(t, err)
	require.Equal(t, "ok", result.Stdout)
	machine, _ := p.Machine(id)
	require.Equal(t, "touch", machine.Files["/ran"])
	require.Equal(t, []Exec{{SandboxID: id, Command: "true"}, {SandboxID: id, Command: "touch"}}, p.Execs())

	p.CreateErr = func(sandbox.CreateRequest) error { return errors.New("no capacity") }
	_, err = p.CreateSandbox(ctx, sandbox.CreateRequest{})
	require.ErrorContains(t, err, "no capacity")
	p.CreateErr = func(sandbox.CreateRequest) error { return nil }
	second, err := p.CreateSandbox(ctx, sandbox.CreateRequest{})
	require.NoError(t, err)
	require.Equal(t, []string{id, second.ID}, p.Live())

	p.DeleteErr = func(string) error { return errors.New("controller unavailable") }
	require.ErrorContains(t, p.DeleteSandbox(ctx, id), "controller unavailable")
	p.DeleteErr = func(string) error { return nil }
	require.NoError(t, p.DeleteSandbox(ctx, id))
	require.Equal(t, []string{id}, p.Deleted())
	require.Equal(t, []string{second.ID}, p.Live())

	for _, err := range []error{
		p.DeleteSandbox(ctx, id),
		p.WriteFile(ctx, id, "/a", sandbox.WriteFileRequest{}),
		func() error { _, err := p.InspectSandbox(ctx, id); return err }(),
		func() error { _, err := p.Execute(ctx, id, sandbox.ExecRequest{}); return err }(),
		func() error { _, err := p.StopSandbox(ctx, id); return err }(),
	} {
		require.ErrorIs(t, err, sandbox.ErrNotFound)
	}
	_, ok := p.Machine(id)
	require.False(t, ok)
}

func TestAccessSurfacesAnswer(t *testing.T) {
	ctx := context.Background()
	p := New()
	service, err := p.CreateService(ctx, "vm", sandbox.ServiceSpec{Name: "svc"})
	require.NoError(t, err)
	require.Equal(t, sandbox.CreateServiceResult{Success: true, ServiceName: "svc"}, service)
	identity, err := p.CreateIdentity(ctx)
	require.NoError(t, err)
	grant, err := p.GrantAccess(ctx, identity.ID, "vm", sandbox.GrantAccessRequest{AllowedUsers: []string{"dev"}})
	require.NoError(t, err)
	require.Equal(t, []string{"dev"}, grant.AllowedUsers)
	token, err := p.CreateIdentityToken(ctx, identity.ID)
	require.NoError(t, err)
	require.Equal(t, identity.ID+"-token", token.ID)
	route, err := p.PublishIngress(ctx, "example.test", sandbox.PublishIngressRequest{SandboxID: "vm", Port: 80})
	require.NoError(t, err)
	require.Equal(t, int32(80), route.Port)
	require.NoError(t, p.RevokeIngress(ctx, route.ID))
}
