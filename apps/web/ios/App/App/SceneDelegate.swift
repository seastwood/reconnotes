import UIKit
import WebKit
import Vision
import Speech
import UniformTypeIdentifiers
import QuickLook
import VisionKit
import AppIntents
import AVFoundation
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
        // …or with a reconnotes:// link (widget, Shortcuts, setup link)
        connectionOptions.urlContexts.map(\.url).filter { !$0.isFileURL }.forEach(AppLinksPlugin.open)

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        let files = URLContexts.map(\.url).filter(\.isFileURL)
        if !files.isEmpty {
            ShareInboxPlugin.importFiles(files)
            (window?.rootViewController as? CAPBridgeViewController)?.bridge?.triggerWindowJSEvent(eventName: "reconnotes:share-inbox")
        }
        URLContexts.map(\.url).filter { !$0.isFileURL }.forEach(AppLinksPlugin.open)
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
        // Open attached files in Quick Look / share them (see FilePreviewPlugin below).
        bridge?.registerPluginInstance(FilePreviewPlugin())
        bridge?.registerPluginInstance(ScribblePlugin())
        // Scan paper documents with the camera (see DocumentScannerPlugin below).
        bridge?.registerPluginInstance(DocumentScannerPlugin())
        // reconnotes:// links from the widget, Siri / Shortcuts and setup links (see AppLinksPlugin below).
        bridge?.registerPluginInstance(AppLinksPlugin())
        // Recordings that keep going with the screen locked (see AudioRecorderPlugin below).
        bridge?.registerPluginInstance(AudioRecorderPlugin())
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
        // No ˄ ˅ ✓ bar above the keyboard: it takes a lot of room and the app
        // has its own Done/back buttons. WebKit can swap its content view, so
        // check again whenever the keyboard is about to appear.
        hideKeyboardAccessoryBar(in: webView)
        NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { [weak self] _ in
            guard let webView = self?.webView else { return }
            self?.hideKeyboardAccessoryBar(in: webView)
        }
    }

    // MARK: - Keyboard accessory bar

    /// WebKit's content view supplies the form accessory bar through
    /// `inputAccessoryView`. Give it a subclass that returns nil instead (the
    /// same thing Capacitor's Keyboard plugin and Cordova do).
    private func hideKeyboardAccessoryBar(in webView: WKWebView) {
        for view in webView.scrollView.subviews where String(describing: type(of: view)).hasPrefix("WKContent") {
            let base: AnyClass = type(of: view)
            let baseName = String(cString: class_getName(base))
            if baseName.hasSuffix("_NoAccessoryBar") { continue }
            let name = baseName + "_NoAccessoryBar"
            var subclass: AnyClass? = NSClassFromString(name)
            if subclass == nil, let made = objc_allocateClassPair(base, name, 0) {
                let selector = #selector(getter: UIResponder.inputAccessoryView)
                let none: @convention(block) (AnyObject) -> AnyObject? = { _ in nil }
                if let method = class_getInstanceMethod(base, selector) {
                    class_addMethod(made, selector, imp_implementationWithBlock(none), method_getTypeEncoding(method))
                }
                objc_registerClassPair(made)
                subclass = made
            }
            if let subclass = subclass {
                object_setClass(view, subclass)
                view.reloadInputViews()
            }
        }
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
///       → { lines: [{ text, confidence, x, y, w, h, words: [{ text, x, y, w, h }] }], width, height }
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
                // each word's own box, for highlighting search matches in pictures
                var words: [[String: Any]] = []
                let text = best.string
                text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: .byWords) { word, range, _, _ in
                    guard let word = word, let wordBox = (try? best.boundingBox(for: range))?.boundingBox else { return }
                    words.append([
                        "text": word,
                        "x": Double(wordBox.minX),
                        "y": Double(1 - wordBox.maxY),
                        "w": Double(wordBox.width),
                        "h": Double(wordBox.height),
                    ])
                }
                return [
                    "words": words,
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
                // Partial results are needed to keep the whole recording: on the
                // device, recognition starts over after each pause and the final
                // result only holds the last stretch.
                request.shouldReportPartialResults = true
                request.taskHint = .dictation
                // On the device: private, works offline, and no 1-minute limit.
                let onDevice = recognizer.supportsOnDeviceRecognition
                request.requiresOnDeviceRecognition = onDevice
                if #available(iOS 16.0, *) { request.addsPunctuation = true }

                var done = false
                var finished: [String] = [] // stretches recognition has moved on from
                var current = ""
                var currentStart: TimeInterval = -1
                let whole = { () -> String in (finished + [current]).filter { !$0.isEmpty }.joined(separator: " ") }
                self.tasks[id] = recognizer.recognitionTask(with: request) { result, error in
                    if done { return }
                    if let result = result {
                        let text = result.bestTranscription.formattedString
                        let start = result.bestTranscription.segments.first?.timestamp ?? 0
                        // A later stretch of the recording: keep the previous one. Seen
                        // either by its start time (when the timings are known) or by
                        // the text starting over shorter and with a different word.
                        let firstWord = { (t: String) in t.split(separator: " ").first.map { $0.lowercased() } ?? "" }
                        let movedOn = start > currentStart + 0.5 || (text.count < current.count && firstWord(text) != firstWord(current))
                        if !current.isEmpty && movedOn && !text.hasPrefix(current) {
                            finished.append(current)
                        }
                        current = text
                        currentStart = start
                        if result.isFinal {
                            done = true
                            cleanup()
                            call.resolve(["text": whole(), "onDevice": onDevice])
                            return
                        }
                    }
                    if let error = error {
                        done = true
                        cleanup()
                        let soFar = whole()
                        if !soFar.isEmpty {
                            call.resolve(["text": soFar, "onDevice": onDevice]) // keep what was recognised
                        } else if (error as NSError).code == 1110 {
                            call.resolve(["text": "", "onDevice": onDevice]) // no speech in the recording
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

/// Shows an attached file with Quick Look (PDF, Word, Excel, Pages, Numbers,
/// Keynote, text, pictures…) or hands it to the share sheet:
///     FilePreview.open({ data: <base64>, name })
///     FilePreview.share({ data: <base64>, name })
@objc(FilePreviewPlugin)
public class FilePreviewPlugin: CAPPlugin, CAPBridgedPlugin, QLPreviewControllerDataSource {
    public let identifier = "FilePreviewPlugin"
    public let jsName = "FilePreview"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise),
    ]
    private var previewURL: URL?

    /// Write the file to a temporary folder under its own name (Quick Look and other apps go by the extension).
    private func temporaryFile(_ call: CAPPluginCall) -> URL? {
        guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else {
            call.reject("Could not read the file")
            return nil
        }
        let name = (call.getString("name") ?? "File").replacingOccurrences(of: "/", with: "-")
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(name)
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            call.reject("Could not save the file: \(error.localizedDescription)")
            return nil
        }
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let url = temporaryFile(call) else { return }
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else { return call.reject("Nothing to show the file on") }
            self.previewURL = url
            let preview = QLPreviewController()
            preview.dataSource = self
            presenter.present(preview, animated: true)
            call.resolve()
        }
    }

    @objc func share(_ call: CAPPluginCall) {
        guard let url = temporaryFile(call) else { return }
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else { return call.reject("Nothing to show the share sheet on") }
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let popover = sheet.popoverPresentationController {
                popover.sourceView = presenter.view
                popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
                popover.permittedArrowDirections = []
            }
            sheet.completionWithItemsHandler = { _, _, _, _ in call.resolve() }
            presenter.present(sheet, animated: true)
        }
    }

    public func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
        previewURL == nil ? 0 : 1
    }

    public func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        (previewURL ?? URL(fileURLWithPath: "/")) as NSURL
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


