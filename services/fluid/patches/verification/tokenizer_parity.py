"""Token ids from Google's sentencepiece for each line of tokenizer-parity-input.txt.

Compare against FluidAudio's SentencePieceTokenizer on the same lines; with
patch 0001 the id sequences are identical. Needs the `sentencepiece` package,
e.g. ~/Services/tts/mlx-audio/.venv/bin/python tokenizer_parity.py
"""
import os
import sys

import sentencepiece

here = os.path.dirname(os.path.abspath(__file__))
model = os.path.expanduser(
    sys.argv[1] if len(sys.argv) > 1
    else "~/.cache/fluidaudio/Models/pocket-tts/v2.1/english/constants_bin/tokenizer.model"
)
sp = sentencepiece.SentencePieceProcessor(model)
for line in open(os.path.join(here, "tokenizer-parity-input.txt"), encoding="utf-8"):
    line = line.rstrip("\n")
    if line.strip():
        ids = sp.encode(line)
        print(f"{len(ids):3d} tokens :: {' '.join(map(str, ids))}")
