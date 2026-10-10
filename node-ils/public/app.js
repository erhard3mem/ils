'use strict';

const $ = (id) => document.getElementById(id);
let me = null;
let authMode = 'login';

async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Anfrage fehlgeschlagen.');
  return data;
}

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) n.append(c);
  return n;
}

const fmtDate = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString('de-AT');

// ---------- Sitzung ----------
function renderSession() {
  const box = $('session');
  box.replaceChildren();
  if (me) {
    box.append(
      el('span', {}, `${me.username}${me.role === 'admin' ? ' (Admin)' : ''}`),
      el('button', { onclick: logout }, 'Abmelden')
    );
  }
  $('auth-panel').hidden = !!me;
  $('add-panel').hidden = !me;
  $('loans-panel').hidden = !me;
  $('admin-panel').hidden = !(me && me.role === 'admin');
}

async function logout() {
  await api('/logout', 'POST', {});
  me = null;
  renderSession();
  await loadBooks();
}

function setAuthMode(mode) {
  authMode = mode;
  $('tab-login').setAttribute('aria-selected', mode === 'login');
  $('tab-register').setAttribute('aria-selected', mode === 'register');
  $('auth-submit').textContent = mode === 'login' ? 'Anmelden' : 'Konto erstellen';
  $('auth-form').password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('auth-msg').textContent = '';
}
$('tab-login').onclick = () => setAuthMode('login');
$('tab-register').onclick = () => setAuthMode('register');

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    me = await api(authMode === 'login' ? '/login' : '/register', 'POST', {
      username: f.username.value,
      password: f.password.value
    });
    f.reset();
    $('auth-msg').textContent = '';
    renderSession();
    $('isbn').focus();                // Scanner kann sofort losschreiben
    await refreshAll();
  } catch (err) {
    $('auth-msg').textContent = err.message;
  }
});

// ---------- Katalog ----------
async function loadBooks() {
  const q = $('search').value.trim();
  const msg = $('catalog-msg');
  try {
    const books = await api('/books' + (q ? '?q=' + encodeURIComponent(q) : ''));
    const list = $('books');
    list.replaceChildren();
    msg.textContent = books.length ? '' : (q ? 'Keine Treffer für diese Suche.' : (me ? 'Noch keine Bücher im Katalog. Fügen Sie rechts das erste hinzu.' : 'Noch keine Bücher im Katalog. Melden Sie sich an und fügen Sie das erste hinzu.'));
    for (const b of books) list.append(bookCard(b));
  } catch (err) {
    msg.textContent = err.message;
  }
}

function bookCard(b) {
  const meta = [b.author, b.publisher, b.year, b.isbn && `ISBN ${b.isbn}`].filter(Boolean).join(' · ');
  const availText = b.copies_available > 0
    ? `${b.copies_available} von ${b.copies_total} verfügbar`
    : 'Alle Exemplare verliehen';
  const card = el('article', { class: 'book' + (b.copies_available > 0 ? '' : ' none') },
    el('div', {}, el('h3', {}, b.title), el('div', { class: 'meta' }, meta)),
    el('div', { class: 'avail' }, availText)
  );
  if (me) {
    const btn = el('button', { onclick: () => loan(b.id, btn) },
      b.loaned_by_me ? 'Bereits ausgeliehen' : 'Ausleihen');
    btn.disabled = b.loaned_by_me || b.copies_available < 1;
    card.append(el('div', { class: 'actions' }, btn));
  }

  // Bewertung und aufklappbare Rezensionen
  const n = b.review_count;
  const summary = n
    ? el('span', { class: 'rating-sum', role: 'img',
        'aria-label': `Durchschnitt ${fmtAvg(b.avg_rating)} von 5 Sternen, ${n} Bewertung${n === 1 ? '' : 'en'}` },
        el('span', { class: 'stars', 'aria-hidden': 'true' }, stars(Math.round(b.avg_rating))),
        ` ${fmtAvg(b.avg_rating)} (${n})`)
    : el('span', { class: 'rating-sum none' }, 'Noch keine Bewertungen');
  const panel = el('div', { class: 'reviews', hidden: '' });
  const toggle = el('button', { class: 'linklike', 'aria-expanded': 'false' }, 'Rezensionen');
  const setOpen = (open) => {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) { openReviews.add(b.id); renderReviews(b.id, panel); } else openReviews.delete(b.id);
  };
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  card.append(el('div', { class: 'rating-line' }, summary, toggle), panel);
  if (openReviews.has(b.id)) setOpen(true);
  return card;
}

