'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { db, SqliteStore } = require('./db');
const isbnLib = require('./isbn');
const { createLookup } = require('./lookup');

const LOOKUP_ENABLED = (process.env.ISBN_LOOKUP || 'on').toLowerCase() !== 'off';
const lookupIsbn = createLookup();

const PORT = process.env.PORT || 3000;
const LOAN_DAYS = 28;

let secret = process.env.SESSION_SECRET;
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET nicht gesetzt – zufälliges Secret, Logins gelten nur bis zum Neustart.');
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use(session({
  name: 'ils.sid',
  secret,
  store: new SqliteStore(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 8
  }
}));

// Zusätzliche CSRF-Hürde: schreibende Requests müssen JSON sein (kein Formular-Post von Fremdseiten)
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type muss application/json sein.' });
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Hilfsfunktionen ----------
const requireAuth = (req, res, next) =>
  req.session.userId ? next() : res.status(401).json({ error: 'Bitte zuerst anmelden.' });

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Findet ein Buch zu einer geprüften ISBN – egal ob als ISBN-13 oder ISBN-10 gespeichert. */
const findByIsbn = (p) =>
  db.prepare('SELECT id, title, copies_total FROM books WHERE isbn IN (?, ?)').get(p.isbn13, p.isbn10 ?? p.isbn13);

// einfache Bremse gegen Passwort-Raten: 10 Fehlversuche je IP in 15 Minuten
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const e = attempts.get(ip);
  if (!e || now - e.first > 15 * 60 * 1000) { attempts.set(ip, { first: now, n: 0 }); return false; }
  return e.n >= 10;
}
const failAttempt = (ip) => { const e = attempts.get(ip); if (e) e.n++; };

// ---------- Auth ----------
app.post('/api/register', (req, res) => {
  const username = str(req.body.username, 40);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!/^[\p{L}\p{N}_.-]{3,40}$/u.test(username))
    return res.status(400).json({ error: 'Benutzername: 3–40 Zeichen (Buchstaben, Zahlen, _ . -).' });
  if (password.length < 8 || password.length > 200)
    return res.status(400).json({ error: 'Das Passwort braucht mindestens 8 Zeichen.' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username))
    return res.status(409).json({ error: 'Dieser Benutzername ist bereits vergeben.' });

  const isFirst = db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0;
  const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, bcrypt.hashSync(password, 12), isFirst ? 'admin' : 'member');

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Sitzungsfehler.' });
    req.session.userId = info.lastInsertRowid;
    res.status(201).json({ id: info.lastInsertRowid, username, role: isFirst ? 'admin' : 'member' });
  });
});

app.post('/api/login', (req, res) => {
  if (tooManyAttempts(req.ip))
    return res.status(429).json({ error: 'Zu viele Versuche. Bitte in 15 Minuten erneut probieren.' });
  const username = str(req.body.username, 40);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  // immer vergleichen, damit die Antwortzeit nichts über existierende Benutzer verrät
  const hash = user ? user.password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = bcrypt.compareSync(password, hash) && user;
  if (!ok) { failAttempt(req.ip); return res.status(401).json({ error: 'Benutzername oder Passwort stimmt nicht.' }); }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Sitzungsfehler.' });
    req.session.userId = user.id;
    res.json({ id: user.id, username: user.username, role: user.role });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('ils.sid'); res.json({ ok: true }); });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json(null);
  const u = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.session.userId);
  res.json(u || null);
});

// ---------- Bücher ----------
const BOOK_SELECT = `
  SELECT b.id, b.isbn, b.title, b.author, b.publisher, b.year, b.copies_total,
         b.copies_total - (SELECT COUNT(*) FROM loans l WHERE l.book_id = b.id AND l.returned_at IS NULL) AS copies_available,
         EXISTS (SELECT 1 FROM loans l WHERE l.book_id = b.id AND l.user_id = @uid AND l.returned_at IS NULL) AS loaned_by_me,
         (SELECT ROUND(AVG(r.rating), 1) FROM reviews r WHERE r.book_id = b.id) AS avg_rating,
         (SELECT COUNT(*) FROM reviews r WHERE r.book_id = b.id) AS review_count
  FROM books b`;

