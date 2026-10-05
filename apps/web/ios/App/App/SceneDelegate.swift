import UIKit
import WebKit
import Vision
import Speech
import UniformTypeIdentifiers
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = ReconBridgeViewController()
        window?.makeKeyAndVisible()

        // Opened with a file ("Open in ReconNotes" / "Copy to ReconNotes") while not running
        ShareInboxPlugin.importFiles(connectionOptions.urlContexts.map(\.url).filter(\.isFileURL))

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        let files = URLContexts.map(\.url).filter(\.isFileURL)
        if !files.isEmpty {
            ShareInboxPlugin.importFiles(files)
            (window?.rootViewController as? CAPBridgeViewController)?.bridge?.triggerWindowJSEvent(eventName: "reconnotes:share-inbox")
        }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

/// Hosts the ReconNotes web app and forwards Apple Pencil side-button gestures to it.
///
/// Web pages can't see Apple Pencil double-tap (2nd gen / USB-C) or squeeze
/// (Pencil Pro), so we attach a UIPencilInteraction to the web view and
/// re-dispatch each gesture as a DOM event:
///
///     window.dispatchEvent(new CustomEvent('reconnotes:pencil', { detail }))
///
/// with detail = { kind: 'tap' | 'squeeze', action: <user preference>, x?, y? }.
/// `action` is the user's choice in Settings › Apple Pencil, and x/y is where
/// the pencil is hovering (in CSS pixels), so the palette can open next to it.
class ReconBridgeViewController: CAPBridgeViewController, UIPencilInteractionDelegate, UIScribbleInteractionDelegate {

    /// The app's bridge view controller, for the Scribble plugin.
    static weak var current: ReconBridgeViewController?
    /// Whether iPadOS Scribble (handwriting → typed text) may run. Off by
    /// default so Pencil writing stays ink; the web app turns it on when the
    /// user picks "Use Scribble" and no drawing is being edited.
    private(set) var scribbleEnabled = false
    private var scribbleBlockers: [UIScribbleInteraction] = []
    private var offsetObservation: NSKeyValueObservation?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // On-device handwriting/text recognition for the web app (see TextRecognitionPlugin below).
        bridge?.registerPluginInstance(TextRecognitionPlugin())
        // On-device speech recognition for recordings and audio files (see SpeechRecognitionPlugin below).
        bridge?.registerPluginInstance(SpeechRecognitionPlugin())
        // Turn a note into a PDF and open the share sheet (see PdfSharePlugin below).
        bridge?.registerPluginInstance(PdfSharePlugin())
        // Things shared to ReconNotes (share sheet / Open in…), see ShareInboxPlugin below.
        bridge?.registerPluginInstance(ShareInboxPlugin())
        bridge?.registerPluginInstance(ScribblePlugin())
        Self.current = self
        guard let webView = webView else { return }
        installScribbleBlocker(in: webView)
        // WebKit can create its content view lazily; check again once the page has loaded.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self = self, !self.scribbleEnabled else { return }
            self.installScribbleBlocker(in: webView)
        }
        let pencil = UIPencilInteraction()
        pencil.delegate = self
        webView.addInteraction(pencil)
        // Let the web app draw edge-to-edge and handle Pencil input itself.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // The app's panels scroll inside the page; the page itself must never
        // move. iOS otherwise slides it up when the keyboard or Scribble
        // appears, taking the toolbars out of view.
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        offsetObservation = webView.scrollView.observe(\.contentOffset, options: [.new]) { scrollView, _ in
            guard scrollView.zoomScale <= 1.01, scrollView.contentOffset != .zero else { return }
            scrollView.contentOffset = .zero
        }
        webView.allowsLinkPreview = false
    }

    // MARK: - Scribble

    /// Attach a UIScribbleInteraction whose delegate vetoes Scribble to
    /// WebKit's content view (the view that hosts editable text). It has to
    /// be removed again for Scribble to work: while attached it takes over
    /// from WebKit's own Scribble support even when it allows it.
    private func installScribbleBlocker(in webView: WKWebView) {
        let candidates = [webView.scrollView] + webView.scrollView.subviews.filter {
            String(describing: type(of: $0)).hasPrefix("WKContent")
        }
        for view in candidates where !scribbleBlockers.contains(where: { $0.view === view }) {
            let blocker = UIScribbleInteraction(delegate: self)
            view.addInteraction(blocker)
            scribbleBlockers.append(blocker)
        }
    }

    private func removeScribbleBlockers() {
        for blocker in scribbleBlockers { blocker.view?.removeInteraction(blocker) }
        scribbleBlockers.removeAll()
    }

    func setScribbleEnabled(_ enabled: Bool) {
        scribbleEnabled = enabled
        if enabled { removeScribbleBlockers() } else if let webView = webView { installScribbleBlocker(in: webView) }
    }

    func scribbleInteraction(_ interaction: UIScribbleInteraction, shouldBeginAt location: CGPoint) -> Bool {
        false
    }

    // MARK: - UIPencilInteractionDelegate

    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        send(kind: "tap", action: Self.name(of: UIPencilInteraction.preferredTapAction), location: tap.hoverPose?.location, in: interaction.view)
    }

    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        // Fire once, when the squeeze completes (like Apple Notes).
        guard squeeze.phase == .ended else { return }
        send(kind: "squeeze", action: Self.name(of: UIPencilInteraction.preferredSqueezeAction), location: squeeze.hoverPose?.location, in: interaction.view)
    }

    /// Pre-iOS 17.5 double-tap callback.
    func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        if #available(iOS 17.5, *) { return } // handled by didReceiveTap
        send(kind: "tap", action: Self.name(of: UIPencilInteraction.preferredTapAction), location: nil, in: nil)
    }

    private static func name(of action: UIPencilPreferredAction) -> String {
        switch action {
        case .ignore: return "ignore"
        case .switchEraser: return "switchEraser"
        case .switchPrevious: return "switchPrevious"
        case .showColorPalette: return "showColorPalette"
        default:
            if #available(iOS 16.0, *), action == .showInkAttributes { return "showInkAttributes" }
            if #available(iOS 17.5, *), action == .showContextualPalette { return "showColorPalette" }
            if #available(iOS 17.5, *), action == .runSystemShortcut { return "ignore" }
            return "switchEraser"
        }
    }

    private func send(kind: String, action: String, location: CGPoint?, in view: UIView?) {
        guard let webView = webView else { return }
        var detail: [String: Any] = ["kind": kind, "action": action]
        if let location = location, let view = view {
            let p = view.convert(location, to: webView)
            detail["x"] = p.x
            detail["y"] = p.y
        }
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('reconnotes:pencil', { detail: \(json) }))")
    }
}

