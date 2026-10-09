# Speech to text with Speaches

Speaches runs Whisper, the speech-to-text model, on your own GPU behind an OpenAI-style web address. ReconNotes then uses it to transcribe recordings and meetings. It is much more accurate than Apple's on-device recognition for a room of people, it spells the names and terms in **Your words** right, and it gives each word's time, so the transcript highlights words as a recording plays.

This guide installs it without Docker, as a service in an LXC container or on any Linux machine with an NVIDIA GPU. It includes the fixes for every problem it ran into along the way, at the step where each one shows up. With Docker instead, see the README's "Audio to text" section.

Already running Home Assistant's `wyoming-faster-whisper`? It runs the same engine, and ReconNotes can use it as a **Wyoming speech-to-text** agent (see [[AI agents]]). Speaches is worth it for two things Wyoming can't do: passing your words to Whisper as a hint, and word timings.

In this guide, `<speaches address>` means the address the ReconNotes server reaches the Speaches machine at, like `192.168.1.30`. `hostname -I` on the Speaches machine shows it.

## 1. Pick where it runs

The easiest place is the container or machine that already runs Ollama with the GPU. GPU access already works there, and both share the card. Otherwise, make a new container and pass the GPU through the same way you did for Ollama.

How much GPU memory it takes: the recommended model, `large-v3-turbo`, needs about 1.6 GB. ReconNotes keeps track of this and unloads Whisper when the next language model wouldn't fit beside it (see step 11).

## 2. Check the GPU

Inside the container, as root:

```bash
nvidia-smi
```

It should list your card, with a driver and CUDA version in the top line (e.g. `CUDA Version: 12.4`). Note that CUDA version: step 7 uses it. If `nvidia-smi` isn't found or lists no card, sort out GPU passthrough first: Speaches won't see the GPU either.

## 3. Install the tools

```bash
apt update && apt install -y git curl ffmpeg patchelf
```

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

```bash
source $HOME/.local/bin/env
```

```bash
uv --version
```

The last command should print a version number. `uv` is the Python installer Speaches uses.

> **Problem: `uv: command not found`.** The install worked, but this shell doesn't know where `uv` went yet. Run `source $HOME/.local/bin/env` (or `export PATH="$HOME/.local/bin:$PATH"`) and try again. In each new shell, run it again, or log out and back in.

**Paste the commands one at a time.** Pasting several at once can run them together on one line. Then the first fails, and everything after it fails too (`uv: command not found`, `.venv/bin/activate: No such file or directory`, `uvicorn: command not found`).

## 4. Install Speaches

```bash
cd /opt
```

```bash
git clone https://github.com/speaches-ai/speaches.git
```

```bash
cd /opt/speaches
```

```bash
uv python install
```

```bash
uv venv
```

```bash
source .venv/bin/activate
```

```bash
uv sync
```

`uv sync` downloads a lot (the speech libraries), so give it a few minutes. When it's done, your prompt starts with `(speaches)`: Speaches' own Python environment is active.

> **Important: always work inside the environment.** Whenever you open a new shell to work on Speaches, first run `cd /opt/speaches` and then `source .venv/bin/activate`. Without it, `uv pip install` says *"No virtual environment found; run `uv venv` to create an environment"*, and `python`/`uvicorn` aren't Speaches'. Once Speaches runs as a service (step 9), you won't need this any more.

## 5. Fix "cannot enable executable stack"

Check that the speech library loads:

```bash
python -c "import ctranslate2; print(ctranslate2.__version__, ctranslate2.get_cuda_device_count())"
```

If it prints a version and `1` (one GPU found), go on to step 6.

> **Problem: `ImportError: libctranslate2-….so.4.5.0: cannot enable executable stack as shared object requires: Invalid argument`.** Some versions of this library are marked as needing an "executable stack", and newer Linux systems (e.g. Ubuntu 25.04, Debian 13) refuse to load them. Clear that mark on its files (`patchelf` needs to be 0.18 or newer: `patchelf --version`):
>
> ```bash
> find .venv/lib/python3.*/site-packages/ctranslate2* -name "*.so*" -exec patchelf --clear-execstack {} \;
> ```
>
> Then run the check again: it should print e.g. `4.5.0 1`.
>
> If `patchelf` is older than 0.18 (it says `unrecognized option '--clear-execstack'`), upgrade the library instead: `uv pip install "ctranslate2>=4.6.0"`.
>
> **After every `uv sync`** (e.g. when updating Speaches), the original files come back. Run the `find … patchelf` line again.

