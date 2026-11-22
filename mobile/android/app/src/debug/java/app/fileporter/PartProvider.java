// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

package app.fileporter;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;
import java.util.List;

/**
 * Debug builds only: content://app.fileporter.part/<start>/<length>/<name>
 * is bytes start..start+length of the app's files/part/<name>, handed
 * out as part of that file (an asset file descriptor at an offset, with
 * a declared length), as a provider serving one entry of an archive
 * does. The Files plugin must read from the offset and stop at the
 * length (see FilesPlugin.java); test/android.test.js sends one.
 */
public class PartProvider extends ContentProvider {

    private static final class Part {
        final File file;
        final long start, length;

        Part(File file, long start, long length) {
            this.file = file;
            this.start = start;
            this.length = length;
        }
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    private Part part(Uri uri) throws FileNotFoundException {
        List<String> seg = uri.getPathSegments();
        if (seg.size() != 3) throw new FileNotFoundException(uri.toString());
        String name = seg.get(2);
        if (name.isEmpty() || name.equals(".") || name.equals("..")) throw new FileNotFoundException(uri.toString());
        File f = new File(new File(getContext().getFilesDir(), "part"), name);
        long start, length;
        try {
            start = Long.parseLong(seg.get(0));
            length = Long.parseLong(seg.get(1));
        } catch (NumberFormatException e) {
            throw new FileNotFoundException(uri.toString());
        }
        if (!f.isFile() || start < 0 || length < 0 || start + length > f.length()) throw new FileNotFoundException(uri.toString());
        return new Part(f, start, length);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        Part p;
        try {
            p = part(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        MatrixCursor c = new MatrixCursor(new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE });
        c.addRow(new Object[] { p.file.getName(), p.length });
        return c;
    }

    @Override
    public String getType(Uri uri) {
        return "application/octet-stream";
    }

    @Override
    public AssetFileDescriptor openAssetFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("read only");
        Part p = part(uri);
        ParcelFileDescriptor fd = ParcelFileDescriptor.open(p.file, ParcelFileDescriptor.MODE_READ_ONLY);
        return new AssetFileDescriptor(fd, p.start, p.length);
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
