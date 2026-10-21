// macOS counterpart of VoiceScribe.Native.exe: the same JSON lines protocol
// (native/README.md), with a Quartz event tap instead of a keyboard hook and
// Command+V instead of Ctrl+V. Key codes are translated to Windows virtual-key
// codes, so shortcuts and settings are shared with Windows. Only recognized
// shortcuts leave this process; ordinary keys are never logged.
import AppKit
import ApplicationServices
import Foundation

// MARK: - Shortcut routing (the rules of HotkeyRouter in VoiceScribe.Native.cs)

final class HotkeyRouter {
    static let space = 0x20, escape = 0x1b, v = 0x56, leftWin = 0x5b, leftAlt = 0xa4, insert = 0x2d, enter = 0x0d
    private let clock: () -> Int64
    private let emit: ([String: Any]) -> Void
    private var suppressed = Set<Int>()
    private var dictationPressed = false
    private var chordDown = false
    private var pressedAt: Int64 = 0
    private(set) var hotkey = "ctrl-space"
    private var custom: (key: Int, control: Bool, alt: Bool, shift: Bool, win: Bool)?
    var active = false
    /// Set by capture-hotkey: the next non-modifier key press is reported and swallowed.
    var capturing = false
    /// Bare Return during a dictation finishes it and presses Return after insertion.
    var enterFinishes = false
    /// State of a key other than the one being handled.
    var keyDown: (Int) -> Bool = { _ in false }

    init(clock: @escaping () -> Int64, emit: @escaping ([String: Any]) -> Void) {
        self.clock = clock
        self.emit = emit
    }

    static func isShiftOrControl(_ key: Int) -> Bool { [0x10, 0xa0, 0xa1, 0x11, 0xa2, 0xa3].contains(key) }
    static func isModifier(_ key: Int) -> Bool {
        isShiftOrControl(key) || key == 0x12 || key == 0xa4 || key == 0xa5 || key == leftWin || key == 0x5c
    }

    /// "key:" + optional "ctrl+", "alt+", "shift+", "win+" in this order + a virtual-key code.
    static func parseCustom(_ value: String) -> (key: Int, control: Bool, alt: Bool, shift: Bool, win: Bool)? {
        guard value.hasPrefix("key:") else { return nil }
        var rest = Substring(value.dropFirst(4))
        var control = false, alt = false, shift = false, win = false
        if rest.hasPrefix("ctrl+") { control = true; rest = rest.dropFirst(5) }
        if rest.hasPrefix("alt+") { alt = true; rest = rest.dropFirst(4) }
        if rest.hasPrefix("shift+") { shift = true; rest = rest.dropFirst(6) }
        if rest.hasPrefix("win+") { win = true; rest = rest.dropFirst(4) }
        guard (1...3).contains(rest.count), rest.allSatisfy({ $0 >= "0" && $0 <= "9" }), let key = Int(rest) else { return nil }
        guard key >= 0x07 && key <= 0xfe && key != 0xe8 && key != escape && !isModifier(key) else { return nil }
        return (key, control, alt, shift, win)
    }

    static func isHotkey(_ value: String?) -> Bool {
        guard let value else { return false }
        return ["ctrl-space", "ctrl-alt-space", "win-alt", "insert"].contains(value) || parseCustom(value) != nil
    }

    func setHotkey(_ value: String) -> Bool {
        guard HotkeyRouter.isHotkey(value) else { return false }
        hotkey = value
        custom = HotkeyRouter.parseCustom(value)
        dictationPressed = false
        chordDown = false
        return true
    }

    private func releasesDictation(_ key: Int) -> Bool {
        if let custom {
            if key == custom.key { return true }
            if custom.control && [0x11, 0xa2, 0xa3].contains(key) { return true }
            if custom.alt && [0x12, 0xa4, 0xa5].contains(key) { return true }
            if custom.shift && [0x10, 0xa0, 0xa1].contains(key) { return true }
            return custom.win && (key == HotkeyRouter.leftWin || key == 0x5c)
        }
        if hotkey == "insert" { return key == HotkeyRouter.insert }
        if [HotkeyRouter.space, 0x11, 0xa2, 0xa3].contains(key) { return true }
        return hotkey == "ctrl-alt-space" && [0x12, 0xa4, 0xa5].contains(key)
    }

    private func emitDictationUp() {
        dictationPressed = false
        emit(["event": "hotkey", "action": "dictation-up", "heldMs": max(0, clock() - pressedAt)])
    }

