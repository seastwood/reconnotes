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
