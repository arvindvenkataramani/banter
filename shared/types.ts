export type HostRole = "control" | "worker";

export interface Host {
  id: string;
  name: string;
  hostname: string;
  role: HostRole;
}

export interface Capability {
  id: string;
  name: string;
}

export interface ServicePermissions {
  enabled: boolean;
  protected?: boolean;    // If true, cannot be stopped or disabled via API
}

export interface ServiceNetwork {
  port: number;
  healthPath: string;
  healthExpect?: "ok" | "reachable";  // "ok" (default) requires 2xx; "reachable" accepts any HTTP response, for services whose health path answers non-2xx by design (e.g. an MCP endpoint returning 406 to a plain GET)
  listenAddress?: string;  // If set, used instead of host hostname when deriving endpoint (e.g. "localhost"). Address only — it does not affect the scheme; see `scheme`.
  healthTimeout?: number;  // ms to wait for health poll on start (shard-specific)
  tailscaleServe?: boolean; // If true, register with Tailscale Serve on start. Lifecycle only — it does not affect the endpoint scheme.
  scheme?: "http" | "https"; // Endpoint protocol, default http. The only thing that decides it; anything can be https (reverse proxy, self-signed cert, any TLS terminator). Set once in defaults.network to apply registry-wide.
  endpoint?: string;       // Derived at load time from scheme + listenAddress or host hostname + port, never stored in JSON
}

// ── Runner types — declare how the platform manages a service ─────────────

export interface ProcessRunner {
  type: "process";
  main: string;           // Command to spawn (split on spaces)
}

export interface SystemdRunner {
  type: "systemd";
  unit: string;           // Unit name without .service, e.g. "embedding"
  unitFile: string;       // Path to unit file relative to $BANTER_ROOT, e.g. "ops/systemd/embedding.service"
}

export interface LaunchdRunner {
  type: "launchd";
  label: string;          // e.g. "com.banter.control-shard"
  plist: string;          // Path to plist relative to $BANTER_ROOT
}

export interface ExternalRunner {
  type: "external";       // Health-monitored only; platform does not start or stop
}

export interface ManagedDaemonRunner {
  type: "managed";        // Self-managing daemon: platform delegates every lifecycle verb to its own CLI
  startCmd: string[];     // argv, no shell — e.g. ["paseo", "daemon", "start"]
  stopCmd: string[];      // argv, no shell — e.g. ["paseo", "daemon", "stop"]
  healthCmd: string;      // shell string run via `sh -c`; exit code alone is the health signal
}

export type ServiceRunner = ProcessRunner | SystemdRunner | LaunchdRunner | ExternalRunner | ManagedDaemonRunner;

export interface ServiceOpsEnv {
  workingDirectory?: string;
  variables?: Record<string, string>;
}

export interface ServiceOps {
  env?: ServiceOpsEnv;    // Used by process runner only
}

export interface ServiceLifecycle {
  loadStrategy?: "startup" | "demand";
  autoStart?: boolean;    // Whether platform should load this service on startup
  shutdown?: boolean;     // Whether platform should stop this service on shutdown
  startupTime?: number;   // ms — grace period for health polling during startup (default: 30000)
  idleUnload?: boolean;   // Whether to evict on idle
  idleTimeout?: number;   // ms before idle eviction
  restartOnCrash?: boolean; // Auto-restart on unexpected exit (process runner only, default: false)
  maxRestarts?: number;   // Max restarts before giving up (default: 3)
  restartBackoff?: number; // Initial delay before restart attempt in ms (default: 5000)
}

export interface ServiceState {
  loadTime?: number;      // Timestamp when service was loaded; used by idle eviction
  // lastUsedAt lands here in Phase 4
}

export interface Service {
  id: string;
  name?: string;          // Display name; falls back to id if omitted
  capabilityId: string;
  hostId: string;
  permissions: ServicePermissions;
  network: ServiceNetwork;
  runner?: ServiceRunner;  // How the platform manages this service
  ops?: ServiceOps;        // Runtime env config (workingDirectory, variables) for process runner
  lifecycle?: ServiceLifecycle;
  state?: ServiceState;   // Runtime-only, never persisted to JSON
}

export interface Shard {
  hostId: string;
  port: number;
  tailscaleServe?: boolean;  // Register with Tailscale Serve on start; does not affect the scheme
  scheme?: "http" | "https"; // Endpoint protocol, default http
  endpoint: string;          // Derived at load time, never stored in JSON
}

export type RegistryType = "control" | "shard";

export type ServiceDefaults = {
  permissions?: Partial<Pick<ServicePermissions, "protected">>;
  network?: Partial<Pick<ServiceNetwork, "healthTimeout" | "tailscaleServe" | "scheme">>;
  lifecycle?: Partial<Pick<ServiceLifecycle, "loadStrategy" | "idleUnload" | "idleTimeout" | "autoStart" | "shutdown">>;
};

export interface Registry {
  version: number;
  type: RegistryType;
  servicesRoot?: string;  // Absolute path to services directory on this host (for reference)
  defaults?: ServiceDefaults;
  hosts: Host[];
  capabilities: Capability[];
  services: Service[];
  shards?: Shard[];
}

export type EventType =
  | "service.up"
  | "service.down"
  | "service.degraded"
  | "service.timed_out"
  | "service.disabled"
  | "service.enabled"
  | "service.restarted"
  | "service.started"
  | "service.stopped"
  | "service.crashed"
  | "service.installed"
  | "service.uninstalled"
  | "service.unloaded"
  | "memory.pressure"
  | "tailscale.serve_failed"
  | "tailscale.serve_remove_failed";

export type HealthState = "healthy" | "degraded" | "timed_out" | "down" | "disabled" | "unknown";

export interface Event {
  id: string;
  timestamp: string;
  type: EventType;
  subjectType: string;
  subjectId: string;
  data: Record<string, unknown>;
  actor: "system" | "user";
}

export interface ServiceWithHealth extends Service {
  health: HealthState;
  lastEvent: Event | null;
  locked?: boolean; // A start/stop lifecycle operation is in progress on the owning node
}


// Capability-specific /info response types

export interface TtsOperation {
  path: string;         // e.g. "/v1/audio/speech"
  method: string;       // "POST"
  contentType: string;  // "application/json"
  responseType: string; // "audio/wav"
}

export interface TtsVoiceInfo {
  id: string;
  name?: string;
}

export interface TtsModelInfo {
  id: string;
  sampleRate: number;
  voices: TtsVoiceInfo[];
}

export interface TtsServiceInfo {
  engine: string;
  synth: TtsOperation;
  stream?: TtsOperation;
  models: TtsModelInfo[];
}

export const CHUNK_STRATEGIES = ['two-chunk', 'paragraph', 'sentence', 'greedy'] as const;
export type ChunkStrategy = typeof CHUNK_STRATEGIES[number];
