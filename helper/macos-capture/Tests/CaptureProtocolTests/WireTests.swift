// SPDX-License-Identifier: AGPL-3.0-only

import CaptureProtocol
import Foundation
import XCTest

// The hex vectors are the same as helper/internal/sidecar/wire_test.go's, so both sides agree
// on the bytes.
final class WireTests: XCTestCase {
    func hex(_ s: String) -> Data {
        var out = Data()
        var it = s.replacingOccurrences(of: " ", with: "").makeIterator()
        while let a = it.next(), let b = it.next() {
            out.append(UInt8(String([a, b]), radix: 16)!)
        }
        return out
    }

    func testControlVectors() throws {
        let cases: [(Control, String)] = [
            (.keyframe(layer: 2), "00000002 21 02"),
            (.bitrate(layer: 1, kbps: 3500), "00000006 22 01 00000dac"),
            (.fps(layer: 0, fps: 120), "00000004 23 00 0078"),
            (.stop, "00000001 24"),
            (.curtain(on: true), "00000002 25 01"),
            (.curtain(on: false), "00000002 25 00"),
        ]
        for (control, want) in cases {
            XCTAssertEqual(control.message().encoded(), hex(want), "\(control)")
            var r = MessageReader()
            r.feed(hex(want))
            let m = try XCTUnwrap(try r.next())
            XCTAssertEqual(try Control(m), control)
        }
    }

    func testVideoVector() throws {
        let h = VideoHeader(layer: 1, keyframe: true, ptsNanos: 0x0102_0304_0506_0708, encodeMicros: 1500)
        let wire = h.message(Data([0, 0, 0, 1, 0x65])).encoded()
        XCTAssertEqual(wire, hex("00000014 03 01 01 0102030405060708 000005dc 0000000165"))
        var r = MessageReader()
        r.feed(wire)
        let m = try XCTUnwrap(try r.next())
        let (back, data) = try m.payload.videoHeader()
        XCTAssertEqual(back, h)
        XCTAssertEqual(data, Data([0, 0, 0, 1, 0x65]))
    }

    func testAudioVector() throws {
        let h = AudioHeader(ptsNanos: 20_000_000, durationMicros: 20000)
        let wire = h.message(Data([0xF8, 0xFF, 0xFE])).encoded()
        XCTAssertEqual(wire, hex("00000010 04 0000000001312d00 00004e20 f8fffe"))
        var r = MessageReader()
        r.feed(wire)
        let (back, packet) = try XCTUnwrap(try r.next()).payload.audioHeader()
        XCTAssertEqual(back, h)
        XCTAssertEqual(packet, Data([0xF8, 0xFF, 0xFE]))
    }

    func testReaderSplitsAndJoins() throws {
        let a = Message(.stats, Data("{}".utf8)).encoded()
        let b = Control.stop.message().encoded()
        var stream = a + b
        var r = MessageReader()
        // Byte by byte: nothing until a message is complete.
        var got: [Message] = []
        while !stream.isEmpty {
            r.feed(stream.prefix(1))
            stream = stream.dropFirst()
            while let m = try r.next() { got.append(m) }
        }
        XCTAssertEqual(got.map(\.type), [MessageType.stats.rawValue, MessageType.stop.rawValue])
    }

    func testReaderRefusesBadLengths() {
        var r = MessageReader()
        r.feed(hex("00000000"))
        XCTAssertThrowsError(try r.next())
        var big = MessageReader()
        big.feed(hex("7fffffff 03"))
        XCTAssertThrowsError(try big.next())
    }

    func testConfigJSON() throws {
        // What the Go helper sends (sidecar.Config), keys as Go marshals them.
        let json = #"{"source":{"kind":"display","id":1},"layers":[{"rid":"f","width":1920,"height":1080,"fps":60,"kbps":8000,"vbvMs":250}],"gopSeconds":10,"cursor":true,"audio":{"pid":42},"thumbnail":{"width":320,"everyMs":2000}}"#
        let m = Message(.config, Data(json.utf8))
        let c = try m.decode(Config.self)
        XCTAssertEqual(c.source, SourceRef(kind: "display", id: 1))
        XCTAssertEqual(c.layers.first?.fps, 60)
        XCTAssertEqual(c.audio?.pid, 42)
        XCTAssertNil(c.audio?.bundleId)
    }

    func testAgentJSON() throws {
        // What the Go helper sends (sidecar.Menu, sidecar.Hotkeys), as wire_test.go's TestAgentJSON.
        let menu = #"{"icon":"live","tooltip":"Live","items":[{"id":1,"label":"Live"},{"id":10,"separator":true},{"id":12,"label":"Privacy curtain","enabled":true,"checked":true}]}"#
        let m = try Message(.menu, Data(menu.utf8)).decode(AgentMenu.self)
        XCTAssertEqual(m.icon, "live")
        XCTAssertEqual(m.items[1].separator, true)
        XCTAssertEqual(m.items[2], AgentMenuItem(id: 12, label: "Privacy curtain", enabled: true, checked: true))
        XCTAssertNil(m.items[0].enabled)
        let hk = #"{"bindings":[{"action":"curtain","trigger":"CTRL+ALT+SHIFT+h","keyCode":4,"modifiers":6656}]}"#
        let h = try Message(.hotkeys, Data(hk.utf8)).decode(Hotkeys.self)
        XCTAssertEqual(h.bindings, [HotkeyBinding(action: "curtain", trigger: "CTRL+ALT+SHIFT+h", keyCode: 4, modifiers: 6656)])
        // What the agent answers, as the Go side reads it.
        let bound = Message.json(.hotkeysBound, HotkeysBound(results: [HotkeyResult(action: "stop", trigger: "CTRL+ALT+SHIFT+x", ok: false, conflict: true, error: "taken")]))
        XCTAssertEqual(String(decoding: bound.payload, as: UTF8.self),
                       #"{"results":[{"action":"stop","conflict":true,"error":"taken","ok":false,"trigger":"CTRL+ALT+SHIFT+x"}]}"#)
        // A press has no "released"; a release does (push-to-talk).
        XCTAssertEqual(String(decoding: Message.json(.hotkey, Hotkey(action: "talk")).payload, as: UTF8.self), #"{"action":"talk"}"#)
        XCTAssertEqual(String(decoding: Message.json(.hotkey, Hotkey(action: "talk", released: true)).payload, as: UTF8.self),
                       #"{"action":"talk","released":true}"#)
    }
}
