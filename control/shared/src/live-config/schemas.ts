// Schemas for the three live files. They own shape and defaults; the registry's
// meaning checks (references, runner requirements, port rules) stay in registry.ts.

import { z } from "zod";
import type { FileSpec } from "./sync";
import { literalPortRule, registryPathRule } from "./rules";

// ── Configuration ────────────────────────────────────────────────────────

const chunkPref = z.object({
  chunking: z.object({
    mode: z.string().optional(),
    minWords: z.number().optional(),
    maxWords: z.number().optional(),
  }).optional(),
});

const sttSchema = z.object({
  serviceId: z.string().optional(),
  model: z.string().optional(),
  preferStreaming: z.boolean().optional(),
  encodings: z.array(z.enum(["opus", "pcm16"])).optional(),
  chunkMs: z.number().optional(),
  options: z.array(z.object({ serviceId: z.string(), name: z.string() })).optional(),
  maxRecordingMs: z.number().optional(),
  settleOnStopMs: z.number().optional(),
  pauseFlushMs: z.number().optional(),
  reveal: z.object({ minIntervalMs: z.number().optional(), maxIntervalMs: z.number().optional() }).optional(),
  vad: z.object({ minSpeechDurationS: z.number().optional(), minSpeechProb: z.number().optional() }).optional(),
  turnTaking: z.object({
    pauseThresholdMs: z.number().optional(),
    commitMinDelayMs: z.number().optional(),
    commitMaxDelayMs: z.number().optional(),
    smartTurnThreshold: z.number().optional(),
    smartTurnLowCutoff: z.number().optional(),
    curve: z.union([
      z.object({ type: z.literal("power"), exponent: z.number() }),
      z.object({ type: z.literal("sigmoid"), center: z.number(), steepness: z.number() }),
    ]).optional(),
    interruptionMinRemainingS: z.number().optional(),
  }).optional(),
  reconnect: z.object({
    attempts: z.number().optional(),
    delayMs: z.number().optional(),
    stableMs: z.number().optional(),
  }).optional(),
});

const configSchema = z.object({
  version: z.number(),
  timezone: z.string().optional(),
  runtime: z.object({ host: z.string().optional(), eventsPath: z.string().optional() }).optional(),
  integrations: z.object({
    openclaw: z.object({
      gateway: z.object({ url: z.string().optional(), token: z.string().optional() }).optional(),
      defaultSession: z.string().optional(),
    }).optional(),
  }).optional(),
  voice: z.object({
    enabled: z.boolean().optional(),
    takeover: z.enum(["ask", "always"]).optional(),
    preload: z.boolean().optional(),
    tts: z.object({
      selection: z.object({
        serviceId: z.string().optional(),
        model: z.string().optional(),
        voice: z.string().optional(),
        speed: z.number().optional(),
      }).optional(),
      options: z.object({
        chunkStrategy: z.string().nullish(),
        minChunkWords: z.number().nullish(),
        maxChunkWords: z.number().nullish(),
      }).optional(),
      modelPrefs: z.record(z.string(), z.record(z.string(), chunkPref)).optional(),
      settingsScope: z.enum(["global", "per-model"]).optional(),
    }).optional(),
    stt: sttSchema.optional(),
    debug: z.object({ saveMicSamples: z.boolean().optional() }).optional(),
  }).optional(),
});

export type PlatformConfig = z.infer<typeof configSchema>;

export const configSpec: FileSpec<PlatformConfig> = {
  name: "config.json",
  schema: configSchema,
  version: 4,
  rules: [],
};

// ── Registry ─────────────────────────────────────────────────────────────

const schemeEnum = z.enum(["http", "https"], {
  error: (issue) => `must be "http" or "https", got ${JSON.stringify(issue.input)}`,
});

const paramValue = z.union([z.string(), z.number(), z.boolean()]);

// An unknown key anywhere in a provision or in models is fatal: a misspelt `omits` would otherwise claim full conformance.
const provisionSchema = z.strictObject({
  api: z.string(),
  basePath: z.string().optional(),
  omits: z.array(z.string()).optional(),
  only: z.array(z.string()).optional(),
  restricts: z.record(z.string(), z.array(paramValue)).optional(),
  defaults: z.record(z.string(), paramValue).optional(),
  extends: z.array(z.string()).optional(),
});

const declaredCall = z.strictObject({
  method: z.enum(["GET", "POST", "PUT", "DELETE"]),
  path: z.string(),
  query: z.record(z.string(), z.string()).optional(),
  body: z.record(z.string(), z.string()).optional(),
});

const modelLoading = z.strictObject({
  loading: z.enum(["required", "none"]),
  autoLoad: z.enum(["always", "never"]).optional(),
  resident: z.enum(["one", "many"]).optional(),
  load: declaredCall.optional(),
  unload: declaredCall.optional(),
}).superRefine((models, ctx) => {
  for (const field of ["autoLoad", "resident"] as const) {
    if (models.loading === "required" && models[field] === undefined) {
      ctx.addIssue({ code: "custom", path: [field], message: `${field} is required when loading is "required"` });
    }
    if (models.loading === "none" && models[field] !== undefined) {
      ctx.addIssue({ code: "custom", path: [field], message: `${field} must be absent when loading is "none"` });
    }
  }
});

const serviceSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  notes: z.string().optional(),
  capabilityId: z.string(),
  hostId: z.string(),
  permissions: z.object({ enabled: z.boolean().optional(), protected: z.boolean().optional() }).optional(),
  network: z.object({
    port: z.number().optional(),
    healthPath: z.string().optional(),
    healthExpect: z.enum(["ok", "reachable"]).optional(),
    listenAddress: z.string().optional(),
    healthTimeout: z.number().optional(),
    tailscaleServe: z.boolean().optional(),
    scheme: schemeEnum.optional(),
  }).optional(),
  runner: z.object({
    type: z.enum(["process", "systemd", "launchd", "external", "managed"]),
    main: z.string().optional(),
    unit: z.string().optional(),
    unitFile: z.string().optional(),
    label: z.string().optional(),
    plist: z.string().optional(),
    startCmd: z.array(z.string()).optional(),
    stopCmd: z.array(z.string()).optional(),
    healthCmd: z.string().optional(),
  }).optional(),
  ops: z.object({
    env: z.object({
      workingDirectory: z.string().optional(),
      variables: z.record(z.string(), z.string()).optional(),
    }).optional(),
    install: z.object({
      artifacts: z.array(z.object({ from: z.string(), to: z.string() })),
    }).optional(),
  }).optional(),
  provides: z.array(provisionSchema).optional(),
  models: modelLoading.optional(),
  lifecycle: z.object({
    loadStrategy: z.enum(["startup", "demand"]).optional(),
    autoStart: z.boolean().optional(),
    shutdown: z.boolean().optional(),
    startupTime: z.number().optional(),
    idleUnload: z.boolean().optional(),
    idleTimeout: z.number().optional(),
    restartOnCrash: z.boolean().optional(),
    maxRestarts: z.number().optional(),
    restartBackoff: z.number().optional(),
    serveRetryAttempts: z.number().optional(),
    serveRetryDelay: z.number().optional(),
  }).optional(),
});

const cloning = z.object({
  requiresText: z.boolean().optional(),
  minDurationS: z.number().optional(),
  maxDurationS: z.number().optional(),
  sampleRate: z.number().optional(),
});

const ttsModel = z.object({
  id: z.string(),
  name: z.string(),
  cloning: cloning.optional(),
  chunkProfile: z.object({ words: z.number(), chars: z.number() }).optional(),
  chunking: z.object({
    mode: z.enum(["two-chunk", "paragraph", "sentence", "greedy"]).optional(),
    minWords: z.number().optional(),
    maxWords: z.number().optional(),
  }).optional(),
});

const sttModel = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["batch", "streaming", "both"]),
  params: z.array(z.object({ name: z.string(), values: z.array(z.number()) })).optional(),
  variants: z.array(z.object({
    id: z.string(),
    params: z.array(z.object({ name: z.string(), value: z.number() })),
  })).optional(),
});

const serving = z.object({
  model: z.string(),
  key: z.string(),
  streaming: z.boolean().optional(),
  realtime: z.boolean().optional(),
  concurrency: z.number().optional(),
  requestParams: z.record(z.string(), z.unknown()).optional(),
});

const provider = z.object({
  resolvesVoices: z.boolean().optional(),
  defaultModel: z.string().optional(),
  idleUnloadMs: z.number().optional(),
  serves: z.array(serving),
});

const recording = z.object({
  audio: z.string(),
  text: z.string(),
  durationS: z.number(),
  sampleRate: z.number(),
});

const rendering = z.object({
  model: z.string(),
  method: z.enum(["preset", "clone"]),
  key: z.string().optional(),
});

const voice = z.object({
  id: z.string(),
  name: z.string(),
  recordings: z.array(recording).optional(),
  renderings: z.array(rendering),
});

const registrySchema = z.object({
  _comment: z.string().optional(),
  version: z.number(),
  type: z.enum(["control", "shard"]),
  servicesRoot: z.string().optional(),
  defaults: z.object({
    permissions: z.object({ protected: z.boolean().optional() }).optional(),
    network: z.object({
      healthTimeout: z.number().optional(),
      tailscaleServe: z.boolean().optional(),
      scheme: schemeEnum.optional(),
    }).optional(),
    lifecycle: z.object({
      loadStrategy: z.enum(["startup", "demand"]).optional(),
      idleUnload: z.boolean().optional(),
      idleTimeout: z.number().optional(),
      autoStart: z.boolean().optional(),
      shutdown: z.boolean().optional(),
      startupTime: z.number().optional(),
      serveRetryAttempts: z.number().optional(),
      serveRetryDelay: z.number().optional(),
    }).optional(),
  }).optional(),
  hosts: z.array(z.object({
    id: z.string(),
    name: z.string(),
    hostname: z.string(),
    role: z.enum(["control", "worker"]),
    port: z.number().optional(),
  })),
  capabilities: z.array(z.object({ id: z.string(), name: z.string() })),
  services: z.array(serviceSchema),
  shards: z.array(z.object({ hostId: z.string(), port: z.number(), scheme: schemeEnum.optional() })).optional(),
  intervals: z.object({ healthMs: z.number().optional(), shardPollMs: z.number().optional() }).optional(),
  roster: z.object({
    ttsModels: z.array(ttsModel).optional(),
    sttModels: z.array(sttModel).optional(),
    providers: z.record(z.string(), provider),
    voices: z.array(voice),
  }).optional(),
});

export type RegistryDocument = z.infer<typeof registrySchema>;

export const registrySpec: FileSpec<RegistryDocument> = {
  name: "registry.json",
  schema: registrySchema,
  version: 4,
  rules: [literalPortRule, registryPathRule],
};

// ── Runtime state ────────────────────────────────────────────────────────

const stateSchema = z.object({
  version: z.number(),
  lastAgent: z.string().optional(),
  lastSessionByAgent: z.record(z.string(), z.string()).default({}),
});

export type RuntimeState = z.infer<typeof stateSchema>;

export const stateSpec: FileSpec<RuntimeState> = {
  name: "state.json",
  schema: stateSchema,
  version: 1,
  rules: [],
};
