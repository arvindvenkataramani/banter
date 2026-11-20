// The rules for the Banter server URL field: what it saves, and what it refuses.

export type ServerUrl = { ok: true; url: string } | { ok: false; problem: string }

/** Trims, drops trailing slashes and accepts only an absolute http or https URL; an empty value is unset. */
export function normaliseServerUrl(input: string): ServerUrl {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (trimmed === '') return { ok: true, url: '' }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, problem: 'Enter a full address, starting with http:// or https://' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, problem: 'Enter a full address, starting with http:// or https://' }
  }
  if (parsed.hostname === '') return { ok: false, problem: 'The address has no host name' }
  return { ok: true, url: trimmed }
}