> **Problem: it prints `0` GPUs.** The container can't use the GPU: check `nvidia-smi` (step 2) and the container's GPU passthrough.

## 6. Test-run it

```bash
WHISPER__INFERENCE_DEVICE=cuda WHISPER__COMPUTE_TYPE=int8 ENABLE_UI=false \
  uvicorn --factory --host 0.0.0.0 --port 8000 speaches.main:create_app
```

It should end with `Uvicorn running on http://0.0.0.0:8000`. Its first log line shows the settings, e.g. `inference_device='cuda'` and `compute_type='int8'`.

- **`WHISPER__COMPUTE_TYPE=int8`** matters on older cards (GTX 10-series), which are slow at the default 16-bit maths. It's fine on newer cards too, and uses less memory.
- Settings like `WHISPER__COMPUTE_TYPE` have **two underscores**: that's how Speaches reads settings that belong together.

Leave it running and open a **second shell** into the same container for the next steps. In it, run `source $HOME/.local/bin/env` first, so `uvx` works.

## 7. Download the model

In the second shell:

```bash
export SPEACHES_BASE_URL="http://localhost:8000"
```

```bash
uvx speaches-cli registry ls --task automatic-speech-recognition | grep -i turbo
```

That lists the "turbo" models Speaches knows. Download the English/multilingual one:

```bash
uvx speaches-cli model download deepdml/faster-whisper-large-v3-turbo-ct2
```

It's about 1.6 GB and stays on disk. If the list shows a different name for it, use that name here and in ReconNotes.

Which model:

| Your hardware | Model |
| --- | --- |
| NVIDIA GPU with 4 GB or more | `deepdml/faster-whisper-large-v3-turbo-ct2`: accurate on meetings, and fast |
| No GPU | `Systran/faster-whisper-small`: large models are too slow on a CPU for a long meeting |

## 8. Test a transcription

Get a short sample (President Kennedy, 11 seconds):

```bash
curl -L -o /tmp/test.flac https://github.com/openai/whisper/raw/main/tests/jfk.flac
```

```bash
curl -s -w "\nHTTP %{http_code}\n" http://localhost:8000/v1/audio/transcriptions \
  -F "file=@/tmp/test.flac" \
  -F "model=deepdml/faster-whisper-large-v3-turbo-ct2"
```

You should get:

```
{"text":"And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.", …}
HTTP 200
```

The first one takes a few seconds longer while the model loads onto the GPU.

> **Problem: nothing comes back, or `HTTP 000`.** Speaches crashed. Look at the first shell. If it shows `Unable to load any of {libcudnn_cnn.so.9…}` / `Cannot load symbol cudnnCreateConvolutionDescriptor` and `Aborted` (or names `libcublas`), the container is missing NVIDIA's cuDNN and cuBLAS libraries. Install them into Speaches' environment, matched to the CUDA version from step 2 (12.4 here; for 12.6 use `12.6.*`, and so on). In the first shell, which is now back at a prompt:
>
> ```bash
> cd /opt/speaches
> ```
>
> ```bash
> source .venv/bin/activate
> ```
>
> ```bash
> uv pip install "nvidia-cudnn-cu12==9.1.*" "nvidia-cublas-cu12==12.4.*"
> ```
>
> Tell the system where they are, and print that path. **Copy what `echo` prints**: the service needs it in step 9.
>
> ```bash
> export LD_LIBRARY_PATH=$(python -c 'import os, nvidia.cublas.lib, nvidia.cudnn.lib; print(os.path.dirname(nvidia.cublas.lib.__file__) + ":" + os.path.dirname(nvidia.cudnn.lib.__file__))')
> ```
>
> ```bash
> echo $LD_LIBRARY_PATH
> ```
>
> Start Speaches again in that same shell (the command from step 6) and repeat the test.