app.get('/api/books', (req, res) => {
  const q = str(req.query.q, 100);
  const uid = req.session.userId || 0;
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  // Gescannte/getippte ISBN (auch mit Bindestrichen oder als ISBN-10) findet das Buch exakt
  let k13 = '', k10 = '';
  try { const p = isbnLib.parse(q); if (p) { k13 = p.isbn13; k10 = p.isbn10 ?? ''; } } catch { /* normale Textsuche */ }
  const rows = q
    ? db.prepare(`${BOOK_SELECT}
        WHERE b.title LIKE @like ESCAPE '\\' OR b.author LIKE @like ESCAPE '\\' OR b.isbn LIKE @like ESCAPE '\\'
           OR (@k13 <> '' AND b.isbn IN (@k13, @k10))
        ORDER BY b.title COLLATE NOCASE LIMIT 200`).all({ like, uid, k13, k10 })
    : db.prepare(`${BOOK_SELECT} ORDER BY b.created_at DESC, b.id DESC LIMIT 200`).all({ uid });
  res.json(rows.map(r => ({ ...r, loaned_by_me: !!r.loaned_by_me })));
});

app.post('/api/books', requireAuth, (req, res) => {
  const title = str(req.body.title, 300);
  const author = str(req.body.author, 200);
  const publisher = str(req.body.publisher, 200) || null;
  const year = req.body.year === '' || req.body.year == null ? null : Number(req.body.year);
  const copies = req.body.copies_total === '' || req.body.copies_total == null ? 1 : Number(req.body.copies_total);

  if (!title || !author) return res.status(400).json({ error: 'Titel und Autor/in sind Pflichtfelder.' });
  if (year !== null && (!Number.isInteger(year) || year < 1000 || year > new Date().getFullYear() + 1))
    return res.status(400).json({ error: 'Erscheinungsjahr ist ungültig.' });
  if (!Number.isInteger(copies) || copies < 1 || copies > 1000)
    return res.status(400).json({ error: 'Exemplare: ganze Zahl zwischen 1 und 1000.' });

  let parsed;
  try { parsed = isbnLib.parse(str(req.body.isbn, 30)); } catch (e) { return res.status(400).json({ error: e.message }); }
  const isbn = parsed ? parsed.isbn13 : null; // immer als ISBN-13 speichern
  if (parsed && findByIsbn(parsed))
    return res.status(409).json({ error: 'Ein Buch mit dieser ISBN existiert bereits.' });

  const info = db.prepare(
    'INSERT INTO books (isbn, title, author, publisher, year, copies_total, created_by) VALUES (?,?,?,?,?,?,?)'
  ).run(isbn, title, author, publisher, year, copies, req.session.userId);
  res.status(201).json({ id: info.lastInsertRowid });
});

// ---------- Rezensionen ----------
// Lesen darf jeder, schreiben nur angemeldete Benutzer (eine Rezension je Buch, später änderbar).
const REVIEW_MAX = 500;
const bookExists = (id) => Number.isInteger(id) && id > 0 && !!db.prepare('SELECT 1 FROM books WHERE id = ?').get(id);

app.get('/api/books/:id/reviews', (req, res) => {
  const id = Number(req.params.id);
  if (!bookExists(id)) return res.status(404).json({ error: 'Buch nicht gefunden.' });
  const uid = req.session.userId || 0;
  const rows = db.prepare(`
    SELECT r.id, r.rating, r.body, r.created_at, r.updated_at, u.username, (r.user_id = @uid) AS mine
    FROM reviews r JOIN users u ON u.id = r.user_id
    WHERE r.book_id = @id
    ORDER BY (r.user_id = @uid) DESC, r.updated_at DESC, r.id DESC
    LIMIT 200`).all({ id, uid });
  const summary = db.prepare('SELECT COUNT(*) AS count, ROUND(AVG(rating), 1) AS avg FROM reviews WHERE book_id = ?').get(id);
  res.json({ summary, reviews: rows.map((r) => ({ ...r, mine: !!r.mine })) });
});

app.put('/api/books/:id/review', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!bookExists(id)) return res.status(404).json({ error: 'Buch nicht gefunden.' });

  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5)
    return res.status(400).json({ error: 'Bitte 1 bis 5 Sterne vergeben.' });
  // Text optional; Zeilenumbrüche bleiben, andere Steuerzeichen werden entfernt
  const raw = typeof req.body.body === 'string' ? req.body.body : '';
  const body = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();
  if ([...body].length > REVIEW_MAX)
    return res.status(400).json({ error: `Die Rezension darf höchstens ${REVIEW_MAX} Zeichen lang sein.` });

  db.prepare(`
    INSERT INTO reviews (book_id, user_id, rating, body) VALUES (?, ?, ?, ?)
    ON CONFLICT (book_id, user_id) DO UPDATE SET
      rating = excluded.rating, body = excluded.body, updated_at = datetime('now')`
  ).run(id, req.session.userId, rating, body || null);
  res.json({ ok: true });
});

