# Remote access with Tailscale

Optional. On your own network, a LAN address is enough and nothing here applies. This covers reaching the dashboard — or a service — from outside your network, assuming you already have Tailscale installed and the machine joined to your tailnet.

Tailscale is the one remote-access method Banter has built-in support for, via `tailscale serve`. Anything else — a reverse proxy, a VPN, your own cert — works too, but is entirely on you; Banter has no code path for it.

---

## How it works

A registry entry with `network.tailscaleServe: true` gets a `tailscale serve` binding registered on start and torn down on stop, mapping `https://<machine>.<tailnet>.ts.net:<port>` to `localhost:<port>` — the HTTPS port and the service's own port are the same number, since that's what `tailscale serve --https=<port>` binds. No port needs opening on your router; the address is only reachable from your tailnet.

`tailscaleServe` is a **lifecycle** flag — it controls whether the Serve command runs, nothing else. It does **not** imply `scheme: "https"`; that's a separate setting the endpoint derivation actually reads. Set both, or the dashboard/other services will still try to reach this one over plain `http` even though Tailscale Serve is terminating TLS on it:

```json
{
  "network": {
    "port": 4200,
    "tailscaleServe": true,
    "scheme": "https"
  }
}
```

Setting `scheme: "https"` once under the registry's `defaults.network` block covers every service instead of repeating it per entry — see [configuration.md](configuration.md).

---

## Turning it on for the control plane

1. Set the control host's `hostname` in `registry.json` to its actual tailnet MagicDNS name (`tailscale status` or the Tailscale admin console will show it — it looks like `your-machine.your-tailnet.ts.net`):

   ```json
   "hosts": [
     { "id": "home-server", "name": "home-server", "hostname": "home-server.your-tailnet.ts.net", "role": "control" }
   ]
   ```

2. On the `control` service entry, set `tailscaleServe: true` and `scheme: "https"` (or set `scheme` once under `defaults.network`, as above).

3. Restart the control plane so it re-reads the registry (see [configuration.md](configuration.md) — registry changes need a restart, they aren't picked up live).

4. `control-runner.sh` runs the `tailscale serve` command as part of starting; check it worked with `tailscale serve status` — the port should show under `Web`. The dashboard is then at `https://<hostname>:<port>` from any device on the tailnet, phone included.

For a service other than the control plane itself — a speech model you want reachable from another machine's browser directly, for instance — the same two flags apply on that service's own `network` block.

---

## CORS, for speech services specifically

If a speech service is served over Tailscale, the dashboard calls it from the browser at its `https://...ts.net` address, not `localhost` — so that address needs to be in the service's CORS allowlist, or the browser will refuse the request even though the service itself is healthy and reachable by `curl`. This is covered in more depth, with the actual environment variables to set, in the "CORS" section of [configuration.md](configuration.md).

---

## Keeping it working

Tailscale Serve entries can drop — a `tailscaled` restart, an OS update, however it happens. `scripts/serve-watchdog.sh` checks every service marked `tailscaleServe: true` against `tailscale serve status` and re-registers anything missing. It's meant for cron, once a minute:

```
* * * * * /path/to/banter/scripts/serve-watchdog.sh
```

Only useful if you're actually running a tailnet — skip it otherwise.
