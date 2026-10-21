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
    """OPTICS clustering with CCIP's default parameters (labels, -1 = noise).

    Same as imgutils' ccip_clustering(method="optics"), but on a precomputed distance matrix:
    imgutils hands OPTICS a Python callback (~36 M calls for 6,000 heads, far beyond the server's
    5-minute request timeout). CCIP's difference metric is exactly half the cosine distance
    (verified 2026-10-20), so the matrix is one matrix product.
    """
    from sklearn.cluster import OPTICS

    x = np.asarray(embeddings, dtype=np.float32)
    if len(x) < max(2, min_samples):
        return [-1] * len(x)
    x = x / np.linalg.norm(x, axis=1, keepdims=True)
    diff = np.clip(0.5 * (1.0 - x @ x.T), 0.0, None)
    np.fill_diagonal(diff, 0.0)
    return [int(v) for v in OPTICS(max_eps=0.5, min_samples=min_samples, metric="precomputed").fit(diff).labels_]
