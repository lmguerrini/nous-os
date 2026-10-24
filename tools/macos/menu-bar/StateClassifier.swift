import Foundation

func connectedStatusLines(mode: String, idleMinutes: Int, maxMinutes: Int, now: Date = Date(), timeZone: TimeZone = .current) -> [String] {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let idle = mode == "presence" ? "Spegnimento dopo 30 min di assenza senza richieste" : "Spegnimento dopo \(max(1, idleMinutes)) min senza richieste"
    let duration: String
    if maxMinutes >= 60 {
        let hours = max(1, Int(ceil(Double(maxMinutes) / 60.0)))
        duration = "\(hours) ore"
    } else {
        duration = "\(max(1, maxMinutes)) min"
    }
    let deadline = now.addingTimeInterval(TimeInterval(maxMinutes * 60))
    let clock = DateFormatter()
    clock.locale = Locale(identifier: "it_IT")
    clock.timeZone = timeZone
    clock.dateFormat = calendar.isDate(deadline, inSameDayAs: now) ? "HH:mm" : "EEE HH:mm"
    return ["Connesso", idle, "Limite sessione: \(duration), fino alle \(clock.string(from: deadline))"]
}

func formatShutdownSentence(timestamp: String, reason: String, now: Date = Date(), timeZone: TimeZone = .current) -> String? {
    let formatter = ISO8601DateFormatter()
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var date = formatter.date(from: timestamp)
    if date == nil {
        formatter.formatOptions = [.withInternetDateTime]
        date = formatter.date(from: timestamp)
    }
    guard let date else { return nil }

    let output = DateFormatter()
    output.locale = Locale(identifier: "it_IT")
    output.timeZone = timeZone
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    output.dateFormat = calendar.isDate(date, inSameDayAs: now) ? "HH:mm" : "d MMM HH:mm"
    let words = ["away": "assenza", "idle": "inattività", "max": "durata massima"]
    return "Spento · spento automaticamente alle \(output.string(from: date)) per \(words[reason] ?? reason)"
}

enum LinkState: Equatable { case on, off, starting, reconnecting, error }

struct LinkFacts {
    var jobRunning: Bool
    var ready: Bool
    var readyPreviously: Bool
    var unrecoveredPollFailure: Bool
    var withinGrace: Bool
    var commandError: String?
    var shutdownSentence: String?
    var connectedSentence: String?
}

struct LinkClassification { let state: LinkState; let sentence: String }

func classify(_ f: LinkFacts) -> LinkClassification {
    if let error = f.commandError { return .init(state: .error, sentence: "Errore: \(error)") }
    guard f.jobRunning else { return .init(state: .off, sentence: f.shutdownSentence ?? "Spento · spento da te") }
    if f.unrecoveredPollFailure && (f.ready || f.readyPreviously) { return .init(state: .reconnecting, sentence: "Riconnessione…") }
    if f.ready { return .init(state: .on, sentence: f.connectedSentence ?? "Connesso") }
    if f.withinGrace { return .init(state: .starting, sentence: "Avvio…") }
    return .init(state: .error, sentence: "Errore: NousOS non è pronto")
}
