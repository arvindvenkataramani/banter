# Security Policy

Banter is published as-is and not actively maintained (see [Status and license](README.md#status-and-license)). There's no SLA on security fixes, but reports are still welcome and will get a look.

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/arvindvenkataramani/banter/security/advisories/new) for anything that shouldn't be public before a fix exists (e.g. an auth bypass, a way to reach a service that shouldn't be reachable). For anything else — a hardening gap, a misconfiguration risk — a regular issue is fine.

There's no bug bounty and no guaranteed response time. If it's serious and unfixed after a reasonable wait, disclosing it publicly is reasonable.

## Before reporting

Check [Hardening](README.md#hardening) in the README first — some things that look like vulnerabilities (an unauthenticated gateway, permissive CORS) are known footguns in the default config, already documented there, not undisclosed issues.

## Scope

This repo (`control/`, `dashboard/`, `plugins/`, `services/`). Vulnerabilities in upstream dependencies (OpenClaw, the STT/TTS models and their servers, onnxruntime-web, etc.) belong in their own repos.
