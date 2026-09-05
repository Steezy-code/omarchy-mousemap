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

// The shape every device entry has. One definition, because an entry built
// without a `layout` reads back as a device whose buttons have no places.
function blankEntry() {
  return { label: "", learned: [], layout: {}, bindings: {} }
}

// Accept whatever is on disk and return something the UI can rely on.
// Unknown keys are dropped rather than preserved: this file is generated
// from the panel, and silently carrying junk forward hides bugs.
function normalize(raw) {
  var out = defaults()
  if (!raw || typeof raw !== "object") return out

  if (raw.scopeToDevice === false) out.scopeToDevice = false

  var devices = raw.devices && typeof raw.devices === "object" ? raw.devices : {}
  for (var key in devices) {
    if (!Object.prototype.hasOwnProperty.call(devices, key)) continue
    var entry = devices[key] || {}
    var clean = blankEntry()
    clean.label = String(entry.label || "")

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
      clean.bindings[String(parsed)] = {
        action: String(binding.action),
        mods: Array.isArray(binding.mods) ? binding.mods.map(String) : [],
        key: binding.key ? String(binding.key) : "",
        command: binding.command ? String(binding.command) : ""
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
  return entry.bindings[String(code)] || { action: "none", mods: [], key: "", command: "" }
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

// Build the whole file.
//
//   devices  discovery output, for the Hyprland device name and the label
//   config   normalized config
//   Actions  the Actions module (passed in so this file stays importable
//            from node tests without QML's import machinery)
//
// Returns { text, binds, skipped } — `skipped` explains anything dropped
// so the panel can say why a mapping is not live.
function generateLua(devices, config, Actions) {
  var lines = [HEADER]
  var binds = 0
  var skipped = []
  var claimed = {}

  var list = devices || []
  for (var d = 0; d < list.length; d++) {
    var device = list[d]
    var entry = deviceEntry(config, device.key)
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

    lines.push("-- " + (device.label || device.key) + (scoped ? "  [" + device.hyprName + "]" : "  [all pointers]"))

    for (var c = 0; c < codes.length; c++) {
      var code = codes[c]
      var resolved = Actions.resolve(entry.bindings[String(code)])
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
      var options = "{ description = " + Actions.luaString(description)
      if (scoped || isKey) options += ", device = { inclusive = true, list = { " + Actions.luaString(bindDevice) + " } }"
      options += " }"

      // Guarded unbind keeps the file idempotent when it is re-run into a
      // live session with hyprctl eval, where earlier binds still stand.
      lines.push("pcall(hl.unbind, " + Actions.luaString(key) + ")")
      lines.push("hl.bind(" + Actions.luaString(key) + ", function()")
      lines.push(Actions.emitBody(resolved, "  "))
      lines.push("end, " + options + ")")
      binds++
    }
    lines.push("")
  }

  if (binds === 0) lines.push("-- No buttons mapped.")
  return { text: lines.join("\n") + "\n", binds: binds, skipped: skipped }
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
    triggerBind: triggerBind,
    blankEntry: blankEntry,
    defaults: defaults,
    normalize: normalize,
    deviceEntry: deviceEntry,
    bindingFor: bindingFor,
    setBinding: setBinding,
    countBindings: countBindings,
    generateLua: generateLua,
    hookBlock: hookBlock,
    hasHook: hasHook,
    withHook: withHook,
    withoutHook: withoutHook,
    HOOK_BEGIN: HOOK_BEGIN,
    HOOK_END: HOOK_END
  }
}
