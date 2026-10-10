#!/usr/bin/env python3
"""ScanWedge-Server

Nimmt Barcodes von der ScanWedge-Android-App entgegen und tippt sie wie ein
USB-Tastatur-Scanner in das gerade aktive Fenster, gefolgt von Enter.

Jede Anfrage ist per HMAC-SHA256 mit dem Kopplungs-Geheimnis signiert
(Zeitstempel + Nonce gegen Wiederholung). Ohne gültige Signatur wird nichts getippt.
"""
import argparse
import hashlib
import hmac
import json
import os
import platform
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_CODE_LEN = 256
MAX_BODY = 4096
MAX_SKEW = 60  # erlaubte Abweichung der Handy-Uhr in Sekunden


# ---------- Konfiguration / Geheimnis ----------
def config_path() -> Path:
    system = platform.system()
    if system == "Windows":
        base = Path(os.environ.get("APPDATA", Path.home()))
    elif system == "Darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "scanwedge" / "config.json"


def load_secret(reset: bool = False) -> str:
    path = config_path()
    if path.exists() and not reset:
        try:
            return json.loads(path.read_text())["secret"]
        except (OSError, ValueError, KeyError):
            pass
    secret = secrets.token_urlsafe(18)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"secret": secret}, f)
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return secret


# ---------- Tastatur-Ausgabe ----------
class DryRunInjector:
    def type(self, text):
        print(f"  [dry-run] tippe: {text!r}")

    def key(self, name):
        print(f"  [dry-run] Taste: {name}")


class PynputInjector:
    """Windows, macOS, Linux/X11."""

    def __init__(self):
        from pynput.keyboard import Controller, Key
        self._kb = Controller()
        self._keys = {"enter": Key.enter, "tab": Key.tab}

    def type(self, text):
        self._kb.type(text)

    def key(self, name):
        k = self._keys[name]
        self._kb.press(k)
        self._kb.release(k)


class YdotoolInjector:
    """Linux/Wayland (benötigt laufenden ydotoold)."""
    _CODES = {"enter": "28", "tab": "15"}

    def __init__(self):
        if not shutil.which("ydotool"):
            raise RuntimeError("ydotool nicht gefunden")

    @staticmethod
    def _run(*args):
        subprocess.run(["ydotool", *args], check=True, timeout=10)

    def type(self, text):
        self._run("type", "--key-delay", "2", "--", text)

    def key(self, name):
        c = self._CODES[name]
        self._run("key", f"{c}:1", f"{c}:0")


# ---- Linux: virtuelle USB-Tastatur über /dev/uinput (Wayland, X11, Konsole) ----
# Der Kernel selbst meldet die Tasten, daher ist es egal, welcher Desktop läuft.
# Keine Zusatzpakete nötig. Tastencodes stammen aus linux/input-event-codes.h.
_K = {
    '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10, '0': 11,
    'MINUS': 12, 'EQUAL': 13, 'TAB': 15, 'LBRACE': 26, 'RBRACE': 27, 'ENTER': 28,
    'SEMICOLON': 39, 'APOSTROPHE': 40, 'GRAVE': 41, 'LSHIFT': 42, 'BACKSLASH': 43,
    'COMMA': 51, 'DOT': 52, 'SLASH': 53, 'SPACE': 57, 'LT': 86, 'RALT': 100,
}
for _row, _start in (("qwertyuiop", 16), ("asdfghjkl", 30), ("zxcvbnm", 44)):
    for _i, _c in enumerate(_row):
        _K[_c] = _start + _i


