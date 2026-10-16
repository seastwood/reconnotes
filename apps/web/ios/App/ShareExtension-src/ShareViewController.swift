import UIKit
import UniformTypeIdentifiers

/// "Share → ReconNotes": saves what was shared (links, text, photos, PDFs,
/// recordings, files) into the App Group inbox and closes. ReconNotes turns
/// it into a new note the next time it's opened – or adds it to the end of a
/// note picked here (your pinned and recent notes, which the app keeps in
/// ShareTargets.json).
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
        targets = loadTargets()
        if targets.isEmpty {
            Task { await save(target: nil) }
        } else {
            banner.isHidden = true
            showPicker()
        }
    }

    // MARK: - where it goes: a new note, or the end of a note you pick

    private var targets: [(id: String, title: String)] = []
    private let card = UIView()

    private func loadTargets() -> [(id: String, title: String)] {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup),
              let data = try? Data(contentsOf: container.appendingPathComponent("ShareTargets.json")),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let notes = obj["notes"] as? [[String: String]] else { return [] }
        return notes.prefix(8).compactMap { n in
            guard let id = n["id"] else { return nil }
            let title = (n["title"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return (id, title.isEmpty ? "Untitled" : title)
        }
    }

    private func row(_ title: String, image: String, tag: Int, bold: Bool = false) -> UIButton {
        var config = UIButton.Configuration.plain()
        config.title = title
        config.image = UIImage(systemName: image)
        config.imagePadding = 10
        config.titleLineBreakMode = .byTruncatingTail
        config.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attrs in
            var a = attrs
            a.font = UIFont.preferredFont(forTextStyle: bold ? .headline : .body)
            return a
        }
        let b = UIButton(configuration: config)
        b.contentHorizontalAlignment = .leading
        b.tag = tag
        b.addTarget(self, action: #selector(picked(_:)), for: .touchUpInside)
        return b
    }

    private func showPicker() {
        card.backgroundColor = .systemBackground
        card.layer.cornerRadius = 16
        card.layer.masksToBounds = true
        card.translatesAutoresizingMaskIntoConstraints = false
        let stack = UIStackView()
        stack.axis = .vertical
        stack.translatesAutoresizingMaskIntoConstraints = false
        let head = UILabel()
        head.text = "Add to ReconNotes"
        head.font = .preferredFont(forTextStyle: .headline)
        head.textAlignment = .center
        head.heightAnchor.constraint(equalToConstant: 48).isActive = true
        stack.addArrangedSubview(head)
        stack.addArrangedSubview(row("New note", image: "square.and.pencil", tag: 0, bold: true))
        let sub = UILabel()
        sub.text = "   ADD TO THE END OF"
        sub.font = .preferredFont(forTextStyle: .caption1)
        sub.textColor = .secondaryLabel
        sub.heightAnchor.constraint(equalToConstant: 28).isActive = true
        stack.addArrangedSubview(sub)
        for (i, t) in targets.enumerated() { stack.addArrangedSubview(row(t.title, image: "doc.text", tag: i + 1)) }
        let cancel = row("Cancel", image: "xmark", tag: -1)
        cancel.tintColor = .secondaryLabel
        stack.addArrangedSubview(cancel)
        card.addSubview(stack)
        view.addSubview(card)
        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.widthAnchor.constraint(equalToConstant: 320),
            stack.topAnchor.constraint(equalTo: card.topAnchor),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -4),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor),
        ])
    }

    @objc private func picked(_ sender: UIButton) {
        if sender.tag < 0 {
            extensionContext?.completeRequest(returningItems: nil)
            return
        }
        let target: (id: String, title: String)? = sender.tag == 0 ? nil : targets[sender.tag - 1]
        card.removeFromSuperview()
        banner.isHidden = false
        Task { await save(target: target) }
    }

    private func save(target: (id: String, title: String)?) async {
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
        if let target { share["target"] = target.id }
        if let data = try? JSONSerialization.data(withJSONObject: share) {
            try? data.write(to: dir.appendingPathComponent("share.json"))
        }
        finish(target.map { "Added to “\($0.title)” ✓" } ?? "Added to ReconNotes ✓", ok: true)
    }

    /// One shared thing: a file (photo, PDF, recording…), a link, or text.
    private func load(_ provider: NSItemProvider, into dir: URL) async -> [String: Any]? {
        // Markdown files come as files (and become notes in the app), not as plain text
        let fileTypes: [UTType] = [.image, .pdf, .audio, .movie] + [UTType("net.daringfireball.markdown")].compactMap { $0 }
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
