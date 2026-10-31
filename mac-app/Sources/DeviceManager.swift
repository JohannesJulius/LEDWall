import Cocoa
import IOKit
import IOKit.serial

/*
 * Erkennt RP2040-Boards am USB:
 *  - "receiver": läuft mit der LEDWall-Empfänger-Firmware (USB-Produkt "LEDWall-Receiver")
 *  - "bootsel":  Laufwerk RPI-RP2 / RP2350 im BOOTSEL-Modus, bereit für eine .uf2
 *  - "rp2040":   anderes Raspberry-Pi-Board (andere Firmware, z. B. CircuitPython)
 * Zu Empfängern wird eine serielle Verbindung gehalten; Textzeilen gehen an die Oberfläche.
 */
final class DeviceManager {

    struct Device: Codable {
        var id: String
        var kind: String
        var port: String?
        var volume: String?
        var board: String?
        var product: String?
        var serial: String?
    }

    struct FirmwareFile: Codable {
        var version: String
        var available: Bool
    }

    struct Firmware: Codable {
        var receiver: FirmwareFile   // RP2040 Zero
        var sender: FirmwareFile     // Pico 2W (RP2350)
        var direct: FirmwareFile     // Pico 2W im Direktbetrieb (Panels direkt am 2W)
    }

    var onChange: (([Device], Firmware) -> Void)?
    var onLine: ((String, String) -> Void)?           // port, Zeile
    var onFlash: ((String, Bool, String) -> Void)?    // Laufwerk, ok, Fehler
    var onUpload: ((String, Int, Int, String, String) -> Void)? // port, gesendet, gesamt, Zustand, Fehler

    private(set) var devices: [Device] = []
    private var connections: [String: SerialConnection] = [:]
    private var timer: Timer?
    private var flashing = Set<String>()

    static let receiverProduct = "LEDWall-Receiver"
    static let senderProduct = "LEDWall-Sender"
    static let rpiVendor = 0x2E8A

    private static func fwURL(_ name: String) -> URL? {
        Bundle.main.resourceURL?.appendingPathComponent("firmware/" + name)
    }

    private static func fwFile(_ uf2: String, _ versionFile: String) -> FirmwareFile {
        let v = fwURL(versionFile).flatMap { try? String(contentsOf: $0, encoding: .utf8) }?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let ok = fwURL(uf2).map { FileManager.default.fileExists(atPath: $0.path) } ?? false
        return FirmwareFile(version: v, available: ok && !v.isEmpty)
    }

    lazy var firmware = Firmware(receiver: Self.fwFile("ledwall-receiver.uf2", "version.txt"),
                                 sender: Self.fwFile("ledwall-sender.uf2", "sender-version.txt"),
                                 direct: Self.fwFile("ledwall-direct.uf2", "sender-version.txt"))

    // Bank-Upload zum Sender: 4-KB-Blöcke, jeder wird mit "ACK n" quittiert
    private struct Upload { var data: Data; var sent: Int }
    private var uploads: [String: Upload] = [:]
    static let uploadChunk = 4096

