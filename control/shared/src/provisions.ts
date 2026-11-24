// Load-time checks on the APIs a service provides and how its models load
// (docs/reference/design/service-apis.md, "Validation at registry load"). They run on parsed objects, so they also
// catch the unknown keys the non-strict schema sync would pass with a warning.
// A failure is fatal at startup and refused at reload.

import { apiEntry, extensionEntry, partNames } from "../../../shared/apis/catalog";
import { adapterFor } from "../../../shared/apis";
import { candidates } from "../../../shared/apis/select";
import type { Operation, SelectableService } from "../../../shared/apis/types";
import type { NodeRoster, Service } from "../../../shared/types";

const PROVISION_KEYS = new Set(["api", "basePath", "omits", "only", "restricts", "defaults", "extends"]);
const MODELS_KEYS = new Set(["loading", "autoLoad", "resident", "load", "unload"]);
const CALL_KEYS = new Set(["method", "path", "query", "body"]);
const METHODS = ["GET", "POST", "PUT", "DELETE"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPrimitive = (v: unknown): boolean => ["string", "number", "boolean"].includes(typeof v);
const kindOf = (part: string): string => part.slice(0, part.indexOf(":"));

const failIn = (section: "services" | "roster", message: string): never => {
  throw new Error(`registry.json ${section}: ${message}`);
};

function unknownKeys(owner: string, value: Record<string, unknown>, known: Set<string>): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) failIn("services", `${owner} has an unknown key "${key}"`);
  }
}

function stringList(owner: string, field: string, value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(v => typeof v === "string")) failIn("services", `${owner}.${field} must be an array of strings`);
  return value as string[];
}

/** The operations a service is called for when it serves an STT model of this kind. */
const sttOperations = (kind: unknown): Operation[] =>
  kind === "streaming" ? ["transcribeStream"] : kind === "batch" ? ["transcribe"] : ["transcribe", "transcribeStream"];

const performs = (service: Service, operation: Operation): boolean =>
  (service.provides ?? []).some(p => adapterFor(p.api)?.operations.includes(operation));

const hasLoadCall = (service: Service): boolean => performs(service, "loadModel") || service.models?.load !== undefined;

function checkProvision(service: Service, provision: unknown, index: number): void {
  const owner = `service "${service.id}" provides[${index}]`;
  if (!isObject(provision)) return failIn("services", `${owner} must be an object`);
  unknownKeys(owner, provision, PROVISION_KEYS);
  const api = provision.api;
  if (typeof api !== "string") return failIn("services", `${owner} names no api`);
  const where = `service "${service.id}" provision of ${api}`;

  if (provision.basePath !== undefined) {
    const base = provision.basePath;
    if (typeof base !== "string" || !base.startsWith("/") || base.endsWith("/")) {
      failIn("services", `${where} has basePath "${String(base)}", which must begin with / and not end with one`);
    }
  }

  const omits = provision.omits === undefined ? [] : stringList(where, "omits", provision.omits);
  const only = provision.only === undefined ? [] : stringList(where, "only", provision.only);
  const omitted = new Set(omits.map(kindOf));
  for (const part of only) {
    if (omitted.has(kindOf(part))) failIn("services", `${where} names ${kindOf(part)} parts in both omits and only`);
  }

  const extensions = provision.extends === undefined ? [] : stringList(where, "extends", provision.extends);
  for (const id of extensions) {
    if (!extensionEntry(id)) failIn("services", `${where} extends "${id}", which is not in the catalog`);
  }
  if (!apiEntry(api)) return failIn("services", `service "${service.id}" provides "${api}", which is not in the catalog`);

  const parts = partNames(api);
  if (!parts) return;
  for (const part of [...omits, ...only]) {
    if (!parts.has(part)) failIn("services", `${where} names "${part}", which is not a part of ${api}`);
  }
  for (const field of ["restricts", "defaults"] as const) {
    const declared = provision[field];
    if (declared === undefined) continue;
    if (!isObject(declared)) return failIn("services", `${where}.${field} must be an object`);
    for (const [name, value] of Object.entries(declared)) {
      if (!parts.has(`parameter:${name}`)) failIn("services", `${where}.${field} names "${name}", which is not a parameter of ${api}`);
      if (field === "defaults") {
        if (!isPrimitive(value)) failIn("services", `${where}.defaults.${name} must be a string, number or boolean`);
        continue;
      }
      if (!Array.isArray(value) || !value.every(isPrimitive)) failIn("services", `${where}.restricts.${name} must be an array of strings, numbers or booleans`);
      const listsValues = [...parts].some(p => p.startsWith(`value:${name}=`));
      if (!listsValues) continue;
      for (const v of value as unknown[]) {
        if (!parts.has(`value:${name}=${String(v)}`)) failIn("services", `${where}.restricts.${name} names value "${String(v)}", which ${api} does not define`);
      }
    }
  }
}

