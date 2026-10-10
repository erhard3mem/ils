'use strict';
/**
 * Online-Abfrage von Buchdaten zu einer ISBN-13.
 *
 * Quellen werden nacheinander gefragt, der erste Treffer gewinnt – so sieht jeder
 * weitere Dienst die ISBN nur, wenn der vorherige nichts gefunden hat:
 *   1. Deutsche Nationalbibliothek (SRU)  – beste Quelle für deutschsprachige Bücher
 *   2. Open Library
 *   3. Google Books
 *
 * Umgebungsvariablen:
 *   ISBN_LOOKUP=off                 Abfrage komplett abschalten (nichts verlässt den Server)
 *   ISBN_LOOKUP_PROVIDERS=dnb,openlibrary,google   Reihenfolge/Auswahl
 *   LOOKUP_TIMEOUT_MS=4000          Zeitlimit je Dienst
 *   GOOGLE_BOOKS_KEY=...            optionaler API-Schlüssel (höheres Kontingent)
 */

const UA = 'ILS-Bibliothek/1.0 (lokales Bibliothekssystem)';
const MAX_BYTES = 1_000_000;

// ---------- Textaufbereitung ----------
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return XML_ENTITIES[e.toLowerCase()] ?? m;
  });
}

const squash = (s) => s.replace(/\s+/g, ' ').trim();

/** "Name : Untertitel / Verfasserangabe" -> "Name: Untertitel" */
function cleanDnbTitle(t) {
  return squash(
    t.replace(/[¬\u0098\u009c]/g, '')   // Nichtsortierzeichen um Artikel (¬Der¬ Process)
     .split(' / ')[0]                    // Verantwortlichkeitsangabe abschneiden
     .replace(/ : /g, ': ')
  );
}

/** "Hilberg, Raul [Verfasser]" -> "Raul Hilberg" */
function cleanDnbPerson(p) {
  const name = squash(p.replace(/\[[^\]]*\]/g, ''));
  const m = name.match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2]} ${m[1]}` : name;
}

/** "Frankfurt am Main : Fischer-Taschenbuch-Verl." -> "Fischer-Taschenbuch-Verl." */
function cleanDnbPublisher(p) {
  const parts = squash(p).split(' : ');
  return parts.length > 1 ? parts.slice(1).join(' : ') : parts[0];
}

function yearFrom(text) {
  const m = String(text ?? '').match(/\b(1\d{3}|20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

// ---------- Quellen ----------
const providers = {
  dnb: {
    label: 'Deutsche Nationalbibliothek',
    url: (isbn) =>
      `https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve&query=${encodeURIComponent('num=' + isbn)}` +
      `&recordSchema=oai_dc&maximumRecords=1`,
    parse(xml) {
      const n = xml.match(/numberOfRecords>\s*(\d+)\s*</);
      if (!n || Number(n[1]) < 1) return null;
      const all = (tag) => [...xml.matchAll(new RegExp(`<dc:${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</dc:${tag}>`, 'g'))]
        .map((m) => decodeXml(m[1]));
      const title = all('title')[0];
      if (!title) return null;
      const creators = all('creator');
      const authors = creators.filter((c) => /\[Verfasser\]/i.test(c));
      const names = (authors.length ? authors : creators).map(cleanDnbPerson).filter(Boolean);
      const publisher = all('publisher')[0];
      return {
        title: cleanDnbTitle(title),
        author: names.join('; '),
        publisher: publisher ? cleanDnbPublisher(publisher) : '',
        year: yearFrom(all('date')[0])
      };
    }
  },

  openlibrary: {
    label: 'Open Library',
    url: (isbn) => `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`,
    parse(text, isbn) {
      const b = JSON.parse(text)[`ISBN:${isbn}`];
      if (!b || !b.title) return null;
      return {
        title: squash(b.subtitle ? `${b.title}: ${b.subtitle}` : b.title),
        author: (b.authors ?? []).map((a) => squash(a.name ?? '')).filter(Boolean).join('; '),
        publisher: squash(b.publishers?.[0]?.name ?? ''),
        year: yearFrom(b.publish_date)
      };
    }
  },

  google: {
    label: 'Google Books',
    url: (isbn) =>
      `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=1` +
      (process.env.GOOGLE_BOOKS_KEY ? `&key=${encodeURIComponent(process.env.GOOGLE_BOOKS_KEY)}` : ''),
    parse(text) {
      const v = JSON.parse(text).items?.[0]?.volumeInfo;
      if (!v || !v.title) return null;
      return {
        title: squash(v.subtitle ? `${v.title}: ${v.subtitle}` : v.title),
        author: (v.authors ?? []).map(squash).filter(Boolean).join('; '),
        publisher: squash(v.publisher ?? ''),
        year: yearFrom(v.publishedDate)
      };
    }
  }
};

// ---------- Ablauf ----------
async function fetchText(fetchFn, url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json, application/xml, text/xml' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('Antwort zu groß');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function createLookup({
  fetchFn = globalThis.fetch,
  order = (process.env.ISBN_LOOKUP_PROVIDERS || 'dnb,openlibrary,google').split(',').map((s) => s.trim()),
  timeoutMs = Number(process.env.LOOKUP_TIMEOUT_MS) || 4000
} = {}) {
  const active = order.filter((k) => providers[k]);
  const cache = new Map();
  const TTL = 60 * 60 * 1000;

  /**
   * @returns {Promise<{found: boolean, book?: object, source?: string, unreachable?: boolean}>}
   * Wirft nie: Netzwerkfehler führen zu found:false (und unreachable:true, wenn kein Dienst antwortete).
   */
  return async function lookup(isbn13) {
    const hit = cache.get(isbn13);
    if (hit && Date.now() - hit.at < TTL) return hit.value;

    let answered = 0;
    for (const key of active) {
      const p = providers[key];
      try {
        const text = await fetchText(fetchFn, p.url(isbn13), timeoutMs);
        answered++;
        const book = p.parse(text, isbn13);
        if (book && book.title) {
          const value = { found: true, book, source: p.label };
          if (cache.size > 500) cache.clear();
          cache.set(isbn13, { at: Date.now(), value });
          return value;
        }
      } catch (e) {
        console.warn(`ISBN-Abfrage (${p.label}) fehlgeschlagen: ${e.message}`);
      }
    }
    return answered === 0 ? { found: false, unreachable: true } : { found: false };
  };
}

module.exports = { createLookup, _internals: { cleanDnbTitle, cleanDnbPerson, cleanDnbPublisher, providers } };