    func start() {
        scan()
        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.scan() }
    }

    // MARK: - Suchen

    func scan() {
        var found: [Device] = []
        for p in serialPorts() where p.vendor == Self.rpiVendor {
            let kind = p.product == Self.receiverProduct ? "receiver" : p.product == Self.senderProduct ? "sender" : "rp2040"
            found.append(Device(id: p.path, kind: kind, port: p.path, board: nil, product: p.product, serial: p.serial))
        }
        for v in bootselVolumes() {
            found.append(Device(id: v.path, kind: "bootsel", volume: v.path, board: v.board))
        }

        // Verbindungen zu neuen Empfängern/Sendern öffnen, verschwundene schließen
        let receiverPorts = Set(found.filter { $0.kind == "receiver" || $0.kind == "sender" }.compactMap { $0.port })
        for (port, conn) in connections where !receiverPorts.contains(port) {
            conn.close()
            connections[port] = nil
            if uploads.removeValue(forKey: port) != nil { onUpload?(port, 0, 0, "error", "Gerät getrennt") }
        }
        for port in receiverPorts where connections[port] == nil {
            let conn = SerialConnection(path: port)
            conn.onLine = { [weak self] line in self?.handleLine(port, line) }
            conn.onClose = { [weak self] in self?.connections[port] = nil }
            if conn.open() {
                connections[port] = conn
                conn.send("INFO\n")
            }
        }

        let changed = (try? JSONEncoder().encode(found)) != (try? JSONEncoder().encode(devices))
        devices = found
        if changed { onChange?(devices, firmware) }
    }

    func pushState() { onChange?(devices, firmware) }

    private struct PortInfo { var path: String; var vendor: Int; var product: String; var serial: String }

    private func serialPorts() -> [PortInfo] {
        var result: [PortInfo] = []
        guard let matching = IOServiceMatching(kIOSerialBSDServiceValue) else { return [] }
        var iter: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iter) == KERN_SUCCESS else { return [] }
        defer { IOObjectRelease(iter) }
        var service = IOIteratorNext(iter)
        while service != 0 {
            defer {
                IOObjectRelease(service)
                service = IOIteratorNext(iter)
            }
            guard let path = IORegistryEntryCreateCFProperty(service, kIOCalloutDeviceKey as CFString,
                                                             kCFAllocatorDefault, 0)?.takeRetainedValue() as? String,
                  path.hasPrefix("/dev/cu.usbmodem") else { continue }
            let opts = IOOptionBits(kIORegistryIterateRecursively | kIORegistryIterateParents)
            func parent(_ key: String) -> Any? {
                IORegistryEntrySearchCFProperty(service, kIOServicePlane, key as CFString, kCFAllocatorDefault, opts)
            }
            let vendor = (parent("idVendor") as? NSNumber)?.intValue ?? 0
            let product = (parent("USB Product Name") as? String) ?? (parent("kUSBProductString") as? String) ?? ""
            let serial = (parent("USB Serial Number") as? String) ?? (parent("kUSBSerialNumberString") as? String) ?? ""
            result.append(PortInfo(path: path, vendor: vendor, product: product, serial: serial))
        }
        return result
    }

    private func bootselVolumes() -> [(path: String, board: String)] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: "/Volumes") else { return [] }
        var out: [(String, String)] = []
        for name in names {
            let path = "/Volumes/" + name
            guard let info = try? String(contentsOfFile: path + "/INFO_UF2.TXT", encoding: .utf8) else { continue }
            if info.contains("RPI-RP2") { out.append((path, "RP2040")) }
            else if info.contains("RP2350") { out.append((path, "RP2350")) }
        }
        return out
    }

    // MARK: - Befehle

    func send(port: String, text: String) {
        connections[port]?.send(text.hasSuffix("\n") ? text : text + "\n")
    }

    func sendFrame(port: String, data: Data) {
        connections[port]?.sendFrame(data)
    }

    // Standard-Trick: Port mit 1200 Baud öffnen -> Board startet im BOOTSEL-Modus
    func touch1200(port: String) {
        connections[port]?.close()
        connections[port] = nil
        DispatchQueue.global().async {
            SerialConnection.touch1200(path: port)
        }
    }

    private func handleLine(_ port: String, _ line: String) {
        if var up = uploads[port] {
            if line == "READY" || line.hasPrefix("ACK ") {
                if line.hasPrefix("ACK ") { up.sent = Int(line.dropFirst(4)) ?? up.sent }
                uploads[port] = up
                onUpload?(port, up.sent, up.data.count, "sending", "")
                if up.sent < up.data.count {
                    let end = min(up.sent + Self.uploadChunk, up.data.count)
                    connections[port]?.sendData(up.data.subdata(in: up.sent..<end))
                }
                return
            }
            if line == "OK" || line.hasPrefix("ERR") {
                uploads[port] = nil
                onUpload?(port, up.data.count, up.data.count, line == "OK" ? "done" : "error", line == "OK" ? "" : String(line.dropFirst(4)))
                return
            }
        }
        onLine?(port, line)
    }

    func upload(port: String, data: Data, crc: UInt32) {
        guard let conn = connections[port] else { onUpload?(port, 0, data.count, "error", "nicht verbunden"); return }
        uploads[port] = Upload(data: data, sent: 0)
        onUpload?(port, 0, data.count, "starting", "")
        conn.send("UPLOAD \(data.count) \(crc)\n")
    }

    // variant: "receiver" | "sender" | "direct" (leer = nach Chip)
    func flash(volume: String, variant: String = "") {
        let board = devices.first(where: { $0.volume == volume })?.board ?? "RP2040"
        let v = variant.isEmpty ? (board == "RP2350" ? "sender" : "receiver") : variant
        let file = v == "direct" ? firmware.direct : v == "sender" ? firmware.sender : firmware.receiver
        guard let src = Self.fwURL("ledwall-\(v).uf2"), file.available else {
            onFlash?(volume, false, "Firmware fehlt in der App")
            return
        }
        guard !flashing.contains(volume) else { return }
        flashing.insert(volume)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/cp")
            p.arguments = ["-X", src.path, volume + "/"]
            let errPipe = Pipe()
            p.standardError = errPipe
            var ok = false
            var msg = ""
            do {
                try p.run()
                p.waitUntilExit()
                ok = p.terminationStatus == 0
                msg = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            } catch {
                msg = error.localizedDescription
            }
            // Das Board startet nach dem Kopieren sofort neu und das Laufwerk verschwindet –
            // ein Fehler am Ende des Kopierens zählt dann trotzdem als Erfolg.
            Thread.sleep(forTimeInterval: 1.5)
            if !ok && !FileManager.default.fileExists(atPath: volume) { ok = true }
            DispatchQueue.main.async {
                self?.flashing.remove(volume)
                self?.onFlash?(volume, ok, ok ? "" : msg.trimmingCharacters(in: .whitespacesAndNewlines))
                self?.scan()
            }
        }
    }
}