    private func press() {
        dictationPressed = true
        pressedAt = clock()
    }

    /// Left Command + left Option. Modifiers are never swallowed.
    private func handleChord(_ key: Int, down: Bool, control: Bool, shift: Bool, target: () -> String) -> Bool {
        let other = key == HotkeyRouter.leftWin ? HotkeyRouter.leftAlt : HotkeyRouter.leftWin
        if !down {
            let wasDown = chordDown
            chordDown = false
            if wasDown && dictationPressed { emitDictationUp() }
            return false
        }
        if !keyDown(other) { chordDown = false; return false }
        if chordDown || control { return false }
        chordDown = true
        var action: String?
        if !shift { action = "dictation-down"; press() } else if active { action = "finish" }
        if let action { emit(["event": "hotkey", "action": action, "target": target()]) }
        return false
    }

    /// True when the key must be swallowed. `target` is evaluated only when a shortcut fires.
    func handle(_ key: Int, down: Bool, control: Bool, shift: Bool, alt: Bool, win: Bool, target: () -> String) -> Bool {
        if capturing && down && !HotkeyRouter.isModifier(key) {
            capturing = false
            suppressed.insert(key)
            emit(["event": "hotkey-captured", "key": key, "ctrl": control, "alt": alt, "shift": shift, "win": win])
            return true
        }
        let chord = hotkey == "win-alt"
        if chord && (key == HotkeyRouter.leftWin || key == HotkeyRouter.leftAlt) {
            return handleChord(key, down: down, control: control, shift: shift, target: target)
        }
        if !down {
            // Releasing any part of the shortcut ends push-to-talk. Never swallow modifiers.
            if !chord && dictationPressed && releasesDictation(key) { emitDictationUp() }
            return suppressed.remove(key) != nil
        }
        if suppressed.contains(key) { return true } // Swallow auto-repeat.
        if chord && chordDown && dictationPressed && !HotkeyRouter.isShiftOrControl(key) {
            // Command+Option+<key> is another shortcut: drop the recording this press started.
            dictationPressed = false
            emit(["event": "hotkey", "action": "dictation-abort"])
            return false
        }

        var action: String?
        if let custom, key == custom.key, control == custom.control, alt == custom.alt, shift == custom.shift, win == custom.win {
            action = "dictation-down"; press()
        } else if hotkey == "insert" && key == HotkeyRouter.insert && !control && !shift && !alt && !win {
            action = "dictation-down"; press()
        } else if !chord && custom == nil && hotkey != "insert" && key == HotkeyRouter.space && control
                    && alt == (hotkey == "ctrl-alt-space") && !win {
            if !shift { action = "dictation-down"; press() }
            // The shortcut plus Shift finishes a running dictation; while idle it passes through.
            else if active { action = "finish" }
        } else if key == HotkeyRouter.v && control && alt && !shift && !win {
            action = "paste-last"
        } else if key == HotkeyRouter.escape && active && !control && !shift && !alt && !win {
            action = "cancel"
        } else if key == HotkeyRouter.enter && active && enterFinishes && !control && !shift && !alt && !win {
            action = "finish-enter"
        }
        guard let action else { return false }
        suppressed.insert(key)
        emit(["event": "hotkey", "action": action, "target": target()])
        return true
    }
}

// MARK: - macOS key codes → Windows virtual-key codes

