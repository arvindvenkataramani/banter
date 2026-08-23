---
name: Bug report
about: Something isn't working
title: ''
labels: ''
assignees: ''

---

**What happened**
What you did, what you expected, what happened instead.

**Where**
- Node: control plane / shard / both
- OS: [e.g. Debian 12, macOS 15]
- Install method: `scripts/install.sh` / `control-deploy.sh` / manual `control-runner.sh` / dev (`control-dev.sh`)
- Banter version or commit (`dev: <short hash>` in the dashboard footer, or `git rev-parse --short HEAD`)

**Logs**
Relevant output — `journalctl --user -u banter` on systemd, the terminal running `control-runner.sh` otherwise, or the browser console for a dashboard issue. Redact anything from `config.json` (gateway token, in particular).

**Registry/config, if relevant**
The specific `runner`/`network` block for the service involved, with secrets stripped — not the whole file.

**Additional context**
Anything else worth knowing.
