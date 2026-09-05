const assert = require("assert")
const A = require("../Actions.js")
const C = require("../Config.js")
const D = require("../Devices.js")
const Dpi = require("../Dpi.js")
const fs = require("fs")

// The path the generated DPI binds call back into.
const HELPER = "/home/somebody/.config/omarchy/plugins/x/scripts/mousemap"

// ---------------------------------------------------------------- escaping

// Everything that reaches the generated file must come back as a single
// quoted Lua literal, because that file is executed by the compositor.
assert.strictEqual(A.luaString('a"b'), '"a\\"b"')
assert.strictEqual(A.luaString("a\\b"), '"a\\\\b"')
assert.strictEqual(A.luaString("a\nb"), '"a\\nb"')
assert.strictEqual(A.luaString("ab"), '"a\\7b"')

// Substring checks prove nothing here - the real question is what the Lua
// parser makes of the output. Round-trip each hostile string through the
// actual interpreter and require it back byte for byte, which is only
// possible if it stayed exactly one string literal.
const { execFileSync } = require("child_process")
function luaRoundTrip(value) {
  return execFileSync("lua", ["-e", `io.write(${A.luaString(value)})`], { encoding: "utf8" })
}
for (const hostile of [
  '"); os.execute("touch /tmp/mousemap-pwned"); ("',  // close string, run code
  "]]..os.execute('x')..[[",                          // break out of a long bracket
  'a\\"); print(1); ("',                              // pre-escaped quote
  "tab\there and newline\nhere",
  "back\\slash",
  "bell\x07and control\x1b[31m",
  "unicode OK e-acute mouse"
]) {
  assert.strictEqual(luaRoundTrip(hostile), hostile,
    `lua round-trip failed for ${JSON.stringify(hostile)}`)
}

// ---------------------------------------------------------------- mods/keys

assert.deepStrictEqual(A.normalizeMods("ctrl + shift"), ["CTRL", "SHIFT"])
assert.deepStrictEqual(A.normalizeMods(["super", "control"]), ["SUPER", "CTRL"])
// Canonical order regardless of input order, so saves stay stable.
assert.deepStrictEqual(A.normalizeMods("SHIFT ALT CTRL SUPER"), ["SUPER", "CTRL", "ALT", "SHIFT"])
assert.deepStrictEqual(A.normalizeMods("bogus"), [])
assert.ok(A.validKey("left") && A.validKey("F5") && A.validKey("code:24"))
assert.ok(!A.validKey('a"); evil('), "key with punctuation rejected")
assert.ok(!A.validKey(""), "empty key rejected")
assert.ok(!A.validKey("code:99999"), "absurd keycode rejected")

// ---------------------------------------------------------------- resolve

assert.strictEqual(A.resolve({ action: "none" }).empty, true)
const back = A.resolve({ action: "back" })
assert.strictEqual(back.kind, "chord")
assert.deepStrictEqual(back.mods, ["ALT"])
assert.strictEqual(back.key, "left")
assert.strictEqual(back.detail, "ALT + ←")

// A custom chord with no key is not usable and must not be emitted.
assert.strictEqual(A.resolve({ action: "custom-key", mods: ["CTRL"] }).ok, false)
assert.strictEqual(A.resolve({ action: "custom-command", command: "  " }).ok, false)
assert.strictEqual(A.resolve({ action: "custom-command", command: "foo" }).command, "foo")

// ---------------------------------------------------------------- normalize

const dirty = {
  version: 1,
  scopeToDevice: true,
  devices: {
    "046d:4079:x": {
      label: "G Pro",
      learned: [272, 275, 999, "276", 275],       // out of range + dupes + string
      bindings: {
        "275": { action: "back" },
        "999": { action: "copy" },                 // out of range code
        "276": { action: "none" },                 // explicit none is not stored
        "274": { action: "custom-command", command: "ls" }
      }
    }
  }
}
const clean = C.normalize(dirty, Dpi)
assert.deepStrictEqual(clean.devices["046d:4079:x"].learned, [272, 275, 276])
assert.deepStrictEqual(Object.keys(clean.devices["046d:4079:x"].bindings).sort(), ["274", "275"])
assert.deepStrictEqual(C.normalize(null), C.defaults())
// Prototype pollution through a config key must not reach Object.prototype.
C.normalize({ devices: { __proto__: { bindings: {} } } })
assert.strictEqual({}.polluted, undefined)

