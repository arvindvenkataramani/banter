import { startService, stopService, startDeadlineMs } from "../../shared/src/lifecycle";
import { submit } from "../../shared/src/executor";
import type { RunFn, PollHealthFn, SpawnFn } from "../../shared/src/tailscale";
import type { Registry } from "../../../shared/types";

// Re-export shared per-service lifecycle for callers in this package
export { startService, stopService };

// ── Shard-level lifecycle ────────────────────────────────────────────────────

interface ShardStartupDeps {
  registryState: Registry;
  eventsPath: string;
  runFn: RunFn;
  pollHealthFn: PollHealthFn;
  spawnFn?: SpawnFn;
}

export async function shardStartup(deps: ShardStartupDeps): Promise<void> {
  const { registryState, eventsPath, runFn, pollHealthFn, spawnFn } = deps;

  for (const svc of registryState.services) {
    if (svc.lifecycle?.autoStart !== true) continue;
    console.log(`Auto-starting ${svc.id}...`);
    try {
      const result = await submit(svc.id, "start", () => startService(runFn, pollHealthFn, svc, eventsPath, spawnFn), { deadlineMs: startDeadlineMs(svc) });
      if (result.ok) {
        svc.state = { ...svc.state, loadTime: Date.now() };
        console.log(`  ${svc.id} started`);
      } else {
        console.error(`  ${svc.id} failed: ${result.error}`);
      }
    } catch (err) {
      console.error(`  ${svc.id} error: ${err}`);
    }
  }
}

interface ShardShutdownDeps {
  registryState: Registry;
  eventsPath: string;
  runFn: RunFn;
  stopHealth: () => void;
  stopIdle: () => void;
  stopServer: () => void;
}

export async function shardShutdown(deps: ShardShutdownDeps): Promise<void> {
  const { registryState, eventsPath, runFn, stopHealth, stopIdle, stopServer } = deps;

  console.log("ControlShard shutting down...");
  // Closed before any service is stopped: a request served during the stop loop
  // would act on this registry, and a service it started after the loop passed
  // it would outlive the shard.
  stopServer();
  stopHealth();
  stopIdle();

  for (const svc of registryState.services) {
    if (svc.lifecycle?.shutdown !== true) continue;
    console.log(`Stopping ${svc.id}...`);
    try {
      await stopService(runFn, svc, eventsPath);
    } catch (err) {
      console.error(`  ${svc.id} stop error: ${err}`);
    }
  }

  console.log("ControlShard stopped.");
  process.exit(0);
}
