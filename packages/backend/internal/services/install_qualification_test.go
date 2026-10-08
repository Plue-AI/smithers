package services

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestInstalledQualificationDataFile(t *testing.T) {
	service := NewInstalledQualification("http://mini.lan:8080")
	require.Empty(t, service.Authorities, "No reference machine or review key has been approved")
	root := t.TempDir()
	file := filepath.Join(root, "qualification.json")
	t.Setenv("SMITHERS_MACHINE_QUALIFICATION_FILE", file)
	_, err := service.Read(t.Context())
	require.Error(t, err)
	require.NoError(t, os.WriteFile(file, []byte(`{"operator_flag":true}`), 0600))
	data, err := service.Read(t.Context())
	require.NoError(t, err)
	require.JSONEq(t, `{"operator_flag":true}`, string(data))
	require.Contains(t, service.Snapshot(t.Context()), "missing", "Operator data cannot add an authority")
	link := filepath.Join(root, "link")
	require.NoError(t, os.Symlink(file, link))
	t.Setenv("SMITHERS_MACHINE_QUALIFICATION_FILE", link)
	_, err = service.Read(t.Context())
	require.Error(t, err)
	t.Setenv("SMITHERS_MACHINE_QUALIFICATION_FILE", root)
	_, err = service.Read(t.Context())
	require.Error(t, err)
	t.Setenv("SMITHERS_MACHINE_QUALIFICATION_FILE", file)
	require.NoError(t, os.WriteFile(file, make([]byte, (1<<20)+2), 0600))
	data, err = service.Read(t.Context())
	require.NoError(t, err)
	require.Len(t, data, (1<<20)+1, "Bound reads; Snapshot refuses oversize data")
	t.Setenv("SMITHERS_MACHINE_QUALIFICATION_FILE", "")
	t.Setenv("SMITHERS_DATA_ROOT", root)
	require.NoError(t, os.WriteFile(filepath.Join(root, "machine-qualification.json"), []byte(`{"from":"install state"}`), 0600))
	data, err = service.Read(t.Context())
	require.NoError(t, err)
	require.JSONEq(t, `{"from":"install state"}`, string(data))
	t.Setenv("SMITHERS_DATA_ROOT", "")
	_, err = service.Read(t.Context())
	require.Error(t, err, "Never discover a receipt in the process working directory")

	if runtime.GOOS != "darwin" {
		_, err = service.Identity(t.Context())
		require.Error(t, err, "Linux cannot claim an installed reference Mac")
	}
}