function checkDeclaredCall(service: Service, field: "load" | "unload", call: unknown): void {
  const owner = `service "${service.id}" models.${field}`;
  if (!isObject(call)) return failIn("services", `${owner} must be an object`);
  unknownKeys(owner, call, CALL_KEYS);
  if (typeof call.method !== "string") failIn("services", `${owner} has no method`);
  if (!METHODS.includes(call.method as string)) failIn("services", `${owner} has method "${String(call.method)}", which is not one of ${METHODS.join(", ")}`);
  if (typeof call.path !== "string" || !call.path.startsWith("/")) failIn("services", `${owner} has path "${String(call.path)}", which must begin with /`);

  const templates: string[] = [call.path as string];
  for (const part of ["query", "body"] as const) {
    const values = call[part];
    if (values === undefined) continue;
    if (!isObject(values)) return failIn("services", `${owner}.${part} must be an object`);
    for (const v of Object.values(values)) templates.push(typeof v === "string" ? v : "");
  }
  for (const placeholder of templates.join("\n").match(/\{[^}]*\}/g) ?? []) {
    if (placeholder !== "{model}") failIn("services", `${owner} uses ${placeholder}; {model} is the only placeholder`);
  }
}

function checkModels(service: Service): void {
  const models = service.models as unknown;
  if (models === undefined) return;
  const owner = `service "${service.id}" models`;
  if (!isObject(models)) return failIn("services", `${owner} must be an object`);
  unknownKeys(owner, models, MODELS_KEYS);
  if (models.loading !== "required" && models.loading !== "none") failIn("services", `${owner}.loading must be "required" or "none"`);
  for (const field of ["load", "unload"] as const) {
    if (models[field] !== undefined) checkDeclaredCall(service, field, models[field]);
  }
}

function checkLoadCalls(service: Service, roster: NodeRoster): void {
  const models = service.models;
  if (models?.loading === "required" && models.autoLoad === "never" && !hasLoadCall(service)) {
    failIn("services", `service "${service.id}" never loads a model on request and declares no load call`);
  }
  if (performs(service, "loadModel") && models?.load !== undefined) {
    failIn("services", `service "${service.id}" provides an API that loads models and also declares models.load`);
  }

  const served = roster.providers[service.id]?.serves ?? [];
  const sttModels = roster.sttModels ?? [];
  for (const { model } of served) {
    const entry = sttModels.find(m => m.id === model);
    if (!entry?.variants?.length || hasLoadCall(service)) continue;
    const carriesVariant = sttOperations(entry.kind).some(op => candidates(op, service, ["carries-variant"], []).length > 0);
    if (!carriesVariant) {
      failIn("services", `service "${service.id}" serves model "${model}", which has variants, but no provision carries a variant and the service declares no load call`);
    }
  }
}

/** Check 9: each roster provider has a candidate for what it is called for. */
function checkCandidates(service: Service, roster: NodeRoster): void {
  const provider = roster.providers[service.id];
  if (!provider) return;
  const ttsIds = new Set((roster.ttsModels ?? []).map(m => m.id));
  const sttModels = new Map((roster.sttModels ?? []).map(m => [m.id, m]));
  for (const { model } of provider.serves) {
    const operations: Operation[] = ttsIds.has(model) ? ["synthesize"] : sttOperations(sttModels.get(model)?.kind);
    if (!operations.some(op => candidates(op, service as SelectableService, op === "transcribeStream" ? ["client-endpointing"] : [], []).length > 0)) {
      const apis = (service.provides ?? []).map(p => p.api).join(", ") || "no API";
      failIn("roster", `provider "${service.id}" serves model "${model}" but no provision can ${operations.join(" or ")}: it provides ${apis}`);
    }
  }
}

/** Checks 1 to 9 over every service, against the roster the services are read with. */
export function validateProvisions(roster: NodeRoster, services: Service[]): void {
  for (const service of services) {
    checkModels(service);
    const provides = service.provides as unknown;
    if (provides !== undefined) {
      if (!Array.isArray(provides)) failIn("services", `service "${service.id}" provides must be an array`);
      const seen = new Set<string>();
      (provides as unknown[]).forEach((provision, i) => {
        checkProvision(service, provision, i);
        const api = (provision as { api: string }).api;
        if (seen.has(api)) failIn("services", `service "${service.id}" lists ${api} more than once`);
        seen.add(api);
      });
    }
    checkLoadCalls(service, roster);
  }
  for (const service of services) checkCandidates(service, roster);
}
