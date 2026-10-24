import AppKit
import UserNotifications
import os

private let kit: String = {
    if let configured = ProcessInfo.processInfo.environment["NOUSOS_TUNNEL_KIT"], !configured.isEmpty {
        return configured
    }
    return URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("connector/nousos-tunnel.sh").path
}()
private let logDir = NSHomeDirectory() + "/Library/Logs/nousos-tunnel"
private let stateDir = NSHomeDirectory() + "/Library/Application Support/nousos-tunnel"

@main final class App: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private static var retainedDelegate: App?
    private let logger = Logger(subsystem: "com.nousos.menubar", category: "menubar")
    private let textMode = ProcessInfo.processInfo.environment["NOUSOS_MENU_TEXT"] == "1"

    static func main() {
        let logger = Logger(subsystem: "com.nousos.menubar", category: "menubar")
        logger.notice("entry: creating NSApplication and App delegate")
        let app = NSApplication.shared
        let delegate = App()
        retainedDelegate = delegate
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }

    var statusItem: NSStatusItem!
    var menu = NSMenu()
    var statusItemMenu: NSMenuItem!
    var connectedDetailItems: [NSMenuItem] = []
    var startItem: NSMenuItem!
    var stopItem: NSMenuItem!
    var presenceItem: NSMenuItem!
    var diagnosticWindow: NSWindow?
    var commandRunning = false
    var commandError: String?
    var beganAt: Date?
    var wasReady = false
    var classification: LinkClassification = .init(state: .off, sentence: "Spento")

    func applicationDidFinishLaunching(_ n: Notification) {
        logger.notice("applicationDidFinishLaunching entered")
        NSApp.setActivationPolicy(.accessory)
        UNUserNotificationCenter.current().delegate = self
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.autosaveName = "com.nousos.menubar"
        statusItem.button?.image = textMode ? nil : symbol("brain")
        statusItem.button?.title = (textMode || statusItem.button?.image == nil) ? "NousOS" : ""
        statusItem.isVisible = true
        logger.notice("statusItem created button=\(self.statusItem.button != nil) image=\(self.statusItem.button?.image != nil) isVisible=\(self.statusItem.isVisible)")
        makeMenu()
        poll()
        Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.poll() }
    }
    func symbol(_ name: String) -> NSImage? { let i = NSImage(systemSymbolName: name, accessibilityDescription: "NousOS"); i?.isTemplate = true; return i }
    func badged(_ base:String, badge:String)->NSImage? {
        guard let brain=symbol(base), let mark=symbol(badge) else{return symbol(base)}
        let image=NSImage(size:NSSize(width:18,height:18)); image.isTemplate=true
        image.lockFocus(); brain.draw(in:NSRect(x:0,y:1,width:16,height:16)); mark.draw(in:NSRect(x:10,y:0,width:8,height:8)); image.unlockFocus(); return image
    }
    func makeMenu() {
        statusItemMenu = NSMenuItem(title: "Spento", action: nil, keyEquivalent: ""); menu.addItem(statusItemMenu)
        connectedDetailItems = (0..<2).map { _ in NSMenuItem(title: "", action: nil, keyEquivalent: "") }
        connectedDetailItems.forEach { $0.isEnabled = false; menu.addItem($0) }
        menu.addItem(.separator())
        startItem = NSMenuItem(title: "Accendi NousOS", action: #selector(start), keyEquivalent: ""); startItem.target = self; menu.addItem(startItem)
        stopItem = NSMenuItem(title: "Spegni NousOS", action: #selector(stop), keyEquivalent: ""); stopItem.target = self; menu.addItem(stopItem)
        presenceItem = NSMenuItem(title: "Avvio automatico quando uso il Mac", action: #selector(togglePresence), keyEquivalent: ""); presenceItem.target = self; menu.addItem(presenceItem)
        menu.addItem(.separator())
        let d = NSMenuItem(title: "Diagnostica", action: #selector(diagnostics), keyEquivalent: ""); d.target = self; menu.addItem(d)
        let q = NSMenuItem(title: "Esci", action: #selector(quit), keyEquivalent: "q"); q.target = self; menu.addItem(q)
        statusItem.menu = menu
    }
    func run(_ args: [String], completion: @escaping (Int32, String) -> Void) {
        commandRunning = true; commandError = nil; refreshMenu()
        DispatchQueue.global(qos: .userInitiated).async {
            let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/zsh"); p.arguments = [kit] + args
            let out = Pipe(); p.standardOutput = out; p.standardError = out
            do { try p.run(); let data = out.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit(); let s = String(data: data, encoding: .utf8) ?? ""; DispatchQueue.main.async { self.commandRunning = false; if p.terminationStatus != 0 { self.commandError = s.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").last ?? "Comando non riuscito" }; completion(p.terminationStatus, s); self.poll() } }
            catch { DispatchQueue.main.async { self.commandRunning = false; self.commandError = error.localizedDescription; completion(-1, ""); self.poll() } }
        }
    }
    @objc func start() { beganAt = Date(); run(["start", "--presence"]) { _,_ in } }
    @objc func stop() { run(["stop"]) { _,_ in } }
    @objc func togglePresence() { run([presenceItem.state == .on ? "presence-disable" : "presence-enable"]) { _,_ in } }
    @objc func quit() { NSApp.terminate(nil) }
    func launchLoaded() -> Bool {
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/launchctl"); p.arguments = ["print", "gui/\(getuid())/com.nousos.tunnel"]
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        do { try p.run(); p.waitUntilExit(); return p.terminationStatus == 0 } catch { return false }
    }
    func poll() {
        DispatchQueue.global(qos: .utility).async {
            let running = self.launchLoaded()
            let ready = self.httpReady()
            let failure = self.hasUnrecoveredFailure()
            let ws = self.watchdogState()
            let kitStatus = self.runSync(["status"])
            let sentence = self.shutdownSentence(running: running, watchdog: ws)
        let connected = running ? self.connectedSentence(ws, status:kitStatus) : nil
            let age = self.beganAt.map { Date().timeIntervalSince($0) } ?? 999
            let c = classify(LinkFacts(jobRunning: running, ready: ready, readyPreviously: self.wasReady, unrecoveredPollFailure: failure, withinGrace: age < 60, commandError: self.commandError, shutdownSentence: sentence, connectedSentence: connected))
            if ready { self.wasReady = true }
            let keeper = FileManager.default.fileExists(atPath: NSHomeDirectory() + "/Library/LaunchAgents/com.nousos.tunnel.presence.plist")
            DispatchQueue.main.async { self.classification = c; self.presenceItem.state = keeper ? .on : .off; self.refreshMenu() }
        }
    }
    func httpReady() -> Bool { guard let u = URL(string: "http://127.0.0.1:47931/readyz") else { return false }; let sem = DispatchSemaphore(value: 0); var ok = false; URLSession.shared.dataTask(with: u) { _,r,_ in ok = (r as? HTTPURLResponse)?.statusCode == 200; sem.signal() }.resume(); _ = sem.wait(timeout: .now()+2); return ok }
    func hasUnrecoveredFailure() -> Bool {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: logDir + "/tunnel-client.ndjson")), let s = String(data: data, encoding: .utf8) else { return false }
        let lines = s.split(separator: "\n").suffix(2000); var failure: Date?
        for line in lines { guard let d = line.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String:Any], let t = o["time"] as? String, let date = ISO8601DateFormatter().date(from:t) else { continue }; let msg = o["msg"] as? String ?? ""; let level = o["level"] as? String ?? ""; if msg == "poll failed; backing off" && (level == "WARN" || level == "ERROR") { failure = date }; if (o["component"] as? String == "controlplane") && (msg.localizedCaseInsensitiveContains("poll succeeded") || msg.localizedCaseInsensitiveContains("poll recovered")) { failure = nil } }
        guard let f = failure else { return false }; return Date().timeIntervalSince(f) < 900
    }
    func watchdogState() -> [String] { (try? String(contentsOfFile: stateDir + "/watchdog.state", encoding: .utf8))?.components(separatedBy: .newlines) ?? [] }
    func shutdownSentence(running: Bool, watchdog: [String]) -> String? {
        guard !running else { return nil }
        if FileManager.default.fileExists(atPath:stateDir + "/manual-stop") { return "Spento · spento da te" }
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: logDir + "/watchdog.log")), let text = String(data:data, encoding:.utf8), let line = text.split(separator:"\n").last, let obj = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String:Any], let reason = obj["reason"] as? String, let ts = obj["ts"] as? String else { return nil }
        return formatShutdownSentence(timestamp: ts, reason: reason)
    }
    func connectedSentence(_ state:[String], status:String)->String {
        let values = (try? String(contentsOfFile: stateDir + "/watchdog.state", encoding: .utf8))?.components(separatedBy:"\n") ?? []
        guard values.count > 3 else { return "Connesso" }
        let mode = values.count > 4 ? values[4] : "idle"
        func minutes(_ key:String, fallback:Int)->Int { guard let line=status.split(separator:"\n").first(where:{$0.hasPrefix(key)}), let value=line.split(separator:":").last?.trimmingCharacters(in:.whitespaces), let n=Double(value) else{return fallback}; return Int(n.rounded(.up)) }
        let rawLimit = Int(values[mode == "presence" ? 5 : 2]) ?? 1200
        let limit = minutes("idle minutes left", fallback:rawLimit / 60)
        let maxLeft = minutes("max minutes left", fallback:120)
        let lines = connectedStatusLines(mode: mode, idleMinutes: max(1, limit), maxMinutes: maxLeft)
        return lines.joined(separator: "\n")
    }
    func refreshMenu() {
        statusItem.button?.alphaValue = 1
        statusItemMenu.title = classification.sentence
        let connectedLines = classification.state == .on ? classification.sentence.components(separatedBy: "\n") : []
        connectedDetailItems.forEach { $0.isHidden = connectedLines.count != 3 }
        if connectedLines.count == 3 {
            statusItemMenu.title = connectedLines[0]
            connectedDetailItems[0].title = connectedLines[1]
            connectedDetailItems[1].title = connectedLines[2]
        }
        switch classification.state { case .on: statusItem.button?.image = symbol("brain.fill"); case .reconnecting: statusItem.button?.image = badged("brain.fill",badge:"arrow.clockwise"); case .starting: let image = symbol("brain"); image?.isTemplate = true; statusItem.button?.image = image; statusItem.button?.alphaValue = 0.5; case .error: statusItem.button?.image = badged("brain",badge:"exclamationmark"); case .off: statusItem.button?.image = symbol("brain"); statusItem.button?.alphaValue = 1 }
        if textMode {
            statusItem.button?.image = nil
            statusItem.button?.title = "NousOS"
        } else {
            statusItem.button?.title = statusItem.button?.image == nil ? "NousOS" : ""
        }
        startItem.isEnabled = !commandRunning; stopItem.isEnabled = !commandRunning; presenceItem.isEnabled = !commandRunning
    }
    @objc func diagnostics() {
        let status = runSync(["status"])
        let watchdog = tail(logDir + "/watchdog.log", 10).map { plainWatchdog($0) }.joined(separator:"\n")
        let warnings = tail(logDir + "/tunnel-client.ndjson", 2000).compactMap { safeWarning($0) }.suffix(20).joined(separator:"\n")
        let gate = gateCounts()
        let content = "STATO KIT\n\(status)\n\nULTIMI EVENTI WATCHDOG\n\(watchdog)\n\nAVVISI TUNNEL\n\(warnings)\n\nDECISIONI DI OGGI\n\(gate)"
        let w = NSWindow(contentRect:NSRect(x:0,y:0,width:640,height:520), styleMask:[.titled,.closable,.miniaturizable], backing:.buffered, defer:false); w.title="Diagnostica NousOS"
        let view = NSView(frame:w.contentView!.bounds); let text = NSTextView(frame:NSRect(x:12,y:50,width:616,height:455)); text.isEditable=false; text.string=content; text.font=NSFont.monospacedSystemFont(ofSize:11,weight:.regular); let scroll=NSScrollView(frame:text.frame); scroll.documentView=text; scroll.hasVerticalScroller=true
        let copy=NSButton(title:"Copia", target:self, action:#selector(copyDiagnostics(_:))); copy.frame=NSRect(x:12,y:12,width:80,height:28); view.addSubview(scroll); view.addSubview(copy); w.contentView=view; diagnosticWindow=w; w.center(); w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps:true); text.string=content
    }
    @objc func copyDiagnostics(_ sender:NSButton) { if let t=diagnosticWindow?.contentView?.subviews.first(where:{$0 is NSScrollView}) as? NSScrollView, let text=t.documentView as? NSTextView { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text.string, forType:.string) } }
    func runSync(_ args:[String])->String { let p=Process(); p.executableURL=URL(fileURLWithPath:"/bin/zsh"); p.arguments=[kit]+args; let o=Pipe(); p.standardOutput=o; p.standardError=o; do { try p.run(); let d=o.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit(); return String(data:d,encoding:.utf8) ?? "" } catch { return error.localizedDescription } }
    func tail(_ path:String,_ count:Int)->[String] { guard let s=try? String(contentsOfFile:path,encoding:.utf8) else{return []}; return Array(s.split(separator:"\n").suffix(count).map(String.init)) }
    func plainWatchdog(_ line:String)->String { guard let o=(try? JSONSerialization.jsonObject(with:Data(line.utf8))) as? [String:Any] else{return "Evento watchdog"}; let reason=o["reason"] as? String ?? "evento"; let ts=o["ts"] as? String ?? ""; return "\(ts) · arresto per \(["away":"assenza","idle":"inattività","max":"durata massima"][reason] ?? reason)" }
    func safeWarning(_ line:String)->String? { guard let o=(try? JSONSerialization.jsonObject(with:Data(line.utf8))) as? [String:Any], ["WARN","ERROR"].contains(o["level"] as? String ?? "") else{return nil}; let time=o["time"] as? String ?? ""; let msg=o["msg"] as? String ?? "avviso"; let id=(o["tunnel_id"] as? String).map{String($0.prefix(13))} ?? ""; return "\(time) · \(msg)" + (id.isEmpty ? "" : " · \(id)") }
    func gateCounts()->String { let day=DateFormatter(); day.timeZone=TimeZone(secondsFromGMT:0); day.dateFormat="yyyyMMdd"; let lines=tail(logDir+"/gate-\(day.string(from:Date())).ndjson",100000); var counts:[String:Int]=[:]; for l in lines { if let o=(try? JSONSerialization.jsonObject(with:Data(l.utf8))) as? [String:Any] { let d=o["decision"] as? String ?? "unknown"; counts[d,default:0]+=1 } }; return counts.keys.sorted().map{"\($0): \(counts[$0]!)"}.joined(separator:"\n") }
    func userNotificationCenter(_ center:UNUserNotificationCenter, willPresent notification:UNNotification, withCompletionHandler completionHandler:@escaping(UNNotificationPresentationOptions)->Void){ completionHandler([]) }
}