// MARK: - On-device text recognition

/// Exposes Apple's Vision text recognizer to the web app as the
/// `TextRecognition` Capacitor plugin (see apps/web/src/lib/deviceOcr.ts).
///
///     TextRecognition.recognize({ image: <base64 PNG/JPEG>, languages?: ["en-US"] })
///       → { lines: [{ text, confidence, x, y, w, h }], width, height }
///
/// Boxes are normalised (0–1) with the origin at the top-left. Recognition
/// runs on the device, works offline and handles handwriting.
@objc(TextRecognitionPlugin)
public class TextRecognitionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TextRecognitionPlugin"
    public let jsName = "TextRecognition"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "recognize", returnType: CAPPluginReturnPromise)
    ]

    @objc func recognize(_ call: CAPPluginCall) {
        guard let base64 = call.getString("image"),
              let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters),
              let image = UIImage(data: data),
              let cgImage = image.cgImage else {
            call.reject("Could not read the image")
            return
        }
        let languages = (call.getArray("languages") as? [String]) ?? []

        let request = VNRecognizeTextRequest { request, error in
            if let error = error {
                call.reject(error.localizedDescription)
                return
            }
            let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
            let lines: [[String: Any]] = observations.compactMap { observation in
                guard let best = observation.topCandidates(1).first else { return nil }
                let box = observation.boundingBox // normalised, origin bottom-left
                return [
                    "text": best.string,
                    "confidence": Double(best.confidence),
                    "x": Double(box.minX),
                    "y": Double(1 - box.maxY),
                    "w": Double(box.width),
                    "h": Double(box.height),
                ]
            }
            call.resolve(["lines": lines, "width": cgImage.width, "height": cgImage.height])
        }
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        if !languages.isEmpty {
            request.recognitionLanguages = languages
        } else if #available(iOS 16.0, *) {
            request.automaticallyDetectsLanguage = true
        }

        let orientation = CGImagePropertyOrientation(image.imageOrientation)
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try VNImageRequestHandler(cgImage: cgImage, orientation: orientation, options: [:]).perform([request])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }
}

