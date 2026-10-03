package services

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
	"testing"
)

// Literal Address contract from T-INS-04 / spec §14.3 and §16.3.3.
func TestInstallAddressValidation(t *testing.T) {
	for _, tc := range []struct {
		name, bind string
		origins    []string
		field      string
	}{
		{"relative", "", []string{"box"}, "origins"},
		{"path", "", []string{"http://box/path"}, "origins"},
		{"ftp", "", []string{"ftp://box"}, "origins"},
		{"bind", "invalid", nil, "bind"},
		{"ambiguous", "", []string{"http://box", "https://box"}, "origins"},
		{"credentials", "", []string{"http://u:p@box"}, "origins"},
		{"query", "", []string{"https://box?x=1"}, "origins"},
		{"fragment", "", []string{"https://box#x"}, "origins"},
		{"default port", "", []string{"http://box:80", "https://box"}, "origins"},
		{"IDN alias", "", []string{"http://bücher.example", "https://xn--bcher-kva.example"}, "origins"},
		{"leading-zero default port", "", []string{"http://box:00080", "https://box"}, "origins"},
		{"invalid IPv6", "", []string{"http://[invalid]"}, "origins"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewInstallAddress(tc.bind, tc.origins)
			require.ErrorContains(t, err, tc.field)
		})
	}
	a, err := NewInstallAddress("0.0.0.0", []string{"http://lan-a:4000", "https://box.example"})
	require.NoError(t, err)
	require.Equal(t, InstallAddress{Listen: "network", Bind: "0.0.0.0", Origins: []string{"http://lan-a:4000", "https://box.example"}}, a)
	require.Equal(t, "ssh -p 2222 T12@lan-a", a.SSHLine("T12"))
	local, err := NewInstallAddress("", nil)
	require.NoError(t, err)
	require.Equal(t, "mac", local.Listen)
	require.NotNil(t, local.Origins)
	require.Equal(t, "ssh -p 2222 T12@localhost", local.SSHLine("T12"))
}
func TestInstallServingUnavailableProvidersBeforeEffects(t *testing.T) {
	// Nil providers deliberately model the parallel ticket contracts. No mock DB
	// hides effects: any attempted database access with this nil pool panics.
	for _, tc := range []struct {
		name    string
		service *InstallServing
	}{
		{"launcher", &InstallServing{}},
		{"publication", &InstallServing{Isolation: func(context.Context) error { return nil }}},
		{"listener", &InstallServing{Isolation: func(context.Context) error { return nil }, Publication: unusedInstallPublication{}}},
		{"isolation refused", &InstallServing{Isolation: func(context.Context) error { return errors.New("microVM refused") }}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.Error(t, tc.service.Set(context.Background(), InstallAddress{Listen: "network", Bind: "0.0.0.0", Origins: []string{"http://lan-a:4000"}}))
		})
	}
}

// Fault-boundary unit fixture: this provider must never be called when another
// required provider is missing. Successful publication is not simulated here.
type unusedInstallPublication struct{}

func (unusedInstallPublication) PublishInstall(context.Context, pgx.Tx, InstallAddress) error {
	panic("publication must not run")
}

func TestInstallAddressUsesBrowserHostSerialization(t *testing.T) {
	// §16.3.3 uniqueness is over the Host a browser sends, including IDNA and
	// normalized numeric/default ports, not the owner's original spelling.
	a, err := NewInstallAddress("", []string{"http://bücher.example:00080", "HTTP://LAN-A:04000"})
	require.NoError(t, err)
	require.Equal(t, []string{"http://xn--bcher-kva.example", "http://lan-a:4000"}, a.Origins)
}
