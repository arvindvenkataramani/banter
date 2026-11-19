# Set up the dsh voice plugin

Build the plugin, install it into a dsh profile, and start dsh. The plugin targets dsh `0.2.2-rc.1`.

## Prerequisites

- **A running Banter server with speech services.** The plugin takes its speech recognition and speech synthesis from Banter, so register at least one speech-to-text and one text-to-speech server there. [Install Banter](../../install.md) first, then [connect speech servers](../../speech-servers.md).
- **A checkout of this repository** with its dependencies installed (`bun install` at the repo root, which [the install script](../../install.md#install-script) also runs).
- **[Bun](https://bun.sh)** to build and install the plugin, and **Node.js** for `npx`.
- **A browser that allows the microphone** on the dsh page. `localhost` and `127.0.0.1` count as secure; see [the https note](../../install.md).

dsh runs from the command line, not as the desktop app:

```bash
npx @deepseek-ai/dsh@0.2.2-rc.1 web
```

## Build and install

From the repo root:

```bash
cd plugins/dsh/voice
bun run build
bun run install-profile web http://localhost:4200
```

`install-profile` takes a dsh profile name and the Banter server URL. `web` is the profile `dsh web` uses. It builds the package, adds it to that profile, and writes the plugin's settings. Replace the URL with your own.

### The Banter server URL

It is the address you open Banter at: the Banter server serves the web app and the speech relay from the same address. [The install script](../../install.md#install-script) prints it when it finishes (`http://localhost:4200` unless you changed the port), and it is the address you type into your browser to open Banter. Use the same address in the install command above.

### What install seeds

`install-profile` reads the voice configuration from the Banter server once and stores it in the profile's plugin settings:

- the Banter server URL;
- the selected provider, model, voice and speed, and the transcription provider;
- the roster the settings page chooses from: the providers, their models and their voices;
- the chunking, speech-detection and turn-taking values the server has set.

It changes nothing else in the profile. Those lists are copies taken at install time, so they do not follow later changes on the Banter server. After adding a voice, model or speech server in Banter, run the install command again to refresh them. Settings you changed on the plugin's page are replaced by the server's values when you do.

dsh keeps profiles under `~/.dsh`. To use another location, set `DSH_HOME` when you run the install command and when you start dsh.

## Start dsh

```bash
npx @deepseek-ai/dsh@0.2.2-rc.1 web
```

Open the address it prints. In dsh's **Plugins** page, make sure **@banter/dsh-voice** is on. When you turn it on, a short "Set up voice" dialog offers to ask for microphone access and checks the speech services; **Open settings** goes to the plugin's [settings](settings.md). Then open a conversation: the voice button is in the composer ([README](README.md#turn-voice-on)).

## If something is wrong

- **No voice button.** The plugin is off, or was installed into a different profile from the one dsh started with.
- **Provider, model or voice lists are empty or out of date.** Run the install command again.
- **Voice will not start.** Hover the red button for the reason. Check the Banter server URL on the General tab, and that the speech services are reachable from Banter.
