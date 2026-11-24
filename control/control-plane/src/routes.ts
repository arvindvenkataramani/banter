import { createRoute, z } from "@hono/zod-openapi";
import {
  HostSchema,
  CapabilitySchema,
  EventSchema,
  ServiceWithHealthSchema,
  ErrorSchema,
  SuccessSchema,
  HealthResponseSchema,
} from "../../shared/src/schemas";

// ── Shared routes (served by the shared app, documented here) ─────────────────

export const getHealth = createRoute({
  method: "get",
  path: "/api/health",
  tags: ["Health"],
  summary: "Liveness probe",
  responses: {
    200: {
      content: { "application/json": { schema: HealthResponseSchema } },
      description: "Service is alive",
    },
  },
});

export const getHosts = createRoute({
  method: "get",
  path: "/api/hosts",
  tags: ["Hosts"],
  summary: "List all hosts",
  responses: {
    200: {
      content: { "application/json": { schema: z.array(HostSchema) } },
      description: "All registered hosts",
    },
  },
});

export const getCapabilities = createRoute({
  method: "get",
  path: "/api/capabilities",
  tags: ["Capabilities"],
  summary: "List all capabilities",
  responses: {
    200: {
      content: { "application/json": { schema: z.array(CapabilitySchema) } },
      description: "All registered capabilities",
    },
  },
});

export const getEvents = createRoute({
  method: "get",
  path: "/api/events",
  tags: ["Events"],
  summary: "List recent events",
  request: {
    query: z.object({
      limit: z.coerce.number().int().positive().optional().openapi({ description: "Max events to return", default: 50 }),
      subjectId: z.string().optional().openapi({ description: "Filter by subject ID" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.array(EventSchema) } },
      description: "Events sorted newest-first",
    },
  },
});

export const getServices = createRoute({
  method: "get",
  path: "/api/services",
  tags: ["Services"],
  summary: "List all services with health state",
  request: {
    query: z.object({
      capability: z.string().optional().openapi({ description: "Filter by capability ID" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.array(ServiceWithHealthSchema) } },
      description: "All services enriched with health state",
    },
  },
});

export const getServiceById = createRoute({
  method: "get",
  path: "/api/services/{id}",
  tags: ["Services"],
  summary: "Get a single service by ID",
  request: {
    params: z.object({ id: z.string().openapi({ description: "Service ID" }) }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: ServiceWithHealthSchema } },
      description: "Service with health state, read live from the owning node",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Service not found",
    },
    503: {
      content: { "application/json": { schema: ErrorSchema } },
      description:
        "The shard owning this service could not be reached. The route answers only from a live read, so a caller wanting last-known state reads GET /api/services instead.",
    },
  },
});

export const checkService = createRoute({
  method: "post",
  path: "/api/services/{id}/check",
  tags: ["Services"],
  summary: "On-demand health check (bypasses consecutive failure threshold)",
  request: {
    params: z.object({ id: z.string().openapi({ description: "Service ID" }) }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: ServiceWithHealthSchema } },
      description: "Service with updated health state",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Service not found",
    },
  },
});

export const startService = createRoute({
  method: "post",
  path: "/api/services/{id}/start",
  tags: ["Services"],
  summary: "Start a service",
  request: {
    params: z.object({ id: z.string().openapi({ description: "Service ID" }) }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: SuccessSchema } },
      description: "Service started",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Service disabled or does not support start",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Service not found",
    },
    500: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Start failed",
    },
  },
});

export const stopService = createRoute({
  method: "post",
  path: "/api/services/{id}/stop",
  tags: ["Services"],
  summary: "Stop a service",
  request: {
    params: z.object({ id: z.string().openapi({ description: "Service ID" }) }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: SuccessSchema } },
      description: "Service stopped",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Service does not support stop",
    },
    403: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Cannot stop a protected service",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Service not found",
    },
    500: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Stop failed",
    },
  },
});

export const restartService = createRoute({
  method: "post",
  path: "/api/services/{id}/restart",
  tags: ["Services"],
  summary: "Restart a service",
  request: {
    params: z.object({ id: z.string().openapi({ description: "Service ID" }) }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: SuccessSchema } },
      description: "Service restarted",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Service does not support restart",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Service not found",
    },
    500: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Restart failed",
    },
  },
});

export const patchService = createRoute({
  method: "patch",
  path: "/api/services/{id}",
  tags: ["Services"],
  summary: "Update service fields (endpoint, healthPath, etc.)",
  request: {
    params: z.object({ id: z.string().openapi({ description: "Service ID" }) }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: ServiceWithHealthSchema } },
      description: "Updated service with health state",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Invalid patch",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Service not found",
    },
  },
});

export const toggleServiceEnabled = createRoute({
  method: "patch",
  path: "/api/services/{id}/enabled",
  tags: ["Services"],
  summary: "Enable or disable a service",
  request: {
    params: z.object({ id: z.string().openapi({ description: "Service ID" }) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ enabled: z.boolean() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated service",
    },
    403: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Cannot disable a protected service",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Service not found",
    },
    500: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Enable/disable action failed",
    },
  },
});

