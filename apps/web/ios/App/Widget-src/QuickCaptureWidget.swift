import WidgetKit
import SwiftUI

/// Home Screen and Lock Screen widget: start a note, a recording or a scan
/// in one tap. Each button opens a reconnotes:// link in the app.

private let newNote = URL(string: "reconnotes://new")!
private let record = URL(string: "reconnotes://record")!
private let scan = URL(string: "reconnotes://scan")!
private let accent = Color(red: 0.88, green: 0.66, blue: 0.0)

struct CaptureEntry: TimelineEntry {
    let date: Date
}

struct CaptureProvider: TimelineProvider {
    func placeholder(in context: Context) -> CaptureEntry { CaptureEntry(date: Date()) }
    func getSnapshot(in context: Context, completion: @escaping (CaptureEntry) -> Void) { completion(CaptureEntry(date: Date())) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<CaptureEntry>) -> Void) {
        completion(Timeline(entries: [CaptureEntry(date: Date())], policy: .never))
    }
}

private struct CaptureButton: View {
    let url: URL
    let symbol: String
    let label: String

    var body: some View {
        Link(destination: url) {
            VStack(spacing: 6) {
                Image(systemName: symbol)
                    .font(.system(size: 22, weight: .semibold))
                    .frame(width: 48, height: 48)
                    .background(accent.opacity(0.22), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .foregroundStyle(accent)
                Text(label).font(.caption).foregroundStyle(.primary)
            }
            .frame(maxWidth: .infinity)
        }
    }
}

struct QuickCaptureView: View {
    @Environment(\.widgetFamily) private var family
    let entry: CaptureEntry

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "square.and.pencil").font(.title2)
            }
            .widgetURL(newNote)
            .widgetBackground(.clear)
        case .accessoryRectangular:
            HStack(spacing: 8) {
                Image(systemName: "square.and.pencil").font(.title3)
                VStack(alignment: .leading) {
                    Text("ReconNotes").font(.headline)
                    Text("New note").font(.caption)
                }
            }
            .widgetURL(newNote)
            .widgetBackground(.clear)
        case .systemSmall:
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(accent)
                Spacer()
                Text("New note").font(.headline)
                Text("ReconNotes").font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .widgetURL(newNote)
            .widgetBackground(Color(.systemBackground))
        default:
            VStack(alignment: .leading, spacing: 10) {
                Text("ReconNotes").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    CaptureButton(url: newNote, symbol: "square.and.pencil", label: "Note")
                    CaptureButton(url: record, symbol: "mic.fill", label: "Record")
                    CaptureButton(url: scan, symbol: "doc.viewfinder", label: "Scan")
                }
            }
            .widgetBackground(Color(.systemBackground))
        }
    }
}

extension View {
    /// iOS 17 wants widgets to declare their background.
    @ViewBuilder func widgetBackground(_ color: Color) -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            containerBackground(for: .widget) { color }
        } else {
            background(color)
        }
    }
}

struct QuickCaptureWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "QuickCapture", provider: CaptureProvider()) { entry in
            QuickCaptureView(entry: entry)
        }
        .configurationDisplayName("Quick capture")
        .description("Start a note, a recording or a scan in one tap.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
    }
}

@main
struct ReconNotesWidgets: WidgetBundle {
    var body: some Widget {
        QuickCaptureWidget()
    }
}
