import UIKit
import WebKit
import Vision
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = ReconBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
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