// ── Control-plane-only routes ─────────────────────────────────────────────────

const ShardStatusSchema = z.object({
  hostId: z.string(),
  endpoint: z.string(),
  online: z.boolean(),
  lastPoll: z.number(),
}).openapi("ShardStatus");

export const getShards = createRoute({
  method: "get",
  path: "/api/shards",
  tags: ["Shards"],
  summary: "List shard connection statuses",
  responses: {
    200: {
      content: { "application/json": { schema: z.array(ShardStatusSchema) } },
      description: "All shards with online/offline status",
    },
  },
});

export const pollShard = createRoute({
  method: "post",
  path: "/api/shards/{hostId}/poll",
  tags: ["Shards"],
  summary: "Trigger an immediate shard poll",
  request: {
    params: z.object({ hostId: z.string().openapi({ description: "Host ID of the shard" }) }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            hostId: z.string(),
            online: z.boolean(),
            lastPoll: z.number(),
          }),
        },
      },
      description: "Poll result",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Shard not found",
    },
    500: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "No poller available",
    },
  },
});

const GatewayConfigSchema = z.object({
  url: z.string(),
  token: z.string(),
}).openapi("GatewayConfig");

export const getGateway = createRoute({
  method: "get",
  path: "/api/gateway",
  tags: ["Config"],
  summary: "OpenClaw gateway URL and token",
  responses: {
    200: {
      content: { "application/json": { schema: GatewayConfigSchema } },
      description: "Gateway connection info",
    },
    503: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Gateway not configured",
    },
  },
});

const VoiceSelectionSchema = z.object({
  serviceId: z.string().optional(),
  model: z.string().optional(),
  voice: z.string().optional(),
  speed: z.number().optional(),
  resolution: z.object({
    model: z.string(),
    voice: z.union([z.object({ name: z.string() }), z.object({ recording: z.string(), transcript: z.string().optional() })]),
    params: z.record(z.string(), z.unknown()).optional(),
  }).optional().openapi({ description: "The shard's resolution of this selection: the model as the runtime names it, the voice by name or recording, and the serving's request parameters" }),
  resolutionError: z.string().optional().openapi({ description: "Why `resolution` is absent: the shard refused the selection or could not be reached" }),
}).openapi("VoiceSelection");

const VoiceTtsSchema = z.object({
  models: z.array(z.object({
    id: z.string(),
    name: z.string(),
    canClone: z.boolean(),
    chunking: z.object({ mode: z.string().optional(), minWords: z.number().optional(), maxWords: z.number().optional() }).optional(),
  })),
  providers: z.array(z.object({
    serviceId: z.string(),
    hostId: z.string(),
    reachable: z.boolean(),
    name: z.string(),
    resolvesVoices: z.boolean().optional(),
    provides: z.array(z.record(z.string(), z.unknown())).optional().openapi({ description: "The APIs the runtime's service serves, with how it departs from each" }),
    models: z.record(z.string(), z.unknown()).optional().openapi({ description: "How the service's models load" }),
    serves: z.array(z.object({
      model: z.string(),
      key: z.string(),
      streaming: z.boolean().optional(),
      realtime: z.boolean().optional(),
      concurrency: z.number().optional(),
      requestParams: z.record(z.string(), z.unknown()).optional(),
    })),
  })),
  voices: z.array(z.object({
    id: z.string(),
    name: z.string(),
    renderings: z.array(z.object({ model: z.string(), method: z.enum(["preset", "clone"]) })),
  })),
  selection: VoiceSelectionSchema,
}).passthrough().openapi("VoiceTts");

const VoiceConfigSchema = z.object({ tts: VoiceTtsSchema }).passthrough().openapi("VoiceConfig");

export const getVoice = createRoute({
  method: "get",
  path: "/api/voice",
  tags: ["Config"],
  summary: "Voice configuration (TTS models, providers, voices, selection, options)",
  responses: {
    200: {
      content: { "application/json": { schema: VoiceConfigSchema } },
      description: "Voice configuration object; `tts.selection.resolution` is the shard's resolution of the stored selection",
    },
    503: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Voice not configured",
    },
  },
});

export const patchGatewayLastAgent = createRoute({
  method: "patch",
  path: "/api/gateway/lastAgent",
  tags: ["Config"],
  summary: "Record the last-used OpenClaw agent",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ agentId: z.string() }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ lastAgent: z.string() }),
        },
      },
      description: "Last agent recorded",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Missing agentId, invalid JSON body, or an agentId that fails validation",
    },
    500: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Config path not set",
    },
  },
});

