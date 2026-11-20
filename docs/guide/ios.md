# iOS and mobile use

Voice works on iPhone and iPad. iOS Safari's autoplay restrictions can make playback silently fail to start, in a way that is easy to mistake for a bug.

- **iOS gates playback on user interaction**, and turning on voice mode or granting microphone access does not satisfy it.
- **Interacting with something else on the page resolves it**: tapping a button, sending a message by text, and so on, after voice mode is on. That interaction is what lets Safari play audio. How long the permission lasts is not defined, so it can reset between sessions.
- If replies arrive with no audio, interact with some other part of the UI once. That is expected behaviour on iOS Safari, not a workaround.
- Voice on a phone needs a secure page: `https`, or `localhost`. A phone opening Banter at a plain `http://<lan-ip>` address can chat by text, but voice mode cannot start. See [remote-access.md](remote-access.md#why-https) for why, and for one way to get `https`.
- Android and Windows clients are not documented here.
