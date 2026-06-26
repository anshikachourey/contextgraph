"""Sentence embedding using sentence-transformers.

The model is loaded once at module import and stays in memory
for subsequent requests — first request will be slower (~2s model load).
"""

from sentence_transformers import SentenceTransformer
import numpy as np

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"

# Load model once — stays in memory across requests
_model = SentenceTransformer(MODEL_NAME)


def embed_messages(texts: list[str]) -> np.ndarray:
    """
    Embed a list of text strings into 384-dimensional vectors.
    Returns a numpy array of shape (len(texts), 384).
    """
    embeddings = _model.encode(texts, show_progress_bar=False, normalize_embeddings=True)
    return np.array(embeddings)
