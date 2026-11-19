# Probes

Instruments for questions Banter cannot answer about itself, because Banter is the thing under test.

[`control/probe`](../../control/probe/README.md) states the principle for the gateway: reading the dashboard's behaviour tells you what the dashboard understands. The same holds wherever a question is about the browser, the device or the network rather than about Banter's code. An answer measured through the dashboard is an answer about the dashboard.

What lives here is deliberately primitive: no build step, no framework, no imports from this repo. A probe that shares the application's machinery shares its assumptions, and a probe that needs the application to run cannot be used when the application is what is broken.

Each probe is a directory with a README that states the question, how to run it, and, once it has been run, the answer. The finding is the artifact: a probe whose result was never written down has to be run again by whoever asks next.

| Probe | Question |
|---|---|
| [`browser-audio`](browser-audio/) | Does playback crackle through the built-in speaker while a microphone capture is open, and does it depend on how the audio is played? |

If you run a probe on a device or browser not covered by its findings, add what you found to its README, with the date, the device and the OS version.
