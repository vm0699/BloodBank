package com.savro.lifelink

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.ContentValues
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import androidx.core.content.FileProvider
import java.io.File
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.View
import android.view.ViewGroup
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private var insetTop = 0
    private var insetBottom = 0
    private var insetLeft = 0
    private var insetRight = 0

    // Deep link (DigiLocker round-trip) that arrived before the page finished loading.
    private var pendingLink: String? = null
    private var pageReady = false

    // WebView geolocation: the page asks via navigator.geolocation, we gate it behind the Android runtime permission.
    private var geoOrigin: String? = null
    private var geoCallback: GeolocationPermissions.Callback? = null
    private val locationPermission =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            geoCallback?.invoke(geoOrigin, grants.values.any { it }, false)
            geoCallback = null
        }
    private val notifPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* the notice is already scheduled */ }

    // <input type="file"> (ID document photo) needs an explicit chooser in a plain WebView.
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val fileChooser =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
            fileCallback = null
        }

    // The page is drawn edge-to-edge, so tell it how big the system bars / cutout are (in CSS px).
    private fun pushInsets() {
        if (!::webView.isInitialized) return
        val d = resources.displayMetrics.density
        val js = "var s=document.documentElement.style;" +
            "s.setProperty('--sat','${insetTop / d}px');" +
            "s.setProperty('--sab','${insetBottom / d}px');" +
            "s.setProperty('--sal','${insetLeft / d}px');" +
            "s.setProperty('--sar','${insetRight / d}px');"
        webView.evaluateJavascript(js, null)
    }

    private fun deliverLink(url: String) {
        if (!pageReady) { pendingLink = url; return }
        val q = url.replace("\\", "\\\\").replace("'", "\\'")
        webView.evaluateJavascript("window.__onDeepLink&&window.__onDeepLink('$q')", null)
    }

    private fun openExternalUri(uri: Uri): Boolean = try {
        startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (_: ActivityNotFoundException) { false }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        // Serve app/src/main/assets/ over a virtual https:// origin instead of a raw file:// URL, so the page
        // behaves like a normal site (fetch, geolocation and service-worker rules need a secure origin).
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = false
                allowContentAccess = true
                useWideViewPort = true
                loadWithOverviewMode = true
                cacheMode = WebSettings.LOAD_DEFAULT
            }
            webChromeClient = object : WebChromeClient() {
                override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                    val fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                    val coarse = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
                    if (fine || coarse) { callback.invoke(origin, true, false); return }
                    geoOrigin = origin
                    geoCallback = callback
                    locationPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                }

                override fun onShowFileChooser(
                    view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams
                ): Boolean {
                    fileCallback?.onReceiveValue(null)
                    fileCallback = callback
                    return try {
                        fileChooser.launch(params.createIntent())
                        true
                    } catch (_: ActivityNotFoundException) {
                        fileCallback = null
                        callback.onReceiveValue(null)
                        false
                    }
                }
            }
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assetLoader.shouldInterceptRequest(request.url)

                // tel:, geo:, mailto:, sms: and any real website open in the right external app, never inside the app.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val u = request.url
                    if (u.host == "appassets.androidplatform.net") return false
                    openExternalUri(u)
                    return true
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    pageReady = true
                    pushInsets()
                    pendingLink?.let { pendingLink = null; deliverLink(it) }
                }
            }
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
            addJavascriptInterface(WebAppInterface(this@MainActivity), "AndroidBridge")
            loadUrl("https://appassets.androidplatform.net/assets/lifelink.html")
        }

        setContentView(webView)

        ViewCompat.setOnApplyWindowInsetsListener(webView) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
            val imeBottom = if (imeVisible) insets.getInsets(WindowInsetsCompat.Type.ime()).bottom else 0
            insetTop = bars.top
            insetBottom = if (imeVisible) 0 else bars.bottom
            insetLeft = bars.left
            insetRight = bars.right
            // Shrink the page above the keyboard so focused inputs stay visible.
            (v.layoutParams as? ViewGroup.MarginLayoutParams)?.let { lp ->
                if (lp.bottomMargin != imeBottom) {
                    lp.bottomMargin = imeBottom
                    v.layoutParams = lp
                }
            }
            pushInsets()
            insets
        }
        WindowCompat.getInsetsController(window, webView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = true
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Let the page handle back first (closes sheets, leaves a screen, etc.).
                webView.evaluateJavascript("(window.__llBack&&window.__llBack())?'1':'0'") { handled ->
                    if (handled?.trim('"') != "1") {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        })

        intent?.data?.let { deliverLink(it.toString()) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.data?.let { deliverLink(it.toString()) }
    }

    inner class WebAppInterface(private val context: Context) {
        @JavascriptInterface
        fun vibrate(milliseconds: Long) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    val manager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                    manager?.defaultVibrator?.vibrate(
                        VibrationEffect.createOneShot(milliseconds, VibrationEffect.DEFAULT_AMPLITUDE)
                    )
                } else {
                    @Suppress("DEPRECATION")
                    val v = context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        v?.vibrate(VibrationEffect.createOneShot(milliseconds, VibrationEffect.DEFAULT_AMPLITUDE))
                    } else {
                        @Suppress("DEPRECATION")
                        v?.vibrate(milliseconds)
                    }
                }
            } catch (_: Exception) {}
        }

        /** Backend base URL baked in at build time (-PapiBase=...). Empty = offline demo mode. */
        @JavascriptInterface
        fun apiBase(): String = BuildConfig.API_BASE

        /** Native share sheet - blood requests spread fastest through WhatsApp and similar apps. */
        @JavascriptInterface
        fun share(text: String) {
            runOnUiThread {
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
                startActivity(Intent.createChooser(send, null))
            }
        }

        @JavascriptInterface
        fun openExternal(url: String) {
            runOnUiThread { openExternalUri(Uri.parse(url)) }
        }

        /** DigiLocker authorisation: Chrome Custom Tab, returns through the savrolifelink://digilocker deep link. */
        @JavascriptInterface
        fun openAuth(url: String) {
            runOnUiThread {
                try {
                    CustomTabsIntent.Builder().build().launchUrl(this@MainActivity, Uri.parse(url))
                } catch (_: ActivityNotFoundException) {
                    openExternalUri(Uri.parse(url))
                }
            }
        }

        /** One-shot local notification at an epoch-ms time. Asks for notification permission on Android 13+. */
        @JavascriptInterface
        fun scheduleNotice(id: Int, whenMillis: Long, title: String, text: String) {
            Notifier.set(context, id, whenMillis, title, text)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                runOnUiThread {
                    if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                        notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                }
            }
        }

        @JavascriptInterface
        fun cancelNotice(id: Int) {
            Notifier.cancel(context, id)
        }

        /** Asks for the Android 13+ notification permission (needed for push and reminders). */
        @JavascriptInterface
        fun requestNotifPermission() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                runOnUiThread {
                    if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                        notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                }
            }
        }

        /**
         * Firebase Cloud Messaging token -> page.__onPushToken(token), which registers it with the backend.
         * Does nothing (safely) until app/google-services.json is added - see docs/BACKEND.md.
         */
        @JavascriptInterface
        fun requestPushToken() {
            try {
                com.google.firebase.messaging.FirebaseMessaging.getInstance().token.addOnSuccessListener { tok ->
                    runOnUiThread { webView.evaluateJavascript("window.__onPushToken&&window.__onPushToken('$tok')", null) }
                }
            } catch (_: Exception) { /* Firebase not configured in this build */ }
        }

        /** Saves a file (donor card PNG / PDF) into Downloads/LifeLink. Returns false if it could not be saved. */
        @JavascriptInterface
        fun saveFile(name: String, mime: String, base64: String): Boolean {
            return try {
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, name)
                        put(MediaStore.Downloads.MIME_TYPE, mime)
                        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/LifeLink")
                    }
                    val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
                    contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                    true
                } else {
                    // API 24-28 would need a storage permission; hand the file to the share sheet instead.
                    shareFile(name, mime, base64, "")
                    true
                }
            } catch (_: Exception) { false }
        }

        /** Opens the system share sheet with a file attached (WhatsApp, Drive, Photos...). */
        @JavascriptInterface
        fun shareFile(name: String, mime: String, base64: String, text: String) {
            try {
                val dir = File(cacheDir, "shared").apply { mkdirs() }
                val file = File(dir, name.replace(Regex("[^A-Za-z0-9._-]"), "_"))
                file.writeBytes(Base64.decode(base64, Base64.DEFAULT))
                val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", file)
                val send = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                if (text.isNotEmpty()) send.putExtra(Intent.EXTRA_TEXT, text)
                runOnUiThread { startActivity(Intent.createChooser(send, null)) }
            } catch (_: Exception) {}
        }
    }
}