// MARK: - Document scanner

/// Apple's document scanner (the one in Notes and Files): finds the page,
/// crops and straightens it, several pages in a row.
///
///     DocumentScanner.scan() → { pages: [<base64 JPEG>], title }   (pages: [] if cancelled)
@objc(DocumentScannerPlugin)
public class DocumentScannerPlugin: CAPPlugin, CAPBridgedPlugin, VNDocumentCameraViewControllerDelegate {
    public let identifier = "DocumentScannerPlugin"
    public let jsName = "DocumentScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
    ]
    private var pending: CAPPluginCall?

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": VNDocumentCameraViewController.isSupported])
    }

    @objc func scan(_ call: CAPPluginCall) {
        guard VNDocumentCameraViewController.isSupported else {
            call.reject("Document scanning isn’t available on this device.")
            return
        }
        DispatchQueue.main.async {
            self.pending = call
            let scanner = VNDocumentCameraViewController()
            scanner.delegate = self
            self.bridge?.viewController?.present(scanner, animated: true)
        }
    }

    public func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
        let call = pending
        pending = nil
        controller.dismiss(animated: true)
        DispatchQueue.global(qos: .userInitiated).async {
            var pages: [String] = []
            for i in 0..<scan.pageCount {
                let image = Self.downscaled(scan.imageOfPage(at: i), longest: 2400)
                if let data = image.jpegData(compressionQuality: 0.82) { pages.append(data.base64EncodedString()) }
            }
            call?.resolve(["pages": pages, "title": scan.title])
        }
    }

    public func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
        controller.dismiss(animated: true)
        pending?.resolve(["pages": [], "title": ""])
        pending = nil
    }

    public func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
        controller.dismiss(animated: true)
        pending?.reject(error.localizedDescription)
        pending = nil
    }

    private static func downscaled(_ image: UIImage, longest: CGFloat) -> UIImage {
        let size = image.size
        let scale = min(1, longest / max(size.width, size.height))
        if scale >= 1 { return image }
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
    }
}


