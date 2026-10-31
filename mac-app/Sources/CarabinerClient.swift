import Foundation
import Network

/*
 * Verbindung zu Carabiner (Brücke zu Ableton Link, github.com/Deep-Symmetry/carabiner).
 * Carabiner nimmt nur lokale Verbindungen an (127.0.0.1, Port 17000). Antworten sind Textzeilen wie
 *   status { :peers 1 :bpm 128.000000 :start 73743731220 :beat 597.737570 }
 * :beat ist die Beat-Position mit Quantum 4, also passend zu Abletons Takten.
 */
final class CarabinerClient {
    struct Status: Codable {
        var enabled = false
        var connected = false
        var peers = 0
        var bpm = 0.0
        var beat = 0.0
        var error = ""
    }

    var onStatus: ((Status) -> Void)?
    private(set) var status = Status()
    var port: UInt16 = 17000

    private var conn: NWConnection?
    private var timer: Timer?
    private var buffer = Data()
    private var reconnectAt = Date.distantPast

    func start() {
        guard !status.enabled else { onStatus?(status); return }
        status = Status()
        status.enabled = true
        connect()
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.tick() }
        onStatus?(status)
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        conn?.cancel()
        conn = nil
        status = Status()
        onStatus?(status)
    }

    private func connect() {
        guard let p = NWEndpoint.Port(rawValue: port) else { return }
        let c = NWConnection(host: "127.0.0.1", port: p, using: .tcp)
        conn = c
        buffer.removeAll()
        c.stateUpdateHandler = { [weak self] st in
            guard let self, self.conn === c else { return }
            switch st {
            case .ready:
                self.status.connected = true
                self.status.error = ""
                self.receive(c)
                self.send("status")
                self.onStatus?(self.status)
            case .waiting, .failed:
                self.fail("Carabiner nicht erreichbar – läuft das Carabiner-Fenster (Port \(self.port))?")
            default:
                break
            }
        }
        c.start(queue: .main)
    }

    private func fail(_ msg: String) {
        conn?.cancel()
        conn = nil
        status.connected = false
        status.peers = 0
        status.error = msg
        reconnectAt = Date().addingTimeInterval(2)
        onStatus?(status)
    }

    private func tick() {
        guard status.enabled else { return }
        if conn == nil {
            if Date() >= reconnectAt { connect() }
            return
        }
        if status.connected { send("status") }
    }

    private func send(_ text: String) {
        conn?.send(content: Data(text.utf8), completion: .contentProcessed { _ in })
    }

    private func receive(_ c: NWConnection) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, done, err in
            guard let self, self.conn === c else { return }
            if let data, !data.isEmpty {
                self.buffer.append(data)
                self.parse()
            }
            if done || err != nil { self.fail("Verbindung zu Carabiner getrennt"); return }
            self.receive(c)
        }
    }

    private func parse() {
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = String(decoding: buffer[buffer.startIndex..<nl], as: UTF8.self)
            buffer.removeSubrange(buffer.startIndex...nl)
            handle(line)
        }
        if buffer.count > 65536 { buffer.removeAll() }
    }

    private func handle(_ line: String) {
        guard line.hasPrefix("status") else { return }
        func value(_ key: String) -> Double? {
            guard let r = line.range(of: ":" + key + " ") else { return nil }
            let token = line[r.upperBound...].prefix { !$0.isWhitespace && $0 != "}" }
            return Double(token)
        }
        if let v = value("bpm") { status.bpm = v }
        if let v = value("beat") { status.beat = v }
        if let v = value("peers") { status.peers = Int(v) }
        status.connected = true
        onStatus?(status)
    }
}
