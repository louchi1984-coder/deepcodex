import AppKit
import Foundation

struct SetupTest: Codable {
    let id: String
    let label: String
}

let tests: [SetupTest] = [
    .init(id: "connect", label: "连接 DeepSeek"),
    .init(id: "vision", label: "测试读图能力")
]

final class AppDelegate: NSObject, NSApplicationDelegate {
    let root = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? FileManager.default.currentDirectoryPath)
    var window: NSWindow!
    var keyField: NSSecureTextField!
    var button: NSButton!
    var summary: NSTextField!
    var nodeProcess: Process?
    var nodeOutput = Data()
    var lastFailureDetail = ""
    var completedSuccessfully = false
    let port = 18782

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        installMenus()
        buildWindow()
        NSApp.activate(ignoringOtherApps: true)
    }

    func installMenus() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "退出 DeepCodex", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(NSMenuItem(title: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editItem.submenu = editMenu

        NSApp.mainMenu = mainMenu
    }

    func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 250), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "DeepCodex"
        window.center()
        window.isReleasedWhenClosed = false
        window.backgroundColor = NSColor(calibratedRed: 0.96, green: 0.97, blue: 0.98, alpha: 1)
        window.delegate = self

        let content = NSView()
        content.translatesAutoresizingMaskIntoConstraints = false
        window.contentView = content

        let icon = NSImageView()
        icon.image = NSImage(contentsOf: root.appendingPathComponent("assets/codex-deepseek-icon-final.png"))
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.wantsLayer = true
        icon.layer?.cornerRadius = 12

        let title = NSTextField(labelWithString: "DeepCodex")
        title.font = .systemFont(ofSize: 26, weight: .bold)

        let subtitle = NSTextField(labelWithString: "首次需输入 DeepSeek API key，连通后自动保存")
        subtitle.font = .systemFont(ofSize: 14)
        subtitle.textColor = .secondaryLabelColor

        let label = NSTextField(labelWithString: "DeepSeek API key")
        label.font = .systemFont(ofSize: 14, weight: .semibold)

        keyField = NSSecureTextField()
        keyField.placeholderString = "sk-..."
        keyField.font = .systemFont(ofSize: 15)
        keyField.bezelStyle = .roundedBezel
        keyField.controlSize = .large

        button = NSButton(title: "开始测试", target: self, action: #selector(startTests))
        button.bezelStyle = .rounded
        button.controlSize = .large
        button.keyEquivalent = "\r"

        summary = NSTextField(labelWithString: "")
        summary.font = .systemFont(ofSize: 13)
        summary.textColor = .secondaryLabelColor
        summary.alignment = .left
        summary.maximumNumberOfLines = 2
        summary.lineBreakMode = .byTruncatingTail

        let footer = NSTextField(labelWithString: "@娄老师说的对")
        footer.font = .systemFont(ofSize: 13, weight: .semibold)
        footer.textColor = .secondaryLabelColor
        footer.alignment = .right

        [icon, title, subtitle, label, keyField, button, summary, footer].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview($0)
        }

        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 30),
            icon.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            icon.widthAnchor.constraint(equalToConstant: 52),
            icon.heightAnchor.constraint(equalToConstant: 52),
            title.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 16),
            title.topAnchor.constraint(equalTo: icon.topAnchor, constant: 2),
            subtitle.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            subtitle.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 6),
            label.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 30),
            label.topAnchor.constraint(equalTo: icon.bottomAnchor, constant: 22),
            keyField.leadingAnchor.constraint(equalTo: label.leadingAnchor),
            keyField.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 8),
            keyField.heightAnchor.constraint(equalToConstant: 34),
            button.leadingAnchor.constraint(equalTo: keyField.trailingAnchor, constant: 10),
            button.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -30),
            button.centerYAnchor.constraint(equalTo: keyField.centerYAnchor),
            button.widthAnchor.constraint(equalToConstant: 104),
            summary.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 30),
            summary.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -30),
            summary.topAnchor.constraint(equalTo: keyField.bottomAnchor, constant: 18),
            footer.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 30),
            footer.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -30),
            footer.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -20)
        ])

        window.makeKeyAndOrderFront(nil)
        keyField.becomeFirstResponder()
    }

    @objc func startTests() {
        let key = keyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        button.isEnabled = false
        lastFailureDetail = ""
        summary.stringValue = "正在测试 DeepSeek API key..."
        startNodeServer { [weak self] ok in
            guard ok else {
                self?.button.isEnabled = true
                self?.summary.stringValue = "启动测试服务失败"
                return
            }
            self?.runRemoteTests(key: key)
        }
    }

    func startNodeServer(completion: @escaping (Bool) -> Void) {
        let process = Process()
        if let nodeBin = ProcessInfo.processInfo.environment["NODE_BIN"], !nodeBin.isEmpty {
            process.executableURL = URL(fileURLWithPath: nodeBin)
            process.arguments = [root.appendingPathComponent("scripts/deepcodex-setup-ui.mjs").path]
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["node", root.appendingPathComponent("scripts/deepcodex-setup-ui.mjs").path]
        }
        var env = ProcessInfo.processInfo.environment
        env["DEEPCODEX_SETUP_SERVER_ONLY"] = "1"
        env["DEEPCODEX_SETUP_PORT"] = "\(port)"
        env["DEEPCODEX_PROVIDER_PROFILE"] = env["DEEPCODEX_PROVIDER_PROFILE"] ?? root.appendingPathComponent("codex-home-deepseek-app/provider-profile.json").path
        process.environment = env

        let out = Pipe()
        nodeOutput = Data()
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.nodeOutput.append(handle.availableData)
        }
        process.standardOutput = out
        process.standardError = Pipe()
        do {
            try process.run()
            nodeProcess = process
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { completion(true) }
        } catch {
            completion(false)
        }
    }

    func runRemoteTests(key: String) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/run")!)
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["key": key])

        Task { [weak self] in
            do {
                let (bytes, _) = try await URLSession.shared.bytes(for: request)
                for try await line in bytes.lines {
                    self?.handleEventLine(line)
                }
            } catch {
                DispatchQueue.main.async {
                    self?.button.isEnabled = true
                    self?.summary.stringValue = error.localizedDescription
                }
            }
        }
    }

    func handleEventLine(_ line: String) {
        guard let data = line.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }
        DispatchQueue.main.async {
            let id = json["id"] as? String ?? ""
            let detail = json["detail"] as? String ?? json["error"] as? String ?? ""
            if type == "start" {
                self.summary.stringValue = id == "vision" ? "正在测试读图能力..." : "正在测试 DeepSeek API key..."
            }
            if type == "pass" {
                if id == "connect" {
                    self.summary.stringValue = "正在测试读图能力..."
                } else if id == "vision" {
                    self.summary.stringValue = "读图能力测试完成"
                }
            }
            if type == "unsupported" {
                self.lastFailureDetail = detail
                self.summary.stringValue = "当前上游不支持读图，已按文本模式接入"
            }
            if type == "fail" {
                self.lastFailureDetail = detail
                self.summary.stringValue = detail
            }
            if type == "done" {
                let ok = json["ok"] as? Bool ?? false
                self.summary.stringValue = ok ? "连接成功，正在启动 DeepCodex..." : (self.lastFailureDetail.isEmpty ? "连接失败，请检查 API key。" : self.lastFailureDetail)
                if ok {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                        self.finishWithKey()
                    }
                } else {
                    self.button.isEnabled = true
                }
            }
        }
    }

    func finishWithKey() {
        completedSuccessfully = true
        let key = keyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if let data = "\(key)\n".data(using: .utf8) {
            FileHandle.standardOutput.write(data)
        }
        nodeProcess?.terminate()
        exit(0)
    }
}

extension AppDelegate: NSWindowDelegate {
    func windowWillClose(_ notification: Notification) {
        nodeProcess?.terminate()
        if !completedSuccessfully {
            exit(130)
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
