// Config shape, and the Lua file the compositor actually reads.
//
// Source of truth is JSON at ~/.config/omarchy/mousemap.json. From it we
// generate ~/.local/state/omarchy-mousemap/bindings.lua, which Hyprland
// pulls in through one managed line in ~/.config/hypr/bindings.lua.
//
// Generating a whole file we own, instead of editing a fenced block inside
// the user's hand-written bindings.lua, means a regeneration can never
// corrupt config the user wrote. The only thing we touch in their file is
// a single dofile line, added once.
//
// dofile rather than require: Hyprland's bootstrap clears package.loaded
// only for the `default.hypr`, `hypr` and theme prefixes, so a required
// module under any other name would be cached and a reload would silently
// keep serving the previous mapping.

var CONFIG_VERSION = 1

// Trigger ids: 272..287 are mouse buttons, KEY_BASE + xkb keycode is a
// keystroke the mouse sends. Mirrors Devices.js, which owns the meaning.
var KEY_BASE = 0x1000

function validTrigger(id) {
  if (!isFinite(id)) return false
  if (id >= 0x110 && id <= 0x11f) return true
  return id >= KEY_BASE && id <= KEY_BASE + 255
}

// The bind string Hyprland takes for a trigger. Devices.triggerBind states
// the same rule for the UI side; the tests hold the two to each other over
// the whole id space so the mirror cannot drift apart unnoticed.
function triggerBind(id) {
  return id >= KEY_BASE ? "code:" + (id - KEY_BASE) : "mouse:" + id
}

function defaults() {
  return { version: CONFIG_VERSION, scopeToDevice: true, devices: {} }
}

// A device key is built by Devices.deviceKey from hex ids and a normalized
// name, so it is always [a-z0-9:-]. Anything else on disk was hand-written
// and can never match a real device; it is dropped rather than carried
// forward, because keys reach a generated Lua file.
function validKey(key) {
  return /^[a-z0-9:-]{1,128}$/.test(String(key || ""))
}

// The shape every device entry has. One definition, because an entry built
// without a `layout` reads back as a device whose buttons have no places.
function blankEntry() {
  return { label: "", learned: [], layout: {}, bindings: {}, dpi: null }
}

// Accept whatever is on disk and return something the UI can rely on.
// Unknown keys are dropped rather than preserved: this file is generated
// from the panel, and silently carrying junk forward hides bugs.
//
// `Dpi` is passed in rather than imported so this file stays loadable from
// a node test without QML's import machinery, the same reason generateLua
// takes `Actions`.
function normalize(raw, Dpi) {
  var out = defaults()
  if (!raw || typeof raw !== "object") return out

  if (raw.scopeToDevice === false) out.scopeToDevice = false

  var devices = raw.devices && typeof raw.devices === "object" ? raw.devices : {}
  for (var key in devices) {
    if (!Object.prototype.hasOwnProperty.call(devices, key)) continue
    if (!validKey(key)) continue
    var entry = devices[key] || {}
    var clean = blankEntry()
    clean.label = String(entry.label || "")
    if (Dpi) clean.dpi = Dpi.normalize(entry.dpi)

    // code -> place id, recorded by the guided pass. Places are validated
    // by the caller against Profiles.PLACES; anything unrecognised is kept
    // as a string here and simply fails to resolve to a slot later, which
    // degrades to the generic layout rather than breaking the diagram.
    var layout = entry.layout && typeof entry.layout === "object" ? entry.layout : {}
    for (var placeKey in layout) {
      if (!Object.prototype.hasOwnProperty.call(layout, placeKey)) continue
      var placeCode = parseInt(placeKey, 10)
      if (!validTrigger(placeCode)) continue
      var placeId = String(layout[placeKey] || "")
      if (placeId !== "") clean.layout[String(placeCode)] = placeId
    }

    if (Array.isArray(entry.learned)) {
      for (var i = 0; i < entry.learned.length; i++) {
        var code = parseInt(entry.learned[i], 10)
        if (validTrigger(code) && clean.learned.indexOf(code) === -1) {
          clean.learned.push(code)
        }
      }
      clean.learned.sort(function (a, b) { return a - b })
    }

    var bindings = entry.bindings && typeof entry.bindings === "object" ? entry.bindings : {}
    for (var codeKey in bindings) {
      if (!Object.prototype.hasOwnProperty.call(bindings, codeKey)) continue
      var parsed = parseInt(codeKey, 10)
      if (!validTrigger(parsed)) continue
      var binding = bindings[codeKey] || {}
      if (!binding.action || binding.action === "none") continue
      // The DPI preset a button jumps to is an index into this device's
      // preset list. Out of range is left as-is here and reported by
      // Actions.resolve, which is the only place that knows how many
      // presets the device actually has.
      var preset = parseInt(binding.preset, 10)
      clean.bindings[String(parsed)] = {
        action: String(binding.action),
        mods: Array.isArray(binding.mods) ? binding.mods.map(String) : [],
        key: binding.key ? String(binding.key) : "",
        command: binding.command ? String(binding.command) : "",
        preset: isFinite(preset) && preset >= 0 ? preset : 0
      }
    }
    out.devices[key] = clean
  }
  return out
}

