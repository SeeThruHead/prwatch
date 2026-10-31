import SwiftUI

struct SettingsView: View {
  @ObservedObject var watch: Watch
  @State private var snapshot: ConfigSnapshot?
  @State private var loading = true

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Text("Watch rules").font(.system(size: 16, weight: .bold))
        Spacer()
        Button { load() } label: { Label("Reload", systemImage: "arrow.clockwise") }.controlSize(.small)
      }
      if let error = snapshot?.error {
        Label(error, systemImage: "exclamationmark.triangle.fill").font(.system(size: 12)).foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let snapshot {
        location(snapshot)
        Divider()
        rules(snapshot)
      } else if loading {
        ProgressView().controlSize(.small)
      } else {
        Label("Could not read the rules. Is prwatch installed?", systemImage: "questionmark.circle").foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
    }
    .padding(16)
    .frame(width: 560, height: 440)
    .onAppear { load() }
  }

  private func location(_ snapshot: ConfigSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Text("Directory").font(.system(size: 12, weight: .semibold)).frame(width: 70, alignment: .leading)
        Text(snapshot.directory).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        Spacer()
        Button("Open") { watch.reveal(snapshot.directory) }.controlSize(.small)
      }
      HStack(spacing: 8) {
        Text("Machine").font(.system(size: 12, weight: .semibold)).frame(width: 70, alignment: .leading)
        Text(snapshot.machine).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
        Spacer()
      }
      ForEach(snapshot.files) { file in
        HStack(spacing: 8) {
          Image(systemName: file.exists ? "doc.text.fill" : "doc.badge.plus").foregroundStyle(file.exists ? Color.accentColor : Color.secondary)
          Text(file.name).font(.system(size: 12, design: .monospaced))
          Text(file.exists ? "" : "not created yet").font(.system(size: 11)).foregroundStyle(.secondary)
          Spacer()
          Button(file.exists ? "Edit" : "Create") { watch.edit(file) { load() } }.controlSize(.small)
        }
      }
    }
  }

  private func rules(_ snapshot: ConfigSnapshot) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 10) {
        if snapshot.rules.isEmpty {
          Text("No rules yet. Each rule names what to watch, whose it is, and where to tell you.")
            .font(.system(size: 12)).foregroundStyle(.secondary)
        }
        ForEach(snapshot.rules) { entry in
          VStack(alignment: .leading, spacing: 2) {
            HStack {
              Text(entry.rule.name).font(.system(size: 13, weight: .semibold))
              Spacer()
              Text(entry.fileName).font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary)
            }
            Text(entry.summary).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
          }
          .padding(8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.06)))
        }
      }
    }
  }

  private func load() {
    loading = true
    watch.loadConfig { snapshot = $0; loading = false }
  }
}
