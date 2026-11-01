import Foundation
import Network

/*
 * Licht-Brücke (früher die Python-App „DJ Light Bridge“).
 *
 * Schickt 30-mal pro Sekunde per UDP an jedes eingetragene Ziel (Relais-Rig und HUB75-Wand
 * 128×96, beide mit Pico 2 W) genau diese Zeile:
 *   BPM=<bpm:.2f>,BEAT=<beat:.4f>,PHASE=<phase:.4f>,PLAYING=<0|1>,APAT=<n>,IPAT=<n>,WAPAT=<n>,WIPAT=<n>
 * APAT/IPAT: Relais-Pattern bei laufendem / gestopptem Link, WAPAT/WIPAT: dasselbe für die HUB75-Wand.
 *
 * Der Takt kommt aus Carabiner (CarabinerClient, Haupt-Thread). Er wird unter einem eigenen
 * Lock (clockLock) abgelegt; die Sende-Schleife läuft auf einer eigenen Queue und wartet nie auf
 * den HTTP-Weg der 64×48-Wand (link.js/devices.js) oder auf den Carabiner-Start.
 */

/// Glättet das Zittern der hochgerechneten Beat-Position (exakte Portierung aus der Python-App).
struct BeatSmoother {
    static let jitterThresholdBeats = 0.05
    private var anchorBeat = 0.0
    private var anchorTime: Double?
    private var anchorBpm = 0.0

    mutating func reset() { anchorTime = nil }

    mutating func smoothedBeat(rawBpm: Double, rawBeat: Double, playing: Bool, now: Double) -> Double {
        guard playing, let t = anchorTime else {
            anchorBeat = rawBeat; anchorTime = now; anchorBpm = rawBpm
            return rawBeat
        }
        let predicted = anchorBeat + (now - t) * (anchorBpm / 60.0)
        if abs(rawBeat - predicted) > Self.jitterThresholdBeats {
            anchorBeat = rawBeat; anchorTime = now; anchorBpm = rawBpm
            return rawBeat
        }
        anchorBpm = rawBpm
        return predicted
    }
}

enum LightMessage {
    static func format(bpm: Double, beat: Double, playing: Bool, multiplier: Int,
                       apat: Int, ipat: Int, wapat: Int, wipat: Int) -> String {
        let m = Double(multiplier)
        let sentBpm = bpm * m
        let sentBeat = beat * m
        var phase = sentBeat.truncatingRemainder(dividingBy: 4.0)
        if phase < 0 { phase += 4.0 }
        return String(format: "BPM=%.2f,BEAT=%.4f,PHASE=%.4f,PLAYING=%d,APAT=%d,IPAT=%d,WAPAT=%d,WIPAT=%d",
                      sentBpm, sentBeat, phase, playing ? 1 : 0, apat, ipat, wapat, wipat)
    }
}

final class LightBridge {
    struct Destination: Codable {
        var id: String
        var kind: String      // "relay" oder "wall"
        var name: String
        var host: String
        var port: Int
    }

    struct Settings: Codable {
        var enabled = false
        var multiplier = 1
        var relayActive = 1
        var relayIdle = 5
        var wallActive = 1
        var wallIdle = 5
        var destinations: [Destination] = []
    }

    struct DestState: Codable {
        var id: String
        var state: String     // "ok", "resolving", "error"
        var error: String
    }

    static let multipliers = [1, 2, 4, 8]
    private static let defaultsKey = "LightBridgeSettings"

    /// Zustand für die Oberfläche (wird vom Haupt-Thread ca. 4× pro Sekunde abgeholt)
    var onState: (([String: Any]) -> Void)?

    // --- Einstellungen (Haupt-Thread schreibt, Sende-Queue liest über settingsLock)
    private let settingsLock = NSLock()
    private var settings = Settings()

    // --- Takt aus Carabiner (eigener Lock, getrennt von allem anderen)
    private struct Clock {
        var connected = false
        var bpm = 0.0
        var beat = 0.0
        var playing = false
        var time = 0.0      // Monotone Zeit der letzten Carabiner-Meldung (s)
    }
    private let clockLock = NSLock()
    private var clock = Clock()

