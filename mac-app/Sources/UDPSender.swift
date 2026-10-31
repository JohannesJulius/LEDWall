import Foundation
import Network

/// Schickt UDP-Pakete (Live-Vorschau) an den Pico 2W. Eine Verbindung je Ziel wird wiederverwendet.
final class UDPSender {
    private var connections: [String: NWConnection] = [:]
    private let queue = DispatchQueue(label: "ledwall.udp")

    func send(host: String, port: UInt16, data: Data) {
        queue.async {
            let key = "\(host):\(port)"
            var conn = self.connections[key]
            if conn == nil || conn?.state == .cancelled {
                guard let p = NWEndpoint.Port(rawValue: port) else { return }
                let c = NWConnection(host: NWEndpoint.Host(host), port: p, using: .udp)
                c.stateUpdateHandler = { [weak self] state in
                    if case .failed = state { self?.queue.async { self?.connections[key] = nil } }
                }
                c.start(queue: self.queue)
                self.connections[key] = c
                conn = c
            }
            conn?.send(content: data, completion: .contentProcessed { _ in })
        }
    }
}
