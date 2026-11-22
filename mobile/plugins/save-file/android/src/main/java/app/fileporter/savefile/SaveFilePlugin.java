// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

package app.fileporter.savefile;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedOutputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Saves a file where the user chooses, through the system's "Save as"
 * dialog (Storage Access Framework). The web view can't download
 * files itself, so the page sends the file here in chunks:
 *
 *   start({name, type}) → {id} | {cancelled: true}   asks where to save
 *   write({id, data})                                appends base64 data
 *   finish({id})        → {saved: true}              closes the file
 *   abort({id})                                      deletes the partial file
 */
@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

    private static final class Target {
        final Uri uri;
        final OutputStream out;

        Target(Uri uri, OutputStream out) {
            this.uri = uri;
            this.out = out;
        }
    }

    private final Map<String, Target> open = new ConcurrentHashMap<>();

    @PluginMethod
    public void start(PluginCall call) {
        String name = call.getString("name", "");
        String type = call.getString("type", "");
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(type == null || type.isEmpty() ? "application/octet-stream" : type);
        intent.putExtra(Intent.EXTRA_TITLE, name == null || name.isEmpty() ? "file" : name);
        startActivityForResult(call, intent, "picked");
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        Uri uri = result.getResultCode() == Activity.RESULT_OK && data != null ? data.getData() : null;
        if (uri == null) {
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }
        // Off the main thread: opening it is content-provider IPC, which a
        // cloud provider may take seconds over.
        getBridge().execute(() -> {
            try {
                String id = UUID.randomUUID().toString();
                open.put(id, new Target(uri, new BufferedOutputStream(openOutput(uri), 1 << 20)));
                JSObject ret = new JSObject();
                ret.put("id", id);
                call.resolve(ret);
            } catch (Exception e) {
                delete(uri);
                call.reject("Couldn't open the file: " + e.getMessage(), e);
            }
        });
    }

    private OutputStream openOutput(Uri uri) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        OutputStream out;
        try {
            // Truncate, in case the user picked an existing file.
            out = resolver.openOutputStream(uri, "wt");
        } catch (IllegalArgumentException | FileNotFoundException e) {
            // Not every provider supports "wt"; a new document is empty anyway.
            out = resolver.openOutputStream(uri, "w");
        }
        if (out == null) throw new IOException("no output stream");
        return out;
    }

    @PluginMethod
    public void write(PluginCall call) {
        Target t = open.get(call.getString("id", ""));
        if (t == null) {
            call.reject("No such file");
            return;
        }
        try {
            t.out.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            call.resolve();
        } catch (Exception e) {
            close(call.getString("id", ""), true);
            call.reject("Couldn't write the file: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void finish(PluginCall call) {
        String id = call.getString("id", "");
        Target t = open.remove(id);
        if (t == null) {
            call.reject("No such file");
            return;
        }
        try {
            t.out.close();
            JSObject ret = new JSObject();
            ret.put("saved", true);
            call.resolve(ret);
        } catch (IOException e) {
            delete(t.uri);
            call.reject("Couldn't finish the file: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void abort(PluginCall call) {
        close(call.getString("id", ""), true);
        call.resolve();
    }

    private void close(String id, boolean discard) {
        Target t = open.remove(id);
        if (t == null) return;
        try {
            t.out.close();
        } catch (IOException ignored) {}
        if (discard) delete(t.uri);
    }

    private void delete(Uri uri) {
        try {
            DocumentsContract.deleteDocument(getContext().getContentResolver(), uri);
        } catch (Exception ignored) {
            // Best effort: the provider may not support deleting.
        }
    }

    @Override
    protected void handleOnDestroy() {
        for (String id : open.keySet()) close(id, true);
    }
}
