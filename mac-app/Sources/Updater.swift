import Cocoa
import CryptoKit

/*
 * Updates über GitHub Releases (Prinzip wie bei MakerDash).
 * Erwartete Release-Dateien: LED-Pattern-Studio-mac.zip und SHA256SUMS.txt
 *
 * Ablauf: neueste Version abfragen -> ZIP laden -> Prüfsumme prüfen -> entpacken ->
 * Hilfsskript wartet, bis die App beendet ist, tauscht das Bundle aus und startet neu.
 */
final class Updater: NSObject, URLSessionDownloadDelegate {

    struct State: Codable {
        var state = "idle"   // idle, checking, uptodate, none, available, downloading, verifying, installing, error
        var current = ""
        var latest = ""
        var notes = ""
        var progress = 0
        var error = ""
        var lastCheck = ""
        var url = ""
        var autoCheck = true
        var repo = ""
        var manual = false
    }

    static let zipAsset = "LED-Pattern-Studio-mac.zip"
    static let sumsAsset = "SHA256SUMS.txt"

    let currentVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    let repo = (Bundle.main.object(forInfoDictionaryKey: "LEDUpdateRepo") as? String) ?? "JohannesJulius/LEDWall"

    private(set) var state = State()
    var onChange: ((State) -> Void)?

    private var zipURL: URL?
    private var sumsURL: URL?
    private var workDir: URL?
    private var timer: Timer?

