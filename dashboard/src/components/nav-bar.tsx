import { Monitor, Moon, Sun, ChevronDown, Server, Settings, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { BanterIcon } from '@/components/icons'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { getTheme, setTheme, type Theme } from '@/lib/theme'
import { useState } from 'react'

type NavOption = {
  path: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  href?: string
}

const NAV_OPTIONS: NavOption[] = [
  { path: '/', label: 'Chat', icon: BanterIcon },
  { path: '/services', label: 'Services', icon: Server },
]

const THEME_OPTIONS: { value: Theme; label: string; icon: React.ReactNode }[] = [
  { value: 'light', label: 'Light', icon: <Sun className="size-4" /> },
  { value: 'dark', label: 'Dark', icon: <Moon className="size-4" /> },
  { value: 'system', label: 'System', icon: <Monitor className="size-4" /> },
]

function themeIcon(t: Theme) {
  if (t === 'light') return <Sun className="size-4" />
  if (t === 'dark') return <Moon className="size-4" />
  return <Monitor className="size-4" />
}

interface NavBarProps {
  currentPath: string
  onNavigate: (path: string) => void
}

export function NavBar({ currentPath, onNavigate }: NavBarProps) {
  const [theme, setThemeState] = useState<Theme>(getTheme)
  const [reloading, setReloading] = useState(false)

  function handleTheme(t: Theme) {
    setTheme(t)
    setThemeState(t)
  }

  async function reloadConfig() {
    setReloading(true)
    try {
      const res = await fetch('/api/config/reload', { method: 'POST' })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`${res.status} ${detail}`)
      }
      toast.success('Config reloaded — refreshing…')
      // Re-fetch every cached endpoint by reloading the page.
      setTimeout(() => window.location.reload(), 400)
    } catch (err) {
      setReloading(false)
      toast.error(`Reload failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const allOptions: NavOption[] = NAV_OPTIONS

  // `/chat` is an alias for the root chat route; both light up the same tab.
  const activePath = currentPath === '/chat' ? '/' : currentPath
  const current = allOptions.find(o => o.path === activePath)
  const currentLabel = current?.label ?? 'Menu'
  const CurrentIcon = current?.icon ?? BanterIcon

  return (
    <header className="z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 pt-[env(safe-area-inset-top)]">
      <div className="flex h-12 items-center gap-4 px-4">
        <button
          type="button"
          onClick={() => onNavigate('/')}
          className="font-semibold text-sm tracking-tight hover:text-foreground/80 cursor-pointer bg-transparent border-0 p-0"
          aria-label="Go to home"
        >
          Banter
        </button>

        {/* Desktop: inline tabs */}
        <div className="flex-1 hidden md:flex items-center gap-2">
          <Tabs value={activePath} onValueChange={onNavigate}>
            <TabsList>
              {NAV_OPTIONS.map(({ path, label, icon: Icon }) => (
                <TabsTrigger key={path} value={path} className="gap-1.5">
                  <Icon className="size-3.5" />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {/* Mobile: dropdown menu */}
        <div className="flex-1 md:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5">
                <CurrentIcon className="size-3.5" />
                {currentLabel}
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {allOptions.map(({ path, label, icon: Icon }) => (
                <DropdownMenuItem
                  key={path}
                  onClick={() => onNavigate(path)}
                  className="gap-2"
                >
                  <Icon className="size-4" />
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {__COMMIT_SHA__ && (
          <span className="text-xs text-muted-foreground font-mono hidden md:inline">
            dev: {__COMMIT_SHA__}
          </span>
        )}

        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5 pr-1.5 text-muted-foreground hover:text-foreground">
                {themeIcon(theme)}
                <span className="text-xs capitalize hidden sm:inline">{theme}</span>
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {THEME_OPTIONS.map(({ value, label, icon }) => (
                <DropdownMenuItem
                  key={value}
                  onClick={() => handleTheme(value)}
                  className="gap-2"
                >
                  {icon}
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Settings" className="text-muted-foreground hover:text-foreground">
                <Settings className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={reloadConfig} disabled={reloading} className="gap-2">
                <RefreshCw className={`size-4${reloading ? ' animate-spin' : ''}`} />
                Reload config
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  )
}
