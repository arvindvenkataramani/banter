import { currentPage, voicePageSupport, type PageContext } from './voice-page-support'

export function PageSecurityNotice({ page = currentPage() }: { page?: PageContext }) {
  const support = voicePageSupport(page)
  if (support === 'ok') return null

  if (support === 'insecure') {
    return (
      <div role="alert" className="rounded-lg bg-destructive/10 text-destructive px-3 py-2 text-sm">
        Voice can't start on this page. Browsers only allow the microphone on a secure page, and this one
        is plain http. Open Banter over https, or at localhost on the machine running it.
      </div>
    )
  }

  return (
    <div role="status" className="rounded-lg bg-muted text-muted-foreground px-3 py-2 text-sm">
      Turn detection is running on one thread, so it responds more slowly. This page isn't cross-origin
      isolated: the Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers the Banter server sends
      aren't reaching the browser. A proxy in front of it may be removing them.
    </div>
  )
}
