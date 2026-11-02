// SPDX-License-Identifier: AGPL-3.0-only

import AppKit
import CaptureProtocol
import Carbon.HIToolbox
import Foundation
import UserNotifications

// agent: the helper's presence on the macOS desktop while "run" is up, the
// counterpart of the Linux tray, notifications and portal shortcuts. The helper starts it
// once (helper/internal/macagent) and drives it over the same socket protocol as a capture:
// it sends the menu (computed by the Linux tray code), notifications and shortcuts; the agent
// shows them and sends back clicks and key presses. It lives apart from the captures, which
// come and go with each stream, so a capture that fails never takes the menu bar item along.
//
// It runs as an accessory app: no Dock icon and no main menu, like LSUIElement in the app
// bundle's Info.plist. Everything here runs on the main thread.

/// The agent's menu bar item.
@MainActor
final class StatusMenu: NSObject {
    private var item: NSStatusItem?
    private let sink: SocketSink

    init(sink: SocketSink) {
        self.sink = sink
    }

    /// show replaces the icon, the tooltip and the menu. The item appears with the first menu,
    /// so a helper run with the tray turned off shows nothing.
    func show(_ m: AgentMenu) {
        let item = self.item ?? NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        self.item = item
        item.button?.image = StatusMenu.icon(m.icon)
        item.button?.toolTip = m.tooltip
        let menu = NSMenu()
        menu.autoenablesItems = false
        for it in m.items {
            if it.separator == true {
                menu.addItem(.separator())
                continue
            }
            let mi = NSMenuItem(title: it.label ?? "", action: #selector(clicked(_:)), keyEquivalent: "")
            mi.target = self
            mi.tag = Int(it.id)
            mi.isEnabled = it.enabled == true
            if let checked = it.checked {
                mi.state = checked ? .on : .off
            }
            menu.addItem(mi)
        }
        item.menu = menu
    }

    @objc private func clicked(_ sender: NSMenuItem) {
        sink.send(.json(.menuClick, MenuClick(id: Int32(sender.tag))))
    }

    /// The icon: SF Symbols, template images that follow the menu bar's appearance, except
    /// live, which is red like the web's live badge.
    static func icon(_ name: String) -> NSImage? {
        let symbol: String
        switch name {
        case "live": symbol = "record.circle.fill"
        case "paused": symbol = "pause.circle"
        case "curtain": symbol = "eye.slash.circle.fill"
        default: symbol = "dot.radiowaves.left.and.right"
        }
        guard let base = NSImage(systemSymbolName: symbol, accessibilityDescription: "Openlive") else { return nil }
        let size = NSImage.SymbolConfiguration(pointSize: 15, weight: .regular)
        if name == "live" {
            let image = base.withSymbolConfiguration(size.applying(.init(paletteColors: [.systemRed])))
            image?.isTemplate = false
            return image
        }
        let image = base.withSymbolConfiguration(size)
        image?.isTemplate = true
        return image
    }
}

/// Notifications through UserNotifications, which needs the process to run from an app bundle
/// (Bundle.main has an identifier). Without one, or when the person turned them off, the
/// helper keeps using osascript.
final class Notifier: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    private let sink: SocketSink
    private var center: UNUserNotificationCenter?
    private var state = ""

    init(sink: SocketSink) {
        self.sink = sink
    }

    static var bundled: Bool {
        Bundle.main.bundleIdentifier != nil && Bundle.main.bundleURL.pathExtension == "app"
    }

    func start() {
        guard Notifier.bundled else {
            report(NotificationState(state: "unavailable", error: "not in an app bundle: \(Bundle.main.bundlePath)"))
            return
        }
        let c = UNUserNotificationCenter.current()
        c.delegate = self
        center = c
        // The first time, macOS asks the person (a notification with Allow); later runs answer at once.
        c.requestAuthorization(options: [.alert, .sound]) { [self] granted, error in
            report(NotificationState(state: granted ? "authorized" : "denied", bundle: Bundle.main.bundleIdentifier, error: error.map { "\($0)" }))
        }
        // The person may change it in System Settings while the helper runs.
        NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.refresh()
        }
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.refresh() }
    }

    private func refresh() {
        center?.getNotificationSettings { [self] settings in
            let granted = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
            if settings.authorizationStatus != .notDetermined {
                report(NotificationState(state: granted ? "authorized" : "denied", bundle: Bundle.main.bundleIdentifier))
            }
        }
    }

    private func report(_ s: NotificationState) {
        DispatchQueue.main.async { [self] in
            guard s.state != state else { return }
            state = s.state
            log("notifications: \(s.state)\(s.error.map { " (\($0))" } ?? "")")
            sink.send(.json(.notifications, s))
        }
    }

    func post(_ n: Notify) {
        guard let center else { return }
        let content = UNMutableNotificationContent()
        content.title = n.title
        if let body = n.body { content.body = body }
        // The helper plays its own sounds (notify.Policy), as on Linux.
        if n.critical == true { content.interruptionLevel = .timeSensitive }
        let id = "openlive-\(n.id)"
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
            if let error { log("notification: \(error)") }
        }
        if n.transient == true {
            // Out of Notification Center once it has been seen, as transient ones on Linux.
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
                self?.center?.removeDeliveredNotifications(withIdentifiers: [id])
            }
        }
    }

    /// Shows banners although the agent counts as the active app.
    func userNotificationCenter(_: UNUserNotificationCenter, willPresent _: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void)
    {
        done([.banner, .list])
    }
}

