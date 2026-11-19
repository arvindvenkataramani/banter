# Remote access with Tailscale

Optional. On your own network, a LAN address is enough and nothing here applies. This covers reaching the dashboard — or a service — from outside your network, assuming you already have Tailscale installed and the machine joined to your tailnet.

Tailscale is the one remote-access method Banter has built-in support for, via `tailscale serve`. Anything else — a reverse proxy, a VPN, your own cert — works too, but is entirely on you; Banter has no code path for it.

---

## Why https

Banter defaults to plain `http`, so it works as shipped on one machine or a home network with no certificates to set up. Moving to `https` is safer, and on a phone it's required for voice mode.

- **Your microphone needs it.** Browsers only grant the microphone to a secure page: `https`, or `http://localhost` on the same machine. Any other device, a phone or another computer, opening the dashboard at `http://192.168.1.20:4200` can chat by text, but voice mode can't start.
- **Everything is readable on the network otherwise.** Over `http`, the audio you speak, the transcripts, the agent's replies and the gateway token travel in the clear. Anyone else on the same Wi-Fi, or any compromised device on it, can read them.
- **The browser can't tell it's really your server.** `https` proves the page came from the machine it names. Over `http`, something on the network can answer in its place.
- **Other websites can reach a plain-http server more easily.** Banter's API has no login of its own; it trusts whoever can reach it. A technique called DNS rebinding lets a web page you visit point its own name at an address on your network and call that address from your browser. A page served over `https` is much harder to target this way, because the attacker can't present a valid certificate for your machine's name.

Banter doesn't refuse requests from pages that aren't `https`, so `http` installs keep working.

### How Tailscale gives you https without managing certificates

When a service has `tailscaleServe: true`, Banter runs `tailscale serve` for it on start. Tailscale then:

- gives the machine a name on your tailnet, like `your-machine.your-tailnet.ts.net`;
- obtains a real, browser-trusted certificate for that name (from Let's Encrypt) and renews it for you;
- terminates `https` on that name and forwards to the service on `localhost`, so the service itself never handles a certificate;
- carries the traffic between your devices over Tailscale's own encrypted connection, and only devices on your tailnet can reach the address at all.

So a phone on your tailnet opens `https://your-machine.your-tailnet.ts.net:4200`, the microphone works, and nothing on the local network can read or impersonate the connection. Your tailnet needs MagicDNS and HTTPS certificates turned on, both in the DNS page of the Tailscale admin console.

Banter doesn't infer `https` from `tailscaleServe`: also set `scheme: "https"`, as below, so Banter addresses the service by its `https` name.

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

Setting `scheme: "https"` once under the registry's `defaults.network` block covers every service instead of repeating it per entry — see [configuration.md](../reference/configuration.md).

---

## Turning it on for the control plane

1. Set the control host's `hostname` in `registry.json` to its actual tailnet MagicDNS name (`tailscale status` or the Tailscale admin console will show it — it looks like `your-machine.your-tailnet.ts.net`):

   ```json
   "hosts": [
     { "id": "home-server", "name": "home-server", "hostname": "home-server.your-tailnet.ts.net", "role": "control" }
   ]
   ```

2. On the `control` service entry, set `tailscaleServe: true` and `scheme: "https"` (or set `scheme` once under `defaults.network`, as above).

3. Restart the control plane so it re-reads the registry (see [configuration.md](../reference/configuration.md) — registry changes need a restart, they aren't picked up live).

4. `control-runner.sh` runs the `tailscale serve` command as part of starting; check it worked with `tailscale serve status` — the port should show under `Web`. The dashboard is then at `https://<hostname>:<port>` from any device on the tailnet, phone included.

For a service other than the control plane itself — a speech model you want reachable from another machine's browser directly, for instance — the same two flags apply on that service's own `network` block.

---

## CORS, for speech services specifically

If a speech service is served over Tailscale, the dashboard calls it from the browser at its `https://...ts.net` address, not `localhost` — so that address needs to be in the service's CORS allowlist, or the browser will refuse the request even though the service itself is healthy and reachable by `curl`. This is covered in more depth, with the actual environment variables to set, in the "CORS" section of [configuration.md](../reference/configuration.md).

---

## Keeping it working

Tailscale Serve entries can drop — a `tailscaled` restart, an OS update, however it happens. `ops/serve-watchdog.sh` checks every service marked `tailscaleServe: true` against `tailscale serve status` and re-registers anything missing. It's meant for cron, once a minute:

```
* * * * * /path/to/banter/ops/serve-watchdog.sh
```

Only useful if you're actually running a tailnet — skip it otherwise.