// ---------- Rezensionen ----------
const openReviews = new Set();        // Bücher mit aufgeklappten Rezensionen (bleibt beim Neuzeichnen offen)
let reviewFlash = null;               // { bookId, text }: einmalige Rückmeldung nach Speichern/Löschen
const fmtAvg = (x) => x.toLocaleString('de-AT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
const starWord = (v) => `${v} Stern${v === 1 ? '' : 'e'}`;

async function renderReviews(bookId, panel) {
  panel.replaceChildren(el('p', { class: 'hint' }, 'Lade …'));
  let data;
  try {
    data = await api(`/books/${bookId}/reviews`);
  } catch (err) {
    panel.replaceChildren(el('p', { class: 'msg error' }, err.message));
    return;
  }
  const mine = data.reviews.find((r) => r.mine);
  const others = data.reviews.filter((r) => !r.mine);
  const parts = [];

  if (reviewFlash && reviewFlash.bookId === bookId) {
    parts.push(el('p', { class: 'msg ok', role: 'status' }, reviewFlash.text));
    reviewFlash = null;
  }
  parts.push(me ? reviewForm(bookId, mine) : el('p', { class: 'hint' }, 'Zum Bewerten und Schreiben einer Rezension bitte anmelden.'));

  if (others.length) {
    parts.push(el('ul', { class: 'review-list' }, ...others.map(reviewItem)));
  } else if (!mine) {
    parts.push(el('p', { class: 'hint' }, 'Noch keine Rezensionen.'));
  }
  panel.replaceChildren(...parts);
}

function reviewItem(r) {
  const when = fmtDate(r.updated_at) + (r.updated_at !== r.created_at ? ' (bearbeitet)' : '');
  const li = el('li', { class: 'review' },
    el('div', { class: 'review-head' },
      el('span', { class: 'stars', role: 'img', 'aria-label': `${r.rating} von 5 Sternen` }, stars(r.rating)),
      el('strong', {}, r.username),
      el('span', { class: 'when' }, when))
  );
  if (r.body) li.append(el('p', { class: 'review-body' }, r.body)); // nur als Text, nie als HTML
  if (me && me.role === 'admin') {
    li.append(el('button', { class: 'linklike danger', onclick: async () => {
      if (!confirm(`Rezension von ${r.username} wirklich löschen?`)) return;
      await deleteReview(r.id, null, 'Rezension gelöscht.');
    } }, 'Löschen (Admin)'));
  }
  return li;
}

async function deleteReview(id, bookId, text) {
  try {
    await api(`/reviews/${id}`, 'DELETE', {});
    if (bookId) reviewFlash = { bookId, text };
    await loadBooks();
  } catch (err) {
    $('catalog-msg').textContent = err.message;
  }
}

function reviewForm(bookId, mine) {
  const group = `rating-${bookId}`;
  const msg = el('p', { class: 'msg', role: 'alert' });
  const labels = [];
  const row = el('div', { class: 'star-row' });
  const paint = (n) => labels.forEach((l, i) => l.classList.toggle('on', i < n));
  const selected = () => Number(form.querySelector('input[type=radio]:checked')?.value || 0);

  for (let v = 1; v <= 5; v++) {
    const id = `r${v}-${bookId}`;
    const input = el('input', { type: 'radio', name: group, id, value: String(v), class: 'sr-only' });
    if (mine && mine.rating === v) input.checked = true;
    input.addEventListener('change', () => paint(v));
    const label = el('label', { for: id, title: starWord(v) },
      el('span', { class: 'sr-only' }, starWord(v)), el('span', { 'aria-hidden': 'true' }, '★'));
    label.addEventListener('mouseenter', () => paint(v));
    labels.push(label);
    row.append(input, label);
  }
  row.addEventListener('mouseleave', () => paint(selected()));

  const ta = el('textarea', { name: 'body', rows: '3', maxlength: '500',
    placeholder: 'Kurze Rezension (optional, höchstens 500 Zeichen)', 'aria-label': 'Kurze Rezension' });
  ta.value = mine?.body || '';
  const count = el('span', { class: 'hint' }, `${[...ta.value].length}/500`);
  ta.addEventListener('input', () => { count.textContent = `${[...ta.value].length}/500`; });

  const actions = el('div', { class: 'review-actions' },
    el('button', { type: 'submit', class: 'accent' }, mine ? 'Änderung speichern' : 'Bewertung speichern'));
  if (mine) {
    actions.append(el('button', { type: 'button', class: 'linklike danger', onclick: () =>
      deleteReview(mine.id, bookId, 'Ihre Rezension wurde gelöscht.') }, 'Meine Rezension löschen'));
  }

  const form = el('form', { class: 'review-form' },
    el('fieldset', {},
      el('legend', {}, mine ? 'Ihre Bewertung' : 'Bewerten Sie dieses Buch'),
      row),
    ta, count, msg, actions);
  paint(mine ? mine.rating : 0);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rating = selected();
    if (!rating) { msg.className = 'msg error'; msg.textContent = 'Bitte zuerst Sterne auswählen.'; return; }
    try {
      await api(`/books/${bookId}/review`, 'PUT', { rating, body: ta.value });
      reviewFlash = { bookId, text: 'Ihre Rezension wurde gespeichert.' };
      await loadBooks();             // aktualisiert auch den Durchschnitt auf der Karte
    } catch (err) {
      msg.className = 'msg error';
      msg.textContent = err.message;
    }
  });
  return form;
}

