// Whether a part of an API's spec is in play for a provision (dev/specs/service-apis.md, section 5).

import type { Provision } from "./types";

const kindOf = (part: string): string => part.slice(0, part.indexOf(":"));

/** A part holds when the provision neither omits it, excludes it by `only`, nor restricts its value away. */
export function partHolds(provision: Provision, part: string): boolean {
  if (provision.omits?.includes(part)) return false;
  // An omitted parameter accepts no values.
  if (part.startsWith("value:") && !partHolds(provision, `parameter:${part.slice("value:".length).split("=")[0]}`)) return false;
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
