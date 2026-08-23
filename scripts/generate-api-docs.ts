/**
 * Generate API reference markdown from OpenAPI route definitions.
 *
 * Usage: bun run scripts/generate-api-docs.ts
 *
 * Imports route definitions from both control-plane and control-shard,
 * builds a combined OpenAPI 3.1 spec, and renders it as markdown.
 * No running server needed — everything is extracted at build time.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// Import all route definitions
import * as cpRoutes from "../control/control-plane/src/routes";
import * as shardRoutes from "../control/control-shard/src/routes";

// ── Build a doc-only app with all routes registered ───────────────────────────

const app = new OpenAPIHono();

// Control-plane routes (shared + CP-specific)
const registeredPaths = new Set<string>();
for (const route of Object.values(cpRoutes)) {
  if (typeof route === "object" && "method" in route && "path" in route) {
    app.openAPIRegistry.registerPath(route);
    registeredPaths.add(`${route.method}:${route.path}`);
  }
}

// Shard-specific routes (skip paths already registered by CP to avoid overwrite)
for (const route of Object.values(shardRoutes)) {
  if (typeof route === "object" && "method" in route && "path" in route) {
    if (registeredPaths.has(`${route.method}:${route.path}`)) continue;
    app.openAPIRegistry.registerPath(route);
  }
}

app.doc("/api/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Banter API",
    version: "1.0.0",
    description: "Voice chat platform for OpenClaw. The control plane is the public API surface; shard endpoints are internal but documented here for reference.",
  },
});

// ── Extract the spec ──────────────────────────────────────────────────────────

const res = await app.fetch(new Request("http://localhost/api/openapi.json"));
const spec = (await res.json()) as any;

// ── Render markdown ───────────────────────────────────────────────────────────

function methodBadge(method: string): string {
  return `\`${method.toUpperCase()}\``;
}

function renderSchema(schema: any, indent = 0): string {
  if (!schema) return "";
  const pad = "  ".repeat(indent);

  // Handle $ref — resolve from components
  if (schema.$ref) {
    const refName = schema.$ref.split("/").pop();
    return `${pad}→ [${refName}](#${refName!.toLowerCase()})`;
  }

  if (schema.type === "array" && schema.items) {
    const inner = renderSchema(schema.items, 0);
    return `${pad}Array of ${inner}`;
  }

  if (schema.type === "object" && schema.properties) {
    const lines = Object.entries(schema.properties).map(([key, val]: [string, any]) => {
      const required = schema.required?.includes(key) ? "" : "?";
      const type = val.$ref ? `→ ${val.$ref.split("/").pop()}` : val.type ?? "any";
      const desc = val.description ? ` — ${val.description}` : "";
      return `${pad}- \`${key}${required}\`: ${type}${desc}`;
    });
    return lines.join("\n");
  }

  return `${pad}${schema.type ?? "any"}`;
}

function renderResponses(responses: Record<string, any>): string {
  const lines: string[] = [];
  for (const [status, resp] of Object.entries(responses)) {
    const desc = resp.description ?? "";
    const content = resp.content?.["application/json"]?.schema;
    lines.push(`- **${status}** — ${desc}`);
    if (content) {
      lines.push(renderSchema(content, 1));
    }
  }
  return lines.join("\n");
}

function renderParameters(params: any[]): string {
  if (!params || params.length === 0) return "";
  const lines = params.map((p) => {
    const req = p.required ? " *(required)*" : "";
    const desc = p.description ? ` — ${p.description}` : "";
    return `- \`${p.name}\` (${p.in})${req}${desc}`;
  });
  return "**Parameters:**\n" + lines.join("\n");
}

function renderRequestBody(body: any): string {
  if (!body) return "";
  const schema = body.content?.["application/json"]?.schema;
  if (!schema) return "";
  return "**Request body:**\n" + renderSchema(schema, 0);
}

// Group paths by tag
const tagGroups = new Map<string, Array<{ method: string; path: string; op: any }>>();

for (const [path, methods] of Object.entries(spec.paths ?? {})) {
  for (const [method, op] of Object.entries(methods as Record<string, any>)) {
    const tags = op.tags ?? ["Other"];
    for (const tag of tags) {
      if (!tagGroups.has(tag)) tagGroups.set(tag, []);
      tagGroups.get(tag)!.push({ method, path, op });
    }
  }
}

// Explicit tag ordering
const tagOrder = ["Health", "Services", "Events", "Hosts", "Capabilities", "Shards", "Config", "Shard"];
const sortedTags = [...tagGroups.keys()].sort((a, b) => {
  const ai = tagOrder.indexOf(a);
  const bi = tagOrder.indexOf(b);
  return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
});

// Build markdown
const md: string[] = [];

md.push("# Banter API Reference");
md.push("");
md.push("> Auto-generated from OpenAPI route definitions. Do not edit manually.");
md.push("");

// Table of contents
md.push("## Contents");
md.push("");
for (const tag of sortedTags) {
  md.push(`- [${tag}](#${tag.toLowerCase().replace(/\s+/g, "-")})`);
}
if (spec.components?.schemas && Object.keys(spec.components.schemas).length > 0) {
  md.push("- [Schemas](#schemas)");
}
md.push("");

// Endpoints by tag
for (const tag of sortedTags) {
  const routes = tagGroups.get(tag)!;
  md.push(`## ${tag}`);
  md.push("");

  for (const { method, path, op } of routes) {
    md.push(`### ${methodBadge(method)} ${path}`);
    md.push("");
    if (op.summary) {
      md.push(op.summary);
      md.push("");
    }

    const params = renderParameters(op.parameters);
    if (params) {
      md.push(params);
      md.push("");
    }

    const body = renderRequestBody(op.requestBody);
    if (body) {
      md.push(body);
      md.push("");
    }

    md.push("**Responses:**");
    md.push(renderResponses(op.responses));
    md.push("");
    md.push("---");
    md.push("");
  }
}

// Schemas section
if (spec.components?.schemas && Object.keys(spec.components.schemas).length > 0) {
  md.push("## Schemas");
  md.push("");

  function renderSchemaTable(schema: any) {
    if (schema.type === "object" && schema.properties) {
      md.push("| Field | Type | Required | Description |");
      md.push("|-------|------|----------|-------------|");
      for (const [field, prop] of Object.entries(schema.properties as Record<string, any>)) {
        const required = schema.required?.includes(field) ? "yes" : "no";
        let type = prop.type ?? "";
        if (prop.$ref) type = `→ ${prop.$ref.split("/").pop()}`;
        // Handle anyOf/oneOf nullable pattern: [{$ref: "..."}, {nullable: true}] or [{$ref: "..."}, {type: "null"}]
        if (prop.anyOf || prop.oneOf) {
          const variants = prop.anyOf ?? prop.oneOf;
          const ref = variants.find((v: any) => v.$ref);
          const hasNull = variants.some((v: any) => v.nullable || v.type === "null");
          if (ref) {
            type = `→ ${ref.$ref.split("/").pop()}`;
            if (hasNull) type += " \\| null";
          }
        }
        if (prop.enum) type = prop.enum.map((e: string) => `\`${e}\``).join(" \\| ");
        if (prop.nullable) type += " \\| null";
        if (prop.type === "array" && prop.items) {
          type = prop.items.$ref
            ? `${prop.items.$ref.split("/").pop()}[]`
            : `${prop.items.type ?? "any"}[]`;
        }
        const desc = prop.description ?? "";
        md.push(`| \`${field}\` | ${type} | ${required} | ${desc} |`);
      }
    } else if (schema.enum) {
      md.push(`One of: ${schema.enum.map((e: string) => `\`${e}\``).join(", ")}`);
    }
  }

  for (const [name, schema] of Object.entries(spec.components.schemas as Record<string, any>)) {
    md.push(`### ${name}`);
    md.push("");

    // Handle allOf (e.g. ServiceWithHealth = Service + extra fields)
    if (schema.allOf) {
      const refs = schema.allOf
        .filter((s: any) => s.$ref)
        .map((s: any) => s.$ref.split("/").pop());
      if (refs.length > 0) {
        md.push(`Extends: ${refs.map((r: string) => `[${r}](#${r.toLowerCase()})`).join(", ")}`);
        md.push("");
      }
      // Render additional properties from inline objects in allOf
      for (const part of schema.allOf) {
        if (part.type === "object" && part.properties) {
          md.push("**Additional fields:**");
          md.push("");
          renderSchemaTable(part);
        }
      }
    } else {
      renderSchemaTable(schema);
    }
    md.push("");
  }
}

// Write output
const outPath = join(import.meta.dir, "../docs/api-reference.md");
await writeFile(outPath, md.join("\n") + "\n");
console.log(`Wrote ${outPath}`);
