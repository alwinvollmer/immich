# booru-tagger (anime tagger service for the fork)

Deployed on nieke as `C:\docker\booru-tagger\tagger` (compose service `danbooru-tagger`, port 7860).

- `POST /v2/analyze` — pixai-tagger-v1.0 (HentaiSL FP32 ONNX export at 1008) + anime head
  detection + CCIP character embeddings. Used by `DanbooruService` in the server.
- `POST /v2/cluster` — CCIP OPTICS clustering (new characters).
- `POST /tag` — legacy pixai v0.9 endpoint for immich-api-worker; drop with the worker (`ENABLE_V1=0`).

`Dockerfile` = CPU (daily use, ~16 s/image, ~4.6 GB RAM). `Dockerfile.gpu` = CUDA (remaps,
~1 s/image on the RTX 3060). Same model file → same tags (benchmark 2026-10-20: 0 flips).

Build on nieke with the proxy build args emptied — Docker Desktop's build proxy returns 502 for
Fastly hosts (PyPI, deb.debian.org):

    docker build --pull=false --build-arg HTTP_PROXY= --build-arg HTTPS_PROXY= \
      --build-arg http_proxy= --build-arg https_proxy= -t <name> .
