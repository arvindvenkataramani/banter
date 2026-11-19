# Browser audio probe

Does playback crackle through a device's built-in speaker while a microphone capture is open, and does it depend on how the audio is played?

Use this if Banter's spoken replies crackle or distort on a phone or laptop speaker while voice mode is listening, and go clean with headphones. That is a known fault on iPhones (see [Findings](#findings)), and this probe is how to check whether your device has it, independently of Banter.

It is a single HTML page with no build step, no framework and no imports from this repo. It opens a microphone, plays one clip three different ways, and prints a timestamped trace you can copy from the device. That matters because the fault shows up on a phone, where there is no console, and because the dashboard can't be the instrument when the dashboard is what is under test.

## Running it

```bash
probes/browser-audio/serve.sh
```

It prints the address to open. You need `python3`; Tailscale is optional.

A browser only grants the microphone to a secure page: https, or `http://localhost` on the same machine. So:

- **With [Tailscale](https://tailscale.com)** running on this machine, `serve.sh` serves the probe over HTTPS at your tailnet name on port 5199, using `tailscale serve`. Open that address on any device on your tailnet, phone included. The Serve entry is removed when you stop the script.
- **Without Tailscale**, it serves `http://localhost:5199` only. A desktop browser on the same machine can use the microphone there, which is enough to check a laptop's speaker.
- **To test a phone without Tailscale**, you need some other way to give the page HTTPS: for example a local certificate made with [mkcert](https://github.com/FiloSottile/mkcert) and trusted on the phone, or a tunnelling service. Point it at `http://127.0.0.1:5199`. Plain `http://<your-ip>:5199` loads the page, but the microphone button will fail.

`PROBE_PORT` changes the port; `PROBE_LOCAL_ONLY=1` skips Tailscale even when it's available. Banter's dashboard and dev server are untouched.

## What it does

**Microphone.** `open` calls `getUserMedia` and holds the stream and nothing else. `+ worklet capture` also builds an `AudioContext` and captures frames through an `AudioWorkletNode` that declares no outputs, which is what Banter's `voice-engine/src/devices.ts` does. Changing it needs the microphone reopened.

**Playback**, the same 12-second clip each time:

- `<audio> element`: a media element with a plain `src`.
- `element + MediaSource`: a media element fed by `ManagedMediaSource` where available, which is the dashboard's own path for speech.
- `Web Audio`: decoded to samples and played through an `AudioContext`, which the dashboard does not do.

The clip is 12 s of sustained harmonics at 48 kHz stereo with a slow tremolo, generated rather than borrowed: steady broadband content makes a discontinuity obvious, where speech hides it. Regenerate it with:

```bash
ffmpeg -y -f lavfi -i "sine=frequency=220:duration=12" -f lavfi -i "sine=frequency=440:duration=12" \
       -f lavfi -i "sine=frequency=1320:duration=12" -f lavfi -i "sine=frequency=3300:duration=12" \
       -filter_complex "[0][1][2][3]amix=inputs=4:weights=1 0.6 0.35 0.2,tremolo=f=0.5:d=0.3,volume=0.5,aformat=sample_rates=48000:channel_layouts=stereo" \
       -c:a libmp3lame -b:a 192k clip.mp3
```

## Using it

1. Use the built-in speaker, not headphones. Headphones break the acoustic path and everything sounds clean.
2. With the microphone closed, play each of the three ways. This is your baseline.
3. Open the microphone and play each way again.
4. Reload the page and repeat steps 2 and 3 several times.

**Judge a session, not a clip.** The fault is intermittent and stays the same within a page load, so one clean playback proves nothing. Reload and try several times before concluding anything from silence.

The comparison that matters is the media element against Web Audio with the microphone open. See Findings for how that came out.

To share a result, copy the trace from the page and note the device, OS version, browser, and whether you heard crackle.

## Findings

**2026-09-21, iPhone on iOS 27, built-in speaker. The playback path does not matter.** All three ways crackle with the microphone open: the plain element, the element on `ManagedMediaSource`, and decoded samples through an `AudioContext`. So the dashboard's split between capture in Web Audio and playback in a media element is not the cause, and moving playback into the capture context would not help.

**The fault is intermittent.** Some sessions with the microphone open never crackle. Within a session the outcome holds across repeated microphone open and close: a clean session stays clean and a crackling one keeps crackling. A fresh page load is the only thing that reliably changes it, though a clean session can still start crackling part-way through. This matters most, because any conclusion drawn from one or two runs judged by ear is unreliable.

**Also observed:** playback volume drops while the microphone is open and returns when it closes, and the second sound played after opening is often much quieter than the first.

The closest published report is [WebKit bug 311451](https://bugs.webkit.org/show_bug.cgi?id=311451), which describes degradation rather than crackle, on headphones rather than the speaker.

## Limits

The probe can't judge crackle without a person listening. Nothing in its trace correlates with whether a session crackles, because the trace records the page's own events and the fault isn't in them. Recording the device's output and measuring it would be the next instrument.
