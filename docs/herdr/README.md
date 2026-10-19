# Fresh, herdr edition

This is a fork of [Fresh](https://github.com/sinelaw/fresh) for the wr/herdr team environment
(`Etunder/herdr-wr`). It is meant to diverge, not to be merged back. Fresh runs inside a herdr pane
in WezTerm on Windows, so the fork:

- **looks like herdr**: the built-in `herdr` theme is the default (herdr's Tokyo Night palette), and
  the chrome is restyled after herdr's (see [style.md](style.md));
- **will open Jupyter notebooks natively**, with kitty images, using the `nb` kernel library from
  herdr-wr (plan: `herdr-wr/docs/notebook-plan.md`);
- **drops what herdr already does**: no Orchestrator (workspaces, agent sessions, the dock);
  herdr manages the panes and the agents;
- **never updates itself from upstream**: self-update is not built in and the update check is
  off, so it can't replace itself with upstream Fresh or report to upstream's telemetry;
- **ships one Windows binary**: `herdr build` CI makes `fresh.exe`, attached to `v*` releases, and
  herdr-wr's `install.ps1` downloads it.

Upstream's release, packaging and publishing workflows are removed. To take upstream changes, merge
`sinelaw/fresh` `master` into this fork's `master`; the fork's own changes stay in their own
commits so conflicts are easy to read.
