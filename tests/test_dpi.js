const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { execFileSync } = require("child_process")

const A = require("../Actions.js")
const C = require("../Config.js")
const Dpi = require("../Dpi.js")

// ---------------------------------------------------------------- the math

// libinput's flat profile is factor = speed + 1, so the conversion is
// exact in both directions. If this ever stops holding, every DPI number
// the panel shows is a lie, which is why it is asserted first.
for (const base of [400, 800, 1200, 1600, 3200]) {
  for (const target of [50, 100, 400, 800, 1600, base, base * 2]) {
    const sens = Dpi.sensitivityFor(target, base)
    if (target > base * 2) {
      assert.strictEqual(sens, null, `${target} is out of reach from ${base}`)
      continue
    }
    assert.ok(sens !== null, `${target} should be reachable from ${base}`)
    assert.ok(sens >= -1 && sens <= 1, `sensitivity ${sens} out of libinput's range`)
    assert.ok(Math.abs(Dpi.effectiveDpi(sens, base) - target) < 1e-9,
      `round trip lost ${target} at base ${base}`)
  }
}

// The base itself is always 1x, which is the one point the user can check
// by feel: selecting the preset that matches their hardware DPI must not
// change how the mouse moves.
for (const base of [400, 800, 1600]) {
  assert.strictEqual(Dpi.sensitivityFor(base, base), 0)
}

// Beyond 2x there is no sensitivity that works, and a pointer that does
// not move is not a preset.
assert.strictEqual(Dpi.sensitivityFor(1601, 800), null)
assert.strictEqual(Dpi.sensitivityFor(0, 800), null)
assert.strictEqual(Dpi.sensitivityFor(-100, 800), null)
assert.strictEqual(Dpi.sensitivityFor(800, 0), null)
assert.strictEqual(Dpi.sensitivityFor(NaN, 800), null)
assert.strictEqual(Dpi.ceilingFor(800), 1600)

// ---------------------------------------------------------------- literals

// The sensitivity is written into a file the compositor executes, so it
// must always be a plain decimal number and never an exponent, a NaN, or
// anything else JS might print.
for (const value of [-1, -0.9999999, -0.5, 0, 1e-9, -1e-9, 0.5, 1, 5, -5, NaN, Infinity]) {
  const text = Dpi.luaSensitivity(value)
  assert.ok(/^-?\d+\.\d{6}$/.test(text), `bad lua literal ${text} for ${value}`)
  const parsed = parseFloat(text)
  assert.ok(parsed >= -1 && parsed <= 1, `literal ${text} outside libinput's range`)
}
// -0 prints as 0, so an unchanged preset does not churn the generated file.
assert.strictEqual(Dpi.luaSensitivity(-0), "0.000000")
assert.strictEqual(Dpi.luaSensitivity(-1e-12), "0.000000")

// ---------------------------------------------------------------- normalize

assert.deepStrictEqual(Dpi.normalize(null), Dpi.blank())
assert.deepStrictEqual(Dpi.normalize("nonsense"), Dpi.blank())

// Presets are clamped into range rather than dropped: dropping one
// renumbers every preset after it, and the number is what a button is
// bound to.
{
  const wild = Dpi.normalize({
    enabled: true, base: 800, active: 99,
    presets: [{ name: "Way too fast", dpi: 999999 }, { name: "  spaced  out ", dpi: 400 }]
  })
  assert.strictEqual(wild.presets.length, 2, "nothing was dropped")
  assert.strictEqual(wild.presets[0].dpi, 1600, "clamped to the 2x ceiling")
  assert.strictEqual(wild.presets[1].name, "spaced out", "whitespace collapsed")
  assert.strictEqual(wild.active, 0, "an out-of-range active index falls back")
  assert.ok(Dpi.reachable(wild.presets[0].dpi, wild.base))
}

// A name reaches an OSD line and a Lua string, so control characters go.
assert.strictEqual(Dpi.normalizeName("a\nb\tc\x07"), "abc")
assert.strictEqual(Dpi.normalizeName(""), "Preset")
assert.strictEqual(Dpi.normalizeName("x".repeat(200)).length, Dpi.MAX_NAME)

