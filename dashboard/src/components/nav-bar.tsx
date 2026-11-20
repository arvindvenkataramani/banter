import { MonitorIcon } from '@phosphor-icons/react/dist/csr/Monitor'
import { MoonIcon } from '@phosphor-icons/react/dist/csr/Moon'
import { SunIcon } from '@phosphor-icons/react/dist/csr/Sun'
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown'
import { HardDrivesIcon } from '@phosphor-icons/react/dist/csr/HardDrives'
import { GearSixIcon } from '@phosphor-icons/react/dist/csr/GearSix'
import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise'
import { SlidersHorizontalIcon } from '@phosphor-icons/react/dist/csr/SlidersHorizontal'
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
import { useEffect, useState } from 'react'
import { SettingsDialog } from '@/features/settings/settings-dialog'
import { postConfigReload } from '@/lib/api'

const RELOAD_PART_LABELS = { config: 'Config', registry: 'Registry' } as const

type NavOption = {
  path: string
  label: string
  icon: React.ComponentType<{ className?: string; weight?: "bold" }>
  href?: string
}

const NAV_OPTIONS: NavOption[] = [
  { path: '/', label: 'Chat', icon: BanterIcon },
  { path: '/services', label: 'Services', icon: HardDrivesIcon },
]

const THEME_OPTIONS: { value: Theme; label: string; icon: React.ReactNode }[] = [
  { value: 'light', label: 'Light', icon: <SunIcon weight="bold" className="size-4" /> },
  { value: 'dark', label: 'Dark', icon: <MoonIcon weight="bold" className="size-4" /> },
  { value: 'system', label: 'System', icon: <MonitorIcon weight="bold" className="size-4" /> },
]

function themeIcon(t: Theme) {
  if (t === 'light') return <SunIcon weight="bold" className="size-4" />
  if (t === 'dark') return <MoonIcon weight="bold" className="size-4" />
  return <MonitorIcon weight="bold" className="size-4" />
}

interface NavBarProps {
  currentPath: string
  onNavigate: (path: string) => void
}

export function NavBar({ currentPath, onNavigate }: NavBarProps) {
  const [theme, setThemeState] = useState<Theme>(getTheme)
  const [reloading, setReloading] = useState(false)
  // A link with ?settings (the dsh plugin's "Open voice settings in Banter") opens the dialog on load.
  const [settingsOpen, setSettingsOpen] = useState(() => new URLSearchParams(window.location.search).has('settings'))
  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('settings')) return
    url.searchParams.delete('settings')
    window.history.replaceState(window.history.state, '', url)
  }, [])

  function handleTheme(t: Theme) {
    setTheme(t)
    setThemeState(t)
  }

  async function reloadConfig() {
    setReloading(true)
    const result = await postConfigReload()
    if (!result.ok) {
      setReloading(false)
      toast.error(`Reload failed: ${result.error}`)
      return
    }

    const { config, registry, shards, warnings } = result.response
    const failedParts: string[] = []
    if (!config.ok) failedParts.push(`${RELOAD_PART_LABELS.config}: ${config.error}`)
    if (!registry.ok) failedParts.push(`${RELOAD_PART_LABELS.registry}: ${registry.error}`)
    for (const [hostId, part] of Object.entries(shards)) {
      if (!part.ok) failedParts.push(`${hostId}: ${part.error}`)
    }

    // Only refresh on a clean reload — otherwise the page would refresh out
    // from under the toasts.
    if (failedParts.length === 0 && warnings.length === 0) {
      toast.success('Config reloaded — refreshing…')
      setTimeout(() => window.location.reload(), 400)
      return
    }

    for (const failure of failedParts) toast.error(failure)
    for (const warning of warnings) toast.warning(warning.message)
    setReloading(false)
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
                  <Icon weight="bold" className="size-3.5" />
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
                <CurrentIcon weight="bold" className="size-3.5" />
                {currentLabel}
                <CaretDownIcon weight="bold" className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {allOptions.map(({ path, label, icon: Icon }) => (
                <DropdownMenuItem
                  key={path}
                  onClick={() => onNavigate(path)}
                  className="gap-2"
                >
                  <Icon weight="bold" className="size-4" />
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
                <CaretDownIcon weight="bold" className="size-3" />
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
                <GearSixIcon weight="bold" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setSettingsOpen(true)} className="gap-2">
                <SlidersHorizontalIcon weight="bold" className="size-4" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem onClick={reloadConfig} disabled={reloading} className="gap-2">
                <ArrowClockwiseIcon weight="bold" className={`size-4${reloading ? ' animate-spin' : ''}`} />
                Reload config
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </header>
  )
}
