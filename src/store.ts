import Database from 'better-sqlite3';
import path from 'path';

const db = new Database(path.join(__dirname, '..', 'faces.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    image_url TEXT,
    met_at TEXT NOT NULL,
    location TEXT
  );

  CREATE TABLE IF NOT EXISTS pending_photos (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    image_url TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

export function savePendingPhoto(id: string, userId: string, imageUrl: string) {
  // Only one pending photo per user at a time
  db.prepare('DELETE FROM pending_photos WHERE user_id = ?').run(userId);
  db.prepare(
    'INSERT INTO pending_photos (id, user_id, image_url, created_at) VALUES (?, ?, ?, ?)'
  ).run(id, userId, imageUrl, new Date().toISOString());
}

export function getPendingPhoto(userId: string) {
  return db.prepare('SELECT * FROM pending_photos WHERE user_id = ?').get(userId) as
    | { id: string; user_id: string; image_url: string; created_at: string }
    | undefined;
}

export function clearPendingPhoto(userId: string) {
  db.prepare('DELETE FROM pending_photos WHERE user_id = ?').run(userId);
}

export function savePerson(
  id: string,
  userId: string,
  name: string,
  imageUrl: string,
  location?: string
) {
  db.prepare(
    'INSERT OR REPLACE INTO people (id, user_id, name, image_url, met_at, location) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, userId, name, imageUrl, new Date().toISOString(), location ?? null);
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
