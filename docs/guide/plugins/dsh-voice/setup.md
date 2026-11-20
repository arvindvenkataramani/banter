# Set up the dsh voice plugin

Build the plugin, install it into a dsh profile, and start dsh. Tested with dsh 0.2.2-rc.5. The plugin declares `>=0.2.2-rc.5`, so newer dsh versions load it; if a later dsh changes something the plugin relies on, it may stop working.

## Prerequisites

- **A running Banter server with speech services, reachable at the Banter server URL in the plugin's settings.** The plugin is required to use Banter's voice from DeepSeek Harness, and it is the only way to get voice there. It takes its speech recognition and speech synthesis from Banter, so register at least one speech-to-text and one text-to-speech server there: [install Banter](../../install.md) first, then [connect speech servers](../../speech-servers.md). The plugin's speech traffic and the starting of speech services go through that server. Without it, turning voice on fails and the voice button shows the error colour.
- **A checkout of this repository** with its dependencies installed (`bun install` at the repo root, which [the install script](../../install.md#install-script) also runs).
- **[Bun](https://bun.sh)** to build and install the plugin, **pnpm**, which dsh's plugin command uses, and **Node.js** for `npx`.
- **A browser that allows the microphone** on the dsh page. `localhost` and `127.0.0.1` count as secure; see [the https note](../../install.md).

The plugin runs in the DeepSeek Harness desktop app and in `dsh web` (`npx @deepseek-ai/dsh web`). Each keeps its own dsh profile: `desktop` for the app, `web` for `dsh web`.

## Build and install

From the repo root:

```bash
ops/dsh-plugin-install.sh http://localhost:4200
```

It takes the Banter server URL (replace it with your own) and installs into every dsh profile it finds; `--profile desktop` or `--profile web` limits it to one. It builds the plugin and installs a copy of it into each profile, so the profile keeps working whatever happens to this checkout; `--link` links the checkout's build instead, so a rebuild shows up when dsh restarts. When the desktop app is installed, the script uses the app's own dsh command, which matches the app's version.

Quit the desktop app fully first (⌘Q): dsh changes the `desktop` profile only while the app is closed, and the script stops before touching any profile if it is open. The app's profile exists once the app has been opened once.

`ops/dsh-plugin-uninstall.sh` removes the plugin and its settings from every profile, or from those named with `--profile`.

### From a release, without a checkout

Each [Banter release](https://github.com/arvindvenkataramani/banter/releases) carries the plugin built from it, `banter-dsh-voice-<version>.tgz`; use the one matching your Banter server's version. Download it, quit the desktop app fully, and add it to a profile with dsh's own command (`npx @deepseek-ai/dsh` works where the app's isn't on your path):

```bash
dsh plugin --profile desktop add ./banter-dsh-voice-0.1.0.tgz   # or --profile web for dsh web
```

Start dsh, then enter the Banter server URL on the plugin's page in **Plugins**.

### The Banter server URL

It is the address you open Banter at: the Banter server serves the web app and the speech relay from the same address. [The install script](../../install.md#install-script) prints it when it finishes (`http://localhost:4200` unless you changed the port), and it is the address you type into your browser to open Banter. Use the same address in the install command above.

### What install writes

The install first checks that the Banter server answers at the URL, and stops with a message if it does not. It then sets the plugin's Banter server URL in each profile's `cordis.patch.yml`, keeping its keep-voice-on setting. It changes no other line of that file, and nothing else in the profile.

The voice settings stay on the Banter server, and the plugin reads them from there. Change them in Banter's settings dialog; the plugin's [settings page](settings.md#voice-settings) shows what is in use and has a link to the dialog.

dsh keeps profiles under `~/.dsh`. To use another location, set `DSH_HOME` when you run the install command and when you start dsh.

## Start dsh

Open the desktop app, or start `dsh web` and open the address it prints:

```bash
npx @deepseek-ai/dsh web
```

dsh loads a newly installed plugin when its profile starts, so restart whichever was already running. In dsh's **Plugins** page, make sure **@banter/dsh-voice** is on. When you turn it on, a short "Set up voice" dialog offers to ask for microphone access and checks the speech services; **Open settings** goes to the plugin's [settings](settings.md). Then open a conversation: the voice button is in the composer ([README](README.md#turn-voice-on)).

## If something is wrong

- **No voice button.** The plugin is off, or was installed into a different profile from the one dsh started with.
- **Voice will not start.** Hover the red button for the reason. Check the Banter server URL on the plugin's settings page, and that the speech services are reachable from Banter.
