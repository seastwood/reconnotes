import UIKit
import UniformTypeIdentifiers

/// "Share → ReconNotes": saves what was shared (links, text, photos, PDFs,
/// recordings, files) into the App Group inbox and closes. ReconNotes turns
/// it into a new note the next time it's opened.
///
/// Needs the App Group `group.com.reconnotes.app` on both the app and this
/// extension (Signing & Capabilities › App Groups) – see the README.
class ShareViewController: UIViewController {
    private let appGroup = Bundle.main.object(forInfoDictionaryKey: "ReconAppGroup") as? String ?? "group.com.reconnotes.app"
    private let banner = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black.withAlphaComponent(0.15)
        banner.text = "Adding to ReconNotes…"
        banner.font = .preferredFont(forTextStyle: .headline)
        banner.textAlignment = .center
        banner.backgroundColor = .secondarySystemBackground
        banner.layer.cornerRadius = 14
        banner.layer.masksToBounds = true
        banner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(banner)
        NSLayoutConstraint.activate([
            banner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            banner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            banner.widthAnchor.constraint(equalToConstant: 260),
            banner.heightAnchor.constraint(equalToConstant: 64),
        ])
        Task { await save() }
    }

    private func save() async {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
            return finish("Turn on the App Group for ReconNotes in Xcode (see the README).", ok: false)
        }
        let id = UUID().uuidString
        let dir = container.appendingPathComponent("ShareInbox/\(id)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        var items: [[String: Any]] = []
        var title: String?
        for case let item as NSExtensionItem in extensionContext?.inputItems ?? [] {
            if title == nil, let t = item.attributedContentText?.string.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { title = t }
            for provider in item.attachments ?? [] {
                if let entry = await load(provider, into: dir) { items.append(entry) }
            }
        }
        if items.isEmpty {
            try? FileManager.default.removeItem(at: dir)
            return finish("Nothing to add", ok: false)
        }
        var share: [String: Any] = ["id": id, "createdAt": Date().timeIntervalSince1970 * 1000, "items": items]
        if let title { share["title"] = title }
        if let data = try? JSONSerialization.data(withJSONObject: share) {
            try? data.write(to: dir.appendingPathComponent("share.json"))
        }
        finish("Added to ReconNotes ✓", ok: true)
    }

    /// One shared thing: a file (photo, PDF, recording…), a link, or text.
    private func load(_ provider: NSItemProvider, into dir: URL) async -> [String: Any]? {
        let fileTypes: [UTType] = [.image, .pdf, .audio, .movie]
        if let type = fileTypes.first(where: { provider.hasItemConformingToTypeIdentifier($0.identifier) }),
           let entry = await copyFile(provider, type: type, into: dir) {
            return entry
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
           let url = await loadItem(provider, UTType.fileURL) as? URL {
            return copy(url, into: dir)
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
           let url = await loadItem(provider, UTType.url) as? URL {
            return url.isFileURL ? copy(url, into: dir) : ["kind": "url", "url": url.absoluteString]
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
           let text = await loadItem(provider, UTType.plainText) as? String {
            return ["kind": "text", "text": text]
        }
        return nil
    }

    private func copyFile(_ provider: NSItemProvider, type: UTType, into dir: URL) async -> [String: Any]? {
        await withCheckedContinuation { cont in
            provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                guard let url else { return cont.resume(returning: nil) }
                // the system deletes `url` when this returns: copy it now
                var entry = self.copy(url, into: dir)
                if var e = entry, let name = provider.suggestedName, !name.isEmpty, let ext = url.pathExtension.isEmpty ? nil : url.pathExtension {
                    e["name"] = name.hasSuffix(".\(ext)") ? name : "\(name).\(ext)"
                    entry = e
                }
                cont.resume(returning: entry)
            }
        }
    }

    private func copy(_ url: URL, into dir: URL) -> [String: Any]? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let file = "\(UUID().uuidString.prefix(8))-\(url.lastPathComponent)"
        do {
            try FileManager.default.copyItem(at: url, to: dir.appendingPathComponent(file))
        } catch {
            return nil
        }
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        return ["kind": "file", "name": url.lastPathComponent, "mime": mime, "file": file]
    }

    private func loadItem(_ provider: NSItemProvider, _ type: UTType) async -> NSSecureCoding? {
        await withCheckedContinuation { cont in
            provider.loadItem(forTypeIdentifier: type.identifier, options: nil) { item, _ in cont.resume(returning: item) }
        }
    }

    private func finish(_ message: String, ok: Bool) {
        DispatchQueue.main.async {
            self.banner.text = message
            DispatchQueue.main.asyncAfter(deadline: .now() + (ok ? 0.7 : 2.5)) {
                self.extensionContext?.completeRequest(returningItems: nil)
            }
        }
    }
}