// Absurd bases are bounded before anything divides by them.
assert.strictEqual(Dpi.normalizeBase(0), Dpi.MIN_BASE)
assert.strictEqual(Dpi.normalizeBase(-5), Dpi.MIN_BASE)
assert.strictEqual(Dpi.normalizeBase(1e9), Dpi.MAX_BASE)
assert.strictEqual(Dpi.normalizeBase("nonsense"), Dpi.DEFAULT_BASE)

// Presets never exceed the cap, whatever is on disk.
{
  const many = Dpi.normalize({ presets: new Array(50).fill({ name: "x", dpi: 800 }) })
  assert.strictEqual(many.presets.length, Dpi.MAX_PRESETS)
}

// Empty presets can never read back as enabled, because the runtime would
// then have a device slot with nothing to select.
assert.strictEqual(Dpi.normalize({ enabled: true, presets: [] }).enabled, false)

// ---------------------------------------------------------------- editing

// Every seeded preset must be reachable from the base it was seeded for,
// at any base — that is the point of seeding by ratio rather than by
// fixed numbers.
for (const base of [Dpi.MIN_BASE, 400, 800, 1600, 3200, 12000, Dpi.MAX_BASE]) {
  const seeds = Dpi.seedPresets(base)
  assert.ok(seeds.length >= 1, `no seeds at base ${base}`)
  const seen = {}
  for (const preset of seeds) {
    assert.ok(Dpi.reachable(preset.dpi, base), `seed ${preset.dpi} unreachable from ${base}`)
    assert.ok(!seen[preset.dpi], `seeded ${preset.dpi} twice at base ${base}`)
    seen[preset.dpi] = true
  }
}

// Lowering the base must not leave a preset stranded above the new
// ceiling, where it would compile to a sensitivity Hyprland rejects.
{
  const high = Dpi.enable(Dpi.normalize({ base: 3200 }))
  const lowered = Dpi.withBase(high, 400)
  for (const preset of lowered.presets) {
    assert.ok(Dpi.reachable(preset.dpi, lowered.base),
      `${preset.dpi} unreachable after dropping the base to 400`)
  }
}

// Removing a preset renumbers the rest, and the caller is told how so it
// can move the buttons bound to them.
{
  const three = Dpi.enable(Dpi.blank())
  assert.strictEqual(three.presets.length, 3)
  const { dpi: two, remap } = Dpi.removePreset(three, 1)
  assert.strictEqual(two.presets.length, 2)
  assert.strictEqual(remap[0], 0)
  assert.strictEqual(remap[1], -1, "the removed preset maps to nothing")
  assert.strictEqual(remap[2], 1, "everything after it shifts down")
  assert.ok(two.active >= 0 && two.active < two.presets.length)

  // Emptying it out turns the feature off rather than leaving an enabled
  // device with no presets.
  let left = two
  while (left.presets.length > 0) left = Dpi.removePreset(left, 0).dpi
  assert.strictEqual(left.enabled, false)
}

// Adding never lands on top of an existing preset.
{
  let config = Dpi.enable(Dpi.blank())
  while (config.presets.length < Dpi.MAX_PRESETS) {
    const before = config.presets.length
    config = Dpi.addPreset(config)
    assert.strictEqual(config.presets.length, before + 1)
    const seen = {}
    for (const preset of config.presets) {
      assert.ok(!seen[preset.dpi], `added a duplicate of ${preset.dpi}`)
      seen[preset.dpi] = true
      assert.ok(Dpi.reachable(preset.dpi, config.base))
    }
  }
  // And stops at the cap rather than growing without bound.
  assert.strictEqual(Dpi.addPreset(config).presets.length, Dpi.MAX_PRESETS)
}

// ---------------------------------------------------------------- resolve