enum Keys {
    /// kVK_* codes of ordinary keys. Keys missing here never form a shortcut.
    static let virtualKeys: [Int64: Int] = {
        var map: [Int64: Int] = [
            0x00: 0x41, 0x0B: 0x42, 0x08: 0x43, 0x02: 0x44, 0x0E: 0x45, 0x03: 0x46, 0x05: 0x47, 0x04: 0x48,
            0x22: 0x49, 0x26: 0x4A, 0x28: 0x4B, 0x25: 0x4C, 0x2E: 0x4D, 0x2D: 0x4E, 0x1F: 0x4F, 0x23: 0x50,
            0x0C: 0x51, 0x0F: 0x52, 0x01: 0x53, 0x11: 0x54, 0x20: 0x55, 0x09: 0x56, 0x0D: 0x57, 0x07: 0x58,
            0x10: 0x59, 0x06: 0x5A,
            0x1D: 0x30, 0x12: 0x31, 0x13: 0x32, 0x14: 0x33, 0x15: 0x34, 0x17: 0x35, 0x16: 0x36, 0x1A: 0x37, 0x1C: 0x38, 0x19: 0x39,
            0x31: 0x20, 0x24: 0x0D, 0x4C: 0x0D, 0x30: 0x09, 0x33: 0x08, 0x75: 0x2E, 0x35: 0x1B,
            0x7B: 0x25, 0x7E: 0x26, 0x7C: 0x27, 0x7D: 0x28, 0x73: 0x24, 0x77: 0x23, 0x74: 0x21, 0x79: 0x22, 0x72: 0x2D,
            0x29: 0xBA, 0x18: 0xBB, 0x2B: 0xBC, 0x1B: 0xBD, 0x2F: 0xBE, 0x2C: 0xBF, 0x32: 0xC0,
            0x21: 0xDB, 0x2A: 0xDC, 0x1E: 0xDD, 0x27: 0xDE, 0x0A: 0xE2,
            0x52: 0x60, 0x53: 0x61, 0x54: 0x62, 0x55: 0x63, 0x56: 0x64, 0x57: 0x65, 0x58: 0x66, 0x59: 0x67, 0x5B: 0x68, 0x5C: 0x69,
            0x43: 0x6A, 0x45: 0x6B, 0x4E: 0x6D, 0x41: 0x6E, 0x4B: 0x6F, 0x47: 0x0C,
            0x48: 0xAF, 0x49: 0xAE, 0x4A: 0xAD,
        ]
        // F1–F20.
        let functionKeys: [Int64] = [0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F, 0x69, 0x6B, 0x71, 0x6A, 0x40, 0x4F, 0x50, 0x5A]
        for (index, code) in functionKeys.enumerated() { map[code] = 0x70 + index }
        return map
    }()

    /// Modifier key codes → (Windows virtual key, NX_DEVICE* bit in the event flags).
    static let modifiers: [Int64: (key: Int, bit: UInt64)] = [
        0x37: (0x5B, 0x08), 0x36: (0x5C, 0x10), 0x3A: (0xA4, 0x20), 0x3D: (0xA5, 0x40),
        0x3B: (0xA2, 0x01), 0x3E: (0xA3, 0x2000), 0x38: (0xA0, 0x02), 0x3C: (0xA1, 0x04),
    ]

    static func macCode(ofModifier key: Int) -> CGKeyCode? {
        modifiers.first(where: { $0.value.key == key }).map { CGKeyCode($0.key) }
    }

    static let v: CGKeyCode = 0x09, returnKey: CGKeyCode = 0x24
}

// MARK: - Process

let ownMarker: Int64 = 0x56534352 // "VSCR": events this helper posts itself.
let startTime = DispatchTime.now().uptimeNanoseconds
func now() -> Int64 { Int64((DispatchTime.now().uptimeNanoseconds - startTime) / 1_000_000) }

let output = DispatchQueue(label: "voice-scribe.output")
/// Output never blocks the event tap: macOS disables slow taps.
func emit(_ value: [String: Any]) {
    output.async {
        guard JSONSerialization.isValidJSONObject(value),
              var data = try? JSONSerialization.data(withJSONObject: value) else { return }
        data.append(0x0A)
        FileHandle.standardOutput.write(data)
    }
}

/// JSON booleans only; JSONSerialization also turns 0 and 1 into NSNumber.
func boolean(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
}

func reply(_ id: Any?, _ ok: Bool, _ error: String? = nil, _ extra: [String: Any] = [:]) {
    var result = extra
    result["id"] = id ?? NSNull()
    result["ok"] = ok
    if let error { result["error"] = error }
    emit(result)
}

final class Helper {
    let router: HotkeyRouter
    private var tap: CFMachPort?
    private var permissionTimer: Timer?
    private var reportedPermission: String?
    private var pending: PendingInsert?
    private var insertTimer: Timer?
    private let source = CGEventSource(stateID: .privateState)

    struct PendingInsert {
        var id: Any?
        var target: pid_t
        var enter: Bool
        var pasteSent = false
        var deadline: Int64
        var enterAfter: Int64 = 0
    }

    init() {
        router = HotkeyRouter(clock: now, emit: { value in
            // Escape cancels a pending insertion synchronously, before the parent hears of it.
            if value["action"] as? String == "cancel", let result = Helper.shared?.cancelledResult() { emit(value); emit(result) }
            else { emit(value) }
        })
        router.keyDown = { key in
            guard let code = Keys.macCode(ofModifier: key) else { return false }
            return CGEventSource.keyState(.combinedSessionState, key: code)
        }
        source?.userData = ownMarker
    }

    static var shared: Helper?

    // MARK: Permissions and the event tap