export const patchGatewayLastSession = createRoute({
  method: "patch",
  path: "/api/gateway/lastSession",
  tags: ["Config"],
  summary: "Record the last-used session name for an agent",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ agentId: z.string(), sessionName: z.string() }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ lastSessionByAgent: z.record(z.string(), z.string()) }),
        },
      },
      description: "Last session recorded",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Missing agentId or sessionName, invalid JSON body, or a value that fails validation",
    },
    500: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Config path not set",
    },
  },
});

const VoiceSelectionPatchSchema = z.object({
  serviceId: z.string().optional(),
  model: z.string().optional(),
  voice: z.string().optional(),
  speed: z.number().optional(),
  chunkStrategy: z.string().nullable().optional(),
  minChunkWords: z.number().nullable().optional(),
  maxChunkWords: z.number().nullable().optional(),
  modelPrefs: z.record(
    z.string(),
    z.record(
      z.string(),
      z.object({
        chunking: z.object({
          mode: z.string().optional(),
          minWords: z.number().optional(),
          maxWords: z.number().optional(),
        }).optional(),
      }).nullable(),
    ),
  ).optional().openapi({ description: "Per-model chunking preferences, keyed by serviceId then model; null clears an entry" }),
  settingsScope: z.enum(["global", "per-model"]).optional(),
  sttServiceId: z.string().optional(),
  preferStreaming: z.boolean().optional().openapi({ description: "Written to voice.stt.preferStreaming: whether a model that can do both streams (live words) or transcribes in batch (on each pause)" }),
  saveMicSamples: z.boolean().optional(),
  takeover: z.enum(["ask", "always"]).optional(),
  vad: z.object({
    minSpeechDurationS: z.number().nullable().optional(),
    minSpeechProb: z.number().nullable().optional(),
  }).optional().openapi({ description: "Merged field by field into voice.stt.vad; probabilities within [0, 1], durations non-negative; null removes a field so the engine default applies" }),
  turnTaking: z.object({
    pauseThresholdMs: z.number().nullable().optional(),
    commitMinDelayMs: z.number().nullable().optional(),
    commitMaxDelayMs: z.number().nullable().optional(),
    smartTurnThreshold: z.number().nullable().optional(),
    smartTurnLowCutoff: z.number().nullable().optional(),
  }).optional().openapi({ description: "Merged field by field into voice.stt.turnTaking; probabilities within [0, 1], durations non-negative; null removes a field so the engine default applies" }),
}).openapi("VoiceSelectionPatch");

export const patchVoiceSelection = createRoute({
  method: "patch",
  path: "/api/voice/selection",
  tags: ["Config"],
  summary: "Update the voice selection and tuning",
  request: {
    body: {
      content: { "application/json": { schema: VoiceSelectionPatchSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ tts: z.object({ selection: VoiceSelectionSchema }).passthrough() }).passthrough() } },
      description: "Updated voice configuration object; `tts.selection.resolution` is the shard's resolution of the new selection",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Invalid JSON body, or the patch failed validation",
    },
    500: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Config path not set",
    },
    503: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Voice not configured, or a named serviceId cannot be checked because a shard has never been polled",
    },
  },
});

const PartResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional().openapi({ description: "Present when ok is false" }),
}).openapi("ReloadPartResult");

const ReloadWarningSchema = z.object({
  kind: z.enum(["provider-changed", "service-removed", "shards-changed", "intervals-changed"]),
  serviceId: z.string().optional(),
  message: z.string(),
}).openapi("ReloadWarning");

const ControlPlaneReloadResponseSchema = z.object({
  config: PartResultSchema,
  registry: PartResultSchema,
  shards: z.record(z.string(), PartResultSchema).openapi({ description: "One result per shard, keyed by hostId" }),
  warnings: z.array(ReloadWarningSchema),
}).openapi("ControlPlaneReloadResponse");

export const postConfigReload = createRoute({
  method: "post",
  path: "/api/config/reload",
  tags: ["Config"],
  summary: "Reload config.json, the registry and every shard's registry from disk without restarting",
  description: "Reload applies what it can and names what it cannot in warnings; it never restarts a service. The body has the same shape whether or not every part succeeded. A shard serves the same path for its own registry and answers { registry, warnings }.",
  responses: {
    200: {
      content: { "application/json": { schema: ControlPlaneReloadResponseSchema } },
      description: "Every part reloaded",
    },
    500: {
      content: { "application/json": { schema: ControlPlaneReloadResponseSchema } },
      description: "At least one part failed; its entry carries the error",
    },
  },
});

export const postDebugMicSample = createRoute({
  method: "post",
  path: "/api/debug/mic-sample",
  tags: ["Config"],
  summary: "Save a raw mic sample for debugging (only registered when DEBUG is set)",
  request: {
    body: {
      content: { "application/octet-stream": { schema: z.any() } },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ filename: z.string(), dir: z.string() }),
        },
      },
      description: "Sample saved",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Empty body",
    },
    403: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Mic sample saving disabled in config",
    },
  },
});