async function loan(id, btn) {
  btn.disabled = true;
  try {
    await api(`/books/${id}/loan`, 'POST', {});
    await refreshAll();
  } catch (err) {
    $('catalog-msg').textContent = err.message;
    btn.disabled = false;
  }
}

let searchTimer;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadBooks, 200);
});

// ---------- Buch hinzufügen ----------
const addForm = $('add-form');
const F = addForm.elements;           // Zugriff über elements: robust bei Feldnamen wie "title"
const AUTO_FIELDS = ['title', 'author', 'publisher', 'year'];
let lookupSeq = 0;                    // verwirft Antworten veralteter Abfragen
let lastLookedUp = '';
let autoFilled = {};                  // Werte, die zuletzt automatisch eingetragen wurden
let autoTimer;

function addMsg(text, kind = '') {
  const m = $('add-msg');
  m.className = 'msg' + (kind ? ' ' + kind : '');
  m.textContent = text;
}

/** Entfernt nur Felder, die noch genau so dastehen, wie die letzte Abfrage sie gefüllt hat. */
function clearAutoFilled() {
  for (const name of AUTO_FIELDS) {
    if (name in autoFilled && F[name].value === autoFilled[name]) F[name].value = '';
  }
  autoFilled = {};
}

async function lookupBarcode() {
  clearTimeout(autoTimer);
  const raw = F.isbn.value.trim();
  if (!raw) {
    addMsg('Bitte zuerst einen Barcode scannen oder eine ISBN eingeben.', 'error');
    F.isbn.focus();
    return;
  }
  const seq = ++lookupSeq;
  lastLookedUp = raw.replace(/[\s-]/g, '');
  clearAutoFilled();
  addMsg('Suche im Internet …');
  $('lookup-btn').disabled = true;
  try {
    const r = await api('/lookup/' + encodeURIComponent(raw));
    if (seq !== lookupSeq) return;
    F.isbn.value = r.isbn;            // einheitlich als ISBN-13
    if (r.existing) {
      const n = r.existing.copies_total;
      addMsg(`Bereits im Katalog: „${r.existing.title}“ (${n} Exemplar${n === 1 ? '' : 'e'}).`, 'error');
      F.isbn.select();
    } else if (r.found) {
      const b = r.book;
      autoFilled = { title: b.title || '', author: b.author || '', publisher: b.publisher || '', year: b.year ? String(b.year) : '' };
      for (const name of AUTO_FIELDS) F[name].value = autoFilled[name];
      addMsg(`Gefunden über ${r.source}. Bitte prüfen und speichern.`, 'ok');
      F.copies_total.focus();
      F.copies_total.select();
    } else {
      addMsg(
        r.disabled ? 'Die Online-Abfrage ist abgeschaltet – bitte Titel und Autor/in selbst eintragen.'
        : r.unreachable ? 'Keine Verbindung zu den Buchdatenbanken – bitte Titel und Autor/in selbst eintragen.'
        : 'Dazu wurde nichts gefunden – bitte Titel und Autor/in selbst eintragen.'
      );
      F.title.focus();
    }
  } catch (err) {
    if (seq !== lookupSeq) return;
    addMsg(err.message, 'error');
    F.isbn.select();
  } finally {
    if (seq === lookupSeq) $('lookup-btn').disabled = false;
  }
}

