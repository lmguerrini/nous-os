import Foundation

func check(_ facts: LinkFacts, _ state: LinkState, _ sentence: String) {
    let result = classify(facts)
    guard result.state == state && result.sentence == sentence else { fatalError("Expected \(state) / \(sentence); got \(result.state) / \(result.sentence)") }
}
@main struct Tests {
 static func main() {
  check(.init(jobRunning:true,ready:true,readyPreviously:true,unrecoveredPollFailure:false,withinGrace:false,commandError:nil,shutdownSentence:nil,connectedSentence:nil),.on,"Connesso")
  check(.init(jobRunning:true,ready:true,readyPreviously:true,unrecoveredPollFailure:true,withinGrace:false,commandError:nil,shutdownSentence:nil,connectedSentence:nil),.reconnecting,"Riconnessione…")
  check(.init(jobRunning:true,ready:false,readyPreviously:false,unrecoveredPollFailure:false,withinGrace:true,commandError:nil,shutdownSentence:nil,connectedSentence:nil),.starting,"Avvio…")
  check(.init(jobRunning:true,ready:false,readyPreviously:false,unrecoveredPollFailure:false,withinGrace:false,commandError:nil,shutdownSentence:nil,connectedSentence:nil),.error,"Errore: NousOS non è pronto")
  for reason in ["assenza","inattività","durata massima"] { check(.init(jobRunning:false,ready:false,readyPreviously:false,unrecoveredPollFailure:false,withinGrace:false,commandError:nil,shutdownSentence:"Spento · spento automaticamente per \(reason)",connectedSentence:nil),.off,"Spento · spento automaticamente per \(reason)") }
  check(.init(jobRunning:false,ready:false,readyPreviously:false,unrecoveredPollFailure:false,withinGrace:false,commandError:nil,shutdownSentence:"Spento · spento da te",connectedSentence:nil),.off,"Spento · spento da te")
  check(.init(jobRunning:true,ready:true,readyPreviously:true,unrecoveredPollFailure:false,withinGrace:false,commandError:"test",shutdownSentence:nil,connectedSentence:nil),.error,"Errore: test")
  let rome = TimeZone(identifier: "Europe/Rome")!
  let fixed = ISO8601DateFormatter().date(from: "2026-10-15T20:00:00Z")!
  let presence = connectedStatusLines(mode: "presence", idleMinutes: 99, maxMinutes: 720, now: fixed, timeZone: rome)
  guard presence[0] == "Connesso", presence[1] == "Spegnimento dopo 30 min di assenza senza richieste", presence[2] == "Limite sessione: 12 ore, fino alle ven 10:00" else { fatalError("Presence lines failed: \(presence)") }
  let idle = connectedStatusLines(mode: "idle", idleMinutes: 47, maxMinutes: 180, now: fixed, timeZone: rome)
  guard idle[1] == "Spegnimento dopo 47 min senza richieste" else { fatalError("Idle lines failed: \(idle)") }
  let midnight = connectedStatusLines(mode: "idle", idleMinutes: 47, maxMinutes: 300, now: fixed, timeZone: rome)
  guard midnight[2].contains("fino alle ven 03:00") else { fatalError("Midnight line failed: \(midnight)") }
  let short = connectedStatusLines(mode: "idle", idleMinutes: 10, maxMinutes: 45, now: fixed, timeZone: rome)
  guard short[2] == "Limite sessione: 45 min, fino alle 22:45" else { fatalError("Short maximum failed: \(short)") }
  let now = ISO8601DateFormatter().date(from: "2026-10-15T12:00:00Z")!
  let fractional = formatShutdownSentence(timestamp: "2026-10-15T05:02:12.266869Z", reason: "away", now: now, timeZone: rome)
  guard fractional == "Spento · spento automaticamente alle 07:02 per assenza" else { fatalError("Fractional timestamp formatting failed: \(fractional ?? "nil")") }
  let wholeSeconds = formatShutdownSentence(timestamp: "2026-10-15T05:02:12Z", reason: "idle", now: now, timeZone: rome)
  guard wholeSeconds == "Spento · spento automaticamente alle 07:02 per inattività" else { fatalError("Whole-second timestamp formatting failed: \(wholeSeconds ?? "nil")") }
  let previousDay = formatShutdownSentence(timestamp: "2026-10-15T05:02:12Z", reason: "max", now: ISO8601DateFormatter().date(from: "2026-10-16T12:00:00Z")!, timeZone: rome)
  guard previousDay == "Spento · spento automaticamente alle 15 ott 07:02 per durata massima" else { fatalError("Previous-day timestamp formatting failed: \(previousDay ?? "nil")") }
  let manualWhileOn = classify(.init(jobRunning:true,ready:true,readyPreviously:true,unrecoveredPollFailure:false,withinGrace:false,commandError:nil,shutdownSentence:"Spento · spento da te",connectedSentence:nil))
  guard manualWhileOn.sentence == "Connesso" else { fatalError("Manual stop affected running tunnel: \(manualWhileOn.sentence)") }
  print("PASS: classifier, connected status, and shutdown sentence assertions.")
 }
}
