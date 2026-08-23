import { createRoute, z } from "@hono/zod-openapi";
import { ErrorSchema, SuccessSchema } from "../../shared/src/schemas";

const ShardStatusResponseSchema = z.object({
  freeMem: z.number(),
  services: z.record(z.string(), z.object({
    health: z.string(),
    lastPing: z.number().nullable(),
  })),
}).openapi("ShardStatusResponse");

export const getStatus = createRoute({
  method: "get",
  path: "/status",
  tags: ["Shard"],
  summary: "Shard memory and per-service health/ping status",
  responses: {
    200: {
      content: { "application/json": { schema: ShardStatusResponseSchema } },
      description: "Shard status with memory info and per-service health",
    },
  },
});

export const pingService = createRoute({
  method: "post",
  path: "/ping/{service}",
  tags: ["Shard"],
  summary: "Record a ping for idle eviction tracking",
  request: {
    params: z.object({ service: z.string().openapi({ description: "Service ID" }) }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
      description: "Ping recorded",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Service not found",
    },
  },
});

export const shardStartService = createRoute({
  method: "post",
  path: "/api/services/{id}/start",
  tags: ["Shard"],
  summary: "Start a demand-loaded service on the shard",
  request: {
    params: z.object({ id: z.string().openapi({ description: "Service ID" }) }),
  },
  responses: {
    202: {
      content: { "application/json": { schema: SuccessSchema } },
      description: "Service load initiated",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Service disabled or not a demand service",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Service not found",
    },
    409: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Lifecycle operation already in progress",
    },
    500: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Load failed",
    },
    503: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Memory pressure",
    },
  },
});

export const shardStopService = createRoute({
  method: "post",
  path: "/api/services/{id}/stop",
  tags: ["Shard"],
  summary: "Stop a demand-loaded service on the shard",
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
      description: "Not a demand service",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Service not found",
    },
    409: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Lifecycle operation already in progress",
    },
    500: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Stop failed",
    },
  },
});
