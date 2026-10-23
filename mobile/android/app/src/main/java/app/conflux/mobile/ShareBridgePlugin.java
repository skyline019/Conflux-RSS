package app.conflux.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ConfluxShareBridge")
public class ShareBridgePlugin extends Plugin {
    private static String pending = null;

    public static void setPending(String value) {
        pending = value;
    }

    @PluginMethod
    public void takePending(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("url", pending);
        pending = null;
        call.resolve(ret);
    }
}
