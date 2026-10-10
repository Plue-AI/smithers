---
"@smthrs/targets": minor
---

`CiToolchain.Docker` accepts `registryMirrors`, a list of `https://` Docker Hub
pull-through mirrors. The generated "Enable the containerd image store" step
merges them into `/etc/docker/daemon.json` with the containerd snapshotter and
restarts the daemon only when the configuration changed. Without mirrors the
step is unchanged.
