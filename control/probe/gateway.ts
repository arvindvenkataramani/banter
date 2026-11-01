// The gateway URL and token, read the way the control plane reads them.
//
// The live config.json names the token as ${OPENCLAW_GATEWAY_TOKEN}. The
// control plane gets that variable from its systemd drop-in in production and
// from $BANTER_PROD/.env.secrets in dev (scripts/control-dev.sh). The probe
// runs from an ordinary shell, so it takes the variable from the environment
// when set and otherwise from the same secrets file dev uses.

import { join } from "node:path";
import { homedir } from "node:os";

export interface GatewayTarget {
  url: string;
  token: string;
}

/** KEY=value lines, as `set -a; source` reads them. Comments and blanks skipped; one layer of matching quotes removed. */
export function parseEnvFile(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    vars[match[1]] = value;
  }
  return vars;
}

/** A ${VAR} reference resolves from the environment first, then the secrets file. Any other value is literal. */
export function resolveValue(
  value: unknown,
  env: Record<string, string | undefined>,
  secrets: Record<string, string>,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const ref = /^\$\{([A-Z0-9_]+)\}$/.exec(value);
  if (!ref) return value;
  return env[ref[1]] ?? secrets[ref[1]];
}

export async function loadGatewayConfig(env: Record<string, string | undefined> = process.env): Promise<GatewayTarget> {
  const prod = env.BANTER_PROD ?? join(homedir(), "services", "banter");
  const configPath = env.BANTER_CONFIG_PATH ?? join(env.BANTER_LIVE_DIR ?? prod, "config.json");
  const secretsPath = join(prod, ".env.secrets");

  const config = await Bun.file(configPath).json();
  const secretsFile = Bun.file(secretsPath);
  const secrets = (await secretsFile.exists()) ? parseEnvFile(await secretsFile.text()) : {};

  const gw = config?.integrations?.openclaw?.gateway;
  const token = resolveValue(gw?.token, env, secrets);
  if (!gw?.url) throw new Error(`no gateway url in ${configPath}`);
  if (!token) throw new Error(`gateway token ${gw?.token} not set in the environment or ${secretsPath}`);
  return { url: gw.url, token };
}