// ---------------------------------------------------------------- lua gen

const devices = [{
  key: "046d:4079:x", label: "Logitech G Pro Wireless",
  hyprName: "logitech-g-pro--1", buttons: []
}]
const config = C.normalize({
  scopeToDevice: true,
  devices: {
    "046d:4079:x": {
      bindings: {
        "275": { action: "back" },
        "276": { action: "forward" },
        "274": { action: "win-close" },
        "277": { action: "custom-command", command: 'notify-send "hi there"' },
        "278": { action: "custom-key", mods: ["CTRL", "SHIFT"], key: "t" }
      }
    }
  }
})
const gen = C.generateLua(devices, config, A, Dpi, HELPER)
assert.strictEqual(gen.binds, 5)
assert.strictEqual(gen.skipped.length, 0)
assert.ok(gen.text.includes('device = { inclusive = true, list = { "logitech-g-pro--1" } }'), "scoped")
assert.ok(gen.text.includes('hl.dsp.send_key_state({ mods = "ALT", key = "left", state = "down" })'), "chord down")
assert.ok(gen.text.includes('state = "up"'), "chord up")
assert.ok(gen.text.includes("hl.dispatch(hl.dsp.window.close())"), "dispatch")
assert.ok(gen.text.includes('exec_cmd("notify-send \\"hi there\\"")'), "command escaped")
assert.ok(gen.text.includes('pcall(hl.unbind, "mouse:275")'), "idempotent unbind")

// A device Hyprland cannot name cannot be scoped, and must be reported
// rather than silently bound to every pointer on the system.
const unnamed = C.generateLua([{ key: "046d:4079:x", label: "X", hyprName: "" }], config, A, Dpi, HELPER)
assert.strictEqual(unnamed.binds, 0)
assert.strictEqual(unnamed.skipped.length, 1)
assert.ok(/cannot be scoped/.test(unnamed.skipped[0].reason))

// Global mode: two mice claiming the same code must not both emit.
const twoMice = [
  { key: "a", label: "Mouse A", hyprName: "mouse-a" },
  { key: "b", label: "Mouse B", hyprName: "mouse-b" }
]
const globalCfg = C.normalize({
  scopeToDevice: false,
  devices: {
    a: { bindings: { "275": { action: "back" } } },
    b: { bindings: { "275": { action: "copy" }, "276": { action: "paste" } } }
  }
})
const globalGen = C.generateLua(twoMice, globalCfg, A, Dpi, HELPER)
assert.strictEqual(globalGen.binds, 2, "duplicate global code emitted once")
assert.strictEqual(globalGen.skipped.length, 1)
assert.ok(/already bound globally/.test(globalGen.skipped[0].reason))
assert.ok(!globalGen.text.includes("device = {"), "global binds carry no device filter")

// ---------------------------------------------------------------- hook

const STATE = "/.local/state/omarchy-mousemap/bindings.lua"
const original = "-- my config\no.bind(\"SUPER + K\", \"x\", \"y\")\n"
const hooked = C.withHook(original, STATE)
assert.ok(C.hasHook(hooked))
assert.ok(hooked.startsWith(original), "existing content untouched")
// Re-hooking is idempotent: exactly one block, ever.
assert.strictEqual(C.withHook(hooked, STATE), hooked)
assert.strictEqual((hooked.match(/BEGIN mousemap/g) || []).length, 1)
// And it round-trips back to the original.
assert.strictEqual(C.withoutHook(hooked), original)
// An unclosed marker is left strictly alone rather than guessed at.
const broken = original + "\n-- BEGIN mousemap\nhalf a block\n"
assert.strictEqual(C.withHook(broken, STATE), broken)

// ---------------------------------------------------------------- real hw

