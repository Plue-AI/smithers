package microsandbox

import (
	"errors"
	"fmt"
	"math"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestHostSizingSpecColumnsAndEdges(t *testing.T) {
	// Oracles transcribed from spec §8.2.1 and check C-MCH-04, not product constants.
	for _, r := range []struct {
		mem, cores, disk, memory, cpus, cap, budget int
		term                                        string
	}{
		{24, 8, 200, 8, 4, 2, 48, "memory"}, {32, 10, 400, 8, 4, 3, 48, "memory"}, {64, 12, 1024, 8, 4, 6, 48, "cores"},
		{16, 8, 200, 6, 4, 1, 48, "memory"}, {23, 8, 200, 6, 4, 2, 48, "memory"}, {64, 12, 136, 8, 4, 3, 34, "disk"},
		{128, 4, 2000, 8, 2, 2, 48, "cores"}, {32, 10, 60, 8, 4, 0, 15, "disk"}, {32, 10, 100, 8, 4, 1, 25, "disk"},
		{13, 8, 200, 6, 4, 0, 48, "memory"}, {16, 1, 200, 6, 2, 0, 48, "cores"},
	} {
		t.Run(fmt.Sprintf("%d/%d/%d", r.mem, r.cores, r.disk), func(t *testing.T) {
			s := ComputeSizing(HostProfile{MemoryBytes: int64(r.mem) << 30, PerfCores: r.cores, DiskFreeBytes: int64(r.disk) << 30})
			require.Equal(t, r.memory*1024, s.MemoryMiB)
			require.Equal(t, r.cpus, s.CPUs)
			require.Equal(t, r.cap, s.Capacity)
			require.Equal(t, int64(r.budget)<<30, s.LayerBudgetBytes)
			require.Equal(t, r.term, s.LimitingTerm)
		})
	}
}

func TestHostSizingIndependentFormulaSweep(t *testing.T) {
	// spec §8.2.1: floor, GiB, reserve 8; negative physical resources grant zero.
	for memory := 8.0; memory <= 192; memory += .5 {
		for cores := 2; cores <= 16; cores++ {
			for _, disk := range []float64{0, 39.9, 40, 71.9, 72, 100, 136, 191.9, 192, 192.1, 400, 1024, 2000} {
				mem := 8.0
				if memory < 24 {
					mem = 6
				}
				m := max(0, int(math.Floor((memory-8)/mem)))
				c := cores / 2
				d := max(0, int(math.Floor((disk-40)/32)))
				p := HostProfile{MemoryBytes: int64(memory * (1 << 30)), PerfCores: cores, DiskFreeBytes: int64(disk * (1 << 30))}
				s := ComputeSizing(p)
				require.Equal(t, int(mem*1024), s.MemoryMiB)
				require.Equal(t, min(4, max(2, c)), s.CPUs)
				require.Equal(t, min(m, c, d), s.Capacity)
				require.Equal(t, m, s.MemoryCapacity)
				require.Equal(t, c, s.CoreCapacity)
				require.Equal(t, d, s.DiskCapacity)
				require.Equal(t, min(int64(48<<30), p.DiskFreeBytes/4), s.LayerBudgetBytes)
				require.Equal(t, s.Capacity == 0, m == 0 || c == 0 || d == 0)
				// §8.2.1a requires a limiting resource; ties may name either minimum.
				terms := map[string]int{"memory": m, "cores": c, "disk": d}
				require.Contains(t, terms, s.LimitingTerm)
				require.Equal(t, min(m, c, d), terms[s.LimitingTerm])
				if min(m, c, d) == 0 {
					require.Positive(t, s.Missing)
					require.NotEmpty(t, s.Fix)
				} else {
					require.Zero(t, s.Missing)
					require.Empty(t, s.Fix)
				}
			}
		}
	}
}

func TestCapacityClamp(t *testing.T) {
	// C-MCH-04 step 2: lower values stay; restore reduces an oversized saved value.
	for _, value := range []int{1, 2, 3, 4} {
		got, err := Clamp(value, 3)
		require.NoError(t, err)
		require.Equal(t, min(value, 3), got)
	}
	for _, value := range []int{0, -1} {
		_, err := Clamp(value, 3)
		var typed *CapacityError
		require.ErrorAs(t, err, &typed)
		require.Equal(t, "user", typed.Class)
	}
	got, err := Clamp(3, 0)
	require.NoError(t, err)
	require.Zero(t, got)
	_, err = Clamp(1, -1)
	require.Error(t, err)
}

func TestCapacityZeroFreshRefusesExistingStarts(t *testing.T) {
	// spec §8.2.1a: amounts missing are measured, not rounded down.
	for _, r := range []struct {
		p         HostProfile
		term, fix string
		missing   int64
	}{
		{HostProfile{MemoryBytes: 139 << 30 / 10, PerfCores: 8, DiskFreeBytes: 200 << 30}, "memory", "needs 14 GiB of memory", (14 << 30) - (139 << 30 / 10)},
		{HostProfile{MemoryBytes: 16 << 30, PerfCores: 1, DiskFreeBytes: 200 << 30}, "cores", "needs 2 performance cores", 1},
		{HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, DiskFreeBytes: 719 << 30 / 10}, "disk", "free 1 GiB on the state volume", (72 << 30) - (719 << 30 / 10)},
	} {
		s := ComputeSizing(r.p)
		require.Zero(t, s.Capacity)
		require.Equal(t, r.term, s.LimitingTerm)
		require.Equal(t, r.fix, s.Fix)
		require.Equal(t, r.missing, s.Missing)
		err := s.ValidateStart(false)
		var typed *CapacityError
		require.ErrorAs(t, err, &typed)
		require.Equal(t, "capacity", typed.Class)
		require.Equal(t, r.missing, typed.Missing)
		if r.term == "memory" {
			require.Contains(t, err.Error(), "0.10 GiB missing")
		}
		if r.term == "cores" {
			require.Contains(t, err.Error(), "1 performance cores missing")
		}
		require.Contains(t, err.Error(), r.fix)
		require.NoError(t, s.ValidateStart(true))
	}
	require.NoError(t, ComputeSizing(HostProfile{MemoryBytes: 24 << 30, PerfCores: 8, DiskFreeBytes: 200 << 30}).ValidateStart(false))
}