/// Transcribes recordings and audio files with Apple's speech recognizer,
/// on the device when the language supports it (private, free, offline):
///     SpeechRecognition.transcribe({ audio: <base64>, ext: 'm4a' }) → { text, onDevice }
@objc(SpeechRecognitionPlugin)
public class SpeechRecognitionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SpeechRecognitionPlugin"
    public let jsName = "SpeechRecognition"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "transcribe", returnType: CAPPluginReturnPromise)
    ]
    /// Running recognitions (kept alive until they finish).
    private var tasks: [UUID: SFSpeechRecognitionTask] = [:]

    @objc func transcribe(_ call: CAPPluginCall) {
        guard let base64 = call.getString("audio"),
              let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
            call.reject("Could not read the audio")
            return
        }
        let ext = call.getString("ext") ?? "m4a"
        let id = UUID()
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(id.uuidString).appendingPathExtension(ext)
        do {
            try data.write(to: url)
        } catch {
            call.reject("Could not save the audio: \(error.localizedDescription)")
            return
        }
        let cleanup = { [weak self] in
            try? FileManager.default.removeItem(at: url)
            DispatchQueue.main.async { self?.tasks[id] = nil }
        }

        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else {
                    cleanup()
                    call.reject("Speech recognition is turned off for ReconNotes. Allow it in Settings › Privacy & Security › Speech Recognition.")
                    return
                }
                let locale = call.getString("locale").map { Locale(identifier: $0) } ?? Locale.current
                guard let recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer(), recognizer.isAvailable else {
                    cleanup()
                    call.reject("Speech recognition isn't available for this language right now.")
                    return
                }
                let request = SFSpeechURLRecognitionRequest(url: url)
                request.shouldReportPartialResults = false
                request.taskHint = .dictation
                // On the device: private, works offline, and no 1-minute limit.
                let onDevice = recognizer.supportsOnDeviceRecognition
                request.requiresOnDeviceRecognition = onDevice
                if #available(iOS 16.0, *) { request.addsPunctuation = true }

                var done = false
                self.tasks[id] = recognizer.recognitionTask(with: request) { result, error in
                    if done { return }
                    if let result = result, result.isFinal {
                        done = true
                        cleanup()
                        call.resolve(["text": result.bestTranscription.formattedString, "onDevice": onDevice])
                    } else if let error = error {
                        done = true
                        cleanup()
                        // 1110: no speech found in the recording
                        if (error as NSError).code == 1110 {
                            call.resolve(["text": "", "onDevice": onDevice])
                        } else {
                            call.reject(error.localizedDescription)
                        }
                    }
                }
            }
        }
    }
}

/// Turns a note (as a self-contained HTML page) into a paginated PDF and
/// opens the share sheet – Save to Files, Mail, Print, AirDrop…
///     PdfShare.share({ html, fileName }) → { completed }
@objc(PdfSharePlugin)
public class PdfSharePlugin: CAPPlugin, CAPBridgedPlugin, WKNavigationDelegate {
    public let identifier = "PdfSharePlugin"
    public let jsName = "PdfShare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise)
    ]
    private var renderView: WKWebView?
    private var pending: CAPPluginCall?
    private var fileName = "Note"

    @objc func share(_ call: CAPPluginCall) {
        guard let html = call.getString("html") else {
            call.reject("Nothing to share")
            return
        }
        DispatchQueue.main.async {
            self.pending?.reject("Replaced by a newer request")
            self.pending = call
            self.fileName = call.getString("fileName") ?? "Note"
            let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 600, height: 800))
            view.navigationDelegate = self
            self.renderView = view
            view.loadHTMLString(html, baseURL: nil)
        }
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // give pictures a moment to decode before laying out the pages
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.makePdf(from: webView) }
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        pending?.reject(error.localizedDescription)
        pending = nil
        renderView = nil
    }

    private func makePdf(from webView: WKWebView) {
        guard let call = pending else { return }
        pending = nil
        // A4, or US Letter in the US and Canada
        let region = (Locale.current as NSLocale).object(forKey: .countryCode) as? String ?? ""
        let paper = ["US", "CA"].contains(region) ? CGRect(x: 0, y: 0, width: 612, height: 792) : CGRect(x: 0, y: 0, width: 595, height: 842)
        let renderer = UIPrintPageRenderer()
        renderer.addPrintFormatter(webView.viewPrintFormatter(), startingAtPageAt: 0)
        renderer.setValue(NSValue(cgRect: paper), forKey: "paperRect")
        renderer.setValue(NSValue(cgRect: paper.insetBy(dx: 42, dy: 48)), forKey: "printableRect")
        let data = NSMutableData()
        UIGraphicsBeginPDFContextToData(data, paper, nil)
        renderer.prepare(forDrawingPages: NSRange(location: 0, length: renderer.numberOfPages))
        for page in 0..<renderer.numberOfPages {
            UIGraphicsBeginPDFPage()
            renderer.drawPage(at: page, in: UIGraphicsGetPDFContextBounds())
        }
        UIGraphicsEndPDFContext()
        renderView = nil

        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(fileName).pdf")
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            call.reject("Couldn't save the PDF: \(error.localizedDescription)")
            return
        }
        guard let presenter = bridge?.viewController else {
            call.reject("Nothing to show the share sheet on")
            return
        }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let popover = sheet.popoverPresentationController {
            // iPad: the sheet points at the top right, where the ⋯ menu is
            popover.sourceView = presenter.view
            popover.sourceRect = CGRect(x: presenter.view.bounds.maxX - 40, y: presenter.view.safeAreaInsets.top + 30, width: 1, height: 1)
            popover.permittedArrowDirections = [.up]
        }
        sheet.completionWithItemsHandler = { _, completed, _, _ in call.resolve(["completed": completed]) }
        presenter.present(sheet, animated: true)
    }
}