// Discovery over this machine's actual /proc snapshot, with profiles.
const P = require("../Profiles.js")
if (fs.existsSync("/proc/bus/input/devices")) {
  const proc = fs.readFileSync("/proc/bus/input/devices", "utf8")
  const found = D.discover(proc, { mice: [{ name: "logitech-g-pro--1" }] }, P.profiles(), {})
  for (const dev of found) {
    assert.ok(dev.key.includes(":"), "device has a composite key")
    assert.ok(dev.buttons.length >= 1, "device has buttons")
    // A profile match must beat the receiver's inflated capability list.
    if (dev.multiplexed && dev.profileId) {
      assert.ok(dev.buttons.length < 15, "profile overrode the multiplexer's claim")
      assert.strictEqual(dev.source, "profile")
    }
  }
}

// A learned button list outranks both the profile and the bitmap.
{
  const proc = fs.readFileSync("/proc/bus/input/devices", "utf8")
  const key = D.discover(proc, {}, P.profiles(), {})[0].key
  const learned = {}
  learned[key] = [0x110, 0x111, 0x112]
  const relearned = D.discover(proc, {}, P.profiles(), learned)[0]
  assert.strictEqual(relearned.source, "learned")
  assert.deepStrictEqual(relearned.buttons.map(b => b.code), [0x110, 0x111, 0x112])
}

console.log("config + actions + devices: all assertions passed")

// ---------------------------------------------------------------- lua syntax

// The generated file is executed by the compositor, so "it looks right"
// is not good enough: hand it to the real Lua parser.
{
  const os_ = require("os"), path = require("path")
  const tmp = path.join(os_.tmpdir(), "mousemap-syntax-check.lua")
  fs.writeFileSync(tmp, gen.text)
  execFileSync("luac", ["-p", tmp])           // throws on a syntax error
  fs.writeFileSync(tmp, globalGen.text)
  execFileSync("luac", ["-p", tmp])
  // And the hook block we splice into the user's own config.
  fs.writeFileSync(tmp, C.hookBlock(STATE))
  execFileSync("luac", ["-p", tmp])
  fs.unlinkSync(tmp)
}

console.log("generated lua parses cleanly")

// ---------------------------------------------------------------- capture

// Holding Ctrl and pressing C fires a Control_L press first; capturing it
// would record a shortcut whose key is a modifier.
assert.strictEqual(A.keysymFor(0x01000021, ""), "", "bare Control not captured")
assert.strictEqual(A.keysymFor(0x01000020, ""), "", "bare Shift not captured")
assert.strictEqual(A.keysymFor(0x43, "c"), "c")
assert.strictEqual(A.keysymFor(0x43, "C"), "c", "shift is a modifier, not a capital")
assert.strictEqual(A.keysymFor(0x01000012, ""), "left")
assert.strictEqual(A.keysymFor(0x01000030, ""), "F1")
assert.strictEqual(A.keysymFor(0x01000052, ""), "F35")
assert.strictEqual(A.keysymFor(0x2c, ","), "comma")
assert.strictEqual(A.keysymFor(0x20, " "), "space")
assert.strictEqual(A.keysymFor(0x01000004, ""), "Return")
// Anything capturable must survive the validator that guards the generator.
for (const [k, t] of [[0x43,"c"],[0x01000012,""],[0x01000030,""],[0x2c,","],[0x20," "],[0x01000004,""],[0x37,"7"]]) {
  const sym = A.keysymFor(k, t)
  assert.ok(sym && A.validKey(sym), `captured keysym ${sym} must pass validKey`)
}
assert.deepStrictEqual(A.modsFromQt(0x04000000 | 0x02000000), ["CTRL", "SHIFT"])
assert.deepStrictEqual(A.modsFromQt(0), [])

console.log("key capture: all assertions passed")

// ---------------------------------------------------------------- triggers

