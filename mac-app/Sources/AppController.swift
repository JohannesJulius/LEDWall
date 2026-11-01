import Cocoa
import WebKit
import UniformTypeIdentifiers

/*
 * Fenster, Menü und WebView für das LED Pattern Studio.
 *
 * Die Oberfläche selbst ist die Web-App aus `pattern-studio/` (liegt im Bundle unter
 * Resources/web). Brücke JS -> Swift: window.webkit.messageHandlers.native.postMessage({cmd, id, ...})
 * Antworten Swift -> JS: window.__native.reply(id, obj) und window.__native.updateState(state)
 */
final class AppController: NSObject, NSApplicationDelegate, NSWindowDelegate,
    WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate {

    private var window: NSWindow!
    private var webView: WKWebView!
    private let updater = Updater()
    private let devices = DeviceManager()
    private let udp = UDPSender()
    private let carabiner = CarabinerClient()
    private let lights = LightBridge()
    private var currentFile: URL?
    private var pageReady = false

    private static var supportDir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("LED Pattern Studio", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
    private var autosaveURL: URL { Self.supportDir.appendingPathComponent("autosave.json") }

    // MARK: - App-Lebenszyklus

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        updater.onChange = { [weak self] st in self?.pushUpdateState(st) }
        updater.startAutoCheck()
        devices.onChange = { [weak self] list, fw in self?.pushDevices(list, fw) }
        devices.onLine = { [weak self] port, line in
            self?.callJS("deviceLine", [port, line])
        }
        devices.onFlash = { [weak self] volume, ok, err in
            self?.callJS("flashResult", [["volume": volume, "ok": ok, "error": err]])
        }
        devices.onUpload = { [weak self] port, sent, total, state, err in
            self?.callJS("uploadProgress", [port, sent, total, state, err])
        }
        devices.start()
        carabiner.onStatus = { [weak self] st in
            guard let self else { return }
            // Ohne Start/Stop-Sync (ältere Carabiner-Version) gilt Link als „läuft“
            self.lights.updateClock(connected: st.connected, bpm: st.bpm, beat: st.beat,
                                    playing: st.hasPlaying ? st.playing : true)
            guard let d = try? JSONEncoder().encode(st),
                  let obj = try? JSONSerialization.jsonObject(with: d) else { return }
            self.callJS("link", [obj])
        }
        lights.onState = { [weak self] st in self?.callJS("lights", [st]) }
        if lights.isEnabled {
            lights.startLoop()
            carabiner.setWanted(.lights, true)
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // Nur ein von der App selbst gestartetes Carabiner wieder beenden
    func applicationWillTerminate(_ notification: Notification) {
        lights.stopLoop()
        carabiner.shutdown()
    }

    // Vor dem Beenden den aktuellen Stand aus der Web-Oberfläche sichern
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard pageReady else { return .terminateNow }
        var done = false
        let finish = {
            if done { return }
            done = true
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        webView.evaluateJavaScript("window.__app ? window.__app.snapshot() : null") { [weak self] result, _ in
            if let s = result as? String { self?.writeAutosave(s) }
            finish()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { finish() }
        return .terminateLater
    }

    // MARK: - Fenster

    private func buildWindow() {
        let ucc = WKUserContentController()
        ucc.add(self, name: "native")
        var boot = "window.__NATIVE_APP__ = { version: \(jsString(updater.currentVersion)) };"
        if let saved = try? String(contentsOf: autosaveURL, encoding: .utf8), !saved.isEmpty {
            boot += "window.__NATIVE_AUTOSAVE__ = \(jsString(saved));"
        }
        ucc.addUserScript(WKUserScript(source: boot, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        let config = WKWebViewConfiguration()
        config.userContentController = ucc
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self

        var rect = NSRect(x: 0, y: 0, width: 1440, height: 900)
        if let vis = NSScreen.main?.visibleFrame {
            rect.size.width = min(rect.width, vis.width - 40)
            rect.size.height = min(rect.height, vis.height - 40)
        }
        window = NSWindow(contentRect: rect, styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "LED Pattern Studio"
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(red: 0.067, green: 0.071, blue: 0.086, alpha: 1)
        window.minSize = NSSize(width: 1000, height: 640)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("MainWindow")
        window.makeKeyAndOrderFront(nil)

        if let web = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true) {
            webView.loadFileURL(web.appendingPathComponent("index.html"), allowingReadAccessTo: web)
        }
    }

    // MARK: - Menü

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Über LED Pattern Studio", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(item("Nach Updates suchen …", #selector(menuUpdates), ""))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Einstellungen …", #selector(menuSettings), ","))
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "LED Pattern Studio ausblenden", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Andere ausblenden", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Alle einblenden", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "LED Pattern Studio beenden", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: "Ablage")
        fileMenu.addItem(item("Neues Projekt", #selector(menuNew), "n"))
        fileMenu.addItem(item("Öffnen …", #selector(menuOpen), "o"))
        fileMenu.addItem(.separator())
        fileMenu.addItem(item("Speichern", #selector(menuSave), "s"))
        let saveAs = item("Speichern unter …", #selector(menuSaveAs), "s")
        saveAs.keyEquivalentModifierMask = [.command, .shift]
        fileMenu.addItem(saveAs)
        fileMenu.addItem(.separator())
        fileMenu.addItem(item("Export für Wand …", #selector(menuExport), "e"))
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Fenster schließen", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = fileMenu
        main.addItem(fileItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Bearbeiten")
        editMenu.addItem(item("Widerrufen", #selector(menuUndo), "z"))
        let redo = item("Wiederholen", #selector(menuRedo), "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(redo)
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Ausschneiden", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Kopieren", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Einsetzen", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Alles auswählen", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        let winItem = NSMenuItem()
        let winMenu = NSMenu(title: "Fenster")
        winMenu.addItem(withTitle: "Im Dock ablegen", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "Zoomen", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        let fs = winMenu.addItem(withTitle: "Vollbild", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        winItem.submenu = winMenu
        main.addItem(winItem)
        NSApp.windowsMenu = winMenu

        NSApp.mainMenu = main
    }

    private func item(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        return i
    }

    private func callApp(_ fn: String) {
        webView.evaluateJavaScript("window.__app && window.__app.\(fn)()", completionHandler: nil)
    }

    @objc private func menuNew() { callApp("newProject") }
    @objc private func menuOpen() { callApp("openProject") }
    @objc private func menuSave() { callApp("save") }
    @objc private func menuSaveAs() { callApp("saveAs") }
    @objc private func menuExport() { callApp("exportBank") }
    @objc private func menuUndo() { callApp("undo") }
    @objc private func menuRedo() { callApp("redo") }
    @objc private func menuSettings() { callApp("settings") }
    @objc private func menuUpdates() { callApp("updates") }

    // MARK: - Brücke JS -> Swift

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        let id = (body["id"] as? NSNumber)?.intValue ?? 0
        switch cmd {
        case "autosave":
            if let d = body["data"] as? String { writeAutosave(d) }
        case "saveProject":
            saveProject(id: id, name: body["name"] as? String ?? "Projekt.ledproj.json",
                        data: body["data"] as? String ?? "", saveAs: body["saveAs"] as? Bool ?? false)
        case "saveFile":
            saveFile(id: id, name: body["name"] as? String ?? "Datei", body: body)
        case "openProject":
            openProject(id: id)
        case "fileReset":
            currentFile = nil
            window.title = "LED Pattern Studio"
        case "update":
            switch body["action"] as? String ?? "" {
            case "check": updater.check(manual: true)
            case "install": updater.install()
            case "autoCheck": updater.autoCheck = body["value"] as? Bool ?? true
            default: pushUpdateState(updater.state)
            }
        case "device":
            let port = body["port"] as? String ?? ""
            switch body["action"] as? String ?? "" {
            case "send": devices.send(port: port, text: body["text"] as? String ?? "")
            case "frame":
                if let b64 = body["base64"] as? String, let d = Data(base64Encoded: b64) { devices.sendFrame(port: port, data: d) }
            case "flash": devices.flash(volume: body["volume"] as? String ?? "", variant: body["variant"] as? String ?? "")
            case "touch1200": devices.touch1200(port: port)
            case "upload":
                if let b64 = body["base64"] as? String, let d = Data(base64Encoded: b64) {
                    devices.upload(port: port, data: d, crc: (body["crc"] as? NSNumber)?.uint32Value ?? 0)
                }
            default: devices.pushState()
            }
        case "link":
            // Ableton Link über Carabiner: start / stop
            switch body["action"] as? String ?? "" {
            case "start": carabiner.setWanted(.link, true)
            case "stop": carabiner.setWanted(.link, false)
            default: carabiner.setWanted(.link, carabiner.status.linkWanted) // nur Zustand melden
            }
        case "lights":
            // Licht-Brücke: Relais-Rig + HUB75-Wand per UDP
            lights.handle(body)
            carabiner.setWanted(.lights, lights.isEnabled)
        case "udp":
            // Live-Vorschau per WLAN an den Pico 2W (Direktbetrieb)
            if let host = body["host"] as? String, let b64 = body["base64"] as? String, let d = Data(base64Encoded: b64) {
                udp.send(host: host, port: UInt16((body["port"] as? NSNumber)?.intValue ?? 4210), data: d)
            }
        case "openURL":
            if let s = body["url"] as? String, let url = URL(string: s), url.scheme == "https" {
                NSWorkspace.shared.open(url)
            }
        default:
            break
        }
    }

    private func reply(_ id: Int, _ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__native && window.__native.reply(\(id), \(s))", completionHandler: nil)
    }

    private func pushDevices(_ list: [DeviceManager.Device], _ fw: DeviceManager.Firmware) {
        guard pageReady,
              let l = try? JSONEncoder().encode(list), let ls = String(data: l, encoding: .utf8),
              let f = try? JSONEncoder().encode(fw), let fs = String(data: f, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__native && window.__native.devices(\(ls), \(fs))", completionHandler: nil)
    }

    // window.__native.<fn>(args...) mit JSON-kodierten Argumenten aufrufen
    private func callJS(_ fn: String, _ args: [Any]) {
        guard pageReady, let d = try? JSONSerialization.data(withJSONObject: args),
              let s = String(data: d, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__native && window.__native.\(fn).apply(null, \(s))", completionHandler: nil)
    }

    private func pushUpdateState(_ st: Updater.State) {
        guard pageReady, let data = try? JSONEncoder().encode(st), let s = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__native && window.__native.updateState(\(s))", completionHandler: nil)
    }

    // MARK: - Dateien

    private func writeAutosave(_ s: String) {
        try? s.write(to: autosaveURL, atomically: true, encoding: .utf8)
    }

    private func setCurrentFile(_ url: URL?) {
        currentFile = url
        window.title = url.map { "LED Pattern Studio – " + $0.lastPathComponent } ?? "LED Pattern Studio"
    }

    private func contentType(for name: String) -> UTType? {
        let ext = (name as NSString).pathExtension
        return ext.isEmpty ? nil : UTType(filenameExtension: ext)
    }

    private func saveProject(id: Int, name: String, data: String, saveAs: Bool) {
        if !saveAs, let url = currentFile {
            do {
                try data.write(to: url, atomically: true, encoding: .utf8)
                reply(id, ["ok": true, "name": url.lastPathComponent])
            } catch {
                reply(id, ["ok": false, "error": error.localizedDescription])
            }
            return
        }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.allowedContentTypes = [.json]
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { [weak self] resp in
            guard let self else { return }
            guard resp == .OK, let url = panel.url else { self.reply(id, ["ok": false, "cancelled": true]); return }
            do {
                try data.write(to: url, atomically: true, encoding: .utf8)
                self.setCurrentFile(url)
                self.reply(id, ["ok": true, "name": url.lastPathComponent])
            } catch {
                self.reply(id, ["ok": false, "error": error.localizedDescription])
            }
        }
    }

    private func saveFile(id: Int, name: String, body: [String: Any]) {
        let data: Data
        if let b64 = body["base64"] as? String, let d = Data(base64Encoded: b64) {
            data = d
        } else {
            data = (body["text"] as? String ?? "").data(using: .utf8) ?? Data()
        }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        if let t = contentType(for: name) { panel.allowedContentTypes = [t] }
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { [weak self] resp in
            guard let self else { return }
            guard resp == .OK, let url = panel.url else { self.reply(id, ["ok": false, "cancelled": true]); return }
            do {
                try data.write(to: url, options: .atomic)
                self.reply(id, ["ok": true, "name": url.lastPathComponent])
            } catch {
                self.reply(id, ["ok": false, "error": error.localizedDescription])
            }
        }
    }

    private func openProject(id: Int) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { [weak self] resp in
            guard let self else { return }
            guard resp == .OK, let url = panel.url else { self.reply(id, ["ok": false, "cancelled": true]); return }
            do {
                let text = try String(contentsOf: url, encoding: .utf8)
                self.setCurrentFile(url)
                self.reply(id, ["ok": true, "name": url.lastPathComponent, "text": text])
            } catch {
                self.reply(id, ["ok": false, "error": error.localizedDescription])
            }
        }
    }

    // MARK: - WKNavigationDelegate / WKUIDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        pushUpdateState(updater.state)
        devices.pushState()
    }

    // Links nach außen im Standardbrowser öffnen
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, url.scheme == "http" || url.scheme == "https" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Abbrechen")
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let p = NSOpenPanel()
        p.allowsMultipleSelection = parameters.allowsMultipleSelection
        p.canChooseDirectories = false
        p.beginSheetModal(for: window) { r in completionHandler(r == .OK ? p.urls : nil) }
    }

    // MARK: - Hilfen

    private func jsString(_ s: String) -> String {
        // String als JS-Literal: über ein JSON-Array kodieren und die Klammern entfernen
        guard let d = try? JSONSerialization.data(withJSONObject: [s]), let a = String(data: d, encoding: .utf8) else { return "\"\"" }
        return String(a.dropFirst().dropLast())
    }
}
