#!/usr/bin/env bash
set -euo pipefail

version=${1:?usage: publish-image.sh VERSION BUILD_SHA}
revision=${2:?usage: publish-image.sh VERSION BUILD_SHA}
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9]+([.-][a-zA-Z0-9]+)*)?$ ]]; then
  echo 'Invalid image release version' >&2
  exit 1
fi
if ! [[ "$revision" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ ]]; then
  echo 'BUILD_SHA must be an exact source revision' >&2
  exit 1
fi
repository=${GITHUB_REPOSITORY:-smithersai/smithers}
if [ "$repository" != smithersai/smithers ]; then
  echo 'The distribution image is published only from smithersai/smithers' >&2
  exit 1
fi
image=ghcr.io/smithersai/smithers
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
build_args=(--platform linux/amd64,linux/arm64
  --build-arg "BUILD_SHA=$revision"
  --build-arg "SMITHERS_DISTRIBUTION_VERSION=$version"
  -f distribution/Dockerfile --tag "$image:$version")
case "${3:-}" in
  --dry-run)
    docker buildx build "${build_args[@]}" --output "type=oci,dest=$work/image.tar" .
    echo 'IMAGE_REHEARSAL_OK platforms=linux/amd64,linux/arm64'
    exit 0
    ;;
  "") ;;
  *) echo 'Expected --dry-run or no third argument' >&2; exit 1 ;;
esac
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_ACTOR:?GITHUB_ACTOR is required}"
printf '%s' "$GH_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin
docker buildx build "${build_args[@]}" --push --metadata-file "$work/metadata.json" .
digest=$(node -e '
  const fs = require("node:fs");
  const digest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))["containerimage.digest"];
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid published image digest");
  process.stdout.write(digest);
' "$work/metadata.json")
docker logout ghcr.io
# An empty config also excludes credential helpers left on the release runner.
mkdir "$work/anonymous"
for platform in linux/amd64 linux/arm64; do
  DOCKER_CONFIG="$work/anonymous" docker pull --platform "$platform" "$image:$version"
  DOCKER_CONFIG="$work/anonymous" docker pull --platform "$platform" "$image@$digest"
done
if gh release view "v$version" --repo "$repository" --json body --jq .body > "$work/notes.md"; then
  release_exists=true
else
  gh release list --repo "$repository" --limit 1 >/dev/null
  release_exists=false
  : > "$work/notes.md"
fi
node --input-type=module - "$work/notes.md" "$image" "$version" "$digest" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const [path, image, version, digest] = process.argv.slice(2);
const start = "<!-- smithers-image:start -->";
const end = "<!-- smithers-image:end -->";
const previous = readFileSync(path, "utf8").replace(/<!-- smithers-image:start -->[\s\S]*?<!-- smithers-image:end -->\n?/g, "").trimEnd();
const receipt = `${start}\n## Self-host image\n\n\`${image}@${digest}\`\n\nTag: \`${image}:${version}\`. Platforms: \`linux/amd64\`, \`linux/arm64\`. Both anonymously pulled after publication.\n${end}\n`;
writeFileSync(path, `${previous}${previous ? "\n\n" : ""}${receipt}`);
NODE
if [ "$release_exists" = true ]; then
  gh release edit "v$version" --repo "$repository" --notes-file "$work/notes.md"
else
  case "$version" in
    *-*) gh release create "v$version" --repo "$repository" --verify-tag --prerelease --notes-file "$work/notes.md" ;;
    *) gh release create "v$version" --repo "$repository" --verify-tag --notes-file "$work/notes.md" ;;
  esac
fi
printf 'PUBLIC_IMAGE_OK image=%s:%s digest=%s\n' "$image" "$version" "$digest"
