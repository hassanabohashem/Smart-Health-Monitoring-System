# Smart Health AI — production container
#
# Build:  docker build -t smarthealth-api .
# Run:    docker run -p 8000:8000 --env-file .env smarthealth-api
#
# We use the slim Python image for a reasonable starting size. PyTorch
# (pulled in by sentence-transformers for RAG embeddings) is large — the
# final image is ~3GB. If you drop RAG, you can use python:3.12-alpine and
# get to ~200MB.
FROM python:3.12-slim

# System deps for pypdf + sentence-transformers + FAISS
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first so Docker can cache the layer.
# We use requirements-prod.txt (no Streamlit / dev tooling) and install torch
# from the CPU-only index to avoid pulling ~700MB of CUDA wheels.
COPY requirements-prod.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir \
        --extra-index-url https://download.pytorch.org/whl/cpu \
        torch==2.11.0+cpu \
    && pip install --no-cache-dir -r requirements-prod.txt

# Copy the rest of the app (see .dockerignore for exclusions)
COPY . .

# Pre-build the RAG index during image build. With PDFs in the corpus,
# first-time indexing on Render's free tier would otherwise exceed the
# 30-second health-check timeout and fail the deploy. Baking the index
# into the image means the container is ready to serve /chat instantly.
RUN python -c "from core.rag import _load_or_build_index; _load_or_build_index()" \
    && echo "RAG index built"

EXPOSE 7860

# Honor the platform's $PORT if set, else default to 7860 (HF Spaces standard).
# Render/Fly/Railway set $PORT automatically, so they still work.
ENV PORT=7860
CMD ["sh", "-c", "uvicorn api:app --host 0.0.0.0 --port ${PORT}"]
