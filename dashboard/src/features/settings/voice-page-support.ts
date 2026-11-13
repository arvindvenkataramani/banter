export interface PageContext {
  isSecureContext: boolean
  crossOriginIsolated: boolean
}

export type VoicePageSupport = 'ok' | 'insecure' | 'not-isolated'

/**
 * What this page lets voice do. Browsers grant the microphone only to a secure
 * context (https, or localhost), and grant SharedArrayBuffer, which the voice
 * models need to run multi-threaded, only to a cross-origin isolated page,
 * which must itself be secure.
 */
export function voicePageSupport(page: PageContext): VoicePageSupport {
  if (!page.isSecureContext) return 'insecure'
  if (!page.crossOriginIsolated) return 'not-isolated'
  return 'ok'
}

export function currentPage(): PageContext {
  return { isSecureContext: self.isSecureContext, crossOriginIsolated: self.crossOriginIsolated }
}
