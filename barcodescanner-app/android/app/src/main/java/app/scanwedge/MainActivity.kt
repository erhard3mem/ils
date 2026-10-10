package app.scanwedge

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.text.InputType
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import android.os.Bundle
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    private lateinit var preview: PreviewView
    private lateinit var status: TextView
    private lateinit var detail: TextView
    private lateinit var btnPair: Button

    private val cameraExecutor = Executors.newSingleThreadExecutor()
    private val netExecutor = Executors.newSingleThreadExecutor()
    private val scanner = BarcodeScanning.getClient()

    private var pairing: Pairing? = null
    private var pairingMode = false
    private var sending = false
    private var lastCode = ""
    private var lastSeen = 0L

    private val askCamera =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startCamera() else setStatus("Kamerazugriff fehlt", "In den App-Einstellungen erlauben.")
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        preview = findViewById(R.id.preview)
        status = findViewById(R.id.status)
        detail = findViewById(R.id.detail)
        btnPair = findViewById(R.id.btnPair)

        pairing = loadPairing()
        btnPair.setOnClickListener { setPairingMode(!pairingMode) }
        findViewById<Button>(R.id.btnPaste).setOnClickListener { showPasteDialog() }
        showReady()

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCamera()
        } else {
            askCamera.launch(Manifest.permission.CAMERA)
        }
    }

    // ---------- Kamera ----------
    @androidx.annotation.OptIn(ExperimentalGetImage::class)
    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = future.get()
            val previewUseCase = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(cameraExecutor) { proxy ->
                val media = proxy.image
                if (media == null) {
                    proxy.close()
                    return@setAnalyzer
                }
                val image = InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
                scanner.process(image)
                    .addOnSuccessListener { codes ->
                        codes.firstNotNullOfOrNull { it.rawValue }?.let { value ->
                            runOnUiThread { onCode(value) }
                        }
                    }
                    .addOnCompleteListener { proxy.close() }
            }
            provider.unbindAll()
            provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, previewUseCase, analysis)
        }, ContextCompat.getMainExecutor(this))
    }

    // ---------- Scan-Logik ----------
    private fun onCode(code: String) {
        val now = SystemClock.elapsedRealtime()
        // Derselbe Code bleibt im Bild: erst wieder senden, wenn er {REARM_MS} ms weg war.
        if (code == lastCode && now - lastSeen < REARM_MS) {
            lastSeen = now
            return
        }
        if (sending) return
        lastCode = code
        lastSeen = now

        if (pairingMode) {
            val p = Pairing.parse(code)
            if (p == null) {
                setStatus("Kein Kopplungs-QR", "Den QR-Code aus dem Server-Fenster scannen.")
                lastCode = ""
            } else {
                applyPairing(p)
            }
            return
        }

        val target = pairing
        if (target == null) {
            setStatus("Nicht gekoppelt", "Auf „Koppeln (QR)“ tippen und den QR-Code des PC-Servers scannen.")
            lastCode = ""
            return
        }

        sending = true
        setStatus("Sende …", code)
        netExecutor.execute {
            val error = ScanSender.send(target, code)
            runOnUiThread {
                sending = false
                if (error == null) {
                    buzz(60)
                    setStatus("Gesendet ✓", code)
                } else {
                    buzz(300)
                    lastCode = "" // beim nächsten Erkennen erneut versuchen
                    setStatus("Fehler", "$error\n$code")
                }
            }
        }
    }

    // ---------- Kopplung ----------
    private fun setPairingMode(on: Boolean) {
        pairingMode = on
        btnPair.text = if (on) "Abbrechen" else "Koppeln (QR)"
        if (on) setStatus("Kopplungsmodus", "QR-Code aus dem Server-Fenster scannen.") else showReady()
    }

    private fun applyPairing(p: Pairing) {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("host", p.host).putInt("port", p.port).putString("secret", p.secret).apply()
        pairing = p
        setPairingMode(false)
        buzz(60)
        setStatus("Gekoppelt ✓", "${p.host}:${p.port}")
    }

    private fun loadPairing(): Pairing? {
        val sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val host = sp.getString("host", null) ?: return null
        val secret = sp.getString("secret", null) ?: return null
        val port = sp.getInt("port", 0)
        return if (port in 1..65535) Pairing(host, port, secret) else null
    }

    private fun showPasteDialog() {
        val input = EditText(this).apply {
            hint = "scanwedge://pair?h=…"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(false)
        }
        AlertDialog.Builder(this)
            .setTitle("Kopplungs-Link einfügen")
            .setView(input)
            .setPositiveButton("Koppeln") { _, _ ->
                val p = Pairing.parse(input.text.toString())
                if (p != null) applyPairing(p) else setStatus("Ungültiger Link", "Der Link beginnt mit scanwedge://pair")
            }
            .setNegativeButton("Abbrechen", null)
            .show()
    }

    // ---------- UI ----------
    private fun showReady() {
        val p = pairing
        if (p == null) setStatus("Nicht gekoppelt", "Auf „Koppeln (QR)“ tippen und den QR-Code des PC-Servers scannen.")
        else setStatus("Bereit", "Sendet an ${p.host}:${p.port}")
    }

    private fun setStatus(title: String, text: String) {
        status.text = title
        detail.text = text
    }

    @Suppress("DEPRECATION")
    private fun buzz(ms: Long) {
        val v = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
        if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
        else v.vibrate(ms)
    }

    override fun onDestroy() {
        super.onDestroy()
        scanner.close()
        cameraExecutor.shutdown()
        netExecutor.shutdown()
    }

    private companion object {
        const val PREFS = "scanwedge"
        const val REARM_MS = 1500L
    }
}