def _build_layout(name: str) -> dict:
    """Zeichen -> (Tastencode, Modifikatoren) für das Tastaturlayout des Desktops.
    Modifikatoren: '' | 'S' (Shift) | 'A' (AltGr)."""
    m = {" ": (_K["SPACE"], "")}
    for c in "abcdefghijklmnopqrstuvwxyz":
        m[c] = (_K[c], "")
        m[c.upper()] = (_K[c], "S")
    for d in "0123456789":
        m[d] = (_K[d], "")

    def put(chars, mods, keys):
        for ch, k in zip(chars, keys):
            m[ch] = (_K[k], mods)

    if name == "us":
        put("-=[];'`\\,./", "", ["MINUS", "EQUAL", "LBRACE", "RBRACE", "SEMICOLON", "APOSTROPHE",
                                  "GRAVE", "BACKSLASH", "COMMA", "DOT", "SLASH"])
        put('_+{}:"~|<>?', "S", ["MINUS", "EQUAL", "LBRACE", "RBRACE", "SEMICOLON", "APOSTROPHE",
                                  "GRAVE", "BACKSLASH", "COMMA", "DOT", "SLASH"])
        put("!@#$%^&*()", "S", list("1234567890"))
    else:  # "de": deutsche QWERTZ-Tastatur (auch Österreich)
        m["y"], m["z"] = (_K["z"], ""), (_K["y"], "")
        m["Y"], m["Z"] = (_K["z"], "S"), (_K["y"], "S")
        put("-.,+#<", "", ["SLASH", "DOT", "COMMA", "RBRACE", "BACKSLASH", "LT"])
        put("_:;*'>?", "S", ["SLASH", "DOT", "COMMA", "RBRACE", "BACKSLASH", "LT", "MINUS"])
        put('!"§$%&/()=', "S", list("1234567890"))
        put("\\@~|{[]}", "A", ["MINUS", "q", "RBRACE", "LT", "7", "8", "9", "0"])
        put("€", "A", ["e"])
        put("ßüöä", "", ["MINUS", "LBRACE", "SEMICOLON", "APOSTROPHE"])
        put("ÜÖÄ", "S", ["LBRACE", "SEMICOLON", "APOSTROPHE"])
    return m


class UinputInjector:
    """Virtuelle Tastatur über /dev/uinput. Das Layout des Desktops wird auf die Tastencodes
    angewendet, deshalb muss --layout zum eingestellten Layout passen (de oder us).
    Ziffern sind in beiden Layouts gleich, Buchstaben und Sonderzeichen nicht."""

    def __init__(self, layout="de", fd=None, settle=1.0):
        self._layout = layout
        self._map = _build_layout(layout)
        if fd is None:
            fd = self._create()
            time.sleep(settle)  # der Desktop braucht einen Moment, bis er das neue Gerät kennt
        self._fd = fd

    @staticmethod
    def _create() -> int:
        import fcntl
        import struct
        try:
            fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        except OSError as e:
            raise RuntimeError(f"/dev/uinput nicht nutzbar ({e.strerror}) – Einrichtung siehe README (Linux/Wayland)")
        try:
            fcntl.ioctl(fd, 0x40045564, 1)                 # UI_SET_EVBIT: EV_KEY
            for code in range(1, 120):
                fcntl.ioctl(fd, 0x40045565, code)          # UI_SET_KEYBIT
            name = b"ScanWedge Virtual Keyboard"
            fcntl.ioctl(fd, 0x405c5503, struct.pack("HHHH80sI", 0x03, 0x1209, 0x5ca0, 1, name, 0))  # UI_DEV_SETUP
            fcntl.ioctl(fd, 0x5501)                        # UI_DEV_CREATE
        except OSError:
            os.close(fd)
            raise
        return fd

    def _emit(self, etype, code, value):
        import struct
        os.write(self._fd, struct.pack("llHHi", 0, 0, etype, code, value))

    def _press(self, code, down):
        self._emit(1, code, 1 if down else 0)  # EV_KEY
        self._emit(0, 0, 0)                    # EV_SYN / SYN_REPORT

    def type(self, text):
        for ch in text:
            spec = self._map.get(ch)
            if spec is None:
                print(f"  Zeichen {ch!r} gibt es im Layout '{self._layout}' nicht – übersprungen")
                continue
            code, mods = spec
            if "S" in mods:
                self._press(_K["LSHIFT"], True)
            if "A" in mods:
                self._press(_K["RALT"], True)
            if mods:
                time.sleep(0.002)
            self._press(code, True)
            self._press(code, False)
            if "A" in mods:
                self._press(_K["RALT"], False)
            if "S" in mods:
                self._press(_K["LSHIFT"], False)
            time.sleep(0.004)

    def key(self, name):
        code = _K[name.upper()]
        self._press(code, True)
        self._press(code, False)