/// Serielle Verbindung (USB-CDC). Lesen über DispatchSource, Schreiben auf einer eigenen Queue.
final class SerialConnection {
    let path: String
    var onLine: ((String) -> Void)?
    var onClose: (() -> Void)?
    private var fd: Int32 = -1
    private var source: DispatchSourceRead?
    private var buffer = Data()
    private let writeQueue = DispatchQueue(label: "ledwall.serial.write")
    private var framePending = false
    private let lock = NSLock()

    init(path: String) { self.path = path }

    func open() -> Bool {
        fd = Darwin.open(path, O_RDWR | O_NOCTTY | O_NONBLOCK)
        guard fd >= 0 else { return false }
        var t = termios()
        tcgetattr(fd, &t)
        cfmakeraw(&t)
        t.c_cflag |= tcflag_t(CLOCAL | CREAD)
        cfsetspeed(&t, speed_t(115200)) // niemals 1200: das würde den BOOTSEL-Modus auslösen
        tcsetattr(fd, TCSANOW, &t)
        _ = fcntl(fd, F_SETFL, 0) // Schreiben blockierend (auf der writeQueue)

        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        src.setEventHandler { [weak self] in self?.readAvailable() }
        let descriptor = fd
        src.setCancelHandler { Darwin.close(descriptor) }
        source = src
        src.resume()
        return true
    }

    private func readAvailable() {
        var tmp = [UInt8](repeating: 0, count: 4096)
        let n = Darwin.read(fd, &tmp, tmp.count)
        if n <= 0 {
            if n == 0 || (errno != EAGAIN && errno != EINTR) { close() }
            return
        }
        buffer.append(contentsOf: tmp[0..<n])
        while let nl = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer[buffer.startIndex..<nl]
            buffer.removeSubrange(buffer.startIndex...nl)
            let line = String(decoding: lineData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            if !line.isEmpty { onLine?(line) }
        }
        if buffer.count > 65536 { buffer.removeAll() }
    }

    func send(_ text: String) {
        write(Data(text.utf8))
    }

    func sendData(_ data: Data) {
        write(data)
    }

    // Bilder für die Live-Vorschau: ist das vorige noch unterwegs, wird dieses verworfen
    func sendFrame(_ data: Data) {
        lock.lock()
        if framePending { lock.unlock(); return }
        framePending = true
        lock.unlock()
        write(data) { [weak self] in
            self?.lock.lock()
            self?.framePending = false
            self?.lock.unlock()
        }
    }

    private func write(_ data: Data, done: (() -> Void)? = nil) {
        let descriptor = fd
        guard descriptor >= 0 else { return }
        writeQueue.async {
            data.withUnsafeBytes { raw in
                guard var p = raw.baseAddress else { return }
                var left = raw.count
                while left > 0 {
                    let n = Darwin.write(descriptor, p, left)
                    if n <= 0 { if errno == EINTR { continue }; break }
                    left -= n
                    p += n
                }
            }
            done?()
        }
    }

    func close() {
        guard fd >= 0 else { return }
        fd = -1
        source?.cancel()
        source = nil
        onClose?()
    }

    static func touch1200(path: String) {
        let fd = Darwin.open(path, O_RDWR | O_NOCTTY | O_NONBLOCK)
        guard fd >= 0 else { return }
        var t = termios()
        tcgetattr(fd, &t)
        cfsetspeed(&t, speed_t(1200))
        tcsetattr(fd, TCSANOW, &t)
        Thread.sleep(forTimeInterval: 0.1)
        Darwin.close(fd)
    }
}