/// Things shared to ReconNotes wait in an inbox until the app turns them
/// into a note: from the Share Extension (via the App Group container) and
/// from "Open in / Copy to ReconNotes" (the app's own Library folder).
///
/// Each share is a folder holding `share.json` and any files:
///     { id, createdAt, title?, items: [{ kind: "url" | "text" | "file", url?, text?, name?, mime?, file? }] }
///
///     ShareInbox.take() → { shares: [{ …share.json, dir }] }
///     ShareInbox.remove({ ids })
@objc(ShareInboxPlugin)
public class ShareInboxPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShareInboxPlugin"
    public let jsName = "ShareInbox"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]

    static var appGroup: String {
        Bundle.main.object(forInfoDictionaryKey: "ReconAppGroup") as? String ?? "group.com.reconnotes.app"
    }

    static var localInbox: URL {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0].appendingPathComponent("ShareInbox", isDirectory: true)
    }

    static var inboxes: [URL] {
        var dirs = [localInbox]
        if let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) {
            dirs.append(group.appendingPathComponent("ShareInbox", isDirectory: true))
        }
        return dirs
    }

    /// Copy opened files into the inbox as one share.
    static func importFiles(_ urls: [URL]) {
        guard !urls.isEmpty else { return }
        let id = UUID().uuidString
        let dir = localInbox.appendingPathComponent(id, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var items: [[String: Any]] = []
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let name = url.lastPathComponent
            let dest = dir.appendingPathComponent(name)
            do {
                try FileManager.default.copyItem(at: url, to: dest)
                let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                items.append(["kind": "file", "name": name, "mime": mime, "file": name])
            } catch {
                NSLog("ReconNotes: couldn't import \(url): \(error)")
            }
        }
        let share: [String: Any] = ["id": id, "createdAt": Date().timeIntervalSince1970 * 1000, "items": items]
        if let data = try? JSONSerialization.data(withJSONObject: share) {
            try? data.write(to: dir.appendingPathComponent("share.json"))
        }
    }

    @objc func take(_ call: CAPPluginCall) {
        var shares: [[String: Any]] = []
        for inbox in Self.inboxes {
            let dirs = (try? FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)) ?? []
            for dir in dirs {
                guard let data = try? Data(contentsOf: dir.appendingPathComponent("share.json")),
                      var share = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                share["dir"] = dir.path
                shares.append(share)
            }
        }
        call.resolve(["shares": shares])
    }

    @objc func remove(_ call: CAPPluginCall) {
        let ids = call.getArray("ids", String.self) ?? []
        for inbox in Self.inboxes {
            for id in ids where !id.contains("/") && !id.contains("..") {
                try? FileManager.default.removeItem(at: inbox.appendingPathComponent(id, isDirectory: true))
            }
        }
        call.resolve()
    }
}

extension CGImagePropertyOrientation {
    /// Photos keep their rotation in EXIF; tell Vision which way is up.
    init(_ orientation: UIImage.Orientation) {
        switch orientation {
        case .up: self = .up
        case .down: self = .down
        case .left: self = .left
        case .right: self = .right
        case .upMirrored: self = .upMirrored
        case .downMirrored: self = .downMirrored
        case .leftMirrored: self = .leftMirrored
        case .rightMirrored: self = .rightMirrored
        @unknown default: self = .up
        }
    }
}

/// Lets the web app turn iPadOS Scribble on or off:
///     Scribble.setEnabled({ enabled: false })
@objc(ScribblePlugin)
public class ScribblePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScribblePlugin"
    public let jsName = "Scribble"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setEnabled", returnType: CAPPluginReturnPromise)
    ]

    @objc func setEnabled(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        DispatchQueue.main.async {
            ReconBridgeViewController.current?.setScribbleEnabled(enabled)
            call.resolve()
        }
    }
}
