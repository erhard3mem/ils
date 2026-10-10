# Bibliothek – Integrated Library System

Node.js + Express + SQLite (better-sqlite3), Webfrontend ohne Build-Schritt.

## Start

```bash
npm install
SESSION_SECRET="$(openssl rand -hex 32)" npm start
# http://localhost:3000
```

Umgebungsvariablen:

| Variable | Bedeutung |
|---|---|
| `PORT` | Port (3000) |
| `DB_PATH` | Datenbankdatei (`./library.db`) |
| `SESSION_SECRET` | Geheimnis für Sessions |
| `NODE_ENV=production` | Secure-Cookie, nur hinter HTTPS |
| `ISBN_LOOKUP=off` | Online-Abfrage der Buchdaten komplett abschalten |
| `ISBN_LOOKUP_PROVIDERS` | Quellen und Reihenfolge, Standard `dnb,openlibrary,google` |
| `LOOKUP_TIMEOUT_MS` | Zeitlimit je Quelle in ms (4000) |
| `GOOGLE_BOOKS_KEY` | optionaler API-Schlüssel für Google Books |

## Funktionen

- Katalog mit Suche (Titel, Autor/in, ISBN) und Verfügbarkeitsanzeige
- Registrierung und Login (bcrypt, Sessions in SQLite, Login-Bremse je IP)
- Angemeldete Benutzer fügen neue Bücher hinzu, am schnellsten per Barcode (siehe unten)
- Bewertungen: 1–5 Sterne und eine kurze Rezension (optional, höchstens 500 Zeichen) – siehe unten
- Ausleihe (28 Tage) und Rückgabe, Übersicht „Meine Ausleihen"
- Der erste registrierte Benutzer wird Admin und sieht alle offenen Ausleihen

## Barcode und Online-Abfrage

Im Formular „Buch hinzufügen“ steht das Feld **Barcode / ISBN** oben und hat nach dem Login den Fokus.

1. Barcode scannen (USB-Scanner, ScanWedge-App oder einfach eintippen) – Enter bzw. die 13. Ziffer löst die Abfrage aus.
2. Die ISBN wird geprüft (Prüfziffer, ISBN-10 wird zu ISBN-13 umgerechnet, gespeichert wird immer die ISBN-13).
3. Ist das Buch schon im Katalog, kommt ein Hinweis, und es wird nichts im Internet angefragt.
4. Sonst werden Titel, Autor/in, Verlag und Jahr online gesucht und ins Formular eingetragen. Der Cursor springt auf „Exemplare“.
5. Prüfen, Enter oder „Buch speichern“ – danach steht der Cursor wieder im Barcode-Feld für das nächste Buch.

Quellen, der Reihe nach, der erste Treffer gewinnt:

1. Deutsche Nationalbibliothek (SRU-Schnittstelle) – beste Quelle für deutschsprachige Bücher
2. Open Library
3. Google Books

Wird nichts gefunden oder ist das Internet nicht erreichbar, trägt man Titel und Autor/in von Hand ein; das Speichern funktioniert unabhängig davon.

**Datenschutz:** Für die Abfrage verlässt die ISBN den Server Richtung der oben genannten Dienste (keine Benutzerdaten, keine Angaben zu Personen). Mit `ISBN_LOOKUP=off` bleibt alles lokal. Schon vorhandene Bücher werden nie nachgeschlagen. Treffer werden eine Stunde im Speicher zwischengehalten.

Die Suche im Katalog findet ein Buch ebenfalls über seinen Barcode, auch mit Bindestrichen oder als ISBN-10.

## Bewertungen und Rezensionen

Unter jedem Buch zeigt der Katalog die Durchschnittsbewertung (z. B. ★★★★☆ 4,3 (7)). „Rezensionen“ klappt die Liste auf.

- **Lesen** darf jeder, auch ohne Anmeldung.
- **Schreiben** dürfen nur angemeldete Benutzer: Sterne wählen (per Maus oder mit den Pfeiltasten), optional einen kurzen Text, speichern.
- Pro Benutzer und Buch gibt es **eine** Rezension. Erneutes Speichern ändert sie (die Anzeige vermerkt „bearbeitet“), „Meine Rezension löschen“ entfernt sie.
- **Admins** dürfen jede Rezension löschen (Moderation).
- Rezensionstexte werden ausschließlich als Text dargestellt, nie als HTML.

Die Tabelle `reviews` wird beim Start automatisch angelegt, bestehende Datenbanken funktionieren weiter.

## Struktur

```
server.js        Express-App, API-Routen
db.js            SQLite-Schema, Session-Store
isbn.js          ISBN-Prüfung (Prüfziffer, 10 <-> 13)
lookup.js        Online-Abfrage (DNB, Open Library, Google Books)
public/          index.html, app.js, style.css
```

## API

| Methode | Pfad | Auth |
|---|---|---|
| POST | /api/register, /api/login, /api/logout | – |
| GET | /api/me | – |
| GET | /api/books?q= | – |
| POST | /api/books | ja |
| GET | /api/lookup/:isbn | ja |
| GET | /api/books/:id/reviews | – |
| PUT | /api/books/:id/review  (`{rating, body}`) | ja |
| DELETE | /api/reviews/:id | ja (eigene) / Admin (alle) |
| POST | /api/books/:id/loan | ja |
| POST | /api/loans/:id/return | ja |
| GET | /api/loans/mine | ja |
| GET | /api/loans | Admin |
