import Foundation
import Network

/*
 * Verbindung zu Carabiner (Brücke zu Ableton Link, github.com/Deep-Symmetry/carabiner).
 * Carabiner nimmt nur lokale Verbindungen an (127.0.0.1, Port 17000). Antworten sind Textzeilen wie
 *   status { :peers 1 :bpm 128.000000 :start 73743731220 :beat 597.737570 :playing true }
 * :beat ist die Beat-Position mit Quantum 4, also passend zu Abletons Takten. :playing kommt nur,
 * nachdem `enable-start-stop-sync` geschickt wurde – das passiert direkt nach dem Verbinden.
 *
 * Zwei Nutzer teilen sich die Verbindung: „link“ (Takt für die 64×48-Wand / Vorschau) und
 * „lights“ (Licht-Brücke: Relais + HUB75-Wand). Verbunden ist, solange einer davon sie braucht.
 * Antwortet nichts auf dem Port, startet CarabinerLauncher ein neben der App liegendes Carabiner.
 */
final class CarabinerClient {
    enum Consumer { case link, lights }

    struct Status: Codable {
        var enabled = false
        var linkWanted = false
        var lightsWanted = false
        var connected = false
        var peers = 0
        var bpm = 0.0
        var beat = 0.0
        var playing = false
        var hasPlaying = false
        var startedByApp = false
        var error = ""
    }

    var onStatus: ((Status) -> Void)?
    private(set) var status = Status()
    let port: UInt16 = 17000
    let launcher = CarabinerLauncher()

    private var conn: NWConnection?
    private var timer: Timer?
    private var buffer = Data()
    private var reconnectAt = Date.distantPast

    func setWanted(_ consumer: Consumer, _ on: Bool) {
        switch consumer {
        case .link: status.linkWanted = on
        case .lights: status.lightsWanted = on
        }
        let want = status.linkWanted || status.lightsWanted
        if want && !status.enabled { start() }
        else if !want && status.enabled { stop() }
        else { publish() }
    }

    // Alte Schnittstelle (nur Link)
    func start(_ consumer: Consumer) { setWanted(consumer, true) }
    func stop(_ consumer: Consumer) { setWanted(consumer, false) }

    private func start() {
        status.enabled = true
        status.connected = false
        status.error = ""
        connect()
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.tick() }
        publish()
    }

    private func stop() {
        timer?.invalidate()
        timer = nil
        conn?.cancel()
        conn = nil
        let link = status.linkWanted, lights = status.lightsWanted
        status = Status()
        status.linkWanted = link
        status.lightsWanted = lights
        publish()
    }

    /// Beim Beenden der App: Verbindung trennen und nur ein selbst gestartetes Carabiner beenden
    func shutdown() {
        timer?.invalidate()
        timer = nil
        conn?.cancel()
        conn = nil
        launcher.stop()
    }

    private func publish() {
        status.startedByApp = launcher.startedByUs
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
                // nur ein Befehl pro Paket; "status" folgt mit dem nächsten Tick (250 ms)
                self.send("enable-start-stop-sync\n")
                self.publish()
            case .waiting, .failed:
                self.fail("Carabiner nicht erreichbar (Port \(self.port)) – starte …")
                // Nichts antwortet: Carabiner neben der App suchen und starten (eigener Lock/Queue)
                self.launcher.ensureRunning { [weak self] msg in
                    guard let self, self.status.enabled, !self.status.connected, !msg.isEmpty else { return }
                    self.status.error = msg
                    self.publish()
                }
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
        publish()
    }

    private func tick() {
        guard status.enabled else { return }
        if conn == nil {
            if Date() >= reconnectAt { connect() }
            return
        }
        if status.connected { send("status\n") }
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
        func token(_ key: String) -> Substring? {
            guard let r = line.range(of: ":" + key + " ") else { return nil }
            return line[r.upperBound...].prefix { !$0.isWhitespace && $0 != "}" }
        }
        if let t = token("bpm"), let v = Double(t) { status.bpm = v }
        if let t = token("beat"), let v = Double(t) { status.beat = v }
        if let t = token("peers"), let v = Double(t) { status.peers = Int(v) }
        if let t = token("playing") {
            status.playing = t == "true"
            status.hasPlaying = true
        }
        status.connected = true
        publish()
    }
}
