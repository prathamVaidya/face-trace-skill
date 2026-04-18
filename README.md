# Face Trace Skill

A Trace AI Glass skill that remembers faces. When you meet someone, take a photo — the skill generates a face embedding and saves it. Next time you see the same person, take another photo and the skill identifies them and speaks their name.

---

## Architecture

This is a **hybrid skill** with two components:

1. **TypeScript server** (`src/`) — Express app handling Trace webhook and MCP endpoints
2. **Python face service** (`face_service/`) — FastAPI app using DeepFace for face embedding and matching

```
User takes photo
  → media.photo webhook → TypeScript server
  → calls Python /embed → generates 512-dim Facenet512 embedding
  → if match found → callback_url → TTS: "That's [Name]!"
  → if no match → saves pending photo → TTS: "Say name is [name]"

User says "name is John"
  → interaction.dialog MCP → TypeScript server
  → links name to pending photo embedding → saves to SQLite

User takes photo again
  → same flow → matches embedding → TTS: "That's John!"
```

---

## Setup

### Prerequisites
- Node.js v18+
- Python 3.10+
- pnpm

### 1. TypeScript server

```bash
pnpm install
cp .env.example .env
```

Fill in `.env`:
```env
PORT=8087
TRACE_HMAC_SECRET=your_hmac_secret_from_dashboard
TRACE_SKILL_ID=your_skill_id
BRAIN_BASE_URL=https://brain.endlessriver.ai
FACE_SERVICE_URL=http://localhost:5001
```

```bash
pnpm dev
```

### 2. Python face service

```bash
cd face_service
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --port 5001
```

### 3. Expose to internet

```bash
ngrok http 8087
```

Update your skill endpoints in the Trace Dashboard with the ngrok URL.

---

## Manifest

```json
{
  "name": "Face Trace Skill",
  "interface": "hybrid",
  "triggers": [
    { "channel": "media.photo", "routing_mode": "active" },
    { "channel": "interaction.dialog", "routing_mode": "active" }
  ],
  "domains": {
    "human_face": "Handle queries if the image contains a human face. Only route here.",
    "remember_name": "Handle query when user tells the name of the human or asks to save."
  },
  "permissions": ["notification.send", "user.profile.read", "user.location.read"]
}
```

---

## API

### TypeScript Server

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/webhook` | Receives `media.photo` and `interaction.dialog` events from Trace |
| POST | `/mcp` | JSON-RPC 2.0 endpoint for voice dialog |
| POST | `/delete-user` | Deletes all stored data for a user |

### Python Face Service

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/embed` | `{ image_url }` → `{ embedding: float[] }` |
| POST | `/match` | `{ image_url, candidates: [{id, embedding}] }` → `{ matched_id, distance }` |
| GET | `/health` | Health check |

---

## Voice Commands

| Utterance | Action |
|-----------|--------|
| `name is [name]` | Links the name to the last captured pending photo |
| `who is [name]` | Looks up a person by name and reads when you met them |
| `list people` / `show people` | Lists up to 5 recently met people |

---

## Database

SQLite (`faces.db`) with two tables:

**`people`** — saved faces
| Column | Type | Description |
|--------|------|-------------|
| id | TEXT | UUID |
| user_id | TEXT | Proxied Trace user ID |
| name | TEXT | Person's name |
| image_url | TEXT | Original photo URL |
| embedding | TEXT | JSON array of 512 floats (Facenet512) |
| met_at | TEXT | ISO timestamp |
| location | TEXT | `lat,lng` string if location permission granted |

**`pending_photos`** — photos awaiting a name
| Column | Type | Description |
|--------|------|-------------|
| id | TEXT | UUID |
| user_id | TEXT | Proxied Trace user ID |
| image_url | TEXT | Photo URL |
| embedding | TEXT | Face embedding JSON |
| created_at | TEXT | ISO timestamp |

---

## Face Recognition

- **Model**: Facenet512 via DeepFace
- **Detector**: RetinaFace
- **Distance metric**: Cosine distance
- **Match threshold**: 0.4 (lower = stricter)

To tune sensitivity, adjust `MATCH_THRESHOLD` in `face_service/main.py`.

---

## Security

- All webhook requests from Trace are verified using HMAC-SHA256 (`src/hmac.ts`)
- Callback responses to Trace are signed with the same HMAC secret
- User IDs are stable proxied identifiers — never raw identity

---

## Deployment

1. Deploy TypeScript server to Railway or any Node host
2. Deploy Python face service to a GPU-enabled host (recommended) or any Python host
3. Set `FACE_SERVICE_URL` to the Python service's public URL
4. Update webhook and MCP endpoints in the Trace Dashboard
