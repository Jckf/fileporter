// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

import Capacitor
import Foundation
import UIKit
import UniformTypeIdentifiers

/// Files to send, for the page in the web view (as on Android, see
/// FilesPlugin.java, but no picking: the web view's own picker also
/// offers the photo library):
///
///   open({uri})    → {file}                       a file shared earlier (after a restart)
///   retain({uri})                                 removes every other file (uri may be absent)
///   takeShared()   → {file} | {error} | {}        what was last opened in the app ("Open in")
///   "shared" event                                something new was opened in it
///
/// iOS hands apps copies of shared files; they are kept in
/// Application Support (fileporter-send/<id>/<name>) until the page
/// retains another, so an interrupted send carries on after a restart.
/// The page reads them in byte ranges from url, which Capacitor serves.
@objc(FilesPlugin)
public class FilesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FilesPlugin"
    public let jsName = "Files"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retain", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeShared", returnType: CAPPluginReturnPromise)
    ]

    // Main thread only.
    private var shared: [String: Any]?

    private var store: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("fileporter-send", isDirectory: true)
    }

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(openedURL(_:)), name: .capacitorOpenURL, object: nil)
    }

    // MARK: Files kept for sending

    @objc func open(_ call: CAPPluginCall) {
        let url = store.appendingPathComponent(call.getString("uri") ?? "")
        guard !(call.getString("uri") ?? "").isEmpty, FileManager.default.fileExists(atPath: url.path),
              let file = try? describe(url) else {
            call.reject("No longer available")
            return
        }
        call.resolve(["file": file])
    }

    @objc func retain(_ call: CAPPluginCall) {
        let keep = (call.getString("uri") ?? "").split(separator: "/").first.map(String.init)
        let dirs = (try? FileManager.default.contentsOfDirectory(at: store, includingPropertiesForKeys: nil)) ?? []
        for dir in dirs where dir.lastPathComponent != keep {
            try? FileManager.default.removeItem(at: dir)
        }
        call.resolve()
    }

    // MARK: Sharing from other apps

    @objc func takeShared(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            let s = self?.shared ?? [:]
            self?.shared = nil
            call.resolve(s)
        }
    }

    /// "Open in fileporter" (Info.plist's document types): iOS copied the
    /// file into Documents/Inbox and opened the app with its URL.
    @objc private func openedURL(_ note: Notification) {
        guard let info = note.object as? [String: Any], let url = info["url"] as? URL, url.isFileURL else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            do {
                self.shared = ["file": try self.keep(url)]
            } catch {
                self.shared = ["error": "unreadable"]
            }
            self.notifyListeners("shared", data: [:])
        }
    }

    // MARK: Files

    /// Moves (or copies, if it can't) url into its own directory in the store.
    private func keep(_ url: URL) throws -> [String: Any] {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let dir = store.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent(url.lastPathComponent.isEmpty ? "file" : url.lastPathComponent)
        do {
            try FileManager.default.moveItem(at: url, to: dest)
        } catch {
            try FileManager.default.copyItem(at: url, to: dest)
        }
        return try describe(dest)
    }

    private func describe(_ url: URL) throws -> [String: Any] {
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
        let modified = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? ""
        guard let served = bridge?.portablePath(fromLocalURL: url) else {
            throw CocoaError(.fileReadUnknown)
        }
        return [
            "uri": url.deletingLastPathComponent().lastPathComponent + "/" + url.lastPathComponent,
            "url": served.absoluteString,
            "name": url.lastPathComponent,
            "size": size,
            "type": type,
            "lastModified": Int64(modified * 1000),
            "persistent": true
        ]
    }
}