// Eigene Rezension löschen; Admins dürfen jede löschen
app.delete('/api/reviews/:id', requireAuth, (req, res) => {
  const review = db.prepare('SELECT id, user_id FROM reviews WHERE id = ?').get(Number(req.params.id));
  if (!review) return res.status(404).json({ error: 'Rezension nicht gefunden.' });
  if (review.user_id !== req.session.userId) {
    const me = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
    if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Sie dürfen nur Ihre eigene Rezension löschen.' });
  }
  db.prepare('DELETE FROM reviews WHERE id = ?').run(review.id);
  res.json({ ok: true });
});

// Buchdaten zu einem gescannten/eingegebenen Barcode im Internet nachschlagen
const lookupHits = new Map(); // userId -> { start, n }
app.get('/api/lookup/:isbn', requireAuth, async (req, res) => {
  const uid = req.session.userId;
  const now = Date.now();
  const w = lookupHits.get(uid);
  if (!w || now - w.start > 60_000) lookupHits.set(uid, { start: now, n: 1 });
  else if (++w.n > 30) return res.status(429).json({ error: 'Zu viele Abfragen – bitte kurz warten.' });

  let p;
  try { p = isbnLib.parse(req.params.isbn); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (!p) return res.status(400).json({ error: 'Bitte eine ISBN eingeben.' });

  // Schon im Katalog? Dann wird nichts im Internet angefragt.
  const existing = findByIsbn(p);
  if (existing) return res.json({ isbn: p.isbn13, existing, found: false });
  if (!LOOKUP_ENABLED) return res.json({ isbn: p.isbn13, existing: null, found: false, disabled: true });

  const result = await lookupIsbn(p.isbn13);
  res.json({ isbn: p.isbn13, existing: null, ...result });
});

// ---------- Ausleihe ----------
app.post('/api/books/:id/loan', requireAuth, (req, res) => {
  const bookId = Number(req.params.id);
  const tx = db.transaction(() => {
    const b = db.prepare(`${BOOK_SELECT} WHERE b.id = @id`).get({ id: bookId, uid: req.session.userId });
    if (!b) return { code: 404, error: 'Buch nicht gefunden.' };
    if (b.loaned_by_me) return { code: 409, error: 'Sie haben dieses Buch bereits ausgeliehen.' };
    if (b.copies_available < 1) return { code: 409, error: 'Aktuell ist kein Exemplar verfügbar.' };
    db.prepare(`INSERT INTO loans (book_id, user_id, due_at) VALUES (?, ?, datetime('now', ?))`)
      .run(bookId, req.session.userId, `+${LOAN_DAYS} days`);
    return { code: 201 };
  });
  const r = tx();
  r.error ? res.status(r.code).json({ error: r.error }) : res.status(201).json({ ok: true });
});

app.post('/api/loans/:id/return', requireAuth, (req, res) => {
  const info = db.prepare(
    `UPDATE loans SET returned_at = datetime('now')
     WHERE id = ? AND user_id = ? AND returned_at IS NULL`
  ).run(Number(req.params.id), req.session.userId);
  info.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Ausleihe nicht gefunden.' });
});

app.get('/api/loans/mine', requireAuth, (req, res) => {
  res.json(db.prepare(`
    SELECT l.id, l.loaned_at, l.due_at, b.title, b.author,
           l.due_at < datetime('now') AS overdue
    FROM loans l JOIN books b ON b.id = l.book_id
    WHERE l.user_id = ? AND l.returned_at IS NULL
    ORDER BY l.due_at`).all(req.session.userId).map(r => ({ ...r, overdue: !!r.overdue })));
});

// Admin-Übersicht aller offenen Ausleihen
app.get('/api/loans', requireAuth, (req, res) => {
  const me = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
  if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Nur für Administratoren.' });
  res.json(db.prepare(`
    SELECT l.id, u.username, b.title, l.loaned_at, l.due_at, l.due_at < datetime('now') AS overdue
    FROM loans l JOIN books b ON b.id = l.book_id JOIN users u ON u.id = l.user_id
    WHERE l.returned_at IS NULL ORDER BY l.due_at`).all().map(r => ({ ...r, overdue: !!r.overdue })));
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Nicht gefunden.' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? 'Ungültige Anfrage.' : 'Interner Fehler.' });
});

app.listen(PORT, () => console.log(`Bibliothek läuft auf http://localhost:${PORT}`));