$('lookup-btn').addEventListener('click', lookupBarcode);

// Handscanner/Handy-Scanner tippen den Code und drücken Enter – das löst die Abfrage aus,
// statt das Formular abzuschicken.
F.isbn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    lookupBarcode();
  }
});

// Auch ohne Enter: sobald eine vollständige 13-stellige Nummer dasteht
F.isbn.addEventListener('input', () => {
  clearTimeout(autoTimer);
  const digits = F.isbn.value.replace(/[\s-]/g, '');
  if (/^\d{13}$/.test(digits) && digits !== lastLookedUp) autoTimer = setTimeout(lookupBarcode, 150);
});

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/books', 'POST', {
      title: F.title.value,
      author: F.author.value,
      isbn: F.isbn.value,
      publisher: F.publisher.value,
      year: F.year.value,
      copies_total: F.copies_total.value
    });
    addForm.reset();
    F.copies_total.value = 1;
    autoFilled = {};
    lastLookedUp = '';
    lookupSeq++;
    addMsg('Buch gespeichert. Nächsten Barcode scannen.', 'ok');
    F.isbn.focus();
    await loadBooks();
  } catch (err) {
    addMsg(err.message, 'error');
  }
});

// ---------- Ausleihen ----------
function loanItem(l, { withReturn, withUser }) {
  const due = el('div', { class: 'due' + (l.overdue ? ' overdue' : '') },
    `${l.overdue ? 'Überfällig seit' : 'Rückgabe bis'} ${fmtDate(l.due_at)}`);
  const li = el('li', {},
    el('strong', {}, l.title),
    el('span', { class: 'due' }, withUser ? l.username : l.author),
    due
  );
  if (withReturn) {
    li.append(el('button', { onclick: async () => {
      try { await api(`/loans/${l.id}/return`, 'POST', {}); await refreshAll(); }
      catch (err) { $('catalog-msg').textContent = err.message; }
    } }, 'Zurückgeben'));
  }
  return li;
}

async function loadLoans() {
  if (!me) return;
  const mine = await api('/loans/mine');
  const ul = $('loans');
  ul.replaceChildren();
  if (!mine.length) ul.append(el('li', { class: 'empty' }, 'Keine offenen Ausleihen.'));
  for (const l of mine) ul.append(loanItem(l, { withReturn: true }));

  if (me.role === 'admin') {
    const all = await api('/loans');
    const al = $('admin-loans');
    al.replaceChildren();
    if (!all.length) al.append(el('li', { class: 'empty' }, 'Keine offenen Ausleihen.'));
    for (const l of all) al.append(loanItem(l, { withUser: true }));
  }
}

async function refreshAll() {
  await Promise.all([loadBooks(), loadLoans()]);
}

// ---------- Start ----------
(async () => {
  try { me = await api('/me'); } catch { me = null; }
  renderSession();
  await refreshAll();
})();
