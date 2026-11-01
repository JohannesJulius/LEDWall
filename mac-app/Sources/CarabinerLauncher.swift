import Foundation

/*
 * Startet Carabiner bei Bedarf selbst.
 *
 * - Prüft per TCP, ob auf 127.0.0.1:17000 schon etwas antwortet. Dann passiert nichts:
 *   ein von Hand gestartetes Carabiner bleibt unangetastet.
 * - Sonst wird ein `Carabiner` (Programm) oder `Carabiner.app` gesucht, das neben der App
 *   liegt (gleicher Ordner wie „LED Pattern Studio.app“ bzw. wie das Programm selbst), und
 *   gestartet. Nur diesen selbst gestarteten Prozess beendet stop() wieder (beim Beenden der App).
 *
 * Der Start läuft unter einem eigenen Lock und auf einer eigenen Queue – getrennt vom Lock des
 * Beat-Takts in LightBridge, damit ein hängender Start nie die Sende-Schleife aufhält.
 */
final class CarabinerLauncher {
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "ledwall.carabiner.launch")
    private var process: Process?
    private var lastAttempt = Date.distantPast
    private(set) var lastMessage = ""

    let port: UInt16

    init(port: UInt16 = 17000) { self.port = port }

    /// true, solange ein von uns gestartetes Carabiner läuft
    var startedByUs: Bool {
        lock.lock(); defer { lock.unlock() }
        return process?.isRunning == true
    }

    /// Nicht blockierend: prüft im Hintergrund und startet Carabiner, falls nötig.
    /// Höchstens alle 10 s ein Versuch.
    func ensureRunning(completion: ((String) -> Void)? = nil) {
        queue.async {
            let msg = self.ensureRunningSync()
            if let completion { DispatchQueue.main.async { completion(msg) } }
        }
    }

    private func ensureRunningSync() -> String {
        lock.lock(); defer { lock.unlock() }
        if process?.isRunning == true { return lastMessage }
        guard Date().timeIntervalSince(lastAttempt) > 10 else { return lastMessage }
        lastAttempt = Date()
        if Self.probe(port: port) { lastMessage = ""; return lastMessage }
        guard let exe = Self.findExecutable() else {
            lastMessage = "Carabiner läuft nicht und wurde nicht neben der App gefunden (Carabiner oder Carabiner.app in denselben Ordner legen)."
            return lastMessage
        }
        let p = Process()
        p.executableURL = exe
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
            process = p
            lastMessage = "Carabiner gestartet (\(exe.lastPathComponent))"
        } catch {
            lastMessage = "Carabiner konnte nicht gestartet werden: \(error.localizedDescription)"
        }
        return lastMessage
    }

    /// Beendet nur ein selbst gestartetes Carabiner.
    func stop() {
        lock.lock(); defer { lock.unlock() }
        guard let p = process else { return }
        if p.isRunning {
            p.terminate()
            // kurz warten, damit der Port beim nächsten Start frei ist
            let until = Date().addingTimeInterval(1)
            while p.isRunning && Date() < until { usleep(20000) }
        }
        process = nil
    }

    // MARK: - Hilfen

    /// TCP-Verbindungsversuch auf 127.0.0.1:port (lokal: Antwort sofort, kein Timeout nötig)
    static func probe(port: UInt16) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        #if os(macOS)
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        #endif
        let r = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return r == 0
    }

    /// Sucht Carabiner neben dem App-Bundle bzw. neben dem Programm.
    static func findExecutable() -> URL? {
        var dirs: [URL] = [Bundle.main.bundleURL.deletingLastPathComponent()]
        if let exe = Bundle.main.executableURL?.deletingLastPathComponent() { dirs.append(exe) }
        let fm = FileManager.default
        for dir in dirs {
            let plain = dir.appendingPathComponent("Carabiner")
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: plain.path, isDirectory: &isDir), !isDir.boolValue, fm.isExecutableFile(atPath: plain.path) {
                return plain
            }
            let app = dir.appendingPathComponent("Carabiner.app")
            if fm.fileExists(atPath: app.path), let b = Bundle(url: app), let exe = b.executableURL,
               fm.isExecutableFile(atPath: exe.path) {
                return exe
            }
        }
        return nil
    }
}
