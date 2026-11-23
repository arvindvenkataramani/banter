// Merges the node rosters into one (docs/reference/design/model-roster.md, "The assembler").
// Recordings and preset keys stay on the node that declares them.

import type { NodeRoster, ResponseFormat, Serving, SttModel, TtsModel } from "../../../shared/types";

export interface AssembledProvider {
  serviceId: string;
  hostId: string;
  reachable: boolean;
  name: string;
  responseFormat: ResponseFormat;
  resolvesVoices?: boolean;
  /** Whether this provider's streaming socket understands session ids and take-over. */
  sessions?: boolean;
  serves: Serving[];
}

export interface AssembledVoice {
  id: string;
  name: string;
  renderings: { model: string; method: "preset" | "clone" }[];
}

export interface RosterCollision {
  kind: "model" | "voice";
  id: string;
  hostIds: string[];
}

export interface AssembledRoster {
  ttsModels: TtsModel[];
  sttModels: SttModel[];
  providers: AssembledProvider[];
  voices: AssembledVoice[];
  collisions: RosterCollision[];
}

export function emptyAssembly(): AssembledRoster {
  return { ttsModels: [], sttModels: [], providers: [], voices: [], collisions: [] };
}

export interface AssembleRosterArgs {
  local: { hostId: string; roster: NodeRoster };
  /** `roster` is null only for a shard never successfully polled. An
   *  unreachable shard's last known roster is still passed, so its
   *  providers are kept and flagged rather than dropped. */
  shards: { hostId: string; roster: NodeRoster | null; reachable: boolean }[];
  nameFor: (serviceId: string) => string | undefined;
}

export function assembleRoster(args: AssembleRosterArgs): AssembledRoster {
  const { local, shards, nameFor } = args;

  // The control plane is always reachable: it is answering the request.
  const nodes = [
    { hostId: local.hostId, roster: local.roster, reachable: true },
    ...shards.map(s => ({ hostId: s.hostId, roster: s.roster, reachable: s.reachable })),
  ].filter((n): n is { hostId: string; roster: NodeRoster; reachable: boolean } => n.roster !== null);

  // An id declared on more than one node is excluded everywhere and reported:
  // a silent winner is the failure this design exists to remove.
  const modelHosts = new Map<string, string[]>();
  const voiceHosts = new Map<string, string[]>();
  for (const node of nodes) {
    for (const m of [...(node.roster.ttsModels ?? []), ...(node.roster.sttModels ?? [])]) {
      modelHosts.set(m.id, [...(modelHosts.get(m.id) ?? []), node.hostId]);
    }
    for (const v of node.roster.voices) voiceHosts.set(v.id, [...(voiceHosts.get(v.id) ?? []), node.hostId]);
  }
  const excluded = (hosts: Map<string, string[]>) => new Set([...hosts].filter(([, h]) => new Set(h).size > 1).map(([id]) => id));
  const badModels = excluded(modelHosts);
  const badVoices = excluded(voiceHosts);

  const collisions: RosterCollision[] = [
    ...[...badModels].map(id => ({ kind: "model" as const, id, hostIds: [...new Set(modelHosts.get(id)!)] })),
    ...[...badVoices].map(id => ({ kind: "voice" as const, id, hostIds: [...new Set(voiceHosts.get(id)!)] })),
  ];

  const ttsModels: TtsModel[] = [];
  const sttModels: SttModel[] = [];
  const providers: AssembledProvider[] = [];
  const voices: AssembledVoice[] = [];
  for (const node of nodes) {
    ttsModels.push(...(node.roster.ttsModels ?? []).filter(m => !badModels.has(m.id)));
    sttModels.push(...(node.roster.sttModels ?? []).filter(m => !badModels.has(m.id)));
  }
  const kept = new Set([...ttsModels, ...sttModels].map(m => m.id));
  const keptTts = new Set(ttsModels.map(m => m.id));

  for (const node of nodes) {
    for (const [serviceId, p] of Object.entries(node.roster.providers)) {
      providers.push({
        serviceId,
        hostId: node.hostId,
        reachable: node.reachable,
        name: nameFor(serviceId) ?? serviceId,
        responseFormat: p.responseFormat ?? "mp3",
        ...(p.resolvesVoices !== undefined && { resolvesVoices: p.resolvesVoices }),
        ...(p.sessions !== undefined && { sessions: p.sessions }),
        serves: (p.serves ?? []).filter(s => kept.has(s.model)),
      });
    }
    for (const v of node.roster.voices) {
      if (badVoices.has(v.id)) continue;
      voices.push({
        id: v.id,
        name: v.name,
        renderings: (v.renderings ?? []).filter(r => keptTts.has(r.model)).map(r => ({ model: r.model, method: r.method })),
      });
    }
  }

  return { ttsModels, sttModels, providers, voices, collisions };
}
