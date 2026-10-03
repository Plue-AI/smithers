"""C-SPK-06 dark preflight; never boots unapproved root inputs.

T-INS-01 has not landed. Its manifest schema and main-built artifact receipts
are unavailable. Do not infer provenance from a caller-supplied hash manifest.
This entry point deliberately has no VM, signing, brew or launchctl invocation.
"""
import argparse
import json
import os
import pathlib
import sys

# T-INS-03 Security preconditions: these are refusal cases, not configurable
# guest inputs. Version/command/environment oracles are literal ticket fixtures.
FORBIDDEN_ENV = (
    'SMITHERS_MICROSANDBOX_BIN', 'SMITHERS_MICROSANDBOX_IMAGE',
    'SMITHERS_WORKSPACE_ROOT', 'SMITHERS_WORKSPACE_ISOLATION',
    'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH', 'BASH_ENV', 'ENV',
)
REQUIRED = (
    'bin/msb', 'bin/smithers-backend', 'lib/libkrunfw.5.dylib',
    'share/microsandbox/base-image.oci.tar',
    'share/microsandbox/base-image.json', 'manifest.json',
)


def main():
    parser = argparse.ArgumentParser(description='C-SPK-06 unprivileged dark preflight')
    parser.add_argument('--bundle', type=pathlib.Path, required=True)
    args, extra = parser.parse_known_args()
    reason = None
    if extra:
        reason = 'caller-selected artifact/image/mount/command/environment is forbidden'
    elif os.geteuid() == 0:
        reason = 'run as the installing GUI user, without sudo'
    elif any(name in os.environ for name in FORBIDDEN_ENV):
        reason = 'inherited guest/runtime environment is forbidden'
    else:
        bundle = args.bundle.absolute()
        # Resolve no executables and read no unapproved manifest as authority.
        # T-INS-01 layout contract only; checking presence does not approve bytes.
        missing = [name for name in REQUIRED if not (bundle / name).is_file()]
        linked = bundle.is_symlink() or any(
            part.is_symlink() for name in REQUIRED
            for part in [bundle / name, *(bundle / name).parents]
        )
        if linked:
            reason = 'symlinked bundle inputs are forbidden'
        elif missing:
            reason = 'missing T-INS-01 bundle files: ' + ', '.join(missing)
        else:
            reason = ('T-INS-01 main-built artifact provenance and approved digests '
                      'are unavailable; branch manifests cannot authorize root code')
    # This is diagnostic output, never a passing machine-written receipt.
    # scripts/check-run.mjs remains the sole receipt runner.
    print(json.dumps({'check': 'C-SPK-06', 'result': 'REFUSED',
                      'reason': reason, 'vm_commands': 0,
                      'expected_version': '0.6.16', 'guest_command': ['echo', 'ok'],
                      'guest_environment': {}, 'guest_stdin': '', 'mounts': []}))
    return 2


if __name__ == '__main__':
    sys.exit(main())
