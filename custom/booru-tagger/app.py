"""Anime tagger service — FastAPI + ONNX Runtime.

v2 (used by the Immich fork):
  POST /v2/analyze  multipart: image=<file>, thresholds=<json, optional>, heads=<1|0, optional>,
                    regions=<1|0, optional>, boxes=<json, optional>
        -> {"model", "width", "height", "tags": {general, character, copyright, rating},
            "heads": [{"box": [x1, y1, x2, y2], "score", "ccip": [768 floats]}]}
        pixai-tagger-v1.0 + anime head detection + CCIP character embeddings
        (heads=0 skips head detection + CCIP: the server reuses heads it stored before and may pass
        their boxes; regions=1 adds pixai's character scores per head region when the image has a
        pixai character: heads[i].character = {tag: score})
  POST /v2/regions  multipart: image=<file>, boxes=<json [[x1, y1, x2, y2], ...]>, floor=<float, default 0.05>
        -> {"regions": [{"box": [...], "character": {tag: score}}]}: pixai on each head region, enlarged
        to head + upper body (characters are recognised from hair, clothes and accessories too)
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
def analyze(
    image: UploadFile = File(...),
    thresholds: str = Form("{}"),
    heads: str = Form("1"),
    regions: str = Form("0"),
    boxes: str = Form(""),
):
    import characters

    img = _open_image(image.file.read())
    try:
        thr = json.loads(thresholds or "{}")
        given = json.loads(boxes) if boxes else []
    except ValueError:
        raise HTTPException(status_code=400, detail="thresholds and boxes must be JSON")
    with _v2_lock:
        started = time.time()
        try:
            tags = _v2["tagger"].predict(img, thr)
            rgb = img.convert("RGB")
            found = characters.heads_with_embeddings(rgb) if heads != "0" else [{"box": box} for box in given]
            if regions == "1" and tags["character"]:
                for head in found:
                    head["character"] = _region_scores(rgb, head["box"])
        except Exception as e:
            log.exception("v2 analyze error")
            raise HTTPException(status_code=500, detail=str(e))
    log.info(
        f"v2: {len(tags['general'])} general, characters {list(tags['character'])}, "
        f"copyright {list(tags['copyright'])}, {len(found)} heads ({'detected' if heads != '0' else 'given'}"
        f"{', regions' if regions == '1' and tags['character'] else ''}), {time.time() - started:.1f}s"
    )
    from pixai10 import MODEL_NAME

    return {"model": MODEL_NAME, "width": img.width, "height": img.height, "tags": tags, "heads": found}


def _region(box: list, width: int, height: int) -> tuple:
    """head box -> head + upper body: 2x wider, from half a head above to 3 heads below"""
    x1, y1, x2, y2 = box
    w, h = x2 - x1, y2 - y1
    cx = (x1 + x2) / 2
    return (
        max(0, int(cx - w)),
        max(0, int(y1 - h * 0.5)),
        min(width, int(cx + w)),
        min(height, int(y2 + h * 3)),
    )


def _region_scores(rgb: Image.Image, box: list, floor: float = 0.05) -> dict:
    """pixai's character scores on a head region (characters are recognised from hair, clothes too)"""
    crop = rgb.crop(_region(box, rgb.width, rgb.height))
    return _v2["tagger"].predict(crop, {"character": floor, "general": 1.01, "copyright": 1.01})["character"]


@app.post("/v2/regions")
def regions(image: UploadFile = File(...), boxes: str = Form(...), floor: float = Form(0.05)):
    img = _open_image(image.file.read()).convert("RGB")
    try:
        box_list = json.loads(boxes)
    except ValueError:
        raise HTTPException(status_code=400, detail="boxes must be JSON")
    out = []
    with _v2_lock:
        started = time.time()
        for box in box_list:
            out.append({"box": box, "character": _region_scores(img, box, floor)})
    log.info(f"v2 regions: {len(box_list)} boxes, {time.time() - started:.1f}s")
    return {"regions": out}


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
