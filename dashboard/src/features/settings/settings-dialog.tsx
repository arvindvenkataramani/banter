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
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
        aria-describedby={undefined}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="voice">
          <TabsList className="w-full">
            <TabsTrigger value="voice" className="flex-1">Voice</TabsTrigger>
            <TabsTrigger value="speech" className="flex-1">Speech</TabsTrigger>
            <TabsTrigger value="listening" className="flex-1">Listening</TabsTrigger>
            <TabsTrigger value="debug" className="flex-1">Debug</TabsTrigger>
          </TabsList>

          <TabsContent value="voice" className="mt-4">{voiceTab(voice.voice)}</TabsContent>
          <TabsContent value="speech" className="mt-4">{voiceTab(voice.speech)}</TabsContent>
          <TabsContent value="listening" className="mt-4">{voiceTab(voice.listening)}</TabsContent>
          <TabsContent value="debug" className="mt-4">{voiceTab(voice.debug)}</TabsContent>
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
