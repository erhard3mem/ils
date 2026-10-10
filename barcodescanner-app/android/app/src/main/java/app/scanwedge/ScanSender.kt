package app.scanwedge

import android.net.Uri
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Kopplungsdaten, wie sie der PC-Server als QR-Code / Link ausgibt. */
data class Pairing(val host: String, val port: Int, val secret: String) {
    companion object {
        /** scanwedge://pair?h=192.168.1.20&p=8765&s=GEHEIMNIS  ->  Pairing oder null */
        fun parse(text: String): Pairing? {
            val uri = try { Uri.parse(text.trim()) } catch (e: Exception) { return null }
            if (uri.scheme != "scanwedge" || uri.host != "pair") return null
            val host = uri.getQueryParameter("h")?.takeIf { it.isNotBlank() } ?: return null
            val port = uri.getQueryParameter("p")?.toIntOrNull()?.takeIf { it in 1..65535 } ?: return null
            val secret = uri.getQueryParameter("s")?.takeIf { it.length >= 8 } ?: return null
            return Pairing(host, port, secret)
        }
    }
}

object ScanSender {
    private val rng = SecureRandom()

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    /** Sendet einen Barcode. Gibt null bei Erfolg zurück, sonst eine Fehlermeldung. */
    fun send(p: Pairing, code: String): String? {
        val body = JSONObject().put("code", code).toString().toByteArray(Charsets.UTF_8)
        val ts = (System.currentTimeMillis() / 1000).toString()
        val nonce = hex(ByteArray(8).also { rng.nextBytes(it) })

        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(p.secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        mac.update("$ts.$nonce.".toByteArray(Charsets.UTF_8))
        val signature = hex(mac.doFinal(body))

        val conn = try {
            URL("http://${p.host}:${p.port}/scan").openConnection() as HttpURLConnection
        } catch (e: Exception) {
            return "Ungültige Serveradresse"
        }
        return try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 3000
            conn.readTimeout = 4000
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(body.size)
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("X-Timestamp", ts)
            conn.setRequestProperty("X-Nonce", nonce)
            conn.setRequestProperty("X-Signature", signature)
            conn.outputStream.use { it.write(body) }
            when (val status = conn.responseCode) {
                200 -> null
                401 -> "PC lehnt ab – Uhrzeit prüfen oder neu koppeln"
                else -> "Serverfehler ($status)"
            }
        } catch (e: IOException) {
            "PC nicht erreichbar (selbes WLAN? Firewall?)"
        } finally {
            conn.disconnect()
        }
    }
}
