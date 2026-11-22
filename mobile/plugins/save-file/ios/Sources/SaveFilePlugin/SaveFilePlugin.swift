// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

import Capacitor
import Foundation
import UIKit

/// Saves a file where the user chooses, through the system's export
/// dialog. The web view can't download files itself, so the page sends
/// the file here in chunks; it is written to a temporary file, which
/// the dialog then copies to the chosen place:
///
///   start({name, type}) → {id}                  creates the temporary file
///   write({id, data})                           appends base64 data
///   finish({id})        → {saved: true|false}   asks where to save it
///   abort({id})                                 removes the temporary file
@objc(SaveFilePlugin)
public class SaveFilePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "SaveFilePlugin"
    public let jsName = "SaveFile"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "abort", returnType: CAPPluginReturnPromise)
    ]

    private struct Target {
        let dir: URL
        let file: URL
        let handle: FileHandle
    }

    private static let dirPrefix = "fileporter-save-"
    private let lock = NSLock()
    private var open: [String: Target] = [:]
    // The export dialog being shown, if any (one at a time).
    private var exporting: (call: CAPPluginCall, dir: URL)?

    override public func load() {
        // Temporary files left behind by a previous run (the app was
        // closed while saving).
        let tmp = FileManager.default.temporaryDirectory
        let items = (try? FileManager.default.contentsOfDirectory(at: tmp, includingPropertiesForKeys: nil)) ?? []
        for url in items where url.lastPathComponent.hasPrefix(SaveFilePlugin.dirPrefix) {
            try? FileManager.default.removeItem(at: url)
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(SaveFilePlugin.dirPrefix + UUID().uuidString, isDirectory: true)
        let file = dir.appendingPathComponent(SaveFilePlugin.safeName(call.getString("name") ?? ""))
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            guard FileManager.default.createFile(atPath: file.path, contents: nil) else {
                throw CocoaError(.fileWriteUnknown)
            }
            let handle = try FileHandle(forWritingTo: file)
            let id = UUID().uuidString
            locked { open[id] = Target(dir: dir, file: file, handle: handle) }
            call.resolve(["id": id])
        } catch {
            try? FileManager.default.removeItem(at: dir)
            call.reject("Couldn't create the file: \(error.localizedDescription)")
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        guard let target = locked({ open[id] }) else {
            call.reject("No such file")
            return
        }
        guard let data = Data(base64Encoded: call.getString("data") ?? "") else {
            call.reject("Invalid data")
            return
        }
        do {
            try target.handle.write(contentsOf: data)
            call.resolve()
        } catch {
            discard(id)
            call.reject("Couldn't write the file: \(error.localizedDescription)")
        }
    }

    @objc func finish(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        guard let target = locked({ open.removeValue(forKey: id) }) else {
            call.reject("No such file")
            return
        }
        do {
            try target.handle.close()
        } catch {
            try? FileManager.default.removeItem(at: target.dir)
            call.reject("Couldn't finish the file: \(error.localizedDescription)")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self, let viewController = self.bridge?.viewController, self.exporting == nil else {
                try? FileManager.default.removeItem(at: target.dir)
                call.reject("Can't show the save dialog now")
                return
            }
            let picker = UIDocumentPickerViewController(forExporting: [target.file], asCopy: true)
            picker.delegate = self
            self.exporting = (call, target.dir)
            viewController.present(picker, animated: true)
        }
    }

    @objc func abort(_ call: CAPPluginCall) {
        discard(call.getString("id") ?? "")
        call.resolve()
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        exported(saved: true)
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        exported(saved: false)
    }

    private func exported(saved: Bool) {
        guard let pending = exporting else { return }
        exporting = nil
        try? FileManager.default.removeItem(at: pending.dir)
        pending.call.resolve(["saved": saved])
    }

    private func discard(_ id: String) {
        guard let target = locked({ open.removeValue(forKey: id) }) else { return }
        try? target.handle.close()
        try? FileManager.default.removeItem(at: target.dir)
    }

    // NSLock.withLock needs iOS 17.
    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    /// The file's name as shown in the dialog: no path separators.
    private static func safeName(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        let trimmed = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed == "." || trimmed == ".." ? "file" : trimmed
    }
}