Lines you can ignore in Speaches' log:

- `pthread_setaffinity_np failed … error code: 22`: containers don't let it pin threads to CPU cores. Harmless.
- `ERROR … Unexpected streaming transcription response type`: a Speaches log quirk. The request still returns the text with `HTTP 200`.
- `Invalid model-index. Not loading eval results into CardData`: from the model list download. Harmless.

## 9. Run it as a service

Stop the test run in the first shell with **Ctrl+C**. If you needed the cuDNN fix, print the path again (it's still set in that shell):

```bash
echo $LD_LIBRARY_PATH
```

Create the service file:

```bash
nano /etc/systemd/system/speaches.service
```

Paste this. If you needed the cuDNN fix, replace `<the path echo printed>` with that line; if you didn't, delete the `LD_LIBRARY_PATH` line.

```ini
[Unit]
Description=Speaches (Whisper speech-to-text)
After=network-online.target

[Service]
WorkingDirectory=/opt/speaches
Environment=WHISPER__INFERENCE_DEVICE=cuda
Environment=WHISPER__COMPUTE_TYPE=int8
Environment=ENABLE_UI=false
Environment=STT_MODEL_TTL=300
Environment=VAD_MODEL_TTL=300
Environment=LD_LIBRARY_PATH=<the path echo printed>
ExecStart=/opt/speaches/.venv/bin/uvicorn --factory --host 0.0.0.0 --port 8000 speaches.main:create_app
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Save with **Ctrl+O**, **Enter**, **Ctrl+X**. Then:

```bash
systemctl daemon-reload
```

```bash
systemctl enable --now speaches
```

```bash
systemctl status speaches
```

It should say `active (running)`. Run the test from step 8 once more to check the service works too. It starts by itself after a reboot.

- `STT_MODEL_TTL=300` keeps Whisper loaded for 5 minutes after the last transcription, so recordings in a row don't wait for it to load. `-1` keeps it loaded forever, and `0` unloads it straight away.
- `VAD_MODEL_TTL=300` does the same for Speaches' voice detector (`silero_vad_v5`, see step 11). Without it, Speaches keeps the detector loaded forever, holding about 0.4 GB of the GPU.
- Already running Speaches without the `VAD_MODEL_TTL` line? Add it, then run `systemctl daemon-reload` and `systemctl restart speaches`.
- To see its log: `journalctl -u speaches -f`.

## 10. Add it in ReconNotes

In **Settings › AI agents**, add an agent:

- **Kind:** OpenAI-compatible
- **Address:** `http://<speaches address>:8000/v1`
- **Model:** `deepdml/faster-whisper-large-v3-turbo-ct2`

Press **Test connection**. Its model name contains "whisper", so it goes on **Audio to text** by itself.

Then fill in **Your words** on the same page with the names and terms that come up in your recordings: people, teams, places, product names. They're passed to Whisper as a hint, so it spells them right.

Check that it's being used:

- **Jobs:** a meeting job shows `<your agent> + <notes model>`. If it says "Apple speech recognition (on the phone)", the server isn't reaching Speaches: check the address, and that port 8000 isn't blocked between the two machines.
- **Under a recording:** the transcript says "Transcribed by …". Tap **Transcribe** on an older recording to read it again with Whisper. After that, playing it highlights each word as it's spoken.

## 11. Sharing the GPU with Ollama

Whisper and Ollama's models share the GPU's memory. On a big card, both simply stay loaded. On a small one (8 GB), a language model loaded right after a transcription may not fit beside Whisper. Ollama then runs it partly on the CPU, many times slower. The **Jobs** view shows that as "partly on the CPU, slow".

It also happens the other way round: a language model still loaded from the last job can leave Whisper too little memory, and it fails ("CUDA failed with error out of memory" in `journalctl -u speaches`). Then ReconNotes unloads Ollama's models and lets Whisper try again. When that's what it took, it remembers, and from then on makes room before Whisper starts. If Whisper still fails, a meeting falls back to the phone's own transcript, and the job shows why under **Speech-to-text**.

For language models, ReconNotes handles this by itself too: while Whisper is loaded, it loads the next model first and checks it fits, before the job starts. If the model was squeezed, it unloads Whisper and loads the model again with the whole GPU. It remembers that, and from then on unloads Whisper before loading that model. Models that fit stay beside it. The **In memory** line in **Jobs** shows Speaches' model too, marked "(speech-to-text)". It may also show `silero_vad_v5`: that's not Whisper, but Speaches' voice detector, which finds the parts of a recording where someone is speaking before Whisper listens. The model itself is tiny, but it runs with its own GPU runtime, which takes about 0.4 GB. When a model needs the room, ReconNotes unloads it along with Whisper, and `VAD_MODEL_TTL` (step 9) lets Speaches release it after 5 minutes idle too.

## 12. See how full the GPU is (optional)

Ollama says how much GPU memory each of its models takes, but neither Ollama nor Speaches says how big the GPU is or how full it is. Inside an LXC container, `nvidia-smi` can't say which program uses what either. A tiny monitor that comes with ReconNotes fills the gap. Run it on the machine (or container) with the GPU, and the **In memory** line in **Jobs** gets a bar: each model's share in its own colour, the rest free, and Whisper's real size. Without it, Whisper's size is an estimate (shown with a `~`).

It's a short Python script that comes with ReconNotes, at `deploy/gpu-stats.py` inside your ReconNotes folder (the one you run `git pull` in). It uses Python's standard library only, so there's nothing to install. Put it on the GPU machine at `/opt/gpu-stats.py`, in either of two ways.

**Either copy it from the ReconNotes machine**, from inside the ReconNotes folder:

```bash
scp deploy/gpu-stats.py root@<speaches address>:/opt/gpu-stats.py
```

**Or paste it.** On the GPU machine, open an empty file:

```bash
nano /opt/gpu-stats.py
```

Paste all of this into it, then save with **Ctrl+O**, **Enter**, **Ctrl+X**:

```python
#!/usr/bin/env python3
"""
GPU memory for ReconNotes
=========================

Ollama and Speaches don't say how big the GPU is or how full it is, and inside
an LXC container nvidia-smi can't tell which program uses what. This tiny
server, run on the machine (or container) with the GPU, answers with each
card's total and used memory, so ReconNotes' Jobs view can show how much room
is left. Python's standard library only; nothing to install.

    python3 gpu-stats.py            # serves http://0.0.0.0:9401/

ReconNotes looks for it on port 9401 of each Ollama / speech-to-text address.
"""
import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("GPU_STATS_PORT", "9401"))


def gpus():
    out = subprocess.run(
        ["nvidia-smi", "--query-gpu=index,name,memory.total,memory.used", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=5, check=True,
    ).stdout
    cards = []
    for line in out.strip().splitlines():
        index, name, total, used = [p.strip() for p in line.split(",")]
        cards.append({"index": int(index), "name": name, "totalMb": int(total), "usedMb": int(used)})
    return cards


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            body, status = json.dumps({"gpus": gpus()}), 200
        except Exception as e:  # no nvidia-smi, driver gone…
            body, status = json.dumps({"error": str(e)}), 500
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
```

Then, on the GPU machine, start it to try it:

```bash
python3 /opt/gpu-stats.py
```

In another shell, check it answers:

```bash
curl -s http://localhost:9401/
```

It should print your card, e.g. `{"gpus": [{"index": 0, "name": "NVIDIA GeForce GTX 1070", "totalMb": 8192, "usedMb": 7540}]}`. Stop it with **Ctrl+C** and make it a service:

```bash
nano /etc/systemd/system/gpu-stats.service
```

```ini
[Unit]
Description=GPU memory for ReconNotes (port 9401)
After=network-online.target

[Service]
ExecStart=/usr/bin/python3 /opt/gpu-stats.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
```

```bash
systemctl enable --now gpu-stats
```

ReconNotes looks for it on port 9401 at the address of each Ollama and speech-to-text agent, so there's nothing to set up in the app. Open **Jobs**: the bar appears within a minute. If the GPU is in the ReconNotes server's own machine (Ollama at `localhost`), ReconNotes asks `nvidia-smi` itself and you don't need the monitor.

Reading the bar:

- **Each colour** is a model, matching the little square before its name. The grey at the end is free.
- **"full"** in red, and a red outline: less than 5% left. The next model to load may not fit.
- **"On the CPU: …"** in red: a model that didn't fit, so it runs slowly. ReconNotes reloads it fully on the next job.

## 13. Tell who said what (optional)

Whisper writes down what was said, not who said it. A second small service, which comes with ReconNotes, tells the voices apart. With it, a recording's transcript shows who's speaking ("Speaker 1", "Speaker 2"…; tap one to give them a name), and the meeting notes say who said, suggested, agreed to or took on what.

It runs on the CPU, so it doesn't take GPU memory from Whisper or the language model. It takes about 5 seconds per minute of audio: roughly 2 minutes for a 25-minute meeting. It uses sherpa-onnx with pyannote's segmentation model and NVIDIA's TitaNet voice model (about 45 MB, downloaded on first start).

Install it in the Speaches container, next to Speaches:

```bash
mkdir -p /opt/diarize
```

```bash
cd /opt/diarize
```

```bash
uv venv
```

```bash
uv pip install sherpa-onnx numpy
```

(`uv: command not found`? Run `source $HOME/.local/bin/env` first, as in step 3.)

The script is `deploy/diarize.py` in your ReconNotes folder. Copy it to `/opt/diarize/diarize.py`, from inside the ReconNotes folder on the ReconNotes machine:

```bash
scp deploy/diarize.py root@<speaches address>:/opt/diarize/diarize.py
```

Or open `nano /opt/diarize/diarize.py` on the Speaches machine and paste all of this:

```python
#!/usr/bin/env python3
"""
Who spoke when, for ReconNotes
==============================

Whisper writes down what was said, not who said it. This small server splits
a recording into turns by voice ("speaker 1 from 0:00 to 0:07, speaker 2…"),
so ReconNotes can label the transcript and the meeting notes can say who
said and agreed what. It runs on the CPU (it doesn't take GPU memory from
Whisper or the language model): about 5 seconds per minute of audio.

It uses sherpa-onnx with pyannote's segmentation model and NVIDIA NeMo's
TitaNet voice model, downloaded once on first start.

    python3 diarize.py            # serves http://0.0.0.0:9402/

    POST /diarize?speakers=N&threshold=T
                                  the recording (any format ffmpeg reads) as the body;
                                  N (optional): at most this many people spoke;
                                  T (optional): how alike voices must be to count as one
                                  person, 0.5–1 (ReconNotes sends its setting; else DIARIZE_THRESHOLD)
    -> {"segments": [{"start": 0.32, "end": 6.87, "speaker": 0}, ...], "speakers": 3}

ReconNotes looks for it on port 9402 of the speech-to-text server's address.
Needs: ffmpeg, and `pip install sherpa-onnx numpy`.
"""
import json
import os
import subprocess
import tarfile
import tempfile
import threading
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx

PORT = int(os.environ.get("DIARIZE_PORT", "9402"))
MODELS = os.environ.get("DIARIZE_MODELS", os.path.join(os.path.dirname(os.path.abspath(__file__)), "diarize-models"))
# how alike two stretches of speech must be to count as one person (higher: fewer speakers)
THRESHOLD = float(os.environ.get("DIARIZE_THRESHOLD", "0.9"))
THREADS = int(os.environ.get("DIARIZE_THREADS", str(max(1, (os.cpu_count() or 2) - 1))))

RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
SEGMENTATION = os.path.join(MODELS, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx")
EMBEDDING = os.path.join(MODELS, "nemo_en_titanet_small.onnx")


def fetch_models():
    os.makedirs(MODELS, exist_ok=True)
    if not os.path.exists(SEGMENTATION):
        print("downloading the segmentation model…", flush=True)
        tar = os.path.join(MODELS, "segmentation.tar.bz2")
        urllib.request.urlretrieve(f"{RELEASES}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2", tar)
        with tarfile.open(tar) as t:
            # only plain files, inside the folder (and no warning on newer Pythons)
            t.extractall(MODELS, **({"filter": "data"} if hasattr(tarfile, "data_filter") else {}))
        os.remove(tar)
    if not os.path.exists(EMBEDDING):
        print("downloading the voice model…", flush=True)
        urllib.request.urlretrieve(f"{RELEASES}/speaker-recongition-models/nemo_en_titanet_small.onnx", EMBEDDING)


def diarizer(clusters=-1, threshold=THRESHOLD):
    cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=SEGMENTATION),
            num_threads=THREADS,
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=EMBEDDING, num_threads=THREADS),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=clusters, threshold=threshold),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not cfg.validate():
        raise RuntimeError("the diarization models are missing or broken – delete the models folder and start again")
    return sherpa_onnx.OfflineSpeakerDiarization(cfg)


def decode(data: bytes, rate: int) -> np.ndarray:
    """Any audio → 16 kHz mono float samples (ffmpeg). From a file, not a pipe: an iPhone's .m4a
    keeps its index at the end, which ffmpeg can't reach in a pipe."""
    with tempfile.NamedTemporaryFile(suffix=".audio") as f:
        f.write(data)
        f.flush()
        out = subprocess.run(
            ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", f.name, "-ac", "1", "-ar", str(rate), "-f", "f32le", "pipe:1"],
            capture_output=True, check=True,
        ).stdout
    return np.frombuffer(out, dtype=np.float32)


def segments(sd, samples):
    return [{"start": round(s.start, 2), "end": round(s.end, 2), "speaker": int(s.speaker)} for s in sd.process(samples).sort_by_start_time()]


lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def answer(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.answer(200, {"ok": True, "threshold": THRESHOLD})

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        if url.path != "/diarize":
            return self.answer(404, {"error": "POST /diarize"})
        try:
            data = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            query = urllib.parse.parse_qs(url.query)
            most = int(query.get("speakers", ["0"])[0] or 0)
            threshold = min(1.0, max(0.5, float(query.get("threshold", [THRESHOLD])[0] or THRESHOLD)))
            with lock:  # one recording at a time: it uses every CPU core it's given
                sd = diarizer(threshold=threshold)
                samples = decode(data, sd.sample_rate)
                found = segments(sd, samples)
                # more voices than people there: grouped again into that many
                if most > 0 and len({s["speaker"] for s in found}) > most:
                    found = segments(diarizer(most, threshold), samples)
            # speakers numbered in the order they first speak
            order = {}
            for s in found:
                s["speaker"] = order.setdefault(s["speaker"], len(order))
            self.answer(200, {"segments": found, "speakers": len(order), "seconds": round(len(samples) / sd.sample_rate, 2)})
        except subprocess.CalledProcessError as e:
            self.answer(400, {"error": "couldn't read the audio: " + e.stderr.decode(errors="replace")[-300:]})
        except Exception as e:  # noqa: BLE001
            self.answer(500, {"error": str(e)})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    fetch_models()
    diarizer()  # check the models load before saying we're ready
    print(f"ready on port {PORT} (threshold {THRESHOLD}, {THREADS} threads)", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
```

Try it (the first start downloads the models, then says `ready on port 9402`):

```bash
/opt/diarize/.venv/bin/python /opt/diarize/diarize.py
```

In another shell, get a short test recording (President Kennedy, 11 seconds):

```bash
curl -L -o /tmp/test.flac https://github.com/openai/whisper/raw/main/tests/jfk.flac
```

and give it to the service:

```bash
curl -s -X POST --data-binary @/tmp/test.flac http://localhost:9402/diarize
```

It should answer with one speaker, e.g. `{"segments": [{"start": 0.3, "end": 10.9, "speaker": 0}], "speakers": 1, …}`. Stop it with **Ctrl+C** and make it a service:

```bash
nano /etc/systemd/system/diarize.service
```

```ini
[Unit]
Description=Who spoke when, for ReconNotes (port 9402)
After=network-online.target

[Service]
WorkingDirectory=/opt/diarize
ExecStart=/opt/diarize/.venv/bin/python /opt/diarize/diarize.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
```

```bash
systemctl enable --now diarize
```

ReconNotes looks for it on port 9402 at your speech-to-text agent's address, so there's nothing to set in the app. From then on:

- **Meetings**: the notes are written from the transcript as turns ("Jesse: …", "Speaker 2: …"). The names on the note's **Attendees** line (the meeting's setup asks for them) are Whisper's spelling hint, and also the most voices it will find.
- **The transcript** under a recording shows a coloured label where each speaker starts. Tap a label to say who it is: the attendees are one tap away, or type a name. Then **Redo the notes with the names** under the transcript rewrites the meeting notes with them.
- **Transcribe** on any recording labels its speakers too.

