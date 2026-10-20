# Ubuntu base: deb.debian.org (python:*-slim) is unreachable from nieke's Docker (2026-10-20)
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    HF_HOME=/model-cache \
    IMGUTILS_HOME=/model-cache \
    PATH=/venv/bin:$PATH

# libgl1/libglib2.0: OpenCV (imgutils detection) needs them
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-venv libgl1 libglib2.0-0 ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    python3 -m venv /venv

WORKDIR /app

RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir \
        "dghs-imgutils==0.19.0" \
        "onnxruntime>=1.19.0,<1.23" \
        fastapi \
        "uvicorn[standard]" \
        python-multipart \
        pillow

COPY app.py pixai10.py characters.py ./

EXPOSE 7860
CMD ["python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