// A mouse Hyprland cannot name cannot have its pointer speed set for it
// alone, and setting it for every pointer would be worse than not setting
// it at all.
{
  const config = Dpi.enable(Dpi.blank())
  assert.strictEqual(Dpi.resolve({ hyprName: "" }, config).ok, false)
  assert.ok(/does not report this device/.test(Dpi.resolve({ hyprName: "" }, config).error))
  assert.strictEqual(Dpi.resolve({ hyprName: "m" }, null).empty, true)
  assert.strictEqual(Dpi.resolve({ hyprName: "m" }, Dpi.blank()).empty, true)

  const resolved = Dpi.resolve({ hyprName: "m", label: "Mouse" }, config)
  assert.strictEqual(resolved.ok, true)
  assert.strictEqual(resolved.presets.length, config.presets.length)
  for (let i = 0; i < resolved.presets.length; i++) {
    assert.strictEqual(resolved.presets[i].dpi, config.presets[i].dpi)
    assert.ok(Math.abs(Dpi.effectiveDpi(resolved.presets[i].sensitivity, resolved.base)
                       - resolved.presets[i].dpi) < 1e-9)
  }
}

// ---------------------------------------------------------------- lua

const HELPER = "/home/some body/.config/omarchy/plugins/x/scripts/mousemap"
const DEVICE = { key: "046d:4079:x", label: "G Pro", hyprName: "logitech-g-pro--1", hyprKbdName: "logitech-g-pro-" }

function build(bindings, dpiConfig) {
  const config = C.normalize({
    scopeToDevice: true,
    devices: { "046d:4079:x": { bindings: bindings, dpi: dpiConfig } }
  }, Dpi)
  return C.generateLua([DEVICE], config, A, Dpi, HELPER)
}

function luaChecks(text) {
  const tmp = path.join(os.tmpdir(), "mousemap-dpi-check.lua")
  fs.writeFileSync(tmp, text)
  try { execFileSync("luac", ["-p", tmp]) } finally { fs.unlinkSync(tmp) }
}

// ---------------------------------------------------------------- harness
//
// Reading the generated file and asserting that it contains the right
// substrings proves very little: what matters is what the compositor does
// when it runs it, and what happens when a button is actually pressed.
//
// So the file is executed by a real Lua interpreter against a stub `hl`,
// and the binds it registers are then invoked. Every hl.device and
// exec_cmd comes back as a trace line, which is the whole observable
// behaviour of the DPI runtime.
//
// It doubles as the escaping test. `os.execute` and `io.popen` are removed
// from the sandbox entirely, so a preset name or a device name that
// escaped its string literal fails here loudly rather than being waved
// through by a substring check that only knows one shape of attack.
const HARNESS = `
local trace = {}
local binds = {}

os.execute = function() error("MOUSEMAP-ESCAPED: os.execute reached", 0) end
io.popen = function() error("MOUSEMAP-ESCAPED: io.popen reached", 0) end

hl = {
  device = function(spec)
    trace[#trace + 1] = table.concat({ "device", spec.name or "?",
      string.format("%.6f", spec.sensitivity or 0/0), spec.accel_profile or "?" }, "\\t")
  end,
  bind = function(key, fn, opts)
    opts = opts or {}
    binds[key .. (opts.release and "|up" or "|down")] = fn
  end,
  unbind = function() end,
  dispatch = function(value) trace[#trace + 1] = "dispatch\\t" .. tostring(value) end,
  timer = function() end,
  dsp = {
    exec_cmd = function(command) return "exec:" .. command end,
    window = setmetatable({}, { __index = function() return function() return "window" end end }),
    send_key_state = function() return "key" end,
  },
}

dofile(GENERATED)

for word in DRIVE:gmatch("%S+") do
  local fn = binds[word]
  if fn == nil then error("MOUSEMAP-NOBIND: " .. word, 0) end
  fn()
end

io.write(table.concat(trace, "\\n"))
`