function deviceEntry(config, key) {
  return (config && config.devices && config.devices[key]) || blankEntry()
}

function bindingFor(config, key, code) {
  var entry = deviceEntry(config, key)
  return entry.bindings[String(code)] || { action: "none", mods: [], key: "", command: "", preset: 0 }
}

function setBinding(config, key, code, binding) {
  if (!config.devices[key]) config.devices[key] = blankEntry()
  var slot = String(code)
  if (!binding || !binding.action || binding.action === "none") delete config.devices[key].bindings[slot]
  else config.devices[key].bindings[slot] = binding
  return config
}

function countBindings(config, key) {
  var entry = deviceEntry(config, key)
  var n = 0
  for (var k in entry.bindings) if (Object.prototype.hasOwnProperty.call(entry.bindings, k)) n++
  return n
}

// ------------------------------------------------------------ lua

var HEADER = [
  "-- Generated by MouseMap. Do not edit by hand.",
  "-- Source of truth: ~/.config/omarchy/mousemap.json",
  "--",
  "-- Loaded from ~/.config/hypr/bindings.lua via dofile, so it is re-read",
  "-- on every Hyprland reload rather than cached.",
  "--",
  "-- The panel window is floated by `mousemap float` rather than by a rule",
  "-- here: Hyprland matches window rules when the window maps, and",
  "-- Quickshell sets the title just after, so a title rule never matches.",
  ""
].join("\n")

