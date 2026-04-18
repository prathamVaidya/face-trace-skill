import Database from 'better-sqlite3';
import path from 'path';

const db = new Database(path.join(__dirname, '..', 'faces.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    image_url TEXT,
    embedding TEXT,
    met_at TEXT NOT NULL,
    location TEXT
  );

  CREATE TABLE IF NOT EXISTS pending_photos (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    image_url TEXT NOT NULL,
    embedding TEXT,
    created_at TEXT NOT NULL
  );
`);

export function savePendingPhoto(id: string, userId: string, imageUrl: string, embedding?: number[]) {
  db.prepare('DELETE FROM pending_photos WHERE user_id = ?').run(userId);
  db.prepare(
    'INSERT INTO pending_photos (id, user_id, image_url, embedding, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, userId, imageUrl, embedding ? JSON.stringify(embedding) : null, new Date().toISOString());
}

export function getPendingPhoto(userId: string) {
  const row = db.prepare('SELECT * FROM pending_photos WHERE user_id = ?').get(userId) as
    | { id: string; user_id: string; image_url: string; embedding: string | null; created_at: string }
    | undefined;
  if (!row) return undefined;
  return { ...row, embedding: row.embedding ? (JSON.parse(row.embedding) as number[]) : null };
}

export function clearPendingPhoto(userId: string) {
  db.prepare('DELETE FROM pending_photos WHERE user_id = ?').run(userId);
}

export function savePerson(
  id: string,
  userId: string,
  name: string,
  imageUrl: string,
  embedding?: number[],
  location?: string
) {
  db.prepare(
    'INSERT OR REPLACE INTO people (id, user_id, name, image_url, embedding, met_at, location) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, userId, name, imageUrl, embedding ? JSON.stringify(embedding) : null, new Date().toISOString(), location ?? null);
}

export function getPeopleWithEmbeddings(userId: string) {
  const rows = db.prepare('SELECT id, name, embedding, met_at FROM people WHERE user_id = ? AND embedding IS NOT NULL').all(userId) as {
    id: string;
    name: string;
    embedding: string;
    met_at: string;
  }[];
  return rows.map(r => ({ id: r.id, name: r.name, met_at: r.met_at, embedding: JSON.parse(r.embedding) as number[] }));
}

export function findPersonById(userId: string, personId: string) {
  return db.prepare('SELECT * FROM people WHERE user_id = ? AND id = ?').get(userId, personId) as
    | { id: string; name: string; image_url: string; met_at: string; location: string }
    | undefined;
}

export function findPersonByName(userId: string, name: string) {
  return db
    .prepare('SELECT * FROM people WHERE user_id = ? AND name LIKE ? ORDER BY met_at DESC LIMIT 1')
    .get(userId, `%${name}%`) as
    | { id: string; name: string; image_url: string; met_at: string; location: string }
    | undefined;
}

export function listPeople(userId: string) {
  return db.prepare('SELECT * FROM people WHERE user_id = ? ORDER BY met_at DESC').all(userId) as {
    id: string;
    name: string;
    met_at: string;
    location: string;
  }[];
}

export function deletePeopleForUser(userId: string) {
  db.prepare('DELETE FROM people WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM pending_photos WHERE user_id = ?').run(userId);
}
