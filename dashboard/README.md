# Dashboard

React SPA served directly by the control plane. Two pages: chat at the root
route, and services.

## Dev

```bash
# From the repo root — Vite on :5173 with HMR, control plane on :4201
bun run control-dev
```

Vite proxies `/api/*` to the control plane. `VITE_PROXY_TARGET` points it
somewhere else; `BANTER_DEV_CONTROL_PORT` and `VITE_PORT` override the ports.

Reaching the dev server from another device (e.g. over Tailscale) needs an
extra step — see [Hardening](../README.md#hardening) in the top-level README.

## Prod

`bun run build` writes `dist/`, which the deploy copies into `$BANTER_PROD` for
the control plane to serve statically.

## Structure

```
src/      React SPA source
dist/     Built output (gitignored)
```

Styling is Tailwind utilities and shadcn/ui components — no hand-written CSS
beyond `index.css`, which holds framework imports and the theme variable blocks.
