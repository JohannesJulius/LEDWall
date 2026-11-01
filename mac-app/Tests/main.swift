// Test der Licht-Brücke: Glättung des Beat-Takts und Nachrichtenformat.
// Läuft in der CI:  xcrun swiftc Sources/LightBridge.swift Tests/main.swift -o lbtest && ./lbtest
import Foundation

var failures = 0
func check(_ ok: Bool, _ msg: String) {
    if !ok { failures += 1; print("FEHLER:", msg) } else { print("ok:", msg) }
}
func near(_ a: Double, _ b: Double, _ eps: Double = 1e-9) -> Bool { abs(a - b) < eps }

var s = BeatSmoother()
check(near(s.smoothedBeat(rawBpm: 120, rawBeat: 7.3, playing: false, now: 0), 7.3), "gestoppt: Rohwert")
s.reset()
check(near(s.smoothedBeat(rawBpm: 120, rawBeat: 0.0, playing: true, now: 0.0), 0.0), "erster Wert setzt Anker")
check(near(s.smoothedBeat(rawBpm: 120, rawBeat: 1.003, playing: true, now: 0.5), 1.0), "kleines Zittern wird geglättet")
check(near(s.smoothedBeat(rawBpm: 120, rawBeat: 2.2, playing: true, now: 1.0), 2.2), "Sprung > 0,05 Beat setzt neuen Anker")
check(near(s.smoothedBeat(rawBpm: 130, rawBeat: 3.21, playing: true, now: 1.5), 3.2), "Vorhersage mit alter BPM")
check(near(s.smoothedBeat(rawBpm: 130, rawBeat: 4.37, playing: true, now: 2.0), 2.2 + 130.0 / 60.0), "BPM des Ankers wird nachgeführt")
check(near(s.smoothedBeat(rawBpm: 130, rawBeat: 9.0, playing: false, now: 2.5), 9.0), "Stopp: Rohwert")

let m = LightMessage.format(bpm: 128, beat: 5.5, playing: true, multiplier: 2, apat: 3, ipat: 5, wapat: 1, wipat: 5)
check(m == "BPM=256.00,BEAT=11.0000,PHASE=3.0000,PLAYING=1,APAT=3,IPAT=5,WAPAT=1,WIPAT=5", "Nachricht: \(m)")
let m2 = LightMessage.format(bpm: 140.123, beat: 1.23456, playing: false, multiplier: 1, apat: 16, ipat: 1, wapat: 10, wipat: 14)
check(m2 == "BPM=140.12,BEAT=1.2346,PHASE=1.2346,PLAYING=0,APAT=16,IPAT=1,WAPAT=10,WIPAT=14", "Nachricht: \(m2)")

if failures > 0 { print("\(failures) Fehler"); exit(1) }
print("Alle Tests bestanden")
