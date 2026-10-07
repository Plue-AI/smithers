package main

import (
	"github.com/pkg/sftp"
	"github.com/stretchr/testify/require"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestSFTPStdioWritesReadsRenamesAndRemoves(t *testing.T) {
	server, client := net.Pipe()
	defer client.Close()
	done := make(chan error, 1)
	go func() { done <- serve(server, os.Geteuid()) }()
	remote, err := sftp.NewClientPipe(client, client)
	require.NoError(t, err)
	root := t.TempDir()
	name := filepath.Join(root, "member.txt")
	file, err := remote.Create(name)
	require.NoError(t, err)
	_, err = file.Write([]byte("member bytes\n"))
	require.NoError(t, err)
	require.NoError(t, file.Close())
	stored, err := os.ReadFile(name)
	require.NoError(t, err)
	require.Equal(t, "member bytes\n", string(stored))
	file, err = remote.Open(name)
	require.NoError(t, err)
	got, err := io.ReadAll(file)
	require.NoError(t, err)
	require.Equal(t, stored, got)
	require.NoError(t, file.Close())
	entries, err := remote.ReadDir(root)
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.Equal(t, "member.txt", entries[0].Name())
	moved := filepath.Join(root, "moved.txt")
	require.NoError(t, remote.Rename(name, moved))
	require.NoError(t, remote.Remove(moved))
	_, err = remote.Stat(moved)
	require.True(t, os.IsNotExist(err))
	require.NoError(t, remote.Close())
	require.NoError(t, <-done)
}
func TestSFTPRefusesRootBeforeReadingInput(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	require.Error(t, serve(server, 0))
	require.Error(t, serve(server, -1))
}