// The guided detect pass filters incoming presses through validTrigger.
// It once inlined a 0x110..0x11f range check instead, which silently threw
// away every keystroke button — the exact buttons that most need detecting,
// because they are the ones a capability probe cannot see either.
{
  const D2 = require("../Devices.js")

  // Real mouse buttons.
  for (const code of [0x110, 0x112, 0x114, 0x11f]) {
    assert.ok(C.validTrigger(code), `mouse button ${code} must be a valid trigger`)
  }

  // Keystroke triggers, including the two this was found on: KEY_2 (xkb 11)
  // and KEY_LEFTCTRL (xkb 37).
  for (const xkb of [9, 11, 37, 100, 255]) {
    const id = D2.keyTrigger(xkb)
    assert.ok(C.validTrigger(id), `key trigger for xkb ${xkb} (id ${id}) must be valid`)
    assert.ok(D2.isKeyTrigger(id), "key trigger must report as one")
    assert.strictEqual(D2.triggerBind(id), "code:" + xkb)
  }

  // Out of range on both sides.
  assert.ok(!C.validTrigger(0x10f), "below BTN_LEFT is not a trigger")
  assert.ok(!C.validTrigger(0x120), "above BTN range but below KEY_BASE is not a trigger")
  assert.ok(!C.validTrigger(C.KEY_BASE + 256), "beyond the keycode range is not a trigger")
  assert.ok(!C.validTrigger(NaN), "NaN is not a trigger")

  // Anything the detect pass can capture must survive the round trip into
  // config and back out as a binding.
  const captured = [274, 276, D2.keyTrigger(11), D2.keyTrigger(37)]
  const bindings = {}
  const layout = {}
  for (const id of captured) {
    bindings[String(id)] = { action: "back" }
    layout[String(id)] = "left-front"
  }
  const round = C.normalize({
    scopeToDevice: true,
    devices: { d: { learned: captured, layout, bindings } }
  })
  assert.deepStrictEqual(round.devices.d.learned, captured.slice().sort((a, b) => a - b),
    "every captured trigger survives normalize")
  assert.strictEqual(Object.keys(round.devices.d.bindings).length, captured.length,
    "every captured trigger can carry a binding")

  const emitted = C.generateLua(
    [{ key: "d", label: "M", hyprName: "m", hyprKbdName: "m-kbd" }], round, A, Dpi, HELPER)
  assert.strictEqual(emitted.binds, captured.length, "every captured trigger emits a bind")
  assert.ok(emitted.text.includes('hl.bind("code:11"'), "keystroke trigger emitted")
  assert.ok(emitted.text.includes('hl.bind("mouse:274"'), "mouse trigger emitted")
}

// ------------------------------------------------------- trigger bind form

// Config generates the bind string and Devices states the same rule for
// the UI. Two copies of one rule is how keystroke buttons were silently
// dropped once already, so they are held to each other across the whole id
// space rather than trusted to stay in step.
for (let id = 0x110; id <= 0x11f; id++) {
  assert.strictEqual(C.triggerBind(id), D.triggerBind(id), `bind form differs at ${id}`)
  assert.strictEqual(C.triggerBind(id), "mouse:" + id)
  assert.ok(C.validTrigger(id), `${id} should be a valid trigger`)
}
for (let kc = 0; kc <= 255; kc++) {
  const id = C.KEY_BASE + kc
  assert.strictEqual(C.triggerBind(id), D.triggerBind(id), `bind form differs at ${id}`)
  assert.strictEqual(C.triggerBind(id), "code:" + kc)
  assert.ok(C.validTrigger(id), `${id} should be a valid trigger`)
}
assert.strictEqual(C.KEY_BASE, D.KEY_BASE, "the two KEY_BASE constants must agree")

// Nothing outside those two runs is a trigger.
for (const id of [0, 0x10f, 0x120, 0xfff, C.KEY_BASE - 1, C.KEY_BASE + 256, NaN]) {
  assert.ok(!C.validTrigger(id), `${id} should not be a valid trigger`)
}

// An entry built by any path has every field the panel reads, including
// the layout — an entry without one is a device whose buttons have no
// places, which reads as a mouse nobody ever detected.
{
  const shape = Object.keys(C.blankEntry()).sort()
  assert.deepStrictEqual(shape, ["bindings", "dpi", "label", "layout", "learned"])
  const config = C.defaults()
  C.setBinding(config, "new:device", 0x113, { action: "back", mods: [], key: "", command: "" })
  assert.deepStrictEqual(Object.keys(config.devices["new:device"]).sort(), shape)
  assert.deepStrictEqual(Object.keys(C.deviceEntry(C.defaults(), "missing")).sort(), shape)
}

console.log("bind form + entry shape: all assertions passed")

console.log("trigger round-trip: all assertions passed")