    var autoCheck: Bool {
        get { UserDefaults.standard.object(forKey: "autoUpdateCheck") as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: "autoUpdateCheck")
            update { $0.autoCheck = newValue }
        }
    }

    override init() {
        super.init()
        state.current = currentVersion
        state.repo = repo
        state.autoCheck = autoCheck
    }

    // Nur auf dem Main-Thread aufrufen
    private func update(_ fn: (inout State) -> Void) {
        fn(&state)
        state.current = currentVersion
        onChange?(state)
    }

    private func fail(_ msg: String) {
        update { $0.state = "error"; $0.error = msg }
    }

    // beim Start (nach 5 s) und danach alle 6 Stunden
    func startAutoCheck() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            if self?.autoCheck == true { self?.check(manual: false) }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { [weak self] _ in
            if self?.autoCheck == true { self?.check(manual: false) }
        }
    }

    private func request(_ url: URL, accept: String = "application/vnd.github+json") -> URLRequest {
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
        r.setValue("LEDPatternStudio/\(currentVersion)", forHTTPHeaderField: "User-Agent")
        r.setValue(accept, forHTTPHeaderField: "Accept")
        return r
    }

    // MARK: - Versionen

    static func parseVersion(_ s: String) -> [Int] {
        var t = s.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("v") { t.removeFirst() }
        if let i = t.firstIndex(where: { $0 == "-" || $0 == "+" || $0 == " " }) { t = String(t[..<i]) }
        var v = t.split(separator: ".").prefix(3).map { Int($0) ?? 0 }
        while v.count < 3 { v.append(0) }
        return v
    }

    static func isNewer(_ latest: String, than current: String) -> Bool {
        let a = parseVersion(latest), b = parseVersion(current)
        for i in 0..<3 where a[i] != b[i] { return a[i] > b[i] }
        return false
    }

    // MARK: - Suchen

    func check(manual: Bool) {
        if ["checking", "downloading", "verifying", "installing"].contains(state.state) { return }
        update { $0.state = "checking"; $0.error = ""; $0.manual = manual }
        guard let url = URL(string: "https://api.github.com/repos/\(repo)/releases/latest") else { return }
        URLSession.shared.dataTask(with: request(url)) { [weak self] data, resp, err in
            DispatchQueue.main.async {
                self?.handleCheck(data: data, resp: resp as? HTTPURLResponse, err: err)
            }
        }.resume()
    }

    private func handleCheck(data: Data?, resp: HTTPURLResponse?, err: Error?) {
        let f = DateFormatter()
        f.dateFormat = "dd.MM.yyyy HH:mm"
        let now = f.string(from: Date())
        guard err == nil, let resp else {
            update { $0.state = "error"; $0.error = "Keine Verbindung zum Update-Server"; $0.lastCheck = now }
            return
        }
        if resp.statusCode == 404 {
            // kein Release vorhanden (oder Repository privat)
            update { $0.state = "none"; $0.lastCheck = now }
            return
        }
        if resp.statusCode == 403 || resp.statusCode == 429 {
            update { $0.state = "error"; $0.error = "GitHub hat zu viele Anfragen gemeldet – später erneut versuchen"; $0.lastCheck = now }
            return
        }
        guard resp.statusCode == 200, let data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            update { $0.state = "error"; $0.error = "Update-Server antwortet mit \(resp.statusCode)"; $0.lastCheck = now }
            return
        }
        let tag = json["tag_name"] as? String ?? ""
        let latest = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        var zip: URL?, sums: URL?
        for a in json["assets"] as? [[String: Any]] ?? [] {
            guard let name = a["name"] as? String, let s = a["browser_download_url"] as? String else { continue }
            if name == Self.zipAsset { zip = URL(string: s) }
            if name == Self.sumsAsset { sums = URL(string: s) }
        }
        guard Self.isNewer(latest, than: currentVersion), zip != nil else {
            update { $0.state = "uptodate"; $0.latest = latest; $0.lastCheck = now }
            return
        }
        zipURL = zip
        sumsURL = sums
        update {
            $0.state = "available"
            $0.latest = latest
            $0.notes = json["body"] as? String ?? ""
            $0.url = json["html_url"] as? String ?? ""
            $0.lastCheck = now
        }
    }

    // MARK: - Installieren

    func install() {
        guard state.state == "available" || state.state == "error", let zipURL else { return }
        let appURL = Bundle.main.bundleURL
        if appURL.path.contains("/AppTranslocation/") || appURL.path.hasPrefix("/Volumes/") {
            fail("Bitte die App zuerst in den Ordner „Programme“ ziehen und von dort starten.")
            return
        }
        let parent = appURL.deletingLastPathComponent().path
        if !FileManager.default.isWritableFile(atPath: parent) {
            fail("Keine Schreibrechte für \(parent) – Update bitte manuell installieren.")
            return
        }
        update { $0.state = "downloading"; $0.progress = 0; $0.error = "" }
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: OperationQueue.main)
        session.downloadTask(with: request(zipURL, accept: "application/octet-stream")).resume()
        session.finishTasksAndInvalidate()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard totalBytesExpectedToWrite > 0 else { return }
        let p = Int(totalBytesWritten * 100 / totalBytesExpectedToWrite)
        if p != state.progress { update { $0.progress = p } }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        let code = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { fail("Download fehlgeschlagen (HTTP \(code))"); return }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("LEDPatternStudio-Update-" + UUID().uuidString)
        let zip = dir.appendingPathComponent(Self.zipAsset)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: location, to: zip)
        } catch {
            fail("Download konnte nicht gespeichert werden: \(error.localizedDescription)")
            return
        }
        workDir = dir
        verify(zip: zip, dir: dir)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { fail("Download fehlgeschlagen: \(error.localizedDescription)") }
    }

    private func verify(zip: URL, dir: URL) {
        update { $0.state = "verifying" }
        guard let sumsURL else { fail("Prüfsumme fehlt im Release"); return }
        URLSession.shared.dataTask(with: request(sumsURL, accept: "application/octet-stream")) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                guard let data, let text = String(data: data, encoding: .utf8) else {
                    self.fail("Prüfsumme konnte nicht geladen werden"); return
                }
                var want = ""
                for line in text.split(whereSeparator: \.isNewline) {
                    let f = line.split(whereSeparator: { $0 == " " || $0 == "\t" })
                    guard f.count == 2 else { continue }
                    var name = String(f[1])
                    if name.hasPrefix("*") { name.removeFirst() }
                    if name == Self.zipAsset { want = f[0].lowercased() }
                }
                guard !want.isEmpty else { self.fail("Prüfsumme für das Update fehlt"); return }
                guard let zipData = try? Data(contentsOf: zip) else { self.fail("Download nicht lesbar"); return }
                let got = SHA256.hash(data: zipData).map { String(format: "%02x", $0) }.joined()
                guard got == want else {
                    try? FileManager.default.removeItem(at: dir)
                    self.fail("Prüfsumme stimmt nicht – Download beschädigt"); return
                }
                self.extractAndReplace(zip: zip, dir: dir)
            }
        }.resume()
    }

    private func extractAndReplace(zip: URL, dir: URL) {
        update { $0.state = "installing" }
        let extract = dir.appendingPathComponent("extracted")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let ok = Self.run("/usr/bin/ditto", ["-x", "-k", zip.path, extract.path])
            DispatchQueue.main.async {
                guard let self else { return }
                guard ok else { self.fail("Update konnte nicht entpackt werden"); return }
                let apps = (try? FileManager.default.contentsOfDirectory(at: extract, includingPropertiesForKeys: nil)) ?? []
                guard let newApp = apps.first(where: { $0.pathExtension == "app" }),
                      let info = NSDictionary(contentsOf: newApp.appendingPathComponent("Contents/Info.plist")),
                      info["CFBundleIdentifier"] as? String == Bundle.main.bundleIdentifier else {
                    self.fail("Update-Paket ist ungültig"); return
                }
                self.launchReplacer(newApp: newApp, dir: dir)
            }
        }
    }

    private func launchReplacer(newApp: URL, dir: URL) {
        let script = """
        #!/bin/sh
        # Wartet, bis die alte App beendet ist, tauscht sie aus und startet die neue.
        PID="$1"; OLD="$2"; NEW="$3"; WORK="$4"
        i=0
        while kill -0 "$PID" 2>/dev/null; do sleep 0.2; i=$((i+1)); [ $i -gt 150 ] && break; done
        BACKUP="$OLD.update-backup"
        rm -rf "$BACKUP"
        if mv "$OLD" "$BACKUP"; then
          if /usr/bin/ditto "$NEW" "$OLD"; then rm -rf "$BACKUP"; else rm -rf "$OLD"; mv "$BACKUP" "$OLD"; fi
        fi
        /usr/bin/xattr -dr com.apple.quarantine "$OLD" 2>/dev/null
        /usr/bin/open "$OLD"
        rm -rf "$WORK"
        """
        let scriptURL = dir.appendingPathComponent("install.sh")
        do {
            try script.write(to: scriptURL, atomically: true, encoding: .utf8)
        } catch {
            fail("Update-Skript konnte nicht geschrieben werden"); return
        }
        let q = { (s: String) in "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let args = [scriptURL.path, String(ProcessInfo.processInfo.processIdentifier), Bundle.main.bundlePath, newApp.path, dir.path]
        // per nohup im Hintergrund, damit das Skript das Beenden der App überlebt
        let cmd = "nohup /bin/sh " + args.map(q).joined(separator: " ") + " >/dev/null 2>&1 &"
        guard Self.run("/bin/sh", ["-c", cmd]) else { fail("Update konnte nicht gestartet werden"); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) }
    }

    @discardableResult
    private static func run(_ path: String, _ args: [String]) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        do {
            try p.run()
            p.waitUntilExit()
            return p.terminationStatus == 0
        } catch {
            return false
        }
    }
}
