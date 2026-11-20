// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

package app.fileporter.files;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.UriPermission;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayInputStream;
import java.io.FileInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Files to send, for the page in the web view:
 *
 *   pick()         → {file} | {cancelled: true}   the system file picker
 *   open({uri})    → {file}                       a file picked earlier (after a restart)
 *   retain({uri})                                 releases every other file (uri may be absent)
 *   takeShared()   → {file} | {link} | {error} | {}
 *                    what was last shared to the app from another app
 *   "shared" event                                something new was shared
 *
 * file = {uri, url, name, size, type, lastModified, persistent, ranges}.
 * The page reads it in byte ranges from url (ranges: "query", adding
 * &start=&end=), which this plugin serves: Capacitor's own handler for
 * content:// URLs only serves whole files. Picked files keep their read permission across restarts
 * (persistent: true), so an interrupted send carries on without picking
 * the file again, until the page retains another one.
 */
@CapacitorPlugin(name = "Files")
public class FilesPlugin extends Plugin {

    static final String PATH = "/_fileporter/file";
    private static final String TAG = "FilesPlugin";
    private static final Pattern LINK = Pattern.compile("https://fileporter\\.app/(#[A-Za-z0-9_.-]+)");

    // Shared to us during this run: readable until the app closes.
    private final Set<String> granted = ConcurrentHashMap.newKeySet();
    private volatile JSObject shared = null;

    @Override
    public void load() {
        Bridge bridge = getBridge();
        bridge.setWebViewClient(
            new BridgeWebViewClient(bridge) {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    if (PATH.equals(request.getUrl().getPath())) return serve(request);
                    return super.shouldInterceptRequest(view, request);
                }
            }
        );
        handleShare(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (handleShare(intent)) notifyListeners("shared", new JSObject());
    }

    // --- Picking ---------------------------------------------------------