// Run a generated file and drive the binds named in `drive`
// ("mouse:275|down mouse:275|up"). Returns the trace as rows.
function runLua(text, drive, home) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mousemap-lua-"))
  const generated = path.join(dir, "bindings.lua")
  const harness = path.join(dir, "harness.lua")
  fs.writeFileSync(generated, text)
  fs.writeFileSync(harness,
    `GENERATED = ${A.luaString(generated)}\nDRIVE = ${A.luaString(drive || "")}\n` + HARNESS)
  try {
    const out = execFileSync("lua", [harness], {
      encoding: "utf8",
      env: Object.assign({}, process.env, { HOME: home || dir })
    })
    return out === "" ? [] : out.split("\n").map(line => line.split("\t"))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// Every hl.device call, as { name, sensitivity, profile }.
function deviceCalls(rows) {
  return rows.filter(row => row[0] === "device")
             .map(row => ({ name: row[1], sensitivity: parseFloat(row[2]), profile: row[3] }))
}

// The whole DPI runtime, with every kind of bound button on it.
{
  const dpiConfig = Dpi.enable(Dpi.normalize({ base: 1600 }))
  const generated = build({
    "275": { action: "dpi-cycle" },
    "276": { action: "dpi-cycle-back" },
    "277": { action: "dpi-preset", preset: 0 },
    "278": { action: "dpi-sniper", preset: 0 }
  }, dpiConfig)

  assert.strictEqual(generated.skipped.length, 0, JSON.stringify(generated.skipped))
  assert.strictEqual(generated.binds, 4)
  assert.strictEqual(generated.dpi.length, 1)
  luaChecks(generated.text)

  // Loading the file alone must put the pointer on the saved preset, and
  // must pin the flat profile — under the adaptive one the numbers on the
  // presets would mean nothing at all.
  const onLoad = deviceCalls(runLua(generated.text, ""))
  assert.strictEqual(onLoad.length, 1)
  assert.strictEqual(onLoad[0].name, "logitech-g-pro--1")
  assert.strictEqual(onLoad[0].profile, "flat")
  const active = dpiConfig.presets[dpiConfig.active]
  assert.ok(Math.abs(Dpi.effectiveDpi(onLoad[0].sensitivity, dpiConfig.base) - active.dpi) < 0.01,
    "loading the file did not select the active preset")

  // Cycling walks the presets in order and wraps, and every step lands on
  // exactly the DPI the panel promised.
  {
    const drive = new Array(dpiConfig.presets.length + 1).fill("mouse:275|down").join(" ")
    const seen = deviceCalls(runLua(generated.text, drive)).slice(1)
    assert.strictEqual(seen.length, dpiConfig.presets.length + 1)
    for (let i = 0; i < seen.length; i++) {
      const expected = dpiConfig.presets[(dpiConfig.active + 1 + i) % dpiConfig.presets.length]
      assert.ok(Math.abs(Dpi.effectiveDpi(seen[i].sensitivity, dpiConfig.base) - expected.dpi) < 0.01,
        `cycle step ${i} landed on ${Dpi.effectiveDpi(seen[i].sensitivity, dpiConfig.base)}, wanted ${expected.dpi}`)
    }
  }

  // Cycling backwards from the first preset wraps to the last rather than
  // falling off the end — Lua's floored % is what makes that work.
  {
    const back = deviceCalls(runLua(generated.text, "mouse:276|down mouse:276|down")).slice(1)
    const count = dpiConfig.presets.length
    for (let i = 0; i < back.length; i++) {
      const expected = dpiConfig.presets[((dpiConfig.active - 1 - i) % count + count) % count]
      assert.ok(Math.abs(Dpi.effectiveDpi(back[i].sensitivity, dpiConfig.base) - expected.dpi) < 0.01,
        `reverse step ${i} wrapped wrong`)
    }
  }

  // Sniper: hold drops to its preset, release returns to the *selected*
  // one — not to whatever an earlier hold left behind. Cycling while held
  // and then releasing must land on the newly cycled preset.
  {
    const rows = runLua(generated.text, "mouse:278|down mouse:278|up")
    const seen = deviceCalls(rows).slice(1)
    assert.strictEqual(seen.length, 2, "hold and release are one device call each")
    assert.ok(Math.abs(Dpi.effectiveDpi(seen[0].sensitivity, dpiConfig.base) - dpiConfig.presets[0].dpi) < 0.01,
      "hold did not drop to its preset")
    assert.ok(Math.abs(Dpi.effectiveDpi(seen[1].sensitivity, dpiConfig.base) - active.dpi) < 0.01,
      "release did not spring back to the selected preset")

    // A press with no matching release must not strand the pointer: the
    // next selection still wins.
    const stranded = deviceCalls(runLua(generated.text, "mouse:278|down mouse:277|down")).slice(1)
    assert.ok(Math.abs(Dpi.effectiveDpi(stranded[1].sensitivity, dpiConfig.base) - dpiConfig.presets[0].dpi) < 0.01,
      "selecting a preset while held did not take effect")
  }

  // Jumping to a preset also asks the helper to remember it and say so,
  // and that call carries nothing but two integers.
  {
    const rows = runLua(generated.text, "mouse:277|down")
    const execs = rows.filter(row => row[0] === "dispatch").map(row => row[1])
    assert.strictEqual(execs.length, 1, "one helper call per switch")
    assert.strictEqual(execs[0], "exec:'" + HELPER + "' dpi note 1 1",
      "helper call: " + execs[0])
  }

  // A held button is not a switch, so it must not spam the helper or the
  // OSD on every press.
  assert.strictEqual(
    runLua(generated.text, "mouse:278|down mouse:278|up").filter(row => row[0] === "dispatch").length,
    0, "sniper must not write state or draw an OSD")
}

// The preset chosen at runtime outlives a reload, which is the whole
// reason the state file exists: changing an unrelated Hyprland setting
// must not silently put the pointer back where the panel last saved it.
{
  const dpiConfig = Dpi.enable(Dpi.normalize({ base: 1600 }))
  const generated = build({}, dpiConfig)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mousemap-home-"))
  fs.mkdirSync(path.join(home, ".local/state/omarchy-mousemap"), { recursive: true })
  const state = path.join(home, ".local/state/omarchy-mousemap/dpi-active")

  fs.writeFileSync(state, "1\t1\n")
  let seen = deviceCalls(runLua(generated.text, "", home))
  assert.ok(Math.abs(Dpi.effectiveDpi(seen[0].sensitivity, dpiConfig.base) - dpiConfig.presets[0].dpi) < 0.01,
    "the saved preset was not restored on load")

  // A state file naming a preset that has since been deleted falls back to
  // the configured one rather than leaving the pointer unset.
  fs.writeFileSync(state, "1\t99\n")
  seen = deviceCalls(runLua(generated.text, "", home))
  assert.ok(Math.abs(Dpi.effectiveDpi(seen[0].sensitivity, dpiConfig.base)
                     - dpiConfig.presets[dpiConfig.active].dpi) < 0.01,
    "a stale state file must fall back, not strand the pointer")

  // And so does junk.
  for (const junk of ["", "garbage\n", "1\tx\n", "\0\n", "-1\t-1\n"]) {
    fs.writeFileSync(state, junk)
    assert.strictEqual(deviceCalls(runLua(generated.text, "", home)).length, 1,
      `state file ${JSON.stringify(junk)} broke loading`)
  }
  fs.rmSync(home, { recursive: true, force: true })
}

// A sniper button aimed at a preset that has since been deleted must be
// refused with a reason, not compiled into a call that silently does
// nothing.
{
  const dpiConfig = Dpi.enable(Dpi.blank())
  const generated = build({ "275": { action: "dpi-preset", preset: 7 } }, dpiConfig)
  assert.strictEqual(generated.binds, 0)
  assert.strictEqual(generated.skipped.length, 1)
  assert.ok(/no longer exists/.test(generated.skipped[0].reason), generated.skipped[0].reason)
}

// A DPI button on a mouse with presets switched off is refused too.
{
  const generated = build({ "275": { action: "dpi-cycle" } }, Dpi.blank())
  assert.strictEqual(generated.binds, 0)
  assert.strictEqual(generated.skipped.length, 1)
  assert.ok(/no DPI presets/.test(generated.skipped[0].reason), generated.skipped[0].reason)
  assert.ok(!generated.text.includes("mm_step"), "nothing emitted for a refused bind")
}

// Presets with no bound button still apply, because choosing one in the
// panel has to do something on its own.
{
  const generated = build({}, Dpi.enable(Dpi.blank()))
  assert.strictEqual(generated.binds, 0)
  assert.strictEqual(generated.dpi.length, 1)
  assert.ok(generated.text.includes("mm_apply(1)"))
  luaChecks(generated.text)
}

// Two mice each get their own slot, and neither can reach the other's.
{
  const second = { key: "046d:c52b:y", label: "MX", hyprName: "mx-master" }
  const config = C.normalize({
    scopeToDevice: true,
    devices: {
      "046d:4079:x": { bindings: { "275": { action: "dpi-cycle" } }, dpi: Dpi.enable(Dpi.blank()) },
      "046d:c52b:y": { bindings: { "275": { action: "dpi-cycle" } }, dpi: Dpi.enable(Dpi.normalize({ base: 3200 })) }
    }
  }, Dpi)
  const generated = C.generateLua([DEVICE, second], config, A, Dpi, HELPER)
  assert.strictEqual(generated.dpi.length, 2)
  assert.strictEqual(generated.binds, 2)
  assert.ok(generated.text.includes("mm_step(1, 1)") && generated.text.includes("mm_step(2, 1)"),
    "each mouse cycles its own presets")
  assert.ok(generated.text.includes('mm_names[2] = "mx-master"'))
  luaChecks(generated.text)

  // The sidecar the helper reads is in the same slot order as the Lua.
  const sidecar = Dpi.sidecar(generated.dpi)
  assert.strictEqual(sidecar.devices.length, 2)
  assert.strictEqual(sidecar.devices[0].name, "logitech-g-pro--1")
  assert.strictEqual(sidecar.devices[1].name, "mx-master")
}

// ---------------------------------------------------------------- hostile

// A preset name is user text that reaches a Lua file, a JSON sidecar, and
// an OSD line. It must survive all three as data.
{
  const hostile = 'x"; os.execute("touch /tmp/pwn"); --'
  const dpiConfig = Dpi.normalize({
    enabled: true, base: 800, presets: [{ name: hostile, dpi: 800 }]
  })
  const generated = build({ "275": { action: "dpi-preset", preset: 0 } }, dpiConfig)
  luaChecks(generated.text)
  // The harness deletes os.execute, so a name that broke out of its string
  // literal raises rather than running.
  runLua(generated.text, "mouse:275|down")

  // It rides in the sidecar as JSON instead, where the helper reads it.
  const sidecar = Dpi.sidecar(generated.dpi)
  assert.strictEqual(sidecar.devices[0].presets[0].name, Dpi.normalizeName(hostile))
  JSON.parse(JSON.stringify(sidecar))
}

// A device name comes from a USB descriptor, so it is equally untrusted.
{
  const evil = { key: "046d:4079:x", label: "X", hyprName: 'a"); os.execute("id"); ("' }
  const config = C.normalize({
    devices: { "046d:4079:x": { dpi: Dpi.enable(Dpi.blank()) } }
  }, Dpi)
  const generated = C.generateLua([evil], config, A, Dpi, HELPER)
  luaChecks(generated.text)
  const seen = deviceCalls(runLua(generated.text, ""))
  assert.strictEqual(seen[0].name, evil.hyprName,
    "the device name must arrive as data, byte for byte")
}

// The helper path is interpolated into a shell command by the generated
// Lua, so a path with a space in it has to survive as one argument.
{
  const generated = build({ "275": { action: "dpi-cycle" } }, Dpi.enable(Dpi.blank()))
  const quoted = execFileSync("lua", ["-e", `
    local mm_helper = ${A.luaString(HELPER)}
    local function mm_quote(value)
      return "'" .. tostring(value):gsub("'", "'\\\\''") .. "'"
    end
    io.write(mm_quote(mm_helper))
  `], { encoding: "utf8" })
  // Round-trip it through a real shell: the quoted form must come back as
  // exactly one argument holding exactly the original path.
  const back = execFileSync("sh", ["-c", `printf '%s\\n' ${quoted}`], { encoding: "utf8" })
  assert.strictEqual(back, HELPER + "\n", "helper path did not survive shell quoting")
  assert.ok(generated.text.includes("mm_quote(mm_helper)"))
}

console.log("dpi: all assertions passed")
