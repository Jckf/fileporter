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
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
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
import java.io.Closeable;
import java.io.FileDescriptor;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
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
    // Picked files we hold a persisted permission for, as last seen
    // (looking it up is an IPC), until retain() releases them.
    private final Set<String> persisted = ConcurrentHashMap.newKeySet();
    // Files being read, by uri (see Source).
    private final Map<String, Source> sources = new HashMap<>();

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
        handleShare(getActivity().getIntent(), false);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleShare(intent, true);
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
        // Off the main thread: describing it is content-provider IPC, which
        // a cloud provider may take seconds over.
        getBridge().execute(() -> {
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
        });
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
        persisted.retainAll(Collections.singleton(keep));
        forgetAllBut(keep);
        call.resolve();
    }

    // --- Sharing from other apps -------------------------------------------

    @PluginMethod
    public void takeShared(PluginCall call) {
        JSObject s = shared;
        shared = null;
        call.resolve(s != null ? s : new JSObject());
    }

    /**
     * Records a share intent, if it is one, then tells the page when
     * notify. Describing the file is content-provider IPC, which a cloud
     * provider may take seconds over, so that runs off the main thread,
     * on the one plugin calls run on: a takeShared() the page calls
     * after this (or after the "shared" event) comes after it.
     */
    @SuppressWarnings("deprecation") // getParcelableExtra(String): the typed one needs API 33
    private void handleShare(Intent intent, boolean notify) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
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
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);

        getBridge().execute(() -> {
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
                Matcher m = LINK.matcher(text != null ? text : "");
                if (m.find()) s.put("link", m.group(1));
                else s.put("error", "notfile");
            }
            shared = s;
            if (notify) notifyListeners("shared", new JSObject());
        });
    }

    // --- Reading -------------------------------------------------------------

    /**
     * A file the page reads, kept open until the page retains another
     * one. A file is opened once and each range read in place (pread),
     * at its own offset, so ranges read at the same time share it.
     * When the provider can only stream it (a pipe, not a file) a range
     * can't start at an offset, only read up to it. The page reads in
     * order, so the stream a range leaves off is kept for the next one,
     * which carries on from there instead of reading from byte 0 again:
     * otherwise a 500 MB file read in 1 MiB ranges would read 125 GB.
     * A provider may also hand out part of a file (say, one entry of an
     * archive): its bytes start at an offset into the file it opens.
     */
    private static final class Source {
        private AssetFileDescriptor file; // open while ranges read it
        private int users; // ranges reading file
        private boolean pipe; // not a file: streamed
        private InputStream idle; // not being read, at byte idleAt
        private long idleAt;
        private boolean dropped; // let go of: closed once no range reads it

        /**
         * The file to read a range of (release() it after), from its
         * getStartOffset() and no further than its getDeclaredLength() if
         * it has one, or null if it can only be streamed. Opened on first
         * use, outside the lock: a cloud provider may take seconds over
         * it, and drop() (from the main thread, or the one plugin calls
         * run on) mustn't wait for that. Ranges that miss it at the same
         * time each open it; the first one in keeps its own and the
         * others close theirs.
         */
        AssetFileDescriptor acquire(ContentResolver resolver, Uri uri) throws IOException {
            synchronized (this) {
                if (file != null) {
                    users++;
                    return file;
                }
                if (pipe) return null;
                if (dropped) throw new IOException("let go of");
            }
            // Not openFileDescriptor(): that refuses part of a file.
            AssetFileDescriptor f = resolver.openAssetFileDescriptor(uri, "r");
            boolean seekable = false;
            if (f != null) {
                try {
                    Os.lseek(f.getFileDescriptor(), 0, OsConstants.SEEK_CUR);
                    seekable = true;
                } catch (ErrnoException e) {
                    // a pipe, not a file: stream it instead
                }
            }
            AssetFileDescriptor got = null;
            synchronized (this) {
                if (!seekable) {
                    pipe = true;
                } else if (file == null && !dropped) {
                    file = f;
                    f = null;
                }
                if (file != null) {
                    users++;
                    got = file;
                }
            }
            closeQuietly(f); // a pipe, or another range got there first
            if (got == null && seekable) throw new IOException("let go of");
            return got;
        }

        void release() {
            AssetFileDescriptor f = null;
            synchronized (this) {
                if (--users == 0 && dropped) {
                    f = file;
                    file = null;
                }
            }
            closeQuietly(f);
        }

        /** Keeps in (at byte at) for the next range, unless one further along is kept already. */
        void giveBack(InputStream in, long at) {
            synchronized (this) {
                if (!dropped && (idle == null || idleAt < at)) {
                    InputStream old = idle;
                    idle = in;
                    idleAt = at;
                    in = old;
                }
            }
            closeQuietly(in);
        }

        void drop() {
            InputStream in;
            AssetFileDescriptor f = null;
            synchronized (this) {
                dropped = true;
                in = idle;
                idle = null;
                if (users == 0) {
                    f = file;
                    file = null;
                }
            }
            closeQuietly(in);
            closeQuietly(f);
        }
    }

    private boolean readable(String uri) {
        if (uri == null || uri.isEmpty()) return false;
        if (granted.contains(uri) || persisted.contains(uri)) return true;
        for (UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (p.isReadPermission() && p.getUri().toString().equals(uri)) {
                persisted.add(uri);
                return true;
            }
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
            long len = end - start + 1;
            InputStream in = openRange(uri, start, len);
            Map<String, String> headers = new HashMap<>();
            headers.put("Content-Length", Long.toString(len));
            headers.put("Cache-Control", "no-store");
            return new WebResourceResponse("application/octet-stream", null, 200, "OK", headers, in);
        } catch (Exception e) {
            Log.w(TAG, "can't read " + uri, e);
            return status(404, "Not Found");
        }
    }

    /** len bytes of uri from start. */
    private InputStream openRange(String uri, long start, long len) throws IOException {
        Source s = source(uri);
        AssetFileDescriptor f = s.acquire(getContext().getContentResolver(), Uri.parse(uri));
        if (f != null) {
            long declared = f.getDeclaredLength(); // part of a file ends there
            long have = declared < 0 ? len : Math.max(0, Math.min(len, declared - start));
            return new FileRange(s, f.getFileDescriptor(), f.getStartOffset() + start, have);
        }
        return stream(s, uri, start, len);
    }

    private Source source(String uri) {
        synchronized (sources) {
            Source s = sources.get(uri);
            if (s == null) sources.put(uri, s = new Source());
            return s;
        }
    }

    /**
     * A stream of uri at start: the one the last range left there (or
     * before it) if there is one, else a new one read up to start.
     */
    private InputStream stream(Source s, String uri, long start, long len) throws IOException {
        InputStream in;
        long at;
        synchronized (s) {
            in = s.idle;
            at = s.idleAt;
            s.idle = null;
        }
        if (in != null && at > start) {
            closeQuietly(in); // past it: start over
            in = null;
        }
        if (in == null) {
            in = getContext().getContentResolver().openInputStream(Uri.parse(uri));
            if (in == null) throw new IOException("can't open");
            at = 0;
        }
        try {
            long left = start - at;
            byte[] skip = new byte[64 << 10];
            while (left > 0) {
                int n = in.read(skip, 0, (int) Math.min(skip.length, left));
                if (n < 0) throw new IOException("past the end");
                left -= n;
            }
        } catch (IOException e) {
            closeQuietly(in);
            throw e;
        }
        return new Streamed(s, in, start, len);
    }

    /** Lets go of the open files, other than keep's (null: all of them). */
    private void forgetAllBut(String keep) {
        List<Source> gone = new ArrayList<>();
        synchronized (sources) {
            Iterator<Map.Entry<String, Source>> it = sources.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<String, Source> e = it.next();
                if (!e.getKey().equals(keep)) {
                    gone.add(e.getValue());
                    it.remove();
                }
            }
        }
        for (Source s : gone) s.drop();
    }

    @Override
    protected void handleOnDestroy() {
        forgetAllBut(null);
    }

    private static void closeQuietly(Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (IOException ignored) {}
    }

    private static WebResourceResponse status(int code, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason, new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    /**
     * len bytes of s's file from at, read in place: ranges don't share a
     * position, so they can be read at the same time.
     */
    private static final class FileRange extends InputStream {
        private final Source s;
        private final FileDescriptor fd;
        private long at;
        private long left;
        private boolean closed;

        FileRange(Source s, FileDescriptor fd, long at, long len) {
            this.s = s;
            this.fd = fd;
            this.at = at;
            left = len;
        }

        @Override
        public int read() throws IOException {
            byte[] b = new byte[1];
            return read(b, 0, 1) == 1 ? b[0] & 0xff : -1;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (closed || left <= 0) return -1;
            if (len == 0) return 0;
            int n;
            try {
                n = Os.pread(fd, b, off, (int) Math.min(len, left), at);
            } catch (ErrnoException e) {
                throw new IOException(e.getMessage(), e);
            }
            if (n <= 0) return -1; // shorter than it said
            at += n;
            left -= n;
            return n;
        }

        @Override
        public int available() {
            return closed ? 0 : (int) Math.min(left, Integer.MAX_VALUE);
        }

        @Override
        public void close() {
            if (closed) return;
            closed = true;
            s.release();
        }
    }

    /**
     * len bytes of a stream that is at byte at. Read to the end (or
     * closed part way), the stream goes back to s for the next range;
     * the web view may only close this later, after the page has asked
     * for that range already.
     */
    private static final class Streamed extends InputStream {
        private final Source s;
        private InputStream in; // null once given back
        private long at;
        private long left;

        Streamed(Source s, InputStream in, long at, long len) {
            this.s = s;
            this.in = in;
            this.at = at;
            left = len;
        }

        @Override
        public int read() throws IOException {
            byte[] b = new byte[1];
            return read(b, 0, 1) == 1 ? b[0] & 0xff : -1;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (in == null || left <= 0) return -1;
            if (len == 0) return 0;
            int n;
            try {
                n = in.read(b, off, (int) Math.min(len, left));
            } catch (IOException e) {
                closeQuietly(in);
                in = null;
                throw e;
            }
            if (n < 0) {
                closeQuietly(in); // shorter than it said
                in = null;
                return -1;
            }
            at += n;
            left -= n;
            if (left == 0) close();
            return n;
        }

        @Override
        public int available() throws IOException {
            return in == null ? 0 : (int) Math.min(in.available(), left);
        }

        @Override
        public void close() {
            if (in == null) return;
            s.giveBack(in, at);
            in = null;
        }
    }
}
