package app.conflux.mobile;

import android.content.Context;
import android.content.Intent;
import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

public class RefreshWorker extends Worker {
    public RefreshWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Intent i = new Intent(getApplicationContext(), RefreshForegroundService.class);
        i.setAction(RefreshForegroundService.ACTION_START);
        i.putExtra(RefreshForegroundService.EXTRA_KICK_JS, true);
        try {
            ContextCompat.startForegroundService(getApplicationContext(), i);
            return Result.success();
        } catch (Exception e) {
            return Result.retry();
        }
    }
}
