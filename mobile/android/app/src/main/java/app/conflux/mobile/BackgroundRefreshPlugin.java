package app.conflux.mobile;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import androidx.core.content.ContextCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(name = "ConfluxBackgroundRefresh")
public class BackgroundRefreshPlugin extends Plugin {
    public static final String WORK_NAME = "conflux_periodic_refresh";

    @PluginMethod
    public void schedule(PluginCall call) {
        int minutes = Math.max(15, call.getInt("intervalMinutes", 60));
        boolean wifiOnly = Boolean.TRUE.equals(call.getBoolean("wifiOnly", true));
        Context ctx = getContext();
        persistNativePrefs(ctx, minutes, wifiOnly);
        scheduleWork(ctx, minutes, wifiOnly);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("intervalMinutes", minutes);
        call.resolve(ret);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Context ctx = getContext();
        persistNativePrefs(ctx, 0, true);
        WorkManager.getInstance(ctx).cancelUniqueWork(WORK_NAME);
        Intent stop = new Intent(ctx, RefreshForegroundService.class);
        stop.setAction(RefreshForegroundService.ACTION_STOP);
        try {
            ctx.startService(stop);
        } catch (Exception ignored) { }
        call.resolve();
    }

    @PluginMethod
    public void startProgress(PluginCall call) {
        String title = call.getString("title", "汇阅");
        String text = call.getString("text", "正在刷新…");
        Context ctx = getContext();
        Intent i = new Intent(ctx, RefreshForegroundService.class);
        i.setAction(RefreshForegroundService.ACTION_START);
        // FGS may already be running from WorkManager; do not re-kick MainActivity
        i.putExtra(RefreshForegroundService.EXTRA_KICK_JS, false);
        try {
            ContextCompat.startForegroundService(ctx, i);
        } catch (Exception e) {
            call.reject(e.getMessage());
            return;
        }
        RefreshForegroundService svc = RefreshForegroundService.getInstance();
        if (svc != null) svc.updateProgress(title, text, 0, 0);
        call.resolve();
    }

    @PluginMethod
    public void stopSilent(PluginCall call) {
        Intent stop = new Intent(getContext(), RefreshForegroundService.class);
        stop.setAction(RefreshForegroundService.ACTION_STOP);
        try {
            getContext().startService(stop);
        } catch (Exception ignored) { }
        call.resolve();
    }

    @PluginMethod
    public void updateProgress(PluginCall call) {
        String title = call.getString("title", "汇阅 · 刷新中");
        String text = call.getString("text", "");
        int progress = call.getInt("progress", 0);
        int max = call.getInt("max", 0);
        RefreshForegroundService svc = RefreshForegroundService.getInstance();
        if (svc != null) {
            svc.updateProgress(title, text, progress, max);
        }
        call.resolve();
    }

    @PluginMethod
    public void complete(PluginCall call) {
        String title = call.getString("title", "汇阅 · 刷新完成");
        String text = call.getString("text", "订阅已更新");
        RefreshForegroundService svc = RefreshForegroundService.getInstance();
        if (svc != null) {
            svc.showCompleted(title, text);
        } else {
            // Service already gone — still fine
            Intent stop = new Intent(getContext(), RefreshForegroundService.class);
            stop.setAction(RefreshForegroundService.ACTION_STOP);
            try { getContext().startService(stop); } catch (Exception ignored) { }
        }
        call.resolve();
    }

    @PluginMethod
    public void fail(PluginCall call) {
        String text = call.getString("text", "刷新出错");
        RefreshForegroundService svc = RefreshForegroundService.getInstance();
        if (svc != null) svc.showFailed(text);
        call.resolve();
    }

    @PluginMethod
    public void moveToBackground(PluginCall call) {
        if (getActivity() != null) {
            getActivity().moveTaskToBack(true);
        }
        call.resolve();
    }

    public static void scheduleWork(Context ctx, int minutes, boolean wifiOnly) {
        int period = Math.max(15, minutes);
        Constraints.Builder cb = new Constraints.Builder()
            .setRequiredNetworkType(wifiOnly ? NetworkType.UNMETERED : NetworkType.CONNECTED);
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(
            RefreshWorker.class,
            period,
            TimeUnit.MINUTES
        )
            .setConstraints(cb.build())
            .build();
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
            WORK_NAME,
            ExistingPeriodicWorkPolicy.UPDATE,
            req
        );
    }

    private static void persistNativePrefs(Context ctx, int minutes, boolean wifiOnly) {
        SharedPreferences.Editor ed = ctx.getSharedPreferences("conflux_bg", Context.MODE_PRIVATE).edit();
        ed.putInt("intervalMinutes", minutes);
        ed.putBoolean("wifiOnly", wifiOnly);
        ed.apply();
    }
}