### Too many or too few speakers

The **threshold** decides how alike two stretches of speech must be to count as one person. It's 0.9 to start.

- One person shown as two speakers → raise it (0.93, then 0.95).
- Two people merged into one → lower it (0.85, then 0.8).

Listing the attendees when you start a meeting also stops one person being counted twice.

**Option A – in ReconNotes (easiest).** **Settings → AI agents → Speaker labels**: move the slider toward **Fewer voices** (higher) or **More voices** (lower). This needs the current `diarize.py` – if you set it up before the slider existed, copy the new script over the old one (as above) and `systemctl restart diarize` once. Once the new script is in, the slider always wins over Option B.

**Option B – on the Speaches machine.** No need to find the service file – `systemctl edit` opens an empty override for it:

```bash
systemctl edit diarize
```

In the editor that opens, type these two lines in the blank space near the top (between the comment lines), then save and exit (nano: Ctrl+O, Enter, Ctrl+X):

```ini
[Service]
Environment=DIARIZE_THRESHOLD=0.95
```

Restart it and check the new value:

```bash
systemctl restart diarize
curl -s http://localhost:9402/
```

It should answer `{"ok": true, "threshold": 0.95}`. To go back to 0.9, run `systemctl revert diarize && systemctl restart diarize`.

Recordings that already have labels keep them until you redo them:

