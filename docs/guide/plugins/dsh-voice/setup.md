# Set up the dsh voice plugin

Build the plugin, install it into a dsh profile, and start dsh. Tested with dsh 0.2.2-rc.5. The plugin declares `>=0.2.2-rc.5`, so newer dsh versions load it; if a later dsh changes something the plugin relies on, it may stop working.

## Prerequisites

- **A running Banter server with speech services, reachable at the Banter server URL in the plugin's settings.** The plugin is required to use Banter's voice from DeepSeek Harness, and it is the only way to get voice there. It takes its speech recognition and speech synthesis from Banter, so register at least one speech-to-text and one text-to-speech server there: [install Banter](../../install.md) first, then [connect speech servers](../../speech-servers.md). The plugin's speech traffic and the starting of speech services go through that server. Without it, turning voice on fails and the voice button shows the error colour.
- **A checkout of this repository** with its dependencies installed (`bun install` at the repo root, which [the install script](../../install.md#install-script) also runs).
- **[Bun](https://bun.sh)** to build and install the plugin, and **Node.js** for `npx`.
- **A browser that allows the microphone** on the dsh page. `localhost` and `127.0.0.1` count as secure; see [the https note](../../install.md).

dsh runs from the command line, not as the desktop app:

```bash
npx @deepseek-ai/dsh web
```

## Build and install

From the repo root:

```bash
cd plugins/dsh/voice
bun run build
bun run install-profile web http://localhost:4200
```

`install-profile` takes a dsh profile name and the Banter server URL. `web` is the profile `dsh web` uses. It builds the package, adds it to that profile, and writes the Banter server URL. Replace the URL with your own.

### The Banter server URL

It is the address you open Banter at: the Banter server serves the web app and the speech relay from the same address. [The install script](../../install.md#install-script) prints it when it finishes (`http://localhost:4200` unless you changed the port), and it is the address you type into your browser to open Banter. Use the same address in the install command above.

### What install writes

`install-profile` first checks that the Banter server answers at the URL, and stops with a message if it does not. It then writes one setting into the profile's plugin settings: the Banter server URL. It changes nothing else in the profile.

The voice settings stay on the Banter server, and the plugin reads them from there. Change them in Banter's settings dialog; the plugin's [settings page](settings.md#voice-settings) shows what is in use and has a link to the dialog.

dsh keeps profiles under `~/.dsh`. To use another location, set `DSH_HOME` when you run the install command and when you start dsh.

## Start dsh

```bash
npx @deepseek-ai/dsh web
```

Open the address it prints. In dsh's **Plugins** page, make sure **@banter/dsh-voice** is on. When you turn it on, a short "Set up voice" dialog offers to ask for microphone access and checks the speech services; **Open settings** goes to the plugin's [settings](settings.md). Then open a conversation: the voice button is in the composer ([README](README.md#turn-voice-on)).

## If something is wrong

- **No voice button.** The plugin is off, or was installed into a different profile from the one dsh started with.
- **Voice will not start.** Hover the red button for the reason. Check the Banter server URL on the plugin's settings page, and that the speech services are reachable from Banter.