// MARK: - reconnotes:// links, Siri and Shortcuts

/// Links that start something in the app – from the Home Screen widget,
/// Siri / the Shortcuts app, or a setup link:
///
///     reconnotes://new[?text=…]   reconnotes://record   reconnotes://scan
///     reconnotes://open?note=<id> reconnotes://search?q=…
///     reconnotes://connect?data=…
///
/// They wait here until the web app takes them (it may still be starting),
/// and the web app is told when one arrives.
@objc(AppLinksPlugin)
public class AppLinksPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppLinksPlugin"
    public let jsName = "AppLinks"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise),
    ]
    private static var pending: [String] = []

    /// Open a link from a note outside the app: web pages in Safari,
    /// mailto:/tel:/maps links in their apps.
    @objc func openExternal(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(), ["http", "https", "mailto", "tel", "sms", "maps", "facetime"].contains(scheme) else {
            call.reject("Not a link that can be opened")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { ok in
                ok ? call.resolve() : call.reject("Couldn't open the link")
            }
        }
    }
    private static let lock = NSLock()

    static func open(_ url: URL) {
        guard url.scheme?.lowercased() == "reconnotes" else { return }
        lock.lock()
        pending.append(url.absoluteString)
        lock.unlock()
        DispatchQueue.main.async {
            ReconBridgeViewController.current?.bridge?.triggerWindowJSEvent(eventName: "reconnotes:app-link")
        }
    }

    @objc func take(_ call: CAPPluginCall) {
        Self.lock.lock()
        let urls = Self.pending
        Self.pending = []
        Self.lock.unlock()
        call.resolve(["urls": urls])
    }
}

/// "New note in ReconNotes", "Record a ReconNotes voice note", "Scan into
/// ReconNotes" – for Siri, Spotlight, the Action button and the Shortcuts app.
@available(iOS 16.0, *)
struct NewNoteIntent: AppIntent {
    static var title: LocalizedStringResource = "New Note"
    static var description = IntentDescription("Start a new note in ReconNotes, optionally with some text in it.")
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Text")
    var text: String?

    @MainActor
    func perform() async throws -> some IntentResult {
        var link = URLComponents(string: "reconnotes://new")!
        if let text = text, !text.isEmpty { link.queryItems = [URLQueryItem(name: "text", value: text)] }
        if let url = link.url { AppLinksPlugin.open(url) }
        return .result()
    }
}

@available(iOS 16.0, *)
struct RecordVoiceNoteIntent: AppIntent {
    static var title: LocalizedStringResource = "Record a Voice Note"
    static var description = IntentDescription("Start a new note and begin recording.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        AppLinksPlugin.open(URL(string: "reconnotes://record")!)
        return .result()
    }
}

@available(iOS 16.0, *)
struct ScanDocumentIntent: AppIntent {
    static var title: LocalizedStringResource = "Scan a Document"
    static var description = IntentDescription("Scan paper pages into a new note.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        AppLinksPlugin.open(URL(string: "reconnotes://scan")!)
        return .result()
    }
}

