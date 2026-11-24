import { z } from "@hono/zod-openapi";

// --- Stable types (mirroring shared/types.ts) ---

export const HostSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  role: z.enum(["control", "worker"]),
}).openapi("Host");

export const CapabilitySchema = z.object({
  id: z.string(),
  name: z.string(),
}).openapi("Capability");

export const EventTypeSchema = z.enum([
  "service.up",
  "service.down",
  "service.degraded",
  "service.timed_out",
  "service.disabled",
  "service.enabled",
  "service.restarted",
  "service.started",
  "service.stopped",
  "service.installed",
  "service.uninstalled",
  "service.unloaded",
  "memory.pressure",
  "tailscale.serve_failed",
  "tailscale.serve_remove_failed",
]);

export const EventSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  type: EventTypeSchema,
  subjectType: z.string(),
  subjectId: z.string(),
  data: z.record(z.string(), z.unknown()),
  actor: z.enum(["system", "user"]),
}).openapi("Event");

export const HealthStateSchema = z.enum([
  "healthy", "degraded", "timed_out", "down", "off", "disabled", "unknown",
]);

// --- Service types (included for response schemas, migrate handlers later) ---

export const ServicePermissionsSchema = z.object({
  enabled: z.boolean(),
  protected: z.boolean().optional(),
});

export const ServiceNetworkSchema = z.object({
  // Required for every runner type except "managed" (a self-managed daemon may
  // have no HTTP health surface at all — see ServiceRunnerSchema).
  port: z.number().optional(),
  healthPath: z.string().optional(),
  healthExpect: z.enum(["ok", "reachable"]).optional(),
  listenAddress: z.string().optional(),
  healthTimeout: z.number().optional(),
  tailscaleServe: z.boolean().optional(),
  endpoint: z.string().optional(),
});

export const ServiceRunnerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("process"), main: z.string() }),
  z.object({ type: z.literal("systemd"), unit: z.string(), unitFile: z.string() }),
  z.object({ type: z.literal("launchd"), label: z.string(), plist: z.string() }),
  z.object({ type: z.literal("external") }),
  z.object({
    type: z.literal("managed"),
    startCmd: z.array(z.string()),
    stopCmd: z.array(z.string()),
    healthCmd: z.string(),
  }),
]).openapi("ServiceRunner");

export const ServiceInstallSchema = z.object({
  artifacts: z.array(z.object({ from: z.string(), to: z.string() })).min(1),
});

export const ServiceOpsEnvSchema = z.object({
  workingDirectory: z.string().optional(),
  variables: z.record(z.string(), z.string()).optional(),
});

export const ServiceOpsSchema = z.object({
  install: ServiceInstallSchema.optional(),
  env: ServiceOpsEnvSchema.optional(),
});

export const ServiceLifecycleSchema = z.object({
  loadStrategy: z.enum(["startup", "demand"]).optional(),
  autoStart: z.boolean().optional(),
  shutdown: z.boolean().optional(),
  idleUnload: z.boolean().optional(),
  idleTimeout: z.number().optional(),
});

export const ServiceStateSchema = z.object({
  loadTime: z.number().optional(),
});

const ParamValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const ProvisionSchema = z.object({
  api: z.string(),
  basePath: z.string().optional(),
  omits: z.array(z.string()).optional(),
  only: z.array(z.string()).optional(),
  restricts: z.record(z.string(), z.array(ParamValueSchema)).optional(),
  defaults: z.record(z.string(), ParamValueSchema).optional(),
  extends: z.array(z.string()).optional(),
}).openapi("Provision");

const DeclaredCallSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "DELETE"]),
  path: z.string(),
  query: z.record(z.string(), z.string()).optional(),
  body: z.record(z.string(), z.string()).optional(),
});

export const ModelLoadingSchema = z.object({
  loading: z.enum(["required", "none"]),
  autoLoad: z.enum(["always", "never"]).optional(),
  resident: z.enum(["one", "many"]).optional(),
  load: DeclaredCallSchema.optional(),
  unload: DeclaredCallSchema.optional(),
}).openapi("ModelLoading");

export const ServiceSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  notes: z.string().optional(),
  capabilityId: z.string(),
  hostId: z.string(),
  permissions: ServicePermissionsSchema,
  network: ServiceNetworkSchema.optional(),
  runner: ServiceRunnerSchema.optional(),
  ops: ServiceOpsSchema.optional(),
  lifecycle: ServiceLifecycleSchema.optional(),
  provides: z.array(ProvisionSchema).optional().openapi({ description: "The APIs this service serves, each with how it departs from the API's spec" }),
  models: ModelLoadingSchema.optional().openapi({ description: "Whether this service's models need loading, and how" }),
  state: ServiceStateSchema.optional(),
}).openapi("Service");

export const ServiceWithHealthSchema = ServiceSchema.extend({
  health: HealthStateSchema,
  lastEvent: z.union([EventSchema, z.null()]),
  pending: z.boolean().openapi({
    description:
      "A lifecycle operation is outstanding for this service. Clients waiting on a start continue only while this is true, so it is always present on a live response — an absent value ends the wait.",
  }),
}).openapi("ServiceWithHealth");

// --- Common response schemas ---

export const ErrorSchema = z.object({
  error: z.string(),
}).openapi("Error");

export const SuccessSchema = z.object({
  success: z.boolean(),
}).openapi("Success");

export const HealthResponseSchema = z.object({
  status: z.string(),
  uptime: z.number(),
}).openapi("HealthResponse");