    func start() {
        if installTap() { return }
        permissionTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] timer in
            if self?.installTap() == true { timer.invalidate() }
        }
    }

    /// Accessibility lets the tap swallow shortcuts and lets this helper post Command+V.
    private func installTap() -> Bool {
        if !AXIsProcessTrusted() {
            needPermission("accessibility") {
                _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            }
            return false
        }
        let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue) | (1 << CGEventType.flagsChanged.rawValue)
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                          eventsOfInterest: CGEventMask(mask), callback: { _, type, event, _ in
            guard let helper = Helper.shared else { return Unmanaged.passUnretained(event) }
            return helper.handle(type, event)
        }, userInfo: nil) else {
            needPermission("input-monitoring") { if #available(macOS 10.15, *) { _ = CGRequestListenEventAccess() } }
            return false
        }
        self.tap = tap
        let loopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), loopSource, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        emit(["event": "ready", "protocol": 1, "pid": Int(getpid())])
        return true
    }

    /// Reported once per missing permission; the parent explains it, and the tap appears when it is granted.
    private func needPermission(_ name: String, prompt: () -> Void) {
        if reportedPermission == name { return }
        reportedPermission = name
        prompt()
        emit(["event": "permission", "permission": name])
    }

    private func handle(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        if event.getIntegerValueField(.eventSourceUserData) == ownMarker { return Unmanaged.passUnretained(event) }
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        let flags = event.flags
        let key: Int
        let down: Bool
        if type == .flagsChanged {
            guard let modifier = Keys.modifiers[code] else { return Unmanaged.passUnretained(event) }
            key = modifier.key
            down = flags.rawValue & modifier.bit != 0
        } else {
            guard let virtualKey = Keys.virtualKeys[code] else { return Unmanaged.passUnretained(event) }
            key = virtualKey
            down = type == .keyDown
        }
        let swallow = router.handle(key, down: down, control: flags.contains(.maskControl), shift: flags.contains(.maskShift),
                                    alt: flags.contains(.maskAlternate), win: flags.contains(.maskCommand),
                                    target: { Helper.frontmost().map { String($0) } ?? "0" })
        return swallow ? nil : Unmanaged.passUnretained(event)
    }

    static func frontmost() -> pid_t? { NSWorkspace.shared.frontmostApplication?.processIdentifier }

    // MARK: Commands

    func process(_ command: [String: Any]) {
        let id = command["id"]
        switch command["command"] as? String {
        case "set-active":
            guard let value = boolean(command["active"]) else { return reply(id, false, "active-must-be-boolean") }
            router.active = value
            reply(id, true)
        case "set-enter-finish":
            guard let value = boolean(command["enabled"]) else { return reply(id, false, "enabled-must-be-boolean") }
            router.enterFinishes = value
            reply(id, true)
        case "set-hotkey":
            guard let value = command["hotkey"] as? String, router.setHotkey(value) else { return reply(id, false, "unknown-hotkey") }
            reply(id, true)
        case "capture-hotkey":
            router.capturing = true
            reply(id, true)
        case "cancel-capture":
            router.capturing = false
            reply(id, true)
        case "get-target":
            reply(id, true, nil, ["target": Helper.frontmost().map { String($0) } ?? "0"])
        case "window-info":
            guard let pid = Helper.pid(command["target"]) else { return reply(id, false, "invalid-target") }
            guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return reply(id, false, "window-gone") }
            let name = app.executableURL?.lastPathComponent ?? app.localizedName
            reply(id, true, nil, ["process": name.map { $0 as Any } ?? NSNull()])
        case "diagnostics":
            var value = Helper.diagnostics()
            value["keyboardHookInstalled"] = tap != nil
            reply(id, true, nil, value)
        case "insert":
            beginInsert(id, command)
        case "cancel-insert":
            let result = cancelledResult()
            reply(id, true, nil, ["cancelled": result != nil])
            if let result { emit(result) }
        case "quit":
            reply(id, true)
            output.async { exit(0) }
        default:
            reply(id, false, "unknown-command")
        }
    }

    static func diagnostics() -> [String: Any] {
        ["protocol": 1, "platform": "darwin", "pointerBytes": MemoryLayout<Int>.size, "inputLayoutValid": true,
         "accessibility": AXIsProcessTrusted(), "keyboardHookInstalled": false,
         "macOS": ProcessInfo.processInfo.operatingSystemVersionString]
    }

    /// Targets are process ids as decimal strings, the counterpart of HWNDs on Windows.
    static func pid(_ value: Any?) -> pid_t? {
        guard let text = value as? String, let number = Int32(text), number > 0 else { return nil }
        return number
    }

    // MARK: Insertion (the parent writes the clipboard first)

    private func beginInsert(_ id: Any?, _ command: [String: Any]) {
        if pending != nil { return reply(id, false, "insert-busy") }
        let enter = command["enter"]
        if enter != nil && !(enter is NSNull) && boolean(enter) == nil { return reply(id, false, "enter-must-be-boolean") }
        guard let target = Helper.pid(command["target"]) else { return reply(id, false, "invalid-target") }
        pending = PendingInsert(id: id, target: target, enter: boolean(enter) ?? false, deadline: now() + 1500)
        advanceInsert()
        if pending != nil {
            insertTimer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in self?.advanceInsert() }
        }
    }

    private func modifiersDown() -> Bool {
        let flags = CGEventSource.flagsState(.combinedSessionState)
        return !flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty
            || CGEventSource.keyState(.combinedSessionState, key: Keys.v)
            || CGEventSource.keyState(.combinedSessionState, key: Keys.returnKey) // Avoid interleaving physical V/Return.
    }

    private func post(_ key: CGKeyCode, flags: CGEventFlags) -> Bool {
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else { return false }
            event.flags = flags
            event.setIntegerValueField(.eventSourceUserData, value: ownMarker)
            event.post(tap: .cghidEventTap)
        }
        return true
    }

    private func advanceInsert() {
        guard var operation = pending else { return }
        if Helper.frontmost() != operation.target {
            return finishInsert(operation.pasteSent ? "inserted" : "clipboard-only", "target-changed", false)
        }
        let time = now()
        if modifiersDown() {
            if time >= operation.deadline { finishInsert(operation.pasteSent ? "inserted" : "clipboard-only", "modifiers-held", false) }
            return
        }
        if !operation.pasteSent {
            guard AXIsProcessTrusted(), post(Keys.v, flags: .maskCommand) else { return finishInsert("clipboard-only", "input-blocked", false) }
            operation.pasteSent = true
            if !operation.enter { pending = operation; return finishInsert("inserted", nil, false) }
            operation.enterAfter = time + 150
            pending = operation
            return
        }
        if time < operation.enterAfter { return }
        let entered = post(Keys.returnKey, flags: [])
        finishInsert("inserted", entered ? nil : "enter-blocked", entered)
    }

    private func result(_ operation: PendingInsert, _ status: String, _ reason: String?, _ entered: Bool) -> [String: Any] {
        var value: [String: Any] = ["id": operation.id ?? NSNull(), "ok": true, "status": status, "entered": entered]
        if let reason { value["reason"] = reason }
        return value
    }

    private func finishInsert(_ status: String, _ reason: String?, _ entered: Bool) {
        guard let operation = pending else { return }
        pending = nil
        insertTimer?.invalidate()
        insertTimer = nil
        emit(result(operation, status, reason, entered))
    }

    /// Drops a pending insertion; its original request resolves with `cancelled`.
    func cancelledResult() -> [String: Any]? {
        guard let operation = pending else { return nil }
        pending = nil
        insertTimer?.invalidate()
        insertTimer = nil
        return result(operation, operation.pasteSent ? "inserted" : "clipboard-only", "cancelled", false)
    }
}