func TestHostDetectionUsesOnlyRequiredFieldsAndStateVolume(t *testing.T) {
	values := map[string]string{"hw.memsize": "34359738368", "hw.perflevel0.physicalcpu": "10", "hw.physicalcpu": "14", "macos": "15.6", "kern.hv_support": "1"}
	seen := []string{}
	probe := func(key string) (string, error) { seen = append(seen, key); return values[key], nil }
	disk := func(path string) (int64, error) { require.Equal(t, "/state", path); return 400 << 30, nil }
	p, err := detectProfile("/state", "darwin", probe, disk)
	require.NoError(t, err)
	require.Equal(t, HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, PhysicalCores: 14, DiskFreeBytes: 400 << 30, MacOSVersion: "15.6", Hypervisor: true}, p)
	require.Equal(t, []string{"hw.memsize", "hw.perflevel0.physicalcpu", "hw.physicalcpu", "macos", "kern.hv_support"}, seen)
	values["kern.hv_support"] = "0"
	p, err = detectProfile("/state", "darwin", probe, disk)
	require.NoError(t, err)
	require.False(t, p.Hypervisor)
	for _, key := range seen {
		for _, bad := range []string{"", "invalid", "-1", "0"} {
			if key == "macos" && bad != "" || key == "kern.hv_support" && bad == "0" {
				continue
			}
			original := values[key]
			values[key] = bad
			_, err = detectProfile("/state", "darwin", probe, disk)
			require.Error(t, err)
			values[key] = original
		}
		cause := errors.New("probe failed")
		_, err = detectProfile("/state", "darwin", func(k string) (string, error) {
			if k == key {
				return "", cause
			}
			return values[k], nil
		}, disk)
		var typed *HostProfileError
		require.ErrorAs(t, err, &typed)
		require.Equal(t, key, typed.Field)
		require.ErrorIs(t, err, cause)
		require.Equal(t, "infra", typed.FlowRuntimeClass())
		require.Equal(t, "host_profile_unavailable", typed.FlowRuntimeCode())
		require.False(t, typed.FlowRuntimeRetryable())
	}
	_, err = detectProfile("/state", "linux", probe, disk)
	require.Error(t, err)
	_, err = detectProfile("/state", "darwin", probe, func(string) (int64, error) { return 0, errors.New("statfs failed") })
	require.Error(t, err)
	_, err = detectProfile("/state", "darwin", probe, func(string) (int64, error) { return -1, nil })
	require.Error(t, err)
}
