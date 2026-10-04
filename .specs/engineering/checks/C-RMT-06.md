# C-RMT-06 Journey: a coordinator install wakes a TODO's machine on a remote host from the app

Product falsifier (98, #3706): if the coordinator box cannot wake a branch on `beaver` over SSH from the app by the end of stage 1, this did not ship.

Owner: T-RMT-04. Layer: e2e on the reference rig (Will's Mac mini as the install, `beaver` as the remote host).

1. Turn `remoteSandboxes` on. In Settings, register `beaver`, confirm its fingerprint and see its profile and capacity.
2. From the app, make a TODO with placement `beaver`. Let it run to a candidate.
3. Open its terminal from the TODO card and run `uname -m && hostname`.
4. Turn the flag off.

Precondition: Intel Virtualization Technology enabled in `beaver`'s firmware (off as of 2026-10-04, #3706).

Pass when step 1 shows `beaver` reachable with capacity at least 1; step 2's TODO card says "on beaver" and the run reaches a candidate; step 3 prints the guest's architecture and hostname from inside the microVM on `beaver`; step 4 hides Add computer and Runs on, and `beaver`'s row reads "beaver · 1 branch · remove to finish" while the machine keeps running. Receipt: `.artifacts/checks/C-RMT-06/<UTC>/`.
