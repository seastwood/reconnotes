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

    /// Whether iPadOS Scribble (handwriting → typed text) may run in the
    /// notes. Off by default so Pencil writing stays ink; the web app changes
    /// it through the Scribble plugin when the user picks "Use Scribble".
    static var scribbleEnabled = false
    /// Where Scribble must never start, even when enabled: drawings and
    /// pictures on screen, in web view points (= CSS pixels). Kept up to date
    /// by the web app as the page scrolls and changes.
    static var scribbleBlockedRects: [CGRect] = []
    private var scribbleBlockers: [UIScribbleInteraction] = []

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // On-device handwriting/text recognition for the web app (see TextRecognitionPlugin below).
        bridge?.registerPluginInstance(TextRecognitionPlugin())
        bridge?.registerPluginInstance(ScribblePlugin())
        guard let webView = webView else { return }
        installScribbleBlocker(in: webView)
        // WebKit can create its content view lazily; check again once the page has loaded.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.installScribbleBlocker(in: webView) }
        let pencil = UIPencilInteraction()
        pencil.delegate = self
        webView.addInteraction(pencil)
        // Let the web app draw edge-to-edge and handle Pencil input itself.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsLinkPreview = false
    }

    // MARK: - Scribble

    /// Attach a UIScribbleInteraction whose delegate can veto Scribble to
    /// WebKit's content view (the view that hosts editable text).
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

    func scribbleInteraction(_ interaction: UIScribbleInteraction, shouldBeginAt location: CGPoint) -> Bool {
        guard Self.scribbleEnabled else { return false }
        // Writing in a drawing stays ink; writing over typed text uses Scribble.
        guard let webView = webView, let view = interaction.view else { return true }
        let point = view.convert(location, to: webView)
        return !Self.scribbleBlockedRects.contains { $0.insetBy(dx: -8, dy: -8).contains(point) }
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

/// Lets the web app turn iPadOS Scribble on or off, and mark the areas
/// (drawings, pictures) where it must not start:
///     Scribble.setEnabled({ enabled: false })
///     Scribble.setBlockedRegions({ rects: [{ x, y, w, h }] })
@objc(ScribblePlugin)
public class ScribblePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScribblePlugin"
    public let jsName = "Scribble"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBlockedRegions", returnType: CAPPluginReturnPromise)
    ]

    @objc func setEnabled(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        DispatchQueue.main.async {
            ReconBridgeViewController.scribbleEnabled = enabled
            call.resolve()
        }
    }

    @objc func setBlockedRegions(_ call: CAPPluginCall) {
        let list = call.getArray("rects", JSObject.self) ?? []
        let rects = list.map { r -> CGRect in
            func num(_ key: String) -> CGFloat {
                if let n = r[key] as? NSNumber { return CGFloat(n.doubleValue) }
                if let d = r[key] as? Double { return CGFloat(d) }
                if let i = r[key] as? Int { return CGFloat(i) }
                return 0
            }
            return CGRect(x: num("x"), y: num("y"), width: num("w"), height: num("h"))
        }
        DispatchQueue.main.async {
            ReconBridgeViewController.scribbleBlockedRects = rects
            call.resolve()
        }
    }
}
