"""
Retrieval-Augmented Generation (RAG) for Smart Health AI.

Loads the `corpus/` directory into a FAISS index (built with all-MiniLM-L6-v2
sentence embeddings) and provides a `retrieve()` function for the chat pipeline.

Supports both markdown / text files and PDF files. The index is persisted to
`medical_db/` so it's built once on first use.

Design choices:
- Chunk size 500 characters with 50-char overlap — proven default for MiniLM.
- Lazy loading + @functools.lru_cache so first retrieve() warms the cache
  once per process; subsequent retrievals are a few milliseconds.
- Fails open: if the corpus is empty or embeddings are unavailable, retrieve()
  returns an empty string and the LLM still runs without RAG context.
"""
from __future__ import annotations

import functools
import glob
import os
from pathlib import Path
from typing import List, Optional, Tuple

from .logger import log_event

CORPUS_DIR = Path(os.environ.get("SMARTHEALTH_CORPUS_DIR", "corpus"))
INDEX_DIR = Path(os.environ.get("SMARTHEALTH_INDEX_DIR", "medical_db"))


def _list_corpus_files() -> List[Path]:
    if not CORPUS_DIR.exists():
        return []
    patterns = ["*.md", "*.txt", "*.pdf"]
    files: List[Path] = []
    for pat in patterns:
        files.extend(sorted(CORPUS_DIR.glob(pat)))
    return files


def _load_md_or_txt(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:  # noqa: BLE001
        log_event("rag_read_error", path=str(path), error=str(e))
        return ""


def _load_pdf(path: Path) -> str:
    try:
        # Lazy import so users without PDF support still work
        from pypdf import PdfReader  # type: ignore
        reader = PdfReader(str(path))
        return "\n".join((p.extract_text() or "") for p in reader.pages)
    except Exception as e:  # noqa: BLE001
        log_event("rag_pdf_error", path=str(path), error=str(e))
        return ""


def _split_chunks(text: str, chunk_size: int = 500, overlap: int = 50) -> List[str]:
    """
    Naive character-based splitter. Keeps paragraph boundaries when possible.
    """
    if not text:
        return []
    # First try paragraph split
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks: List[str] = []
    buf = ""
    for p in paragraphs:
        if len(buf) + len(p) + 2 <= chunk_size:
            buf = (buf + "\n\n" + p).strip()
        else:
            if buf:
                chunks.append(buf)
            # If the paragraph itself is larger than chunk_size, hard-split.
            if len(p) > chunk_size:
                i = 0
                while i < len(p):
                    chunks.append(p[i: i + chunk_size])
                    i += chunk_size - overlap
                buf = ""
            else:
                buf = p
    if buf:
        chunks.append(buf)
    return chunks


# ── FAISS-backed implementation ────────────────────────────────────────

@functools.lru_cache(maxsize=1)
def _load_or_build_index():
    """
    Load the FAISS index if persisted, otherwise build it from the corpus.
    Returns (db, embeddings) or (None, None) if RAG cannot start.
    """
    try:
        from langchain_community.embeddings import HuggingFaceEmbeddings
        from langchain_community.vectorstores import FAISS
        from langchain_text_splitters import RecursiveCharacterTextSplitter
    except Exception as e:  # noqa: BLE001
        log_event("rag_import_failed", error=str(e))
        return None, None

    embeddings = HuggingFaceEmbeddings(
        model_name="all-MiniLM-L6-v2",
        model_kwargs={"device": "cpu"},
    )

    # Try to load persisted index
    if INDEX_DIR.exists():
        try:
            db = FAISS.load_local(
                str(INDEX_DIR), embeddings, allow_dangerous_deserialization=True,
            )
            log_event("rag_index_loaded", path=str(INDEX_DIR))
            return db, embeddings
        except Exception as e:  # noqa: BLE001
            log_event("rag_index_load_failed", error=str(e), path=str(INDEX_DIR))
            # fall through and rebuild

    # Build from corpus
    files = _list_corpus_files()
    if not files:
        log_event("rag_no_corpus", dir=str(CORPUS_DIR))
        return None, None

    all_chunks: List[Tuple[str, dict]] = []  # (text, metadata)
    splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=50)

    for f in files:
        if f.suffix.lower() == ".pdf":
            text = _load_pdf(f)
        else:
            text = _load_md_or_txt(f)
        if not text:
            continue
        chunks = splitter.split_text(text)
        for i, c in enumerate(chunks):
            all_chunks.append((c, {"source": f.name, "chunk": i}))

    if not all_chunks:
        log_event("rag_no_chunks")
        return None, None

    texts = [c for c, _ in all_chunks]
    metas = [m for _, m in all_chunks]
    db = FAISS.from_texts(texts, embeddings, metadatas=metas)

    try:
        INDEX_DIR.mkdir(parents=True, exist_ok=True)
        db.save_local(str(INDEX_DIR))
        log_event("rag_index_built", files=len(files), chunks=len(all_chunks),
                  path=str(INDEX_DIR))
    except Exception as e:  # noqa: BLE001
        log_event("rag_index_save_failed", error=str(e))

    return db, embeddings


def retrieve(query: str, k: int = 3, max_chars: int = 2000) -> str:
    """Backward-compatible wrapper — returns just the concatenated text."""
    text, _ = retrieve_with_sources(query, k=k, max_chars=max_chars)
    return text


def retrieve_with_sources(
    query: str, k: int = 3, max_chars: int = 2000,
) -> "tuple[str, list[dict]]":
    """
    Retrieve up to k relevant chunks. Returns (concatenated_text, sources)
    where sources is a list of dicts: [{source, chunk, snippet}].
    """
    if not query or not query.strip():
        return "", []
    db, _ = _load_or_build_index()
    if db is None:
        return "", []
    try:
        docs = db.similarity_search(query, k=k)
    except Exception as e:  # noqa: BLE001
        log_event("rag_search_failed", error=str(e))
        return "", []
    if not docs:
        return "", []
    pieces: list[str] = []
    sources: list[dict] = []
    used = 0
    seen_sources: set[str] = set()
    for doc in docs:
        meta = doc.metadata or {}
        src = meta.get("source", "unknown")
        chunk_idx = meta.get("chunk", 0)
        text = (doc.page_content or "").strip()
        piece = f"[source: {src}]\n{text}"
        if used + len(piece) > max_chars and pieces:
            break
        pieces.append(piece)
        used += len(piece)
        # Dedupe sources per request — if multiple chunks come from the same
        # file, only show it once.
        if src not in seen_sources:
            seen_sources.add(src)
            # Include a short snippet for UI tooltips
            snippet = text[:140] + ("…" if len(text) > 140 else "")
            sources.append({
                "source": src,
                "chunk": chunk_idx,
                "snippet": snippet,
            })
    return "\n\n".join(pieces), sources


def reset_index():
    """Delete the persisted index. Useful after adding new PDFs to corpus/."""
    import shutil
    if INDEX_DIR.exists():
        shutil.rmtree(INDEX_DIR)
    _load_or_build_index.cache_clear()


def index_stats() -> dict:
    """Return stats about the current corpus and index."""
    files = _list_corpus_files()
    return {
        "corpus_dir": str(CORPUS_DIR),
        "index_dir": str(INDEX_DIR),
        "corpus_files": [f.name for f in files],
        "index_exists": INDEX_DIR.exists(),
    }