// The DPI runtime.
//
// Everything a preset needs at press time happens in this file: the
// sensitivity tables are precomputed by Dpi.js, so switching a preset is
// one hl.device call with no process to spawn and no arithmetic to redo.
// The helper is only asked to persist the choice and draw the OSD, which
// can happen a few milliseconds later without anyone noticing.
//
// Devices are addressed by slot number rather than by name, so the only
// thing that ever reaches a command line is an integer. The helper looks
// the slot up in dpi.json, written beside this file by the same Apply.
function dpiPreamble(slots, Actions, Dpi, helperPath) {
  var lines = [
    "-- ---------------------------------------------------------------- DPI",
    "--",
    "-- Pointer speed per device, as libinput accel speeds under the flat",
    "-- profile, where the factor is exactly 1 + speed. See Dpi.js.",
    "",
    "local mm_names, mm_sens = {}, {}",
    "local mm_active, mm_held = {}, {}",
    "local mm_state = (os.getenv(\"HOME\") or \"\") .. \"/.local/state/omarchy-mousemap/dpi-active\"",
    "local mm_helper = " + Actions.luaString(helperPath),
    "",
    "-- The chosen preset outlives a reload. Without this, changing an",
    "-- unrelated Hyprland setting would silently put the pointer back to",
    "-- whatever the panel last saved.",
    "do",
    "  local file = io.open(mm_state, \"r\")",
    "  if file then",
    "    for line in file:lines() do",
    "      local slot, index = line:match(\"^(%d+)\\t(%d+)$\")",
    "      if slot then mm_active[tonumber(slot)] = tonumber(index) end",
    "    end",
    "    file:close()",
    "  end",
    "end",
    "",
    "local function mm_apply(slot)",
    "  local steps = mm_sens[slot]",
    "  if not steps then return end",
    "  local index = mm_held[slot] or mm_active[slot] or 1",
    "  if steps[index] == nil then index = 1 end",
    "  hl.device({ name = mm_names[slot], accel_profile = \"flat\", sensitivity = steps[index] })",
    "end",
    "",
    "-- A path with a space or a quote in it is still one argument.",
    "local function mm_quote(value)",
    "  return \"'\" .. tostring(value):gsub(\"'\", \"'\\\\''\") .. \"'\"",
    "end",
    "",
    "local function mm_select(slot, index)",
    "  local steps = mm_sens[slot]",
    "  if not steps or steps[index] == nil then return end",
    "  mm_active[slot] = index",
    "  mm_held[slot] = nil",
    "  mm_apply(slot)",
    "  hl.dispatch(hl.dsp.exec_cmd(mm_quote(mm_helper) .. \" dpi note \" .. slot .. \" \" .. index))",
    "end",
    "",
    "-- Lua's % is floored, so a step of -1 from the first preset lands on",
    "-- the last one rather than on nothing.",
    "local function mm_step(slot, delta)",
    "  local steps = mm_sens[slot]",
    "  if not steps or #steps == 0 then return end",
    "  mm_select(slot, ((mm_active[slot] or 1) - 1 + delta) % #steps + 1)",
    "end",
    "",
    "-- Sniper: the held preset is separate from the chosen one, so letting",
    "-- go always returns to whatever was selected rather than to a preset",
    "-- an earlier hold happened to leave behind.",
    "local function mm_hold(slot, index)",
    "  local steps = mm_sens[slot]",
    "  if not steps or steps[index] == nil then return end",
    "  mm_held[slot] = index",
    "  mm_apply(slot)",
    "end",
    "",
    "local function mm_release(slot)",
    "  mm_held[slot] = nil",
    "  mm_apply(slot)",
    "end",
    ""
  ]

  for (var i = 0; i < slots.length; i++) {
    var slot = slots[i]
    var n = i + 1
    var sens = []
    for (var p = 0; p < slot.presets.length; p++) sens.push(Dpi.luaSensitivity(slot.presets[p].sensitivity))
    lines.push(Actions.luaComment(slot.label + "  [" + slot.name + "]  base " + slot.base + " DPI"))
    lines.push("mm_names[" + n + "] = " + Actions.luaString(slot.name))
    lines.push("mm_sens[" + n + "] = { " + sens.join(", ") + " }")
    // A stale state file can name a preset that has since been deleted.
    lines.push("if mm_sens[" + n + "][mm_active[" + n + "] or 0] == nil then mm_active[" + n + "] = " + (slot.active + 1) + " end")
    lines.push("mm_apply(" + n + ")")
    lines.push("")
  }

  return lines.join("\n")
}

// Which devices get a DPI runtime slot, in the order the generated file
// numbers them.
//
// The generator emits from this and the panel reads the runtime's state
// file through it, so "slot 2" means the same mouse to both. Working it
// out twice is exactly how the two would drift the first time a device
// stopped qualifying for a reason only one of them knew about.
//
// Returns { slots, byKey, skipped } — slots[i] is the resolved DPI for
// slot i+1, byKey maps a device key to its slot number, and skipped
// carries devices that wanted a slot and could not have one.
function dpiSlots(devices, config, Dpi) {
  var slots = []
  var byKey = {}
  var skipped = []
  var list = devices || []
  if (!Dpi) return { slots: slots, byKey: byKey, skipped: skipped }

  for (var i = 0; i < list.length; i++) {
    var device = list[i]
    var resolved = Dpi.resolve(device, deviceEntry(config, device.key).dpi)
    if (resolved.empty) continue
    if (!resolved.ok) {
      skipped.push({ device: device.key, reason: resolved.error })
      continue
    }
    byKey[device.key] = slots.length + 1
    slots.push(resolved)
  }
  return { slots: slots, byKey: byKey, skipped: skipped }
}

