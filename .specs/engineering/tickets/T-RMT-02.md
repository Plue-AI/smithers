# T-RMT-02 `remoteSandboxes` flag and registered remote hosts in Settings

Stage S1 · Size M · Depends on T-RMT-01, T-INS-06 · Unblocks T-RMT-03 · Issue: [#3706](https://github.com/smithersai/smithers/issues/3706)
Spec: spec.md §8.13.2, §8.13.3, §5.2, §14.3 (Settings) · Product: #3706 Product position (M-40 pending in mvp.md)

Added 2026-10-04 by smithers-8a for Will's sandbox-placement ruling (#3706). Behind `remoteSandboxes`, off by default.


**ON HOLD (2026-10-04, Will via smithers-56, #3706):** remote machines reuse the Plue Cloud controller and `microsandbox-worker`; this ticket's SSH mechanism is superseded until spec §8.13 is reconciled (§8.13.0). Do not start.

## Goal
The owner registers a Linux KVM host by SSH in Settings behind the off-by-default `remoteSandboxes` flag; the install pins its host key, probes its profile and refuses a host without KVM.

## Scope
In: the Go flag `feature_flags.remote_sandboxes` and its app mirror; the `machines` key in `install_settings`; the install SSH key pair; host-key pinning; the probe; the Settings rows and their Container; owner-only writes through `PUT /api/install`.
Out: starting VMs on the host (T-RMT-03); capacity and placement (T-RMT-04); Cloud boxes (T-RMT-05).

## Changes
- Reshape `packages/backend/internal/config/config.go` `FeatureFlagsConfig`: add `remote_sandboxes` (default false, env `SMITHERS_REMOTE_SANDBOXES`) beside, and distinct from, `remote_sandbox_enabled`. Gate the route field with the existing `middleware.FeatureFlagGate`.
- Reshape `install_settings` (migration 0104) usage: key `machines`, value `[{name, ssh, host_key, state_dir}]`; the private key sealed under `machines_ssh_key`. No new table.
- Reshape the strict `PUT /api/install` decoder (`routes/github_app_setup.go` `SetCapacity`) to accept `machines` beside `capacity`, owner only.
- App: `AppFeatures.remoteSandboxes`; Settings Machines rows (name, address, fingerprint, profile, limits, state) in the existing Settings View; design (smithers-06) supplies the rows.

## Decisions and pre-review
- Design: `.specs/design/placement.md` (4786488c8c) supplies the Computers list, Add computer and the row states.
- smithers-3f approves key storage, host-key pinning and the trust statement before this lands. smithers-06 supplies the Settings rows. smithers-8a accepts the flag name.

## Tests

C-RMT-02:
1. Config test: both flag keys exist and are distinct; `remote_sandboxes` defaults false.
2. With the flag off, the owner PUTs a new host; the app hides the Computers list and the Runs on control. Then, with one host already holding a machine, turn the flag off.
3. With the flag on, the maintainer and the member each PUT `machines`.
4. The owner registers a fake SSH host (in-process server with KVM present), confirms the fingerprint, then the server presents another host key.
5. Register a fake host without `/dev/kvm`.
6. Read back `GET /api/install`; grep the response and logs for the private key.

Pass when:
- Step 1 passes. Step 2 refuses the new host with class `disabled` and renders no list, except the holding host's row reading "beaver · 1 branch · remove to finish", whose machine keeps running. Step 3 is refused with class `permission`.
- Step 4 stores the host and then refuses connections with class `security` until re-confirmed. Step 5 is refused naming "needs /dev/kvm".
- Step 6 shows the public key only.

## Acceptance
- [C-RMT-02](../checks/C-RMT-02.md)

## Risks and notes
- The flag name sits close to `remote_sandbox_enabled`; the config test is the guard.
- `beaver` has VT-x disabled in firmware (smithers-56, #3706, 13:20 PT): `/dev/kvm` is absent until someone enables Intel Virtualization Technology at the keyboard. CI uses a Linux KVM VM.