- After Option A: ⋯ → **Redo meeting notes** tells the voices apart again with the new setting.
- After Option B: ReconNotes can't tell the service changed, so use ⋯ → **Redo from a fresh transcript** (it transcribes again too, so it takes longer).

Check the names you gave the voices afterwards: a different split can number them differently.

## Updating Speaches

```bash
cd /opt/speaches
```

```bash
source .venv/bin/activate
```

```bash
git pull
```

```bash
uv sync
```

Then repeat the `patchelf` line from step 5 and the `uv pip install "nvidia-cudnn-cu12…"` line from step 8 if you needed them: `uv sync` undoes both. Then run `systemctl restart speaches`, and repeat the test from step 8.

## Quick fixes

| What you see | Fix |
| --- | --- |
| `uv: command not found` | `source $HOME/.local/bin/env` (step 3) |
| `No virtual environment found` | `cd /opt/speaches` and `source .venv/bin/activate` first (step 4) |
| `cannot enable executable stack` | `patchelf --clear-execstack` on the ctranslate2 files (step 5) |
| `ctranslate2.get_cuda_device_count()` is `0` | the container has no GPU access (step 2) |
| test returns nothing / `HTTP 000`, log says `libcudnn…` / `Aborted` | install cuDNN + cuBLAS and set `LD_LIBRARY_PATH` (step 8), and put it in the service (step 9) |
| works by hand but not as a service | the service is missing the `LD_LIBRARY_PATH` line (step 9) |
| Jobs says "Apple speech recognition" | ReconNotes can't reach Speaches: check the agent's address ends in `:8000/v1` (step 10) |
| notes model "partly on the CPU" after a meeting | caught as the model loads, before the job runs (step 11); update ReconNotes if you still see it |
| no speaker labels in transcripts | the speaker service isn't running, or port 9402 is blocked: `curl -s http://<speaches address>:9402/` from the ReconNotes machine (step 13) |
| the bar in Jobs doesn't appear | the GPU monitor isn't running, or port 9401 is blocked: `curl -s http://<speaches address>:9401/` from the ReconNotes machine (step 12) |
| a meeting job says "Done by Apple speech recognition" with a **Speech-to-text: Failed** line | the reason is on that line; `journalctl -u speaches -n 50` shows Speaches' side (step 11) |
