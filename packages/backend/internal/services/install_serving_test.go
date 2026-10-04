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
		{"IPv6 alias", "", []string{"http://[2001:0DB8:0:0:0:0:0:1]", "https://[2001:db8::1]"}, "origins"},
		{"mapped IPv6 alias", "", []string{"http://[::ffff:127.0.0.1]", "https://[::ffff:7f00:1]"}, "origins"},
		{"short IPv4 alias", "", []string{"http://127.1", "https://127.0.0.1"}, "origins"},
		{"octal IPv4 alias", "", []string{"http://0177.0.0.1", "https://127.0.0.1"}, "origins"},
		{"hex IPv4 alias", "", []string{"http://0x7f000001", "https://127.0.0.1"}, "origins"},
		{"trailing-dot IPv4 alias", "", []string{"http://127.0.0.1.", "https://127.0.0.1"}, "origins"},
		{"invalid octal", "", []string{"http://08"}, "origins"},
		{"numeric DNS suffix", "", []string{"http://box.1"}, "origins"},
		{"long IPv4", "", []string{"http://1.2.3.4.5"}, "origins"},
		{"large IPv4 part", "", []string{"http://256.0.0.1"}, "origins"},
		{"large IPv4 tail", "", []string{"http://1.2.65536"}, "origins"},
		{"large hex IPv4", "", []string{"http://0x100000000"}, "origins"},
		{"empty IPv4 part", "", []string{"http://1..1"}, "origins"},
		{"localhost scheme collision", "", []string{"https://localhost:4000"}, "origins"},
		{"IPv4 loopback scheme collision", "", []string{"https://127.1:4000"}, "origins"},
		{"IPv6 loopback scheme collision", "", []string{"https://[0:0:0:0:0:0:0:1]:4000"}, "origins"},
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

func TestInstallAddressIPv4BrowserHostsAndLoopback(t *testing.T) {
	// §16.3.3 keys origins by the Host browsers send; §1.4 keeps HTTP loopback.
	for _, tc := range []struct{ raw, want string }{
		{"http://127.1:4000", "http://127.0.0.1:4000"},
		{"http://0177.0.0.1:4000", "http://127.0.0.1:4000"},
		{"http://0x7f000001:4000", "http://127.0.0.1:4000"},
		{"http://127.0.0.1.:4000", "http://127.0.0.1:4000"},
		{"http://1.2.65535", "http://1.2.255.255"},
		{"http://1.16777215", "http://1.255.255.255"},
		{"http://4294967295", "http://255.255.255.255"},
		{"http://0x", "http://0.0.0.0"},
		{"http://0x100000000z", "http://0x100000000z"},
	} {
		a, err := NewInstallAddress("", []string{tc.raw})
		require.NoError(t, err)
		require.Equal(t, []string{tc.want}, a.Origins)
	}
	for _, raw := range []string{"http://localhost:4000", "http://[::1]:4000"} {
		a, err := NewInstallAddress("", []string{raw})
		require.NoError(t, err)
		require.Equal(t, []string{raw}, a.Origins)
	}
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
	a, err := NewInstallAddress("", []string{"http://bücher.example:00080", "HTTP://LAN-A:04000", "http://[2001:0DB8:0:0:0:0:0:1]", "https://[::ffff:127.0.0.1]"})
	require.NoError(t, err)
	require.Equal(t, []string{"http://xn--bcher-kva.example", "http://lan-a:4000", "http://[2001:db8::1]", "https://[::ffff:7f00:1]"}, a.Origins)
}
