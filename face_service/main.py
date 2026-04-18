from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import numpy as np
import requests
import tempfile
import os
from deepface import DeepFace

app = FastAPI()

MODEL_NAME = "Facenet512"
MATCH_THRESHOLD = 0.4  # cosine distance threshold


class EmbedRequest(BaseModel):
    image_url: str


class Candidate(BaseModel):
    id: str
    embedding: list[float]


class MatchRequest(BaseModel):
    image_url: str
    candidates: list[Candidate]


def download_image(url: str) -> str:
    resp = requests.get(url, timeout=15)
    resp.raise_for_status()
    suffix = ".jpg"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp.write(resp.content)
    tmp.close()
    return tmp.name


def get_embedding(image_path: str) -> list[float]:
    result = DeepFace.represent(
        img_path=image_path,
        model_name=MODEL_NAME,
        enforce_detection=True,
        detector_backend="retinaface",
    )
    return result[0]["embedding"]


def cosine_distance(a: list[float], b: list[float]) -> float:
    va, vb = np.array(a), np.array(b)
    return float(1 - np.dot(va, vb) / (np.linalg.norm(va) * np.linalg.norm(vb)))


@app.post("/embed")
def embed(req: EmbedRequest):
    path = None
    try:
        path = download_image(req.image_url)
        embedding = get_embedding(path)
        return {"embedding": embedding}
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))
    finally:
        if path and os.path.exists(path):
            os.remove(path)


@app.post("/match")
def match(req: MatchRequest):
    if not req.candidates:
        return {"matched_id": None, "distance": None}

    path = None
    try:
        path = download_image(req.image_url)
        query_emb = get_embedding(path)

        best_id, best_dist = None, float("inf")
        for c in req.candidates:
            dist = cosine_distance(query_emb, c.embedding)
            if dist < best_dist:
                best_dist = dist
                best_id = c.id

        if best_dist > MATCH_THRESHOLD:
            return {"matched_id": None, "distance": best_dist}

        return {"matched_id": best_id, "distance": best_dist}
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))
    finally:
        if path and os.path.exists(path):
            os.remove(path)


@app.get("/health")
def health():
    return {"status": "ok"}