@available(iOS 16.0, *)
struct ReconNotesShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: NewNoteIntent(),
            phrases: ["New note in \(.applicationName)", "Start a \(.applicationName) note", "Take a note in \(.applicationName)"],
            shortTitle: "New Note",
            systemImageName: "square.and.pencil"
        )
        AppShortcut(
            intent: RecordVoiceNoteIntent(),
            phrases: ["Record a \(.applicationName) voice note", "Record in \(.applicationName)"],
            shortTitle: "Record",
            systemImageName: "mic"
        )
        AppShortcut(
            intent: ScanDocumentIntent(),
            phrases: ["Scan into \(.applicationName)", "Scan a document with \(.applicationName)"],
            shortTitle: "Scan",
            systemImageName: "doc.viewfinder"
        )
    }
}


// MARK: - Audio recorder

/// Records audio natively (like Voice Memos), so a recording keeps going when
/// the screen locks or you switch apps – a web page's microphone is cut off
/// then. The screen is also kept from dimming and locking while recording.
///
///     AudioRecorder.start() → { startedAt }
///     AudioRecorder.stop()  → { path, startedAt, endedAt, mime }   (an .m4a file; read it with Capacitor.convertFileSrc)
///     AudioRecorder.status() → { recording, startedAt }
///     AudioRecorder.remove({ path })
@objc(AudioRecorderPlugin)
public class AudioRecorderPlugin: CAPPlugin, CAPBridgedPlugin, AVAudioRecorderDelegate {
    public let identifier = "AudioRecorderPlugin"
    public let jsName = "AudioRecorder"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private var recorder: AVAudioRecorder?
    private var fileURL: URL?
    private var startedAt: Date?

    private static func millis(_ d: Date) -> Double { d.timeIntervalSince1970 * 1000 }

    private func askPermission(_ done: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission { granted in DispatchQueue.main.async { done(granted) } }
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission { granted in DispatchQueue.main.async { done(granted) } }
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        if let r = recorder, r.isRecording, let at = startedAt {
            return call.resolve(["startedAt": Self.millis(at)])
        }
        askPermission { granted in
            guard granted else {
                return call.reject("Microphone access was denied. Allow it in Settings › ReconNotes › Microphone.", "denied")
            }
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
                try session.setActive(true)
                let url = FileManager.default.temporaryDirectory.appendingPathComponent("recording-\(UUID().uuidString).m4a")
                let settings: [String: Any] = [
                    AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                    AVSampleRateKey: 44100,
                    AVNumberOfChannelsKey: 1,
                    AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
                ]
                let r = try AVAudioRecorder(url: url, settings: settings)
                r.delegate = self
                guard r.record() else { return call.reject("The recording couldn’t start.") }
                let now = Date()
                self.recorder = r
                self.fileURL = url
                self.startedAt = now
                // don't let the screen dim and lock while recording
                UIApplication.shared.isIdleTimerDisabled = true
                call.resolve(["startedAt": Self.millis(now)])
            } catch {
                call.reject("The recording couldn’t start: \(error.localizedDescription)")
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let r = self.recorder, let url = self.fileURL, let at = self.startedAt else {
                return call.reject("Not recording.", "not-recording")
            }
            r.stop()
            self.recorder = nil
            self.fileURL = nil
            self.startedAt = nil
            UIApplication.shared.isIdleTimerDisabled = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            call.resolve(["path": url.path, "startedAt": Self.millis(at), "endedAt": Self.millis(Date()), "mime": "audio/mp4"])
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let r = self.recorder, r.isRecording, let at = self.startedAt {
                call.resolve(["recording": true, "startedAt": Self.millis(at)])
            } else {
                call.resolve(["recording": false])
            }
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        if let path = call.getString("path"), path.hasPrefix(FileManager.default.temporaryDirectory.path) {
            try? FileManager.default.removeItem(atPath: path)
        }
        call.resolve()
    }

    /// iOS stopped it (e.g. another app took the microphone): the app saves what was recorded.
    public func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        if self.recorder === recorder {
            notifyListeners("interrupted", data: ["successfully": flag])
        }
    }
}
