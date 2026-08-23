import { useState, useEffect, useCallback } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NavBar } from '@/components/nav-bar'
import { ServicesPage } from '@/features/services/page'
import { ChatPage } from '@/features/chat/page'
import { GatewayProvider } from '@/lib/gateway-context'

function readRoute() {
  const path = window.location.pathname || '/'
  const params = new URLSearchParams(window.location.search)
  return { path, filter: params.get('filter') ?? '' }
}

export function App() {
  const [{ path, filter }, setRoute] = useState(readRoute)

  const navigate = useCallback((newPath: string, newFilter?: string) => {
    const url = new URL(window.location.href)
    url.pathname = newPath
    if (newFilter !== undefined) {
      if (newFilter) url.searchParams.set('filter', newFilter)
      else url.searchParams.delete('filter')
    } else {
      url.searchParams.delete('filter')
    }
    history.pushState(null, '', url.toString())
    setRoute({ path: newPath, filter: newFilter ?? '' })
  }, [])

  useEffect(() => {
    function onPop() { setRoute(readRoute()) }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    const titles: Record<string, string> = {
      '/': 'Chat',
      '/chat': 'Chat',
      '/services': 'Services',
    }
    const label = titles[path]
    document.title = label ? `Banter — ${label}` : 'Banter'
  }, [path])

  function onNavigate(newPath: string) {
    navigate(newPath)
  }

  const isChat = path === '/' || path === '/chat'

  return (
    <GatewayProvider>
    <TooltipProvider>
    <div className="h-dvh flex flex-col overflow-hidden">
      <NavBar currentPath={path} onNavigate={onNavigate} />
      {isChat ? (
        <ChatPage filter={filter} navigate={navigate} />
      ) : (
        <main className="flex-1 overflow-y-auto p-4">
          {path === '/services' && <ServicesPage filter={filter} navigate={navigate} />}
        </main>
      )}
      <Toaster />
    </div>
    </TooltipProvider>
    </GatewayProvider>
  )
}

export default App