def make_injector(kind: str, dry_run: bool, layout: str = "de"):
    if dry_run:
        return DryRunInjector()
    linux = platform.system() == "Linux"
    wayland = linux and (os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland"
                         or bool(os.environ.get("WAYLAND_DISPLAY")))
    if kind == "auto":
        if wayland:
            if os.access("/dev/uinput", os.W_OK):
                kind = "uinput"
            elif shutil.which("ydotool"):
                kind = "ydotool"
            else:
                kind = "pynput"
        else:
            kind = "pynput"
    if kind == "pynput" and wayland:
        print("ACHTUNG: Du nutzt Wayland. Das Backend 'pynput' erreicht dort nur X11-Fenster – in\n"
              "         andere Programme wird NICHTS getippt. Lösung: --backend uinput (siehe README,\n"
              "         Abschnitt Linux/Wayland). Prüfen mit: python scanwedge_server.py --test\n")
    try:
        if kind == "uinput":
            inj = UinputInjector(layout)
        elif kind == "ydotool":
            inj = YdotoolInjector()
        else:
            inj = PynputInjector()
    except Exception as e:  # ImportError, fehlendes Display, fehlende Rechte ...
        sys.exit(f"Tastatur-Backend '{kind}' nicht verfügbar: {e}")
    print(f"Tastatur-Backend: {kind}" + (f" (Layout {layout})" if kind == "uinput" else ""))
    return inj


# ---------- Anwendung ----------
class App:
    def __init__(self, secret, injector, prefix, suffix):
        self.secret = secret.encode()
        self.injector = injector
        self.prefix = prefix
        self.suffix = suffix
        self._seen = {}
        self._seen_lock = threading.Lock()
        self._inject_lock = threading.Lock()

    def verify(self, headers, body: bytes) -> bool:
        try:
            ts = int(headers.get("X-Timestamp", ""))
        except ValueError:
            return False
        nonce = headers.get("X-Nonce", "")
        if not (8 <= len(nonce) <= 64) or not nonce.isprintable():
            return False
        now = time.time()
        if abs(now - ts) > MAX_SKEW:
            return False
        msg = f"{ts}.{nonce}.".encode() + body
        expected = hmac.new(self.secret, msg, hashlib.sha256).hexdigest()
        given = headers.get("X-Signature", "")
        if not hmac.compare_digest(given.encode(), expected.encode()):
            return False
        with self._seen_lock:
            for k, t in list(self._seen.items()):
                if now - t > 2 * MAX_SKEW:
                    del self._seen[k]
            if nonce in self._seen:
                return False  # Wiederholung
            self._seen[nonce] = now
        return True

    def emit(self, code: str):
        with self._inject_lock:
            self.injector.type(self.prefix + code)
            if self.suffix != "none":
                self.injector.key(self.suffix)


