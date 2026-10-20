"""Anime tagger service — FastAPI + ONNX Runtime.

v2 (used by the Immich fork):
  POST /v2/analyze  multipart: image=<file>, thresholds=<json, optional>
        -> {"model", "width", "height", "tags": {general, character, copyright, rating},
            "heads": [{"box": [x1, y1, x2, y2], "score", "ccip": [768 floats]}]}
        pixai-tagger-v1.0 + anime head detection + CCIP character embeddings.
  POST /v2/cluster  {"embeddings": [[...]], "min_samples": 3} -> {"labels": [...]}
  GET  /v2/info     -> model name, default thresholds, device

v1 (legacy, immich-api-worker; remove with the worker):
  POST /tag  {"image": "<base64>", "general_threshold": 0.3, "character_threshold": 0.75}
        -> {"general": "tag1, tag2", "character": "char1", "copyright": "ip1"}
"""

import base64
import io
import json
import logging
import os
import threading
import time

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from PIL import Image

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


app = FastAPI()


class TagRequest(BaseModel):
    image: str  # base64-encoded image bytes
    general_threshold: float = 0.3
    character_threshold: float = 0.75


class TagResponse(BaseModel):
    general: str
    character: str
    copyright: str


_v2 = {}
_v2_lock = threading.Lock()


@app.on_event("startup")
def warmup():
    """Pre-load the models on startup to avoid a cold start on the first request."""
    import numpy as np

    import characters
    from pixai10 import PixaiTagger

    log.info("Loading pixai-tagger-v1.0 ...")
    _v2["tagger"] = PixaiTagger()
    dummy = Image.fromarray(np.zeros((512, 512, 3), dtype=np.uint8))
    _v2["tagger"].predict(dummy, {})
    characters.heads_with_embeddings(dummy)
    log.info("v2 models loaded and ready.")
    if os.environ.get("ENABLE_V1", "1") == "1":
        from imgutils.tagging import get_pixai_tags

        log.info("Loading pixai-tagger-v0.9 model (legacy /tag)...")
        get_pixai_tags(Image.fromarray(np.zeros((448, 448, 3), dtype=np.uint8)), thresholds=0.99)
        log.info("Model loaded and ready.")


def _open_image(data: bytes) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
        return image
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image: {e}")


@app.post("/v2/analyze")
def analyze(image: UploadFile = File(...), thresholds: str = Form("{}")):
    import characters

    img = _open_image(image.file.read())
    try:
        thr = json.loads(thresholds or "{}")
    except ValueError:
        raise HTTPException(status_code=400, detail="thresholds must be JSON")
    with _v2_lock:
        started = time.time()
        try:
            tags = _v2["tagger"].predict(img, thr)
            rgb = img.convert("RGB")
            heads = characters.heads_with_embeddings(rgb)
        except Exception as e:
            log.exception("v2 analyze error")
            raise HTTPException(status_code=500, detail=str(e))
    log.info(
        f"v2: {len(tags['general'])} general, characters {list(tags['character'])}, "
        f"copyright {list(tags['copyright'])}, {len(heads)} heads, {time.time() - started:.1f}s"
    )
    from pixai10 import MODEL_NAME

    return {"model": MODEL_NAME, "width": img.width, "height": img.height, "tags": tags, "heads": heads}


class ClusterRequest(BaseModel):
    embeddings: list[list[float]]
    min_samples: int = 3


@app.post("/v2/cluster")
def cluster(req: ClusterRequest):
    import characters

    with _v2_lock:
        return {"labels": characters.cluster(req.embeddings, req.min_samples)}


@app.get("/v2/info")
def info():
    from pixai10 import MODEL_NAME, providers

    tagger = _v2.get("tagger")
    return {
        "model": MODEL_NAME,
        "ready": tagger is not None,
        "thresholds": tagger.default_thresholds if tagger else None,
        "providers": tagger.session.get_providers() if tagger else providers(),
    }


@app.post("/tag", response_model=TagResponse)
def tag(req: TagRequest):
    from imgutils.tagging import get_pixai_tags

    try:
        img_bytes = base64.b64decode(req.image)
        image = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image: {e}")

    try:
        general_tags, character_tags = get_pixai_tags(
            image,
            thresholds={"general": req.general_threshold, "character": req.character_threshold},
        )
        # fmt='ips' derives franchises from character detections — pass same character threshold
        copyright_list = get_pixai_tags(
            image,
            fmt="ips",
            thresholds={"character": req.character_threshold},
        )
    except Exception as e:
        log.exception("Tagger error")
        raise HTTPException(status_code=500, detail=str(e))

    general_str = ", ".join(general_tags.keys())
    character_str = ", ".join(character_tags.keys())
    copyright_str = ", ".join(copyright_list)

    log.info(
        f"Tagged: {len(general_tags)} general, {len(character_tags)} character, "
        f"{len(copyright_list)} copyright"
    )
    log.info(f"  general: {general_str[:120]}")
    log.info(f"  character: {character_str}")
    log.info(f"  copyright: {copyright_str}")

    return TagResponse(general=general_str, character=character_str, copyright=copyright_str)


@app.get("/health")
def health():
    return {"status": "ok"}
