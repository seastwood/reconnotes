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
                                  person, 0.5–1.5 (ReconNotes sends its setting; else DIARIZE_THRESHOLD)
    -> {"segments": [{"start": 0.32, "end": 6.87, "speaker": 0}, ...], "speakers": 3,
        "voices": {"0": [0.012, -0.08, ...], ...}}

"voices" is what each speaker sounds like (a TitaNet voice embedding, from up to a minute of
their speech): ReconNotes compares them with the voices you've named before, to name people
it recognises.

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
THRESHOLD = float(os.environ.get("DIARIZE_THRESHOLD", "1.0"))
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


def voice_of(extractor, samples, rate, turns):
    """One speaker's voice: an embedding of their longest turns (up to a minute), unit length."""
    chosen, total = [], 0.0
    for t in sorted(turns, key=lambda t: t["end"] - t["start"], reverse=True):
        if t["end"] - t["start"] < 1.0 or total >= 60:
            continue
        chosen.append(samples[int(t["start"] * rate):int(t["end"] * rate)])
        total += t["end"] - t["start"]
    if not chosen:
        return None
    stream = extractor.create_stream()
    stream.accept_waveform(sample_rate=rate, waveform=np.concatenate(chosen))
    stream.input_finished()
    if not extractor.is_ready(stream):
        return None
    v = np.array(extractor.compute(stream), dtype=np.float32)
    n = float(np.linalg.norm(v))
    return [round(float(x), 5) for x in (v / n)] if n > 0 else None


_extractor = None


def extractor():
    global _extractor
    if _extractor is None:
        _extractor = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=EMBEDDING, num_threads=THREADS))
    return _extractor


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
            threshold = min(1.5, max(0.5, float(query.get("threshold", [THRESHOLD])[0] or THRESHOLD)))
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
                # what each one sounds like (to recognise them in other recordings)
                voices = {}
                for v in range(len(order)):
                    try:
                        emb = voice_of(extractor(), samples, sd.sample_rate, [s for s in found if s["speaker"] == v])
                    except Exception as e:  # noqa: BLE001 – the labels still count without it
                        print(f"voice {v}: {e}", flush=True)
                        emb = None
                    if emb:
                        voices[str(v)] = emb
            self.answer(200, {"segments": found, "speakers": len(order), "voices": voices, "seconds": round(len(samples) / sd.sample_rate, 2)})
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