class Handler(BaseHTTPRequestHandler):
    timeout = 10  # Schutz vor hängenden Verbindungen

    def log_message(self, fmt, *args):
        pass

    def _reply(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._reply(200, {"ok": True, "name": platform.node()})
        else:
            self._reply(404, {"error": "not found"})

    def do_POST(self):
        app: App = self.server.app
        if self.path != "/scan":
            return self._reply(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self._reply(400, {"error": "bad length"})
        if not 0 < length <= MAX_BODY:
            return self._reply(413, {"error": "body size"})
        body = self.rfile.read(length)

        if not app.verify(self.headers, body):
            print(f"{time.strftime('%H:%M:%S')}  abgelehnt (Signatur/Zeit) von {self.client_address[0]}")
            return self._reply(401, {"error": "unauthorized"})

        try:
            code = json.loads(body)["code"]
            if not isinstance(code, str) or len(code) > MAX_CODE_LEN:
                raise ValueError
        except (ValueError, KeyError, TypeError):
            return self._reply(400, {"error": "bad request"})
        code = "".join(ch for ch in code if ch.isprintable())  # keine Steuerzeichen/Zeilenumbrüche
        if not code:
            return self._reply(400, {"error": "empty code"})

        try:
            app.emit(code)
        except Exception as e:
            print(f"Fehler beim Tippen: {e}")
            return self._reply(500, {"error": "inject failed"})
        print(f"{time.strftime('%H:%M:%S')}  {code}")
        self._reply(200, {"ok": True})


# ---------- Kopplung ----------
def local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def show_pairing(uri: str, invert: bool):
    print("\nKopplung: In der App auf 'Koppeln' tippen und diesen QR-Code scannen.")
    try:
        import qrcode
        qr = qrcode.QRCode(border=2)
        qr.add_data(uri)
        qr.make(fit=True)
        qr.print_ascii(invert=invert)
    except ImportError:
        print("(Für den QR-Code im Terminal: pip install qrcode)")
    print(f"Link (zum Einfügen in der App): {uri}\n")


def main():
    ap = argparse.ArgumentParser(description="ScanWedge: Handy-Barcodescanner als Tastatur-Scanner")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--bind", default="0.0.0.0", help="Adresse, auf der gelauscht wird")
    ap.add_argument("--ip", help="IP für den Kopplungs-QR (Standard: automatisch)")
    ap.add_argument("--suffix", choices=["enter", "tab", "none"], default="enter",
                    help="Taste nach dem Barcode (Standard: enter)")
    ap.add_argument("--prefix", default="", help="Text vor jedem Barcode")
    ap.add_argument("--backend", choices=["auto", "pynput", "uinput", "ydotool"], default="auto",
                    help="Tipp-Methode (auto wählt unter Wayland uinput, sonst pynput)")
    ap.add_argument("--layout", choices=["de", "us"], default="de",
                    help="Tastaturlayout des PCs, nur für --backend uinput (Standard: de)")
    ap.add_argument("--test", action="store_true",
                    help="Selbsttest: tippt nach 5 Sekunden einen Testtext, ohne Handy und Netzwerk")
    ap.add_argument("--reset-secret", action="store_true", help="neues Kopplungs-Geheimnis erzeugen")
    ap.add_argument("--invert", action="store_true", help="QR-Code invertiert ausgeben (falls Scan scheitert)")
    ap.add_argument("--dry-run", action="store_true", help="nur anzeigen, nichts tippen")
    args = ap.parse_args()

    secret = load_secret(args.reset_secret)
    injector = make_injector(args.backend, args.dry_run, args.layout)
    app = App(secret, injector, args.prefix, args.suffix)

    if args.test:
        print("\nSelbsttest: In 5 Sekunden wird 'ScanWedge-Test 0123456789' getippt.")
        print("Klicke jetzt in ein Textfeld eines anderen Programms (Editor, Browser, ...).")
        for i in range(5, 0, -1):
            print(f"  {i} ...", flush=True)
            time.sleep(1)
        app.emit("ScanWedge-Test 0123456789")
        print("Fertig. Ist der Text im Textfeld erschienen? Dann funktioniert das Tippen.")
        return

    ip = args.ip or local_ip()
    show_pairing(f"scanwedge://pair?h={ip}&p={args.port}&s={secret}", args.invert)

    server = ThreadingHTTPServer((args.bind, args.port), Handler)
    server.app = app
    print(f"Lausche auf {args.bind}:{args.port} – Strg+C beendet.")
    print("Der Barcode landet im Fenster, das gerade den Fokus hat.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nBeendet.")


if __name__ == "__main__":
    main()
