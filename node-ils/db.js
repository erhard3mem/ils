'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const session = require('express-session');

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'library.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS books (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  isbn         TEXT UNIQUE,
  title        TEXT NOT NULL,
  author       TEXT NOT NULL,
  publisher    TEXT,
  year         INTEGER,
  copies_total INTEGER NOT NULL DEFAULT 1 CHECK (copies_total >= 1),
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  loaned_at   TEXT NOT NULL DEFAULT (datetime('now')),
  due_at      TEXT NOT NULL,
  returned_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_loans_book_active ON loans(book_id) WHERE returned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_loans_user_active ON loans(user_id) WHERE returned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_books_title  ON books(title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_books_author ON books(author COLLATE NOCASE);

-- Eine Rezension je Benutzer und Buch (Sterne 1–5, Text optional)
CREATE TABLE IF NOT EXISTS reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (book_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_book ON reviews(book_id);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  expires INTEGER NOT NULL,
  data    TEXT NOT NULL
);
`);

/** Minimaler Session-Store auf SQLite, damit Logins einen Neustart überstehen. */
class SqliteStore extends session.Store {
  constructor() {
    super();
    this._get = db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?');
    this._set = db.prepare('INSERT OR REPLACE INTO sessions (sid, expires, data) VALUES (?, ?, ?)');
    this._del = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this._gc = db.prepare('DELETE FROM sessions WHERE expires <= ?');
    setInterval(() => this._gc.run(Date.now()), 15 * 60 * 1000).unref();
  }
  _expiry(sess) {
    return sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
  }
  get(sid, cb) {
    try {
      const row = this._get.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try { this._set.run(sid, this._expiry(sess), JSON.stringify(sess)); cb && cb(null); }
    catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
  destroy(sid, cb) {
    try { this._del.run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
}

module.exports = { db, SqliteStore };