    // --- Sende-Schleife (nur auf `queue`)
    private let queue = DispatchQueue(label: "ledwall.lights", qos: .userInteractive)
    private var timer: DispatchSourceTimer?
    private var smoother = BeatSmoother()
    private var conns: [String: (key: String, conn: NWConnection)] = [:]
    private var destState: [String: DestState] = [:]
    private var lastMessage = ""
    private var sentCount = 0
    private var uiTimer: Timer?

    init() {
        if let d = UserDefaults.standard.data(forKey: Self.defaultsKey),
           let s = try? JSONDecoder().decode(Settings.self, from: d) {
            settings = s
        }
        settings.multiplier = Self.multipliers.contains(settings.multiplier) ? settings.multiplier : 1
    }

    var isEnabled: Bool {
        settingsLock.lock(); defer { settingsLock.unlock() }
        return settings.enabled
    }

    static func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }

    // MARK: - Takt

    func updateClock(connected: Bool, bpm: Double, beat: Double, playing: Bool) {
        clockLock.lock()
        clock = Clock(connected: connected, bpm: bpm, beat: beat, playing: playing, time: Self.now())
        clockLock.unlock()
    }

    // MARK: - Ein/Aus

    func startLoop() {
        queue.async {
            guard self.timer == nil else { return }
            let t = DispatchSource.makeTimerSource(queue: self.queue)
            t.schedule(deadline: .now(), repeating: .milliseconds(33), leeway: .milliseconds(2))
            t.setEventHandler { [weak self] in self?.tick() }
            t.resume()
            self.timer = t
        }
        if uiTimer == nil {
            uiTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.publish() }
        }
    }

    func stopLoop() {
        queue.async {
            self.timer?.cancel()
            self.timer = nil
            self.smoother.reset()
        }
    }

    // MARK: - Befehle aus der Oberfläche (Haupt-Thread)

    func handle(_ body: [String: Any]) {
        let int = { (k: String) -> Int? in (body[k] as? NSNumber)?.intValue }
        settingsLock.lock()
        switch body["action"] as? String ?? "" {
        case "enable":
            settings.enabled = body["value"] as? Bool ?? false
        case "set":
            if let v = int("multiplier"), Self.multipliers.contains(v) { settings.multiplier = v }
            if let v = int("relayActive"), (1...16).contains(v) { settings.relayActive = v }
            if let v = int("relayIdle"), (1...16).contains(v) { settings.relayIdle = v }
            if let v = int("wallActive"), (1...16).contains(v) { settings.wallActive = v }
            if let v = int("wallIdle"), (1...16).contains(v) { settings.wallIdle = v }
        case "addDest":
            let host = (body["host"] as? String ?? "").trimmingCharacters(in: .whitespaces)
            let kind = body["kind"] as? String == "wall" ? "wall" : "relay"
            let port = int("port") ?? 5005
            if !host.isEmpty, (1...65535).contains(port) {
                let name = (body["name"] as? String ?? "").trimmingCharacters(in: .whitespaces)
                settings.destinations.append(Destination(id: UUID().uuidString, kind: kind,
                    name: name.isEmpty ? host : name, host: host, port: port))
            }
        case "updateDest":
            if let id = body["id"] as? String, let i = settings.destinations.firstIndex(where: { $0.id == id }) {
                if let n = body["name"] as? String, !n.isEmpty { settings.destinations[i].name = n }
                if let h = body["host"] as? String, !h.isEmpty { settings.destinations[i].host = h }
                if let p = int("port"), (1...65535).contains(p) { settings.destinations[i].port = p }
            }
        case "removeDest":
            if let id = body["id"] as? String { settings.destinations.removeAll { $0.id == id } }
        default:
            break
        }
        let enabled = settings.enabled
        if let d = try? JSONEncoder().encode(settings) { UserDefaults.standard.set(d, forKey: Self.defaultsKey) }
        settingsLock.unlock()
        if enabled { startLoop() } else { stopLoop() }
        publish()
    }

    // MARK: - Sende-Schleife (auf `queue`)

    private func tick() {
        settingsLock.lock()
        let s = settings
        settingsLock.unlock()
        clockLock.lock()
        let c = clock
        clockLock.unlock()

        let now = Self.now()
        let playing = c.playing
        let rawBpm = c.bpm
        let rawBeat = c.beat + (now - c.time) * c.bpm / 60.0
        let beat = smoother.smoothedBeat(rawBpm: rawBpm, rawBeat: rawBeat, playing: playing, now: now)
        let msg = LightMessage.format(bpm: rawBpm, beat: beat, playing: playing, multiplier: s.multiplier,
                                      apat: s.relayActive, ipat: s.relayIdle, wapat: s.wallActive, wipat: s.wallIdle)
        lastMessage = msg
        guard c.connected, c.bpm > 0 else { syncConnections(s.destinations, send: nil); return }
        syncConnections(s.destinations, send: Data(msg.utf8))
        sentCount &+= 1
    }

    private func syncConnections(_ dests: [Destination], send data: Data?) {
        let ids = Set(dests.map { $0.id })
        for (id, entry) in conns where !ids.contains(id) {
            entry.conn.cancel()
            conns[id] = nil
            destState[id] = nil
        }
        for d in dests {
            let key = "\(d.host):\(d.port)"
            if let e = conns[d.id], e.key != key { e.conn.cancel(); conns[d.id] = nil }
            if conns[d.id] == nil {
                guard let p = NWEndpoint.Port(rawValue: UInt16(clamping: d.port)) else { continue }
                let c = NWConnection(host: NWEndpoint.Host(d.host), port: p, using: .udp)
                let id = d.id
                destState[id] = DestState(id: id, state: "resolving", error: "")
                c.stateUpdateHandler = { [weak self, weak c] st in
                    guard let self, let c, self.conns[id]?.conn === c else { return }
                    switch st {
                    case .ready: self.destState[id] = DestState(id: id, state: "ok", error: "")
                    case .waiting(let e): self.destState[id] = DestState(id: id, state: "error", error: "\(e)")
                    case .failed(let e):
                        self.destState[id] = DestState(id: id, state: "error", error: "\(e)")
                        c.cancel()
                        self.conns[id] = nil   // beim nächsten Tick neu aufbauen
                    default: break
                    }
                }
                c.start(queue: queue)
                conns[d.id] = (key, c)
            }
            guard let data, let e = conns[d.id], e.conn.state == .ready else { continue }
            let id = d.id
            e.conn.send(content: data, completion: .contentProcessed { [weak self] err in
                guard let self else { return }
                if let err { self.destState[id] = DestState(id: id, state: "error", error: "\(err)") }
                else if self.destState[id]?.state != "ok" { self.destState[id] = DestState(id: id, state: "ok", error: "") }
            })
        }
    }

    // MARK: - Zustand an die Oberfläche

    private func publish() {
        settingsLock.lock()
        let s = settings
        settingsLock.unlock()
        queue.async {
            let states = s.destinations.map { self.destState[$0.id] ?? DestState(id: $0.id, state: s.enabled ? "resolving" : "off", error: "") }
            let msg = self.lastMessage
            let running = self.timer != nil
            let sent = self.sentCount
            DispatchQueue.main.async {
                guard let sd = try? JSONEncoder().encode(s),
                      var obj = (try? JSONSerialization.jsonObject(with: sd)) as? [String: Any],
                      let dd = try? JSONEncoder().encode(states),
                      let dObj = try? JSONSerialization.jsonObject(with: dd) else { return }
                obj["destState"] = dObj
                obj["message"] = msg
                obj["running"] = running
                obj["sent"] = sent
                self.onState?(obj)
            }
        }
    }

    func pushState() { publish() }
}
