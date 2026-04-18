import fetch from 'node-fetch';

const FACE_SERVICE_URL = process.env.FACE_SERVICE_URL || 'http://localhost:5001';

export async function generateEmbedding(imageUrl: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${FACE_SERVICE_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl }),
    });
    if (!res.ok) {
      console.error(`[FaceService] /embed failed: ${res.status} ${await res.text()}`);
      return null;
    }
    const data = await res.json() as { embedding: number[] };
    return data.embedding;
  } catch (err) {
    console.error('[FaceService] /embed error:', err);
    return null;
  }
}

export async function matchFace(
  imageUrl: string,
  candidates: { id: string; embedding: number[] }[]
): Promise<{ matched_id: string | null; distance: number | null }> {
  try {
    const res = await fetch(`${FACE_SERVICE_URL}/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl, candidates }),
    });
    if (!res.ok) {
      console.error(`[FaceService] /match failed: ${res.status} ${await res.text()}`);
      return { matched_id: null, distance: null };
    }
    return await res.json() as { matched_id: string | null; distance: number | null };
  } catch (err) {
    console.error('[FaceService] /match error:', err);
    return { matched_id: null, distance: null };
  }
}
