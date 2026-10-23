package app.conflux.mobile;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    private static MainActivity instance;

    private String pendingShare = null;
    private boolean pendingBackgroundRefresh = false;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    public static MainActivity getInstance() {
        return instance;
    }

    /**
     * Soft path: process already has a live WebView — dispatch refresh without a new launch flash.
     * @return true if JS was (or will be) kicked
     */
    public static boolean requestBackgroundRefreshIfAlive() {
        MainActivity act = instance;
        if (act == null || act.getBridge() == null || act.getBridge().getWebView() == null) {
            return false;
        }
        act.pendingBackgroundRefresh = true;
        act.dispatchBackgroundRefreshToJs(350);
        return true;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShareBridgePlugin.class);
        registerPlugin(BackgroundRefreshPlugin.class);
        super.onCreate(savedInstanceState);
        instance = this;
        captureIntent(getIntent());
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureIntent(intent);
        dispatchPendingToJs();
    }

    @Override
    public void onStart() {
        super.onStart();
        dispatchPendingToJs();
    }

    private void captureIntent(Intent intent) {
        if (intent == null) return;
        if (intent.getBooleanExtra("backgroundRefresh", false)) {
            pendingBackgroundRefresh = true;
        }
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action) && intent.getType() != null && intent.getType().startsWith("text/")) {
            CharSequence shared = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (shared != null && shared.length() > 0) {
                pendingShare = shared.toString().trim();
            }
        } else if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            String url = intent.getData().getQueryParameter("url");
            if (url == null || url.isEmpty()) {
                url = intent.getDataString();
            }
            if (url != null && !url.isEmpty() && !url.contains("background-refresh")) {
                pendingShare = url;
            }
            if (intent.getData() != null && "background-refresh".equals(intent.getData().getHost())) {
                pendingBackgroundRefresh = true;
            }
        }
        ShareBridgePlugin.setPending(pendingShare);
    }

    private void dispatchPendingToJs() {
        dispatchShareToJs();
        dispatchBackgroundRefreshToJs();
    }

    private void dispatchShareToJs() {
        if (pendingShare == null || getBridge() == null || getBridge().getWebView() == null) return;
        try {
            String payload = JSONObject.quote(pendingShare);
            getBridge().getWebView().post(() ->
                getBridge().getWebView().evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('confluxShare',{detail:" + payload + "}));",
                    null
                )
            );
            pendingShare = null;
            ShareBridgePlugin.setPending(null);
        } catch (Exception ignored) { /* retry */ }
    }

    private void dispatchBackgroundRefreshToJs() {
        dispatchBackgroundRefreshToJs(1200);
    }

    private void dispatchBackgroundRefreshToJs(long delayMs) {
        if (!pendingBackgroundRefresh || getBridge() == null || getBridge().getWebView() == null) return;
        pendingBackgroundRefresh = false;
        mainHandler.postDelayed(() -> {
            try {
                if (getBridge() == null || getBridge().getWebView() == null) return;
                getBridge().getWebView().evaluateJavascript(
                    "window.dispatchEvent(new Event('confluxBackgroundRefresh'));",
                    null
                );
            } catch (Exception ignored) { }
        }, delayMs);
    }
}
