'use strict';
/**
 * ISBN-Hilfen. Bücher tragen als Barcode eine EAN-13, die mit 978 oder 979 beginnt
 * und identisch mit der ISBN-13 ist. Intern wird immer die ISBN-13 gespeichert.
 */

const clean = (raw) => String(raw ?? '').replace(/[\s-]/g, '').toUpperCase();

function sum13(d12) {
  let s = 0;
  for (let i = 0; i < 12; i++) s += Number(d12[i]) * (i % 2 ? 3 : 1);
  return s;
}

function valid13(d) {
  return (10 - (sum13(d) % 10)) % 10 === Number(d[12]);
}

function valid10(d) {
  let s = 0;
  for (let i = 0; i < 9; i++) s += Number(d[i]) * (10 - i);
  s += d[9] === 'X' ? 10 : Number(d[9]);
  return s % 11 === 0;
}

function to13(isbn10) {
  const core = '978' + isbn10.slice(0, 9);
  return core + ((10 - (sum13(core) % 10)) % 10);
}

function to10(isbn13) {
  if (!isbn13.startsWith('978')) return null; // 979-Nummern haben keine ISBN-10
  const core = isbn13.slice(3, 12);
  let s = 0;
  for (let i = 0; i < 9; i++) s += Number(core[i]) * (10 - i);
  const c = (11 - (s % 11)) % 11;
  return core + (c === 10 ? 'X' : String(c));
}

/**
 * Prüft eine eingegebene oder gescannte Nummer.
 * @returns {{isbn13: string, isbn10: string|null} | null}  null bei leerer Eingabe
 * @throws Error mit deutscher Meldung, wenn die Nummer keine gültige ISBN ist
 */
function parse(raw) {
  const s = clean(raw);
  if (!s) return null;
  if (/^\d{13}$/.test(s)) {
    if (!/^97[89]/.test(s)) throw new Error('Das ist kein Buch-Barcode (ISBN beginnt mit 978 oder 979).');
    if (!valid13(s)) throw new Error('Die Prüfziffer stimmt nicht – bitte erneut scannen oder die Nummer prüfen.');
    return { isbn13: s, isbn10: to10(s) };
  }
  if (/^\d{9}[\dX]$/.test(s)) {
    if (!valid10(s)) throw new Error('Die Prüfziffer der ISBN-10 stimmt nicht – bitte die Nummer prüfen.');
    return { isbn13: to13(s), isbn10: s };
  }
  throw new Error('Ungültige ISBN (10 oder 13 Stellen erwartet).');
}

module.exports = { parse, clean };