    @PluginMethod
    public void pick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
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
        ContentResolver resolver = getContext().getContentResolver();
        boolean persistent = true;
        try {
            resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException e) {
            persistent = false; // readable for now, not after a restart
            granted.add(uri.toString());
        }
        try {
            JSObject ret = new JSObject();
            ret.put("file", describe(uri, persistent));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Couldn't read that file: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void open(PluginCall call) {
        String uri = call.getString("uri", "");
        if (!readable(uri)) {
            call.reject("No longer available");
            return;
        }
        try {
            JSObject ret = new JSObject();
            ret.put("file", describe(Uri.parse(uri), !granted.contains(uri)));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("No longer available: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void retain(PluginCall call) {
        String keep = call.getString("uri", "");
        ContentResolver resolver = getContext().getContentResolver();
        for (UriPermission p : resolver.getPersistedUriPermissions()) {
            if (!p.getUri().toString().equals(keep)) {
                resolver.releasePersistableUriPermission(p.getUri(), Intent.FLAG_GRANT_READ_URI_PERMISSION);
            }
        }
        call.resolve();
    }

    // --- Sharing from other apps -------------------------------------------

    @PluginMethod
    public void takeShared(PluginCall call) {
        JSObject s = shared;
        shared = null;
        call.resolve(s != null ? s : new JSObject());
    }

    /** Records a share intent; true if it was one. */
    @SuppressWarnings("deprecation") // getParcelableExtra(String): the typed one needs API 33
    private boolean handleShare(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return false;
        // Handled: a recreated activity mustn't share it again.
        intent.setAction(null);

        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }

        JSObject s = new JSObject();
        if (uris.size() > 1) {
            s.put("error", "many");
        } else if (uris.size() == 1) {
            Uri uri = uris.get(0);
            granted.add(uri.toString());
            try {
                s.put("file", describe(uri, false));
            } catch (Exception e) {
                Log.w(TAG, "can't read shared " + uri, e);
                s.put("error", "unreadable");
            }
        } else {
            // Shared text: a fileporter link opens; anything else isn't a file.
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            Matcher m = LINK.matcher(text != null ? text : "");
            if (m.find()) s.put("link", m.group(1));
            else s.put("error", "notfile");
        }
        shared = s;
        return true;
    }

    // --- Reading -------------------------------------------------------------

    private boolean readable(String uri) {
        if (uri == null || uri.isEmpty()) return false;
        if (granted.contains(uri)) return true;
        for (UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (p.isReadPermission() && p.getUri().toString().equals(uri)) return true;
        }
        return false;
    }

    private JSObject describe(Uri uri, boolean persistent) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        String name = null;
        long size = -1;
        long modified = 0;
        try (Cursor c = resolver.query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (i >= 0 && !c.isNull(i)) name = c.getString(i);
                i = c.getColumnIndex(OpenableColumns.SIZE);
                if (i >= 0 && !c.isNull(i)) size = c.getLong(i);
                i = c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED);
                if (i >= 0 && !c.isNull(i)) modified = c.getLong(i);
            }
        }
        if (size < 0) {
            try (AssetFileDescriptor afd = resolver.openAssetFileDescriptor(uri, "r")) {
                if (afd != null) size = afd.getLength();
            }
        }
        if (size < 0) throw new IOException("unknown size");
        if (name == null || name.isEmpty()) name = uri.getLastPathSegment() != null ? uri.getLastPathSegment() : "file";
        String type = resolver.getType(uri);

        JSObject f = new JSObject();
        f.put("uri", uri.toString());
        f.put("url", PATH + "?u=" + Uri.encode(uri.toString()));
        f.put("name", name);
        f.put("size", size);
        f.put("type", type != null ? type : "");
        f.put("lastModified", modified);
        f.put("persistent", persistent);
        f.put("ranges", "query");
        return f;
    }

    /**
     * Serves bytes start..end (inclusive, from the query) of a readable
     * file, with status 200. Not a Range request: the web view applies a
     * request's Range to intercepted responses itself, by skipping the
     * start of the stream, so it would read up to the offset every time.
     */
    private WebResourceResponse serve(WebResourceRequest request) {
        Uri url = request.getUrl();
        String uri = url.getQueryParameter("u");
        if (!readable(uri)) return status(403, "Forbidden");
        long start, end;
        try {
            start = Long.parseLong(url.getQueryParameter("start"));
            end = Long.parseLong(url.getQueryParameter("end"));
        } catch (Exception e) {
            return status(400, "Bad Request");
        }
        if (start < 0 || end < start) return status(400, "Bad Request");
        try {
            InputStream in = openAt(Uri.parse(uri), start);
            long len = end - start + 1;
            Map<String, String> headers = new HashMap<>();
            headers.put("Content-Length", Long.toString(len));
            headers.put("Cache-Control", "no-store");
            return new WebResourceResponse("application/octet-stream", null, 200, "OK", headers, new Limited(in, len));
        } catch (Exception e) {
            Log.w(TAG, "can't read " + uri, e);
            return status(404, "Not Found");
        }
    }

    private InputStream openAt(Uri uri, long start) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        ParcelFileDescriptor pfd = resolver.openFileDescriptor(uri, "r");
        if (pfd != null) {
            FileInputStream in = new ParcelFileDescriptor.AutoCloseInputStream(pfd);
            try {
                in.getChannel().position(start);
                return in;
            } catch (IOException e) {
                in.close(); // a pipe, not a file: read up to start instead
            }
        }
        InputStream in = resolver.openInputStream(uri);
        if (in == null) throw new IOException("can't open");
        long left = start;
        byte[] skip = new byte[64 << 10];
        while (left > 0) {
            int n = in.read(skip, 0, (int) Math.min(skip.length, left));
            if (n < 0) {
                in.close();
                throw new IOException("past the end");
            }
            left -= n;
        }
        return in;
    }

    private static WebResourceResponse status(int code, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason, new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    /** At most n bytes of in. */
    private static final class Limited extends FilterInputStream {
        private long left;

        Limited(InputStream in, long n) {
            super(in);
            left = n;
        }

        @Override
        public int read() throws IOException {
            if (left <= 0) return -1;
            int b = super.read();
            if (b >= 0) left--;
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }

        @Override
        public long skip(long n) throws IOException {
            long s = super.skip(Math.min(n, left));
            left -= s;
            return s;
        }

        @Override
        public int available() throws IOException {
            return (int) Math.min(super.available(), left);
        }
    }
}
