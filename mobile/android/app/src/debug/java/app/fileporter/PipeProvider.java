// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

package app.fileporter;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Log;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Debug builds only: content://app.fileporter.pipe/<name> is the app's
 * files/pipe/<name>, served through a pipe, as a provider that can only
 * stream a file (one that makes or downloads it as it goes) serves it.
 * Such a file can't be read at an offset, so the Files plugin streams it
 * (see FilesPlugin.java); test/android.test.js sends one. Each open is
 * logged ("open <name>"), so the test can tell how often it was opened.
 */
public class PipeProvider extends ContentProvider {

    private static final String TAG = "PipeProvider";

    @Override
    public boolean onCreate() {
        return true;
    }

    private File file(Uri uri) throws FileNotFoundException {
        String name = uri.getLastPathSegment();
        if (name == null || name.isEmpty() || name.equals(".") || name.equals("..") || uri.getPathSegments().size() != 1) {
            throw new FileNotFoundException(uri.toString());
        }
        File f = new File(new File(getContext().getFilesDir(), "pipe"), name);
        if (!f.isFile()) throw new FileNotFoundException(uri.toString());
        return f;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File f;
        try {
            f = file(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        MatrixCursor c = new MatrixCursor(new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE });
        c.addRow(new Object[] { f.getName(), f.length() });
        return c;
    }

    @Override
    public String getType(Uri uri) {
        return "application/octet-stream";
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("read only");
        File f = file(uri);
        Log.i(TAG, "open " + f.getName());
        ParcelFileDescriptor[] pipe;
        try {
            pipe = ParcelFileDescriptor.createPipe();
        } catch (IOException e) {
            throw new FileNotFoundException(e.getMessage());
        }
        ParcelFileDescriptor out = pipe[1];
        new Thread(() -> {
            byte[] buf = new byte[64 << 10];
            try (InputStream in = new FileInputStream(f); OutputStream o = new ParcelFileDescriptor.AutoCloseOutputStream(out)) {
                for (int n; (n = in.read(buf)) > 0;) o.write(buf, 0, n);
            } catch (IOException e) {
                // The reader closed its end before the end of the file.
            }
        }, "PipeProvider").start();
        return pipe[0];
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }
}