// Build the whole file.
//
//   devices  discovery output, for the Hyprland device name and the label
//   config   normalized config
//   Actions  the Actions module (passed in so this file stays importable
//   Dpi      from node tests without QML's import machinery)
//   helper   absolute path to scripts/mousemap, which the DPI binds call
//            to persist a switch and draw the OSD
//
// Returns { text, binds, skipped, dpi } — `skipped` explains anything
// dropped so the panel can say why a mapping is not live, and `dpi` is the
// resolved per-device preset list, in the same slot order the generated
// binds use, so the panel can write the sidecar the helper reads.
function generateLua(devices, config, Actions, Dpi, helper) {
  var lines = [HEADER]
  var binds = 0
  var skipped = []
  var claimed = {}
  var list = devices || []

  // Pointer speed first: a button bound to a DPI preset compiles to a call
  // into the runtime this sets up, so the slots have to exist before the
  // binds that reference them are read.
  var dpi = dpiSlots(list, config, Dpi)
  for (var s = 0; s < dpi.skipped.length; s++) skipped.push(dpi.skipped[s])
  if (dpi.slots.length > 0) lines.push(dpiPreamble(dpi.slots, Actions, Dpi, helper))

  for (var d = 0; d < list.length; d++) {
    var device = list[d]
    var entry = deviceEntry(config, device.key)
    var dpiSlot = dpi.byKey[device.key] || 0
    var dpiResolved = dpiSlot > 0 ? dpi.slots[dpiSlot - 1] : null
    var codes = []
    for (var codeKey in entry.bindings) {
      if (Object.prototype.hasOwnProperty.call(entry.bindings, codeKey)) codes.push(parseInt(codeKey, 10))
    }
    if (codes.length === 0) continue
    codes.sort(function (a, b) { return a - b })

    var scoped = config.scopeToDevice && device.hyprName
    if (config.scopeToDevice && !device.hyprName) {
      skipped.push({ device: device.key, reason: "Hyprland does not report this device by name, so its bindings cannot be scoped to it." })
      continue
    }

    lines.push(Actions.luaComment((device.label || device.key)
      + (scoped ? "  [" + device.hyprName + "]" : "  [all pointers]")))

    for (var c = 0; c < codes.length; c++) {
      var code = codes[c]
      var resolved = Actions.resolve(entry.bindings[String(code)], { dpi: dpiResolved, dpiSlot: dpiSlot })
      if (!resolved.ok) {
        skipped.push({ device: device.key, code: code, reason: resolved.error || "incomplete binding" })
        continue
      }

      var isKey = code >= KEY_BASE
      var key = triggerBind(code)

      // Without device scoping every bind is global, so the first device
      // to claim a code wins and the rest would silently shadow it.
      if (!scoped && !isKey) {
        if (claimed[code]) {
          skipped.push({ device: device.key, code: code, reason: "button " + code + " is already bound globally by " + claimed[code] })
          continue
        }
        claimed[code] = device.label || device.key
      }


      // A keystroke from the mouse can only ever be bound scoped to the
      // mouse's keyboard device. Binding it globally would swallow that key
      // on the real keyboard — for a button that sends Ctrl or a digit,
      // that breaks typing outright — so it is refused instead.
      var bindDevice = isKey ? device.hyprKbdName : device.hyprName
      if (isKey && !bindDevice) {
        skipped.push({
          device: device.key, code: code,
          reason: "This button sends a keystroke, and Hyprland does not report the mouse as a keyboard, so it cannot be bound safely."
        })
        continue
      }
      if (isKey && !config.scopeToDevice) {
        skipped.push({
          device: device.key, code: code,
          reason: "This button sends a keystroke, which can only be bound with per-device scoping switched on."
        })
        continue
      }

      var description = "MouseMap: " + resolved.label
      var bindOptions = function (onRelease) {
        var out = "{ description = " + Actions.luaString(description)
        if (onRelease) out += ", release = true"
        if (scoped || isKey) out += ", device = { inclusive = true, list = { " + Actions.luaString(bindDevice) + " } }"
        return out + " }"
      }

      // Guarded unbind keeps the file idempotent when it is re-run into a
      // live session with hyprctl eval, where earlier binds still stand.
      // It clears the release half too, so a sniper button that stops
      // being one does not leave its restore behind.
      lines.push("pcall(hl.unbind, " + Actions.luaString(key) + ")")
      lines.push("hl.bind(" + Actions.luaString(key) + ", function()")
      lines.push(Actions.emitBody(resolved, "  "))
      lines.push("end, " + bindOptions(false) + ")")
      binds++

      // Hold-to-slow needs both edges. Hyprland keeps a press bind and a
      // release bind on the same key side by side, which is the whole
      // mechanism: the press drops the DPI and the release puts it back.
      var release = Actions.emitReleaseBody(resolved, "  ")
      if (release !== "") {
        lines.push("hl.bind(" + Actions.luaString(key) + ", function()")
        lines.push(release)
        lines.push("end, " + bindOptions(true) + ")")
      }
    }
    lines.push("")
  }

  if (binds === 0 && dpi.slots.length === 0) lines.push("-- Nothing mapped.")
  return { text: lines.join("\n") + "\n", binds: binds, skipped: skipped, dpi: dpi.slots }
}

