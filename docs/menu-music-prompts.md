# Menu Music — audio.cpp prompts (final AI version)

The shipped 60 s loops under `client/static/assets/audio/music/menu-<map>.ogg`
are **procedural v1** (`debug/menu-music-preview/gen.py --long`). They are the
style reference. When you want the full AI-quality pass, render the four tracks
below with audio.cpp and drop them onto the same filenames — no code change needed.

## Model choice

- **First try: `ace_step` / ACE-Step 1.5 Turbo** — text-to-music, instrumental,
  MIT-licensed weights, runs local via audio.cpp GGUF (`ACE-Step1.5-GGUF`,
  LM + DiT-turbo Q8 + VAE). 60 s stereo in minutes on an 8 GB CUDA card.
- **Alternative: `stable_audio` / Stable Audio 3 Small Music** — purely
  instrumental, best loop discipline. Pick if ACE-Step sings over the track
  despite `instrumental` (pass no lyrics at all).
- Keep Qwen3-TTS out of this: it is speech-only, it cannot do music.

> Do NOT prompt for a Call-of-Duty theme or any named title. "In the style of"
> a military shooter menu is fine; a melody clone is a copyright problem.
> All prompts below say `original composition, no vocals`.

## Shared generation rules (all four tracks)

- `duration 60`, `stereo`, `instrumental, no vocals, no lyrics, no choir`
- `original composition, seamless loop, no intro swell, no outro ending,`
  `consistent energy from bar 1 to the last bar`
- Render at the model's native rate, then master (see below), then encode.

## Per-map prompts

### 1. shipment — Container Yard (`menu-shipment`)

> Dark military-industrial menu loop, 92 BPM, D minor. Deep taiko ensemble
> and punchy cinematic toms driving four-on-the-floor, low distorted bass
> ostinato, short brass stabs every 4 bars, sparse metallic container hits.
> Tense, claustrophobic, relentless. Original composition, instrumental,
> no vocals, seamless 60 second loop, no intro, no outro.

### 2. dust2 — Desert Lanes (`menu-dust2`)

> Sparse desert-ops menu loop, 80 BPM, E phrygian. Frame drums and soft
> shaker, deep E drone, mournful duduk-style lead phrase, occasional
> oud-like plucks offbeat. Dry, open, patient tension. Original composition,
> instrumental, no vocals, seamless 60 second loop, no intro, no outro.

### 3. ares — Orbital Station (`menu-ares`)

> Cold sci-fi menu loop, 100 BPM, A minor. Pulsing 16th-note synth bass,
> wide glassy pads (Am F C G), gentle rising arpeggio, sparse ping lead
> with echo, airy noise sweeps. Weightless, high-tech, calm before contact.
> Original composition, instrumental, no vocals, seamless 60 second loop,
> no intro, no outro.

### 4. nuketown — Cul-de-Sac (`menu-nuketown`)

> Ironic 60s-suburb menu loop, 112 BPM, C major with a dark twist. Twangy
> surf-rock guitar motif, walking upright bass, swung brushed drums, small
> bells doubling the line; in the final quarter the harmony turns ominous
> (Ab borrowed chord) without changing tempo. Cheerful surface, wrong
> underneath. Original composition, instrumental, no vocals, seamless
> 60 second loop, no intro, no outro.

## audio.cpp commands (ace_step family)

```bat
:: one-time model fetch (names follow the audio.cpp GGUF repo layout)
:: models/ACE-Step1.5: LM acestep-5Hz-lm-4B-Q8_0.gguf + Qwen3-Embedding-0.6B-Q8_0.gguf
::                     + acestep-v15-turbo-Q8_0.gguf (DiT) + vae-BF16.gguf

audiocpp_cli --task music --family ace_step --model models/ACE-Step1.5 ^
  --backend cuda --duration 60 --prompt "<PROMPT FROM ABOVE>" --out raw/menu-shipment.wav
```

Repeat per map (swap prompt + out name). If the CLI flag names differ on your
audio.cpp build, the WebUI Arena exposes the same families — same prompts.

## Mastering → drop-in (same for AI or procedural renders)

Target: passive bed, clearly under SFX. The player (`menu-music.ts`)
multiplies MASTER × MUSIC × 0.25 on top, so master the files to roughly the
same loudness as the shipped ones (~-16 LUFS integrated):

```bat
:: 1. loop hygiene: 0.5 s equal-power crossfade of tail over head + loudness
ffmpeg -y -i raw/menu-shipment.wav -filter_complex ^
  "acrossfade=d=0.5:c1=tri:c2=tri,loudnorm=I=-16:TP=-2.0:LRA=11" ^
  -ar 48000 -ac 2 master/menu-shipment.wav

:: 2. game files (ogg primary, mp3 fallback for Safari)
ffmpeg -y -i master/menu-shipment.wav -ar 48000 -ac 2 -c:a libopus -b:a 96k ^
  client/static/assets/audio/music/menu-shipment.ogg
ffmpeg -y -i master/menu-shipment.wav -ar 44100 -ac 2 -codec:a libmp3lame -qscale:a 4 ^
  client/static/assets/audio/music/menu-shipment.mp3
```

Then update `bytes` in `client/static/assets/audio/music/manifest.json`
(sum of the four `.ogg` files) and reload the menu — the new tracks play
with no code change. Keep the 60 s length: the crossfade logic assumes
long loops, not stings.
