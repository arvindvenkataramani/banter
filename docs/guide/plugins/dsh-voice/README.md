# Voice for dsh

A plugin that adds Banter's voice mode to the web UI of dsh (DeepSeek Harness). dsh keeps the conversation, its composer and its run controls. The plugin adds a few buttons to the composer: you talk, your words appear in the text box and are sent when you finish a turn, and the reply is spoken back. You can cut in while it speaks, and type at any time.

Speech recognition and speech synthesis come from a Banter server you run; see [setup.md](setup.md). The plugin's [settings page](settings.md) picks the voice, the transcription provider and how patient the turn-taking is.

## Turn voice on

Install the plugin ([setup.md](setup.md)), then open a conversation in dsh. The microphone button in the composer's tool row turns voice on; the first time, allow microphone access when the browser asks.

![The dsh composer with the voice button circled at the right of the tool row.](images/turn-on.png)

*The voice button is the microphone at the right of the composer's tool row.*

Press it. A spinner shows while voice starts; press the spinner to cancel. Once voice is on, speak.

## The controls

State is shown by colour on the buttons, never by text. Hover a button for its name.

| Button | What it shows |
|---|---|
| Microphone, plain | Voice is off. Press to turn it on. |
| Spinner | Voice is starting. Press to cancel. |
| Microphone, green | Voice is on and listening. |
| Microphone, green on a green tint | It hears you speaking. |
| Microphone with a slash, amber | The mic is muted. Press to unmute. |
| Microphone with a slash, amber outline | The mic is muted because you are typing; see below. |
| Speaker, plain | Speech is on. Press to mute speech only. |
| Speaker, green tint | The reply is being spoken. |
| Speaker with a cross, amber | Speech is muted. Press to unmute. |
| Broken link | The mic and speech are muted separately. Press to link them again. It appears only then. |
| Cross | Turn voice off. Red when voice has a problem: hover it for the reason. |

While the mic and speech are linked, the mic button mutes and unmutes both together. Muting speech alone stops the reply being spoken without stopping what the agent does.

![The composer while voice is on and hearing speech: the speaker, microphone and cross buttons, with the microphone green on a tint.](images/listening.png)

*Staged: the page was set into the listening state for this capture, with no microphone or speech service in use.*

If voice cannot start, the microphone button turns red and its tooltip gives the reason. Press it to try again. When another dsh session is using the transcription server, the tooltip says so, and pressing the button takes it over.

## The mic shortcut

While voice is on, a keyboard shortcut mutes and unmutes the mic.

| Platform | Shortcut |
|---|---|
| macOS | Command + Option + M |
| Windows | Ctrl + Alt + M |
| Linux | Ctrl + Shift + comma |

It is the command "Mute or unmute the voice mic" in dsh's shortcut settings, where you can rebind it. It works from the text box too, and does nothing while voice is off.

## Typing while voice is on

Your speech appears in the composer's text box as you talk, and is sent when your turn ends. If you type in the box:

- The mic mutes itself, so spoken words never land in the middle of your text. The mic button shows the amber outline.
- Your text stays as you typed it; voice does not write over it.
- Press Send as usual and the mute ends: voice goes back to listening.
- Or unmute the mic by hand, with the button or the shortcut. Your text is kept, and what you say next is added after it.

If the box already holds text when voice turns on, voice starts muted in the same way.

## Where next

- [setup.md](setup.md): build, install and start.
- [settings.md](settings.md): every setting on the plugin's page.
