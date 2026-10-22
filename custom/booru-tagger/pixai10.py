"""pixai-tagger-v1.0 on ONNX Runtime (community ONNX export, same preprocessing as the
official RescalePadProcessor: RGB on white, fit into SIZE x SIZE keeping the aspect
ratio, pad black centred, normalise mean/std 0.5).

Default graph: HentaiSL's FP32 export at 1008 with query-chunked global attention. The same
file runs on CPU (~16 s/image, ~4.6 GB RAM) and GPU (~1 s/image on an RTX 3060), so both
give the same tags (benchmark 2026-10-20). The nocturna FP16 export needs 8 GB RAM on CPU."""

import json
import logging
import os
import re

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from PIL import Image

log = logging.getLogger(__name__)

REPO = os.environ.get("PIXAI_REPO", "HentaiSL/pixai-tagger-v1.0-onnx-1008-672-336-ft")
GRAPH = os.environ.get("PIXAI_GRAPH", "tagger_1008_fp32.onnx")
GRAPH_DATA = os.environ.get("PIXAI_GRAPH_DATA", "tagger_1008_fp32.onnx.data")  # external weights, if any
CONFIG = os.environ.get("PIXAI_CONFIG", "config.json")
SIZE = int(os.environ.get("PIXAI_SIZE", "1008"))
MODEL_NAME = os.environ.get("PIXAI_MODEL_NAME", "pixai-tagger-v1.0")
CATEGORIES = ("general", "character", "copyright", "rating")


def providers():
    if os.environ.get("TAGGER_DEVICE", "cpu").lower() == "gpu":
        # Without limits the CUDA arena grows until the 6 GB card is full; Windows then spills
        # into shared system memory and every image takes ~12 s instead of ~1.5 s (2026-10-21).
        limit_mb = int(os.environ.get("PIXAI_GPU_MEM_MB", "3500"))
        options = {
            "arena_extend_strategy": "kSameAsRequested",
            "gpu_mem_limit": limit_mb * 1024 * 1024,
            "cudnn_conv_algo_search": "HEURISTIC",
        }
        return [("CUDAExecutionProvider", options), "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


class PixaiTagger:
    def __init__(self):
        if GRAPH_DATA:
            hf_hub_download(REPO, GRAPH_DATA)
        path = hf_hub_download(REPO, GRAPH)
        cfg = json.load(open(hf_hub_download(REPO, CONFIG), encoding="utf-8"))
        self.tags = cfg["tags"]
        self.default_thresholds = cfg["category_best_threshold"]
        offset, count = dict((c, (o, n)) for c, o, n in self._splits(cfg))["character"]
        self.character_tags = set(self.tags[offset:offset + count])
        self.splits = {}
        offset = 0
        for category, count in cfg["tags_split"]:
            self.splits[category] = (offset, count)
            offset += count
        self.session = ort.InferenceSession(path, providers=providers())
        self.input_name = self.session.get_inputs()[0].name
        # exports differ: some end in a sigmoid ("probs"), others return raw "logits"
        self.logits = "logit" in self.session.get_outputs()[0].name.lower()
        log.info(
            f"{MODEL_NAME} loaded from {REPO}/{GRAPH} ({'logits' if self.logits else 'probs'}) "
            f"with {self.session.get_providers()}"
        )

    @staticmethod
    def _splits(cfg):
        offset = 0
        for category, count in cfg["tags_split"]:
            yield category, offset, count
            offset += count

    def base_character(self, tag: str) -> str:
        """costume variants are the same character: name_(costume)_(series) -> name_(series),
        when pixai knows that base tag (asuna_(bunny)_(blue_archive) -> asuna_(blue_archive))"""
        # nested forms step down one level at a time:
        # jeanne_d'arc_alter_(avenger)_(third_ascension)_(fate) -> ..._(avenger)_(fate) -> ..._(fate)
        while match := re.match(r"^(.*)_\([^()]*\)_\(([^()]*)\)$", tag):
            base = f"{match.group(1)}_({match.group(2)})"
            if base not in self.character_tags:
                break
            tag = base
        return tag

    def preprocess(self, image: Image.Image) -> np.ndarray:
        if image.mode != "RGB":
            image = image.convert("RGBA")
            canvas = Image.new("RGBA", image.size, (255, 255, 255))
            canvas.alpha_composite(image)
            image = canvas.convert("RGB")
        width, height = image.size
        if (width, height) != (SIZE, SIZE):
            scale = min(SIZE / height, SIZE / width)
            new_w, new_h = max(1, int(width * scale)), max(1, int(height * scale))
            image = image.resize((new_w, new_h), Image.Resampling.BILINEAR)
            canvas = Image.new("RGB", (SIZE, SIZE), (0, 0, 0))
            canvas.paste(image, ((SIZE - new_w) // 2, (SIZE - new_h) // 2))
            image = canvas
        array = (np.asarray(image, dtype=np.float32) / 255.0 - 0.5) / 0.5
        return np.transpose(array, (2, 0, 1))[None]

    def predict(self, image: Image.Image, thresholds: dict) -> dict:
        """Tag scores per category, each filtered by its threshold (rating: all four)."""
        probs = self.session.run(None, {self.input_name: self.preprocess(image)})[0][0]
        if self.logits:
            probs = 1.0 / (1.0 + np.exp(-probs.astype(np.float32)))
        result = {}
        for category in CATEGORIES:
            offset, count = self.splits[category]
            scores = probs[offset:offset + count]
            floor = 0.0 if category == "rating" else thresholds.get(category, self.default_thresholds[category])
            idx = np.flatnonzero(scores >= floor)
            ordered = idx[np.argsort(-scores[idx])]
            result[category] = {self.tags[offset + int(i)]: round(float(scores[i]), 4) for i in ordered}
        # costume variants merge into their character (highest score wins)
        merged = {}
        for tag, score in result["character"].items():
            base = self.base_character(tag)
            merged[base] = max(merged.get(base, 0.0), score)
        result["character"] = dict(sorted(merged.items(), key=lambda item: -item[1]))
        return result
