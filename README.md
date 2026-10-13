# VMO Audio Notes

Local audio transcription and summaries for Obsidian. Start and stop the native recorder with one button, then receive a new Markdown note beside the note where recording began—even if you switch folders while recording.

Built for English recordings on Apple Silicon Macs, using **whisper.cpp small.en** for transcription and **Ollama with Qwen3:4b** for summarization. Daily use requires no terminal commands.

## Features

- One recording button or an optional hotkey, using Obsidian’s native audio recorder.
- New notes containing a summary, key points, decisions, action items, timestamped transcript, and links to the original audio and source note.
- Local processing after one-time dependency and model downloads; no cloud transcription or summarization API.
- Sequential transcription and summarization to reduce memory overlap.
- Processing queue with progress, cancellation, pause/resume, and retries.
- Saved checkpoints for long recordings and interrupted processing.
- Transcripts saved before summarization, with retries that preserve user edits.
- Existing audio files can be queued from their right-click menu.

## Requirements

- macOS on Apple Silicon. Developed and tested on an M2 Mac with 8 GB of memory.
- Obsidian **1.13.7 or later**; native-recorder integration was verified against 1.13.7, not every later version.
- Obsidian’s **Audio recorder** core plugin enabled.
- [Homebrew](https://brew.sh/) for the one-time local-tool installation.
- [Ollama](https://ollama.com/) with `qwen3:4b` downloaded locally.

Whisper is used for speech recognition; Qwen summarizes the resulting text. Model downloads and other applications require additional disk space and memory. Intel Macs, Windows, Linux, and mobile are not supported by the default configuration.

## Install

This is a manually installed community plugin; it is not listed in Obsidian’s community-plugin directory.

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/VincentHP/vmo-audio-notes/releases/latest).
2. Create `.obsidian/plugins/vmo-audio-notes/` inside your vault and place those three files there.
3. Reload Obsidian. In **Settings → Community plugins**, enable community plugins and **VMO Audio Notes**. Enable **Audio recorder** under Core plugins as well.
4. Install Homebrew and Ollama if needed. Download Qwen3:4b once through Ollama; its terminal equivalent is `ollama pull qwen3:4b`.
5. Open **Settings → VMO Audio Notes → Setup / verify**. This installs missing `whisper-cpp` and `ffmpeg` tools through Homebrew, downloads and verifies the English Whisper model, and checks the local Qwen model.

Default executable paths target Apple Silicon Homebrew and the Ollama Mac app. Paths and the model name can be adjusted in plugin settings. The English transcription model is stored at `~/Library/Application Support/VMO Audio Notes/models/ggml-small.en.bin`.

## Daily use

1. Open a Markdown note in the folder where you want the result.
2. Click the **microphone with sound waves** in the left ribbon. Its tooltip is **VMO Audio Notes: start / stop recording**. The same command is available in the command palette.
3. Click again to stop recording. Processing starts automatically.
4. Click **Audio:** in the bottom status bar to see progress or open the completed note.

The output is named `Audio Note YYYY-MM-DD HHmmss.md`, with a suffix when necessary. It is created beside the starting note, independent of the vault’s default new-note location. Original audio follows the vault’s attachment settings, using the starting note as its source.

Assign a shortcut under **Settings → Hotkeys → VMO Audio Notes: Start / stop native recording**. No hotkey is imposed by default.

To process an existing recording, right-click its audio file and choose **Transcribe with VMO Audio Notes**. The output goes beside the active Markdown note, or beside the audio when no Markdown note is active.

## Stop, pause, and recover

- **Stop recording:** click the recording button again; transcription starts afterward.
- **Cancel processing:** keeps the recording and completed chunks. Use **Retry** to continue.
- **Automatic processing off:** pauses the current job and queue. Turn it on to resume.
- Keep Obsidian open while recording. The native recorder does not persist audio until recording stops; crashes during recording can lose unsaved audio.
- Closing Obsidian during processing leaves saved checkpoints that resume on the next launch.

The transcript is written before summarization. If Qwen fails, the transcript remains available. Retrying replaces only an untouched summary placeholder; if that placeholder was edited, the generated summary is appended instead. Keep the hidden `vmo-audio-job` and `vmo-summary` HTML comments until processing finishes, since they prevent duplicate writes.

## Privacy and resource use

Runtime model requests go only to Ollama at `127.0.0.1:11434`. Setup downloads dependencies through Homebrew and the verified English model from [ggerganov/whisper.cpp on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp).

Audio is transcribed in five-minute chunks before Qwen loads. Long transcripts are summarized in sections with a 4,096-token context. Qwen3 requests use an explicit non-thinking prompt and structured output to keep summaries separate from reasoning text. Installed Ollama models are not modified. The plugin releases the model after processing and only stops server processes it started itself.

Queue checkpoints and configuration live in the plugin’s local `data.json`. This can include unfinished transcripts and source paths: **do not commit or share it**. Original recordings are never deleted by the plugin. Temporary converted audio is removed after processing or cancellation, although a crash may leave an OS temporary folder.

## Compatibility and limitations

- English transcription, microphone audio, and processing while Obsidian is open.
- No live transcription, speaker identification, or system-audio capture.
- The companion uses private native-recorder interfaces because Obsidian does not expose a public recording-complete API. Obsidian updates may require plugin changes; an interface check reports unsupported recorder configurations.
- Recordings started through the original core-recorder button alone are not automatically queued. Use the companion button or right-click the saved audio afterward.
- Transcription and summarization can make mistakes. Keep the linked original recording available when accuracy matters.

## Verification

The automated suite contains **21 checks** covering folder switching, filename collisions, cancellation, pause/resume, restart recovery, chunk checkpoints, summary failures, preserving edited notes and unsaved editor content, subprocess cleanup, and structured Qwen output.

Synthetic benchmarks on an M2 / 8 GB Mac with `small.en` and `qwen3:4b`:

| Recording length | Transcription | Complete pipeline |
| --- | ---: | ---: |
| 10 minutes | 27 seconds | 72 seconds |
| 60 minutes | 159 seconds | 400 seconds |

These are September 2026 measurements using repeated, known English speech. They are performance and integration checks, not a real-lecture accuracy evaluation or a latency guarantee. The native recorder was also tested with synthetic speech while switching to a different folder; the resulting audio and note retained the starting folder.

## Development

No npm dependencies are required. Use Node.js 22 or later:

```sh
node build.js
node --test test.js
```

- `plugin.js`: Obsidian integration, recording sessions, queue, and settings.
- `runtime.js`: local processes, Whisper transcription, and Ollama summarization.
- `core.js`: transcript formatting, note generation, and structured summary rendering.
- `build.js`: generates the self-contained `main.js` loaded by Obsidian.
- `test.js`: automated checks with an Obsidian test harness.
- `benchmark.js`: optional local 10-minute and one-hour benchmarks. Supply a valid `sample.aiff` speech fixture containing “queue” and “Friday” for its phrase checks, and install the local tools and models first. Generated fixtures and results are ignored by Git.

Rebuild `main.js` whenever source changes. Continuous integration checks both the test suite and that the committed bundle matches its sources.

## Support

Report bugs or request features in [GitHub Issues](https://github.com/VincentHP/vmo-audio-notes/issues). Include macOS/Obsidian versions, the processing stage, and the error message. Remove private paths, transcripts, and recordings from diagnostic information before sharing.

Maintained by [VincentHP](https://github.com/VincentHP).
