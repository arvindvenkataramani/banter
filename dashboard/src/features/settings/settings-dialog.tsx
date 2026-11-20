import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useVoiceSettings } from './voice-settings'
import { PageSecurityNotice } from './page-security-notice'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SettingsDialog({ open, onOpenChange }: Props) {
  const [saving, setSaving] = useState(false)

  const voice = useVoiceSettings(open)
  const saveVoice = voice.save

  const save = useCallback(async () => {
    setSaving(true)
    try {
      if (!(await saveVoice())) return
      toast.success('Settings saved')
      onOpenChange(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save settings')
    } finally {
      setSaving(false)
    }
  }, [saveVoice, onOpenChange])

  const voiceTab = (panel: React.ReactNode) =>
    voice.status === 'loading' ? (
      <p className="py-6 text-sm text-muted-foreground">Loading…</p>
    ) : voice.status === 'unconfigured' ? (
      <p className="py-6 text-sm text-muted-foreground">Voice has no usable voice configured.</p>
    ) : panel

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* A click outside is too easy to make by accident to discard staged edits. */}
      <DialogContent
        // One fixed size for every tab, so switching tabs never resizes the dialog; the tab's content scrolls inside it.
        className="flex h-[min(85vh,56rem)] flex-col sm:max-w-3xl"
        aria-describedby={undefined}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <PageSecurityNotice />

        <Tabs defaultValue="speech" className="min-h-0 flex-1">
          <TabsList className="w-full shrink-0">
            <TabsTrigger value="speech" className="flex-1">Speech</TabsTrigger>
            <TabsTrigger value="listening" className="flex-1">Listening</TabsTrigger>
            <TabsTrigger value="general" className="flex-1">General</TabsTrigger>
            <TabsTrigger value="help" className="flex-1">Help</TabsTrigger>
          </TabsList>

          <TabsContent value="speech" className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">{voiceTab(voice.speech)}</TabsContent>
          <TabsContent value="listening" className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">{voiceTab(voice.listening)}</TabsContent>
          <TabsContent value="general" className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">{voiceTab(voice.general)}</TabsContent>
          <TabsContent value="help" className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">{voice.help ?? voiceTab(null)}</TabsContent>
        </Tabs>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
