import { useState } from 'react'
import { Sliders } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import type { SessionListEntry } from '@/lib/gateway-types'
import { SessionList } from './session-list'

interface ModelOption {
  id: string
  label: string
}

// Button defaults to font-medium and SelectTrigger sets its height via a
// data-attribute selector, so both need explicit overrides here.
const controlPill =
  'h-7 px-2 text-[12.5px] font-normal text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04]'

const selectPill = `${controlPill} data-[size=default]:h-7 border-transparent bg-transparent shadow-none gap-1 [&>svg]:w-[11px] [&>svg]:h-[11px] [&>svg]:opacity-70`

interface Props {
  agents: string[]
  currentAgent: string
  onAgentChange: (id: string) => void
  models: ModelOption[]
  currentModel: string
  onModelChange: (id: string) => void
  contextUsage: string | null
  contextWarning: boolean
  onNewSession: () => void
  sessions: SessionListEntry[]
  currentSessionName: string
  onSelectSession: (name: string) => void
  voiceControls?: React.ReactNode
}

export function ControlBar({
  agents,
  currentAgent,
  onAgentChange,
  models,
  currentModel,
  onModelChange,
  contextUsage,
  contextWarning,
  onNewSession,
  sessions,
  currentSessionName,
  onSelectSession,
  voiceControls,
}: Props) {
  const [sessionOpen, setSessionOpen] = useState(false)

  return (
    <div className="flex items-center gap-1 py-2 border-b border-border/60 shrink-0">
      {/* Agent/model — quiet pills on desktop, dialog on mobile */}
      <div className="hidden md:flex items-center gap-1">
        <Select value={currentAgent} onValueChange={onAgentChange}>
          <SelectTrigger className={selectPill}>
            <SelectValue placeholder="Agent" />
          </SelectTrigger>
          <SelectContent>
            {agents.map((id) => (
              <SelectItem key={id} value={id}>{id}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={currentModel} onValueChange={onModelChange}>
          <SelectTrigger className={selectPill}>
            <SelectValue placeholder="Model" />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <SessionHistoryDialog
          sessions={sessions}
          currentSessionName={currentSessionName}
          onSelectSession={onSelectSession}
        />
      </div>

      <div className="md:hidden">
        <SessionConfigSheet
          agents={agents}
          currentAgent={currentAgent}
          onAgentChange={onAgentChange}
          models={models}
          currentModel={currentModel}
          onModelChange={onModelChange}
          sessions={sessions}
          currentSessionName={currentSessionName}
          onSelectSession={onSelectSession}
        />
      </div>

      <AlertDialog open={sessionOpen} onOpenChange={setSessionOpen}>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="sm" className={controlPill}>New</Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start a new conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              The current conversation will be preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { onNewSession(); setSessionOpen(false) }}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Data, not a control — stays mono so digits don't jitter, but sized to
          sit on the same line as the pills. */}
      {contextUsage && (
        <span className={`font-mono text-[11.5px] whitespace-nowrap px-1.5 ${contextWarning ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>{contextUsage}</span>
      )}

      {voiceControls && (
        <div className="ml-auto flex items-center gap-2">
          {voiceControls}
        </div>
      )}
    </div>
  )
}

// Mobile: one surface holding the session controls and the conversation list.
function SessionConfigSheet({
  agents,
  currentAgent,
  onAgentChange,
  models,
  currentModel,
  onModelChange,
  sessions,
  currentSessionName,
  onSelectSession,
}: {
  agents: string[]
  currentAgent: string
  onAgentChange: (id: string) => void
  models: ModelOption[]
  currentModel: string
  onModelChange: (id: string) => void
  sessions: SessionListEntry[]
  currentSessionName: string
  onSelectSession: (name: string) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <Sliders className="h-4 w-4" />
        </Button>
      </SheetTrigger>
      {/* data-[side=bottom]:h-[85vh] — SheetContent sets h-auto through a
          data-attribute selector, which outranks a plain h-[85vh]. */}
      <SheetContent side="bottom" className="flex flex-col gap-0 p-0 data-[side=bottom]:h-[85vh]" aria-describedby={undefined}>
        <SheetHeader className="shrink-0 px-4 pr-12 pb-2">
          <SheetTitle>Session</SheetTitle>
        </SheetHeader>

        <div className="flex shrink-0 flex-col gap-4 px-4 pb-4">
          <div className="flex flex-col gap-1.5">
            <Label>Agent</Label>
            <Select value={currentAgent} onValueChange={onAgentChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {agents.map((id) => (
                  <SelectItem key={id} value={id}>{id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Model</Label>
            <Select value={currentModel} onValueChange={onModelChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <Separator />

        {/* pb-[env(safe-area-inset-bottom)] keeps the last row clear of the
            iPhone home indicator instead of ending flush at the screen edge. */}
        <div className="min-h-0 min-w-0 flex-1 px-2 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <SessionList
            sessions={sessions}
            currentSessionName={currentSessionName}
            onSelect={(name) => { onSelectSession(name); setOpen(false) }}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}

// Desktop: the pills stay inline; history gets its own dialog so rows have room
// for a title, preview, and timestamp.
function SessionHistoryDialog({
  sessions,
  currentSessionName,
  onSelectSession,
}: {
  sessions: SessionListEntry[]
  currentSessionName: string
  onSelectSession: (name: string) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className={controlPill}>
          History
        </Button>
      </DialogTrigger>
      <DialogContent className="gap-0 p-0 sm:max-w-xl" aria-describedby={undefined}>
        {/* h-8 + justify-center centres the title against the 32px close
            button, which is absolutely positioned at the same top edge; pr-12
            keeps the text clear of it. */}
        <DialogHeader className="flex h-8 justify-center px-6 pt-[1.625rem] pr-12">
          <DialogTitle>Conversations</DialogTitle>
        </DialogHeader>
        {/* min-w-0: this is a grid item, and grid/flex items default to
            min-width:auto — without it the list stretches to its widest row
            and drags the dialog off-screen instead of truncating. */}
        <div className="h-[min(28rem,60vh)] min-w-0 px-4 pt-4 pb-4">
          <SessionList
            sessions={sessions}
            currentSessionName={currentSessionName}
            onSelect={(name) => { onSelectSession(name); setOpen(false) }}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
