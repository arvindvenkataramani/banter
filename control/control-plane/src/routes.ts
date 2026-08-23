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
      description: "Service with health state",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Service not found",
    },
  },
});

export const getServiceInfo = createRoute({
  method: "get",
  path: "/api/services/{id}/info",
  tags: ["Services"],
  summary: "Proxy to a service's /info endpoint",
  request: {
    params: z.object({ id: z.string().openapi({ description: "Service ID" }) }),
  },
  responses: {
    200: {
      description: "Service-specific info (shape varies by capability)",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Service not found",
    },
    502: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Failed to reach service",
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

export const getVoice = createRoute({
  method: "get",
  path: "/api/voice",
  tags: ["Config"],
  summary: "Voice configuration (TTS providers, models, voices, options)",
  responses: {
    200: {
      description: "Voice configuration object",
    },
    503: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Voice not configured",
    },
  },
});

export const patchGatewayDefaultAgent = createRoute({
  method: "patch",
  path: "/api/gateway/defaultAgent",
  tags: ["Config"],
  summary: "Set the default OpenClaw agent",
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
          schema: z.object({ defaultAgent: z.string() }),
        },
      },
      description: "Default agent updated",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Missing agentId or invalid JSON body",
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
      description: "Missing agentId/sessionName or invalid JSON body",
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
  settingsScope: z.enum(["global", "per-model"]).optional(),
  sttServiceId: z.string().optional(),
}).openapi("VoiceSelectionPatch");

export const patchVoiceSelection = createRoute({
  method: "patch",
  path: "/api/voice/selection",
  tags: ["Config"],
  summary: "Update the active TTS/STT selection",
  request: {
    body: {
      content: { "application/json": { schema: VoiceSelectionPatchSchema } },
    },
  },
  responses: {
    200: {
      description: "Updated voice configuration object",
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
      description: "Voice not configured",
    },
  },
});

export const postConfigReload = createRoute({
  method: "post",
  path: "/api/config/reload",
  tags: ["Config"],
  summary: "Reload config.json from disk without restarting the process",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), version: z.number() }),
        },
      },
      description: "Config reloaded",
    },
    500: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Config path not set, or reload failed",
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
