# Deployment tool compatibility with Effect rc.115

These exact-version patches adapt the repository's private deployment tools to
Effect `4.0.0-rc.115`. Alchemy and its Cloudflare runtime `2.0.0-beta.76`,
alongside their Distilled `1.0.0-rc.8`
dependencies still call the removed lowercase Config constructors. Alchemy also
uses the former Config effect mapper and lowercase CLI constructors.

The patches update those calls to the corresponding rc.115 APIs in both source
and emitted JavaScript. They do not change Effect, resource declarations,
credentials, provider endpoints or deployment behavior. The public `@smthrs/*`
tarballs do not depend on these deployment packages and do not require these
patches in consumer applications.

`package.json#patchedDependencies` is used by Bun;
`pnpm-workspace.yaml#patchedDependencies` is used by pnpm. Keep their exact
package versions and patch paths identical, and regenerate both lockfiles when
a patch changes. Frozen installation must apply the checked-in patch bytes.

Validate with the offline stack tests in
`apps/site/scripts/deployment.test.mjs`, the documentation checks, and both
package managers' frozen installs. These checks import and inspect stacks; they
do not deploy infrastructure. Remove each patch when upgrading to an upstream
version that uses the supported Effect APIs, and repeat these checks before
deploying with that version.

# dprint static Linux binary

`dprint@0.57.1.patch` makes the npm `dprint` wrapper run the static musl build
on every Linux host with a musl build, instead of the glibc build. The glibc
build names `/lib64/ld-linux-*.so` as its ELF interpreter, so a NixOS Cloud
guest without a working loader link answered every `dprint check` with
`spawnSync … ENOENT`; the static build needs no interpreter. When the musl
optional package is not installed, the unmodified wrapper downloads it from
the registry through `HTTPS_PROXY` and verifies it against the digest in the
package's `hashes.json`; it fails closed without the network. The patch also
exports `getTarget` so `packages/smithers/build/targets/test/DprintLinuxBinary.test.ts`
can pin the selection. Remove it when upstream dprint prefers an
interpreter-free Linux binary.
