// Candidate selection (dev/specs/service-apis.md, section 6): which provision of a
// service performs an operation, read from the declarations alone.

import { adapterFor, type Adapter } from "./index";
import type { Basis, Capability, Operation, Provision, SelectableService } from "./types";

export interface Selection {
  operation: Operation;
  provision: Provision;
  adapter: Adapter;
}

export class SelectionRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectionRefusal";
  }
}

const kindOf = (part: string): string => part.slice(0, part.indexOf(":"));

/** A part holds when the provision neither omits it, excludes it by `only`, nor restricts its value away. */
export function partHolds(provision: Provision, part: string): boolean {
  if (provision.omits?.includes(part)) return false;
  // `only` states the implemented parts of each kind it names; the rest of those kinds are omitted.
  if (provision.only && !provision.only.includes(part) && provision.only.some(p => kindOf(p) === kindOf(part))) return false;
  const restricts = provision.restricts;
  if (!restricts) return true;
  if (part.startsWith("value:")) {
    const body = part.slice("value:".length);
    const at = body.indexOf("=");
    const allowed = restricts[body.slice(0, at)];
    return !allowed || allowed.map(String).includes(body.slice(at + 1));
  }
  if (part.startsWith("parameter:")) return restricts[part.slice("parameter:".length)]?.length !== 0;
  return true;
}

const extensionHolds = (provision: Provision, id: string): boolean => (provision.extends as string[] | undefined)?.includes(id) === true;

/** A requirement is an extension id or a part name; parts always contain a colon. */
const requirementHolds = (provision: Provision, name: string): boolean =>
  name.includes(":") ? partHolds(provision, name) : extensionHolds(provision, name);

function basisHolds(provision: Provision, basis: Basis): boolean {
  if (basis.part === undefined && basis.extension === undefined && !basis.spec) return false;
  return (basis.part === undefined || partHolds(provision, basis.part))
    && (basis.extension === undefined || extensionHolds(provision, basis.extension));
}

/** Whether the provision holds a basis for the capability, as its adapter declares them. */
export function capabilityHolds(provision: Provision, adapter: Adapter, capability: Capability): boolean {
  return adapter.capabilities[capability]?.some(basis => basisHolds(provision, basis)) === true;
}

/** Every candidate for the operation, best first. Ties keep `provides` order. */
export function candidates(
  operation: Operation,
  service: SelectableService,
  needs: Capability[],
  preferences: Capability[],
): Selection[] {
  const kept: Selection[] = [];
  for (const provision of service.provides ?? []) {
    const adapter = adapterFor(provision.api);
    if (!adapter?.operations.includes(operation)) continue;
    if (!(adapter.requires[operation] ?? []).every(name => requirementHolds(provision, name))) continue;
    if (!needs.every(need => capabilityHolds(provision, adapter, need))) continue;
    kept.push({ operation, provision, adapter });
  }
  const ranks = (s: Selection) => preferences.map(p => (capabilityHolds(s.provision, s.adapter, p) ? 0 : 1));
  return kept
    .map((selection, order) => ({ selection, order, rank: ranks(selection) }))
    .sort((a, b) => {
      for (let i = 0; i < preferences.length; i++) if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i];
      return a.order - b.order;
    })
    .map(entry => entry.selection);
}

/** The winning provision and its adapter, or a refusal naming the service, the operation and what it declares. */
export function select(
  operation: Operation,
  service: SelectableService,
  needs: Capability[],
  preferences: Capability[],
): Selection {
  const [winner] = candidates(operation, service, needs, preferences);
  if (winner) return winner;
  // INVENTED: spec silent on the wording for a service that declares no API.
  const declared = (service.provides ?? []).map(p => p.api).join(", ") || "no API";
  throw new SelectionRefusal(`${service.id} cannot ${operation}: it provides ${declared}`);
}