// MARK: - Self-test: shortcut routing with a fake clock and no system input

func selfTest() -> Int32 {
    var checks = 0, failures: [String] = []
    func check(_ condition: Bool, _ name: String) { checks += 1; if !condition { failures.append(name) } }
    var time: Int64 = 0
    var events: [[String: Any]] = []
    var held = Set<Int>()
    let router = HotkeyRouter(clock: { time }, emit: { events.append($0) })
    router.keyDown = { held.contains($0) }
    func key(_ code: Int, _ down: Bool, ctrl: Bool = false, shift: Bool = false, alt: Bool = false, win: Bool = false) -> Bool {
        router.handle(code, down: down, control: ctrl, shift: shift, alt: alt, win: win, target: { "42" })
    }
    func last() -> String? { events.last?["action"] as? String }

    check(key(0x20, true, ctrl: true), "ctrl+space is swallowed")
    check(last() == "dictation-down" && events.last?["target"] as? String == "42", "ctrl+space starts with the target")
    check(key(0x20, true, ctrl: true), "auto-repeat is swallowed")
    check(events.count == 1, "auto-repeat emits nothing")
    time = 500
    check(key(0x20, false, ctrl: true), "release of a swallowed key is swallowed")
    check(last() == "dictation-up" && events.last?["heldMs"] as? Int64 == 500, "release reports the hold")
    check(!key(0x1B, true), "Escape passes while idle")
    router.active = true
    check(key(0x1B, true), "Escape cancels while active")
    check(last() == "cancel", "cancel emitted")
    _ = key(0x1B, false)
    check(!key(0x1B, true, shift: true), "Shift+Escape passes")
    check(!key(0x0D, true), "Return passes without enter-finish")
    router.enterFinishes = true
    check(key(0x0D, true) && last() == "finish-enter", "Return finishes while active")
    _ = key(0x0D, false)
    check(key(0x20, true, ctrl: true, shift: true) && last() == "finish", "shortcut plus Shift finishes")
    _ = key(0x20, false, ctrl: true, shift: true)
    router.active = false
    check(!key(0x20, true, ctrl: true, shift: true), "shortcut plus Shift passes while idle")
    check(key(0x56, true, ctrl: true, alt: true) && last() == "paste-last", "⌃⌥V pastes the last text")
    _ = key(0x56, false)
    check(!key(0x20, true, ctrl: true, alt: true), "⌃⌥Space is not the default")

    check(router.setHotkey("key:alt+32"), "Option+Space is accepted")
    check(!router.setHotkey("key:27") && !router.setHotkey("key:ctrl+162") && !router.setHotkey("bogus"), "invalid shortcuts are rejected")
    check(router.hotkey == "key:alt+32", "a rejected shortcut keeps the previous one")
    events.removeAll()
    check(!key(0x20, true, ctrl: true), "Control+Space passes with a custom shortcut")
    check(!key(0x20, true, shift: true, alt: true), "extra modifiers do not match")
    check(key(0x20, true, alt: true) && last() == "dictation-down", "custom shortcut starts")
    time = 700
    check(!key(0xA4, false) && last() == "dictation-up", "releasing Option ends a hold and passes")
    check(key(0x20, false), "space release is swallowed")

    check(router.setHotkey("insert"), "insert preset")
    check(!key(0x2D, true, shift: true), "Shift+Help passes")
    check(key(0x2D, true) && last() == "dictation-down", "bare Help starts")
    _ = key(0x2D, false)

    check(router.setHotkey("win-alt"), "chord preset")
    events.removeAll()
    held = [0xA4]
    check(!key(0x5B, true, alt: true, win: true), "chord never swallows Command")
    check(last() == "dictation-down", "chord starts")
    check(!key(0x41, true, alt: true, win: true) && last() == "dictation-abort", "a third key aborts")
    _ = key(0x41, false)
    held = []
    check(!key(0x5B, false), "chord release passes")

    router.capturing = true
    check(!key(0xA2, true, ctrl: true), "capture ignores modifiers")
    check(key(0x78, true, ctrl: true) && events.last?["event"] as? String == "hotkey-captured" && events.last?["key"] as? Int == 0x78, "capture reports a key")
    check(key(0x78, false), "captured key release is swallowed")
    check(!router.capturing, "capture is one-shot")

    check(Keys.virtualKeys[0x31] == 0x20 && Keys.virtualKeys[0x09] == 0x56 && Keys.virtualKeys[0x7A] == 0x70 && Keys.virtualKeys[0x5A] == 0x83, "key codes translate")

    let ok = failures.isEmpty
    var report: [String: Any] = ["event": "self-test", "ok": ok, "checks": checks]
    if !ok { report["failures"] = failures }
    emit(report)
    output.sync {}
    return ok ? 0 : 1
}

// MARK: - Main

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments == ["--self-test"] { exit(selfTest()) }
if arguments == ["--diagnostics"] {
    var value = Helper.diagnostics()
    value["event"] = "diagnostics"
    emit(value)
    output.sync {}
    exit(0)
}
if !arguments.isEmpty {
    emit(["event": "error", "error": "unknown-argument"])
    output.sync {}
    exit(2)
}

// An application without a Dock icon, so the workspace reports the frontmost app as it changes.
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
let helper = Helper()
Helper.shared = helper

Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        guard line.utf8.count <= 16384 else { reply(nil, false, "command-too-large"); continue }
        guard let data = line.data(using: .utf8),
              let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            reply(nil, false, "invalid-json-command")
            continue
        }
        DispatchQueue.main.async { helper.process(command) }
    }
    // The parent closed stdin or exited: the tap goes away with the process.
    output.async { exit(0) }
}
DispatchQueue.main.async { helper.start() }
application.run()