/// Global shortcuts as Carbon hot keys: RegisterEventHotKey needs no Accessibility permission
/// (an event tap would). Registered exclusive, so a shortcut another app holds fails and is
/// reported as a conflict instead of firing in both.
final class HotkeyCenter {
    private let sink: SocketSink
    private var refs: [EventHotKeyRef] = []
    private var actions: [UInt32: String] = [:]
    private var handler: EventHandlerRef?
    /// 'OLVE', the signature of the helper's hot keys.
    private static let signature: OSType = 0x4F4C_5645

    init(sink: SocketSink) {
        self.sink = sink
    }

    func bind(_ bindings: [HotkeyBinding]) -> [HotkeyResult] {
        installHandler()
        refs.forEach { UnregisterEventHotKey($0) }
        refs.removeAll()
        actions.removeAll()
        var results: [HotkeyResult] = []
        for (i, b) in bindings.enumerated() {
            let id = EventHotKeyID(signature: HotkeyCenter.signature, id: UInt32(i + 1))
            var ref: EventHotKeyRef?
            let status = RegisterEventHotKey(b.keyCode, b.modifiers, id, GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &ref)
            if status == noErr, let ref {
                refs.append(ref)
                actions[id.id] = b.action
                results.append(HotkeyResult(action: b.action, trigger: b.trigger, ok: true))
            } else if status == OSStatus(eventHotKeyExistsErr) {
                results.append(HotkeyResult(action: b.action, trigger: b.trigger, ok: false, conflict: true, error: "another app uses this shortcut"))
            } else {
                results.append(HotkeyResult(action: b.action, trigger: b.trigger, ok: false, error: "RegisterEventHotKey: \(status)"))
            }
        }
        return results
    }

    private func installHandler() {
        guard handler == nil else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let me = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, data in
            guard let event, let data else { return OSStatus(eventNotHandledErr) }
            var id = EventHotKeyID()
            let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                           nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            guard status == noErr, id.signature == HotkeyCenter.signature else { return OSStatus(eventNotHandledErr) }
            Unmanaged<HotkeyCenter>.fromOpaque(data).takeUnretainedValue().pressed(id.id)
            return noErr
        }, 1, &spec, me, &handler)
    }

    private func pressed(_ id: UInt32) {
        guard let action = actions[id] else { return }
        sink.send(.json(.hotkey, Hotkey(action: action)))
    }
}

/// agent: hello, then the helper's messages until stop or the socket closes (the helper is
/// gone), which exits.
func serveAgent(sink: SocketSink) -> Never {
    signal(SIGPIPE, SIG_IGN)
    sink.onClosed = { exit(0) }
    let v = ProcessInfo.processInfo.operatingSystemVersion
    sink.send(.json(.hello, Hello(protocolVersion: protocolVersion, version: sidecarVersion, os: "macOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)")))
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let menu = MainActor.assumeIsolated { StatusMenu(sink: sink) }
    let notifier = Notifier(sink: sink)
    let hotkeys = HotkeyCenter(sink: sink)
    DispatchQueue.main.async { notifier.start() }
    sink.readMessages({ m in
        DispatchQueue.main.async {
            do {
                switch MessageType(rawValue: m.type) {
                case .menu:
                    let decoded = try m.decode(AgentMenu.self)
                    MainActor.assumeIsolated { menu.show(decoded) }
                case .notify:
                    notifier.post(try m.decode(Notify.self))
                case .hotkeys:
                    let results = hotkeys.bind(try m.decode(Hotkeys.self).bindings)
                    sink.send(.json(.hotkeysBound, HotkeysBound(results: results)))
                case .stop:
                    sink.flush()
                    exit(0)
                default:
                    log("agent: unexpected message 0x\(String(m.type, radix: 16))")
                }
            } catch {
                log("agent: bad message 0x\(String(m.type, radix: 16)): \(error)")
            }
        }
    }, closed: { DispatchQueue.main.async { exit(0) } })
    app.run()
    exit(0)
}
