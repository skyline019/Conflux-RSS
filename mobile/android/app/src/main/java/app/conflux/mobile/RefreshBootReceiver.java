package app.conflux.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

/**
 * Reschedule WorkManager after reboot if background refresh was enabled.
 */
public class RefreshBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())
            && !"android.intent.action.QUICKBOOT_POWERON".equals(intent.getAction())) {
            return;
        }
        SharedPreferences prefs = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
        // Capacitor Preferences are in a different store; plugin also writes native flag
        SharedPreferences nativePrefs = context.getSharedPreferences("conflux_bg", Context.MODE_PRIVATE);
        int minutes = nativePrefs.getInt("intervalMinutes", 0);
        boolean wifiOnly = nativePrefs.getBoolean("wifiOnly", true);
        if (minutes > 0) {
            BackgroundRefreshPlugin.scheduleWork(context, minutes, wifiOnly);
        }
    }
}
