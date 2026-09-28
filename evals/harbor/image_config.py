"""An OCI image's run configuration, read from its registry.

`docker exec` runs in the image's WORKDIR; a plue workspace exec runs in the
CLI's default directory unless told otherwise, and plue does not report the
image's config. This reads it from the registry (anonymous pull token, the
linux/amd64 manifest of an index) and caches it by image reference in
PLUE_IMAGE_CONFIG_CACHE (default ~/.cache/plue-image-config.json). A digest-
pinned reference never changes, so the cache never expires.

    working_dir("harborframework/terminal-bench:x@sha256:…") -> "/app" | None
"""

from __future__ import annotations

import fcntl
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

_ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json",
])
_TIMEOUT_SEC = 30


class _HttpsRedirects(urllib.request.HTTPRedirectHandler):
    """Follows a registry's redirects (blob CDNs) to https URLs only."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != "https":
            raise urllib.error.HTTPError(newurl, code, f"refused non-https redirect: {newurl}", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_HttpsRedirects)


def parse(image: str) -> tuple[str, str, str]:
    """(registry host, repository, digest or tag) of a Docker-style reference."""
    name, _, digest = image.partition("@")
    tag = None
    if ":" in name.rsplit("/", 1)[-1]:
        name, tag = name.rsplit(":", 1)
    first = name.split("/", 1)[0]
    if "/" in name and ("." in first or ":" in first or first == "localhost"):
        registry, repo = name.split("/", 1)
    else:
        registry, repo = "registry-1.docker.io", name if "/" in name else f"library/{name}"
    return registry, repo, digest or tag or "latest"


def _get(url: str, token: str | None, accept: str):
    headers = {"Accept": accept}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return _OPENER.open(urllib.request.Request(url, headers=headers), timeout=_TIMEOUT_SEC)


def _fetch(registry: str, repo: str, path: str, token: str | None, accept: str = _ACCEPT):
    url = f"https://{registry}/v2/{repo}/{path}"
    try:
        return json.load(_get(url, token, accept)), token
    except urllib.error.HTTPError as error:
        if error.code != 401 or token:
            raise
        challenge = dict(re.findall(r'(\w+)="([^"]*)"', error.headers.get("WWW-Authenticate", "")))
        realm = challenge.get("realm", "")
        if urllib.parse.urlsplit(realm).scheme != "https":
            # The registry is named by the task's FROM line, so its challenge
            # is untrusted: never let it point this host at file:// or http://.
            raise ValueError(f"registry {registry} names a non-https token realm: {realm!r}")
        query = f"{realm}?service={challenge.get('service', '')}&scope=repository:{repo}:pull"
        reply = json.load(_OPENER.open(query, timeout=_TIMEOUT_SEC))
        token = reply.get("token") or reply.get("access_token")
        return json.load(_get(url, token, accept)), token


def fetch_config(image: str) -> dict[str, Any]:
    """The image config blob (`{"config": {"WorkingDir", "User", "Env", …}}`)."""
    registry, repo, reference = parse(image)
    manifest, token = _fetch(registry, repo, f"manifests/{reference}", None)
    if "manifests" in manifest:
        chosen = next((m for m in manifest["manifests"]
                       if (m.get("platform") or {}).get("os") == "linux"
                       and (m.get("platform") or {}).get("architecture") == "amd64"), manifest["manifests"][0])
        manifest, token = _fetch(registry, repo, f"manifests/{chosen['digest']}", token)
    config, _ = _fetch(registry, repo, f"blobs/{manifest['config']['digest']}", token, accept="*/*")
    return config


def _cache_path() -> Path:
    return Path(os.environ.get("PLUE_IMAGE_CONFIG_CACHE") or Path.home() / ".cache" / "plue-image-config.json")


def run_config(image: str, *, cache: Path | None = None,
               fetch: Callable[[str], dict[str, Any]] = fetch_config) -> dict[str, Any] | None:
    """`config` of the image (WorkingDir, User, …), or None when unreadable."""
    path = cache or _cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_suffix(path.suffix + ".lock"), "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            known = json.loads(path.read_text())
        except (OSError, ValueError):
            known = {}
        if image in known:
            return known[image]
        try:
            config = (fetch(image) or {}).get("config") or {}
        except Exception:  # noqa: BLE001 - a registry fault is "unknown", never a trial failure
            return None
        known[image] = {"WorkingDir": config.get("WorkingDir") or "", "User": config.get("User") or ""}
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(known, indent=1, sort_keys=True))
        tmp.replace(path)
        return known[image]


def working_dir(image: str, **kwargs) -> str | None:
    config = run_config(image, **kwargs)
    return (config or {}).get("WorkingDir") or None