// ------------------------------------------------------------ hook line

// The one line we add to the user's bindings.lua, inside markers so it can
// be found and removed again cleanly.
var HOOK_BEGIN = "-- BEGIN mousemap"
var HOOK_END = "-- END mousemap"

function hookBlock(statePath) {
  return [
    HOOK_BEGIN,
    "-- Mouse button bindings, generated by the MouseMap plugin.",
    "-- Remove this block to disable them; the file it loads is regenerated",
    "-- by the panel and is safe to delete.",
    'pcall(dofile, os.getenv("HOME") .. "' + statePath + '")',
    HOOK_END
  ].join("\n")
}

function hasHook(text) {
  return String(text || "").indexOf(HOOK_BEGIN) !== -1
}

// Append the block, or replace an existing one in place. Everything
// outside the markers is preserved byte for byte.
function withHook(text, statePath) {
  var body = String(text || "")
  var block = hookBlock(statePath)
  var begin = body.indexOf(HOOK_BEGIN)
  if (begin === -1) {
    var joiner = body.length === 0 || /\n\s*$/.test(body) ? "" : "\n"
    return body + joiner + "\n" + block + "\n"
  }
  var end = body.indexOf(HOOK_END, begin)
  if (end === -1) return body  // unclosed marker: refuse to guess where it ends
  return body.substring(0, begin) + block + body.substring(end + HOOK_END.length)
}

function withoutHook(text) {
  var body = String(text || "")
  var begin = body.indexOf(HOOK_BEGIN)
  if (begin === -1) return body
  var end = body.indexOf(HOOK_END, begin)
  if (end === -1) return body
  var after = body.substring(end + HOOK_END.length)
  var before = body.substring(0, begin)
  return (before.replace(/\n+$/, "\n") + after.replace(/^\n+/, "")).replace(/\n{3,}/g, "\n\n")
}

if (typeof module !== "undefined") {
  module.exports = {
    CONFIG_VERSION: CONFIG_VERSION,
    KEY_BASE: KEY_BASE,
    validTrigger: validTrigger,
    validKey: validKey,
    triggerBind: triggerBind,
    blankEntry: blankEntry,
    defaults: defaults,
    normalize: normalize,
    deviceEntry: deviceEntry,
    bindingFor: bindingFor,
    setBinding: setBinding,
    countBindings: countBindings,
    dpiSlots: dpiSlots,
    generateLua: generateLua,
    hookBlock: hookBlock,
    hasHook: hasHook,
    withHook: withHook,
    withoutHook: withoutHook,
    HOOK_BEGIN: HOOK_BEGIN,
    HOOK_END: HOOK_END
  }
}
