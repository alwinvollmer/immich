"""Anime head detection + CCIP character embeddings (dghs-imgutils)."""

import numpy as np
from PIL import Image

MIN_HEAD_SCORE = 0.5


def heads_with_embeddings(image: Image.Image) -> list:
    from imgutils.detect import detect_heads
    from imgutils.metrics import ccip_batch_extract_features

    heads = [h for h in detect_heads(image) if h[2] >= MIN_HEAD_SCORE]
    if not heads:
        return []
    crops = [image.crop(box) for box, _, _ in heads]
    features = ccip_batch_extract_features(crops)
    out = []
    for (box, _, score), feature in zip(heads, features):
        out.append({
            "box": [int(v) for v in box],
            "score": round(float(score), 4),
            "ccip": [round(float(v), 6) for v in np.asarray(feature, dtype=np.float32)],
        })
    return out


def cluster(embeddings: list, min_samples: int) -> list:
    """OPTICS clustering with CCIP's tuned eps (labels, -1 = noise)."""
    from imgutils.metrics import ccip_clustering

    feats = [np.asarray(e, dtype=np.float32) for e in embeddings]
    if len(feats) < max(2, min_samples):
        return [-1] * len(feats)
    return [int(v) for v in ccip_clustering(feats, method="optics", min_samples=min_samples)]
