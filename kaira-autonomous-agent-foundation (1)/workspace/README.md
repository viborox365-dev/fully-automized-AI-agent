# Kaira's workspace

This directory is Kaira's sandbox — the only place her filesystem and shell
tools may operate. Everything she creates, downloads, or builds while working
on objectives lives here.

- Override the location with the `KAIRA_WORKSPACE` env variable.
- Nothing outside this directory can be touched by her tools
  (path escapes are rejected by `resolveInWorkspace`).
- Safe to inspect, version-control, or wipe independently of the app state.
