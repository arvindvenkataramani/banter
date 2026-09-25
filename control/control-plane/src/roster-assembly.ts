import type { NodeRoster, Provider, ResponseFormat, VoiceModel, VoiceReference } from "../../../shared/types";

export interface AssembledProvider {
  serviceId: string;
  hostId: string;
  reachable: boolean;
  name: string;
  responseFormat: ResponseFormat;
  ttsModels?: Provider["ttsModels"];
  sttModels?: Provider["sttModels"];
  /** Whether this provider's streaming socket understands session ids and take-over. */
  sessions?: boolean;
}

export interface AssembledVoice {
  id: string;
  name: string;
  models: (VoiceModel & { hostId: string; references: VoiceReference[] })[];
}

export interface RosterCollision {
  kind: "model" | "voice-name";
  id: string;
  hostIds: string[];
}

export interface AssembledRoster {
  providers: AssembledProvider[];
  voices: AssembledVoice[];
  collisions: RosterCollision[];
}

export interface AssembleRosterArgs {
  local: { hostId: string; roster: NodeRoster };
  /** `roster` is null only for a shard never successfully polled. An
   *  unreachable shard's last known roster is still passed, so its
   *  providers are kept and flagged rather than dropped. */
  shards: { hostId: string; roster: NodeRoster | null; reachable: boolean }[];
  nameFor: (serviceId: string) => string | undefined;
}

/** The control plane is always reachable — it is answering the request
 *  that asked for this. */
function nodeContributions(
  hostId: string,
  roster: NodeRoster,
  reachable: boolean,
  nameFor: (serviceId: string) => string | undefined
): { providers: AssembledProvider[]; voiceLinks: Map<string, { link: VoiceModel; hostId: string; name: string; references: VoiceReference[] }[]> } {
  const providers: AssembledProvider[] = Object.entries(roster.providers).map(([serviceId, p]) => ({
    serviceId,
    hostId,
    reachable,
    name: nameFor(serviceId) ?? serviceId,
    responseFormat: p.responseFormat ?? "mp3",
    ...(p.ttsModels !== undefined && { ttsModels: p.ttsModels }),
    ...(p.sttModels !== undefined && { sttModels: p.sttModels }),
    ...(p.sessions !== undefined && { sessions: p.sessions }),
  }));

  const voiceLinks = new Map<string, { link: VoiceModel; hostId: string; name: string; references: VoiceReference[] }[]>();
  for (const voice of roster.voices) {
    const entries = voice.models.map(link => ({
      link,
      hostId,
      name: voice.name,
      references: voice.references ?? [],
    }));
    voiceLinks.set(voice.id, entries);
  }

  return { providers, voiceLinks };
}

export function assembleRoster(args: AssembleRosterArgs): AssembledRoster {
  const { local, shards, nameFor } = args;

  const allProviders: AssembledProvider[] = [];
  // Entries are kept in first-seen order: the control plane, then shards in
  // the order given.
  const voiceEntries = new Map<string, { link: VoiceModel; hostId: string; name: string; references: VoiceReference[] }[]>();
  const voiceNameByFirstSeen = new Map<string, string>();

  const nodes = [
    { hostId: local.hostId, roster: local.roster, reachable: true },
    ...shards.map(s => ({ hostId: s.hostId, roster: s.roster, reachable: s.reachable })),
  ];

  for (const node of nodes) {
    if (node.roster === null) continue; // never polled — nothing to contribute
    const { providers, voiceLinks } = nodeContributions(node.hostId, node.roster, node.reachable, nameFor);
    allProviders.push(...providers);
    for (const [voiceId, entries] of voiceLinks) {
      if (!voiceNameByFirstSeen.has(voiceId)) voiceNameByFirstSeen.set(voiceId, entries[0].name);
      const existing = voiceEntries.get(voiceId) ?? [];
      voiceEntries.set(voiceId, [...existing, ...entries]);
    }
  }

  // A model id declared by more than one provider is excluded from all of
  // them and reported, rather than left ambiguously routable.
  const modelHosts = new Map<string, Set<string>>();
  for (const provider of allProviders) {
    for (const model of provider.ttsModels ?? []) {
      const hosts = modelHosts.get(model.id) ?? new Set<string>();
      hosts.add(provider.hostId);
      modelHosts.set(model.id, hosts);
    }
  }
  const collidingModelIds = new Set([...modelHosts.entries()].filter(([, hosts]) => hosts.size > 1).map(([id]) => id));
  const collisions: RosterCollision[] = [];
  for (const id of collidingModelIds) {
    collisions.push({ kind: "model", id, hostIds: [...modelHosts.get(id)!] });
  }
  const providers: AssembledProvider[] = collidingModelIds.size === 0
    ? allProviders
    : allProviders.map(p =>
        p.ttsModels === undefined
          ? p
          : { ...p, ttsModels: p.ttsModels.filter(m => !collidingModelIds.has(m.id)) }
      );

  // Same voice id, different names on different nodes: the first-seen name
  // wins, and every distinct name involved is reported.
  const voices: AssembledVoice[] = [];
  for (const [voiceId, entries] of voiceEntries) {
    const names = new Set(entries.map(e => e.name));
    if (names.size > 1) {
      collisions.push({ kind: "voice-name", id: voiceId, hostIds: [...new Set(entries.map(e => e.hostId))] });
    }
    voices.push({
      id: voiceId,
      name: voiceNameByFirstSeen.get(voiceId)!,
      models: entries.map(e => ({ ...e.link, hostId: e.hostId, references: e.references })),
    });
  }

  return { providers, voices, collisions };
}
