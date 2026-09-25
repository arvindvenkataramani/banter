export type HostRole = "control" | "worker";

export interface Host {
  id: string;
  name: string;
  hostname: string;
  role: HostRole;
  // Optional: the port a consumer should use to reach a well-known service
  // on this host, when that fact isn't otherwise derivable from
  // Registry.services[] (e.g. a consumer on a different machine entirely,
  // with no access to this host's own registry.json).
  port?: number;
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

// One built file, copied from the source tree into the service's working
// directory by the install scripts (scripts/install-artifacts.sh).
export interface InstallArtifact {
  from: string;           // Relative to the source tree the install runs from
  to: string;             // Relative to ops.env.workingDirectory
}

export interface ServiceOps {
  env?: ServiceOpsEnv;    // Used by process runner only
  install?: { artifacts: InstallArtifact[] };
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
  serveRetryAttempts?: number; // Total Tailscale Serve write attempts, including the first (default: 3)
  serveRetryDelay?: number;    // ms between Serve retry attempts (default: 250)
}

export interface ServiceState {
  loadTime?: number;      // Timestamp when service was loaded; used by idle eviction
  // lastUsedAt lands here in Phase 4
}

export interface Service {
  id: string;
  name?: string;          // Display name; falls back to id if omitted
  notes?: string;         // Free-text usage notes: what it is, how to drive it, where it came from
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
  lifecycle?: Partial<Pick<ServiceLifecycle, "loadStrategy" | "idleUnload" | "idleTimeout" | "autoStart" | "shutdown" | "startupTime" | "serveRetryAttempts" | "serveRetryDelay">>;
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
  /** Always present on a loaded registry; empty when the file has none. */
  roster?: NodeRoster;
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
  pending?: boolean; // A lifecycle request for this service is outstanding, queued or executing
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

export interface ChunkProfile {
  words: number;
  chars: number;
}

// Compatibility with a VoiceReference is computed at validation, not written
// per voice. Absent means the model cannot clone at all.
export interface Cloning {
  available: boolean;
  requiresText?: boolean;
  minDurationS?: number;
  maxDurationS?: number;
  sampleRate?: number;
}

// A voice rendered under a second model must use that model's own
// chunkProfile, or one model's constraint silently degrades another's audio.
export interface TtsModel {
  id: string;
  name: string;
  /** What this provider's runtime calls the model — the same model can have
   *  a different key under a different runtime. */
  key: string;
  cloning?: Cloning;
  chunkProfile?: ChunkProfile;
  /** Fast enough for the realtime voice loop. Absent means it is not. */
  realtime?: boolean;
  /** The provider's runtime can stream this model's audio as it renders. */
  streaming?: boolean;
  /** How the realtime voice loop splits text for this model. Distinct from
   *  `chunkProfile`, which bounds the generation pipeline's own chunks. */
  chunking?: { mode?: ChunkStrategy; minWords?: number; maxWords?: number };
  /** Most requests the realtime voice loop sends this model at once. */
  concurrency?: number;
  /** Fields passed verbatim into every synthesis request for this model. */
  requestParams?: Record<string, unknown>;
  presetVoices?: { id: string; name: string }[];
}

export interface SttModel {
  id: string;
  name: string;
  key: string;
  kind: "batch" | "streaming" | "both";
  params?: { name: string; values: number[] }[];
  variants?: { id: string; params: { name: string; value: number }[] }[];
}

export interface Provider {
  /** The audio format this runtime returns from /v1/audio/speech. Absent means mp3. */
  responseFormat?: ResponseFormat;
  ttsModels?: TtsModel[];
  sttModels?: SttModel[];
  /** Whether this runtime's streaming socket understands session ids and take-over. Absent means no. */
  sessions?: boolean;
}

export const RESPONSE_FORMATS = ["mp3", "aac", "wav"] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

/** Declared, not probed from the file — a stale value here is taken as fact. */
export interface VoiceReference {
  audio: string;
  text?: string;
  durationS: number;
  sampleRate: number;
}

export interface VoiceModel {
  serviceId: string;
  model: string;
  key: string;
}

export interface VoiceDefinition {
  id: string;
  name: string;
  references?: VoiceReference[];
  models: VoiceModel[];
}

/** What `clone` means in a VoiceModel's `key`: render from a reference
 *  rather than ask the model for a name it already knows. */
export const CLONE_KEY = "clone";

export interface NodeRoster {
  providers: Record<string, Provider>;
  voices: VoiceDefinition[];
}

/** One reload response reports one PartResult per part. */
export type PartResult = { ok: true } | { ok: false; error: string };

/** Names what a reload could not apply. Reload never restarts anything itself. */
export interface ReloadWarning {
  kind: "provider-changed" | "service-removed" | "shards-changed";
  serviceId?: string;
  message: string;
}

export interface ControlPlaneReloadResponse {
  config: PartResult;
  registry: PartResult;
  shards: Record<string, PartResult>;
  warnings: ReloadWarning[];
}

export interface ShardReloadResponse {
  registry: PartResult;
  warnings: ReloadWarning[];
}
