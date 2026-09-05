// Pointer speed, expressed in DPI, and the presets you switch between.
//
// Nothing here writes to the mouse. Like the rest of MouseMap, a preset is
// a compositor setting scoped to one device, so the mouse behaves exactly
// as it did out of the box on any other machine.
//
// ------------------------------------------------------------ the math
//
// Hyprland hands a device's `sensitivity` straight to libinput as the
// pointer acceleration speed, clamped to [-1, 1]. Under the *flat* accel
// profile libinput turns that into a constant factor:
//
//     factor = speed + 1                      (libinput filter-flat.c)
//
// so it is an exact linear multiplier from 0x to 2x, with 1x at 0. That
// is the whole reason presets are pinned to `accel_profile = "flat"`: the
// adaptive profile's curve is velocity-dependent, and a "DPI" computed
// against it would be a number that means nothing.
//
//     effective = base * (1 + sensitivity)
//     sensitivity = effective / base - 1
//
// where `base` is the DPI the mouse's own sensor is set to. So a preset is
// reachable when 0 < target <= 2 * base.
//
// The 2x ceiling sounds like a limitation and mostly is not, because
// scaling *down* from a high hardware DPI is the good direction: the
// sensor still reports at full resolution and the compositor divides, so
// low-DPI motion stays smooth. Scaling up multiplies whole sensor counts
// and steps the pointer. The advice that falls out — set the mouse's
// onboard DPI to the highest you will ever want, then use presets to come
// down from it — is what you would want to do anyway.
//
// If `base` is wrong, every preset is wrong by the same factor: the
// numbers become labels but the ratios between them stay exact. Worth
// knowing, because it means a user who cannot find out what their mouse is
// set to still gets a working feature.

// libinput's flat profile tops out at 2x.
var MAX_FACTOR = 2

// Hardware DPI the presets are measured against when nothing says
// otherwise. 800 is the most common factory default; the panel says
// plainly that it is a guess and where to check.
var DEFAULT_BASE = 800

// A sensor below this is not a real setting, and above it is beyond
// anything shipping. Bounds, not opinions — they only exist to keep a
// typo out of the generated Lua.
var MIN_BASE = 100
var MAX_BASE = 32000

// Presets are rounded to this, because DPI is quoted in round numbers and
// a slider that lands on 1447 reads as broken.
var STEP = 50

var MAX_PRESETS = 8
var MAX_NAME = 24

// Sensitivity is written into Lua as a literal, so it is fixed to a known
// number of decimals rather than left to whatever the runtime prints.
var SENS_DECIMALS = 6

function clamp(value, low, high) {
  return value < low ? low : (value > high ? high : value)
}

function isNumber(value) {
  return typeof value === "number" && isFinite(value)
}

// ------------------------------------------------------------ conversion

// The sensitivity that makes `base` feel like `target`, or null when no
// sensitivity can: libinput cannot exceed 2x, and 0x is a pointer that
// does not move.
function sensitivityFor(target, base) {
  if (!isNumber(target) || !isNumber(base)) return null
  if (base <= 0 || target <= 0) return null
  var sens = target / base - 1
  if (sens < -1 || sens > MAX_FACTOR - 1) return null
  return sens
}

function effectiveDpi(sensitivity, base) {
  if (!isNumber(sensitivity) || !isNumber(base)) return 0
  return base * (1 + sensitivity)
}

// The highest DPI this base can reach.
function ceilingFor(base) {
  return Math.round(normalizeBase(base) * MAX_FACTOR)
}

function reachable(target, base) {
  return sensitivityFor(target, base) !== null
}

// A Lua number literal. Rounded first so the same preset always generates
// the same bytes, which is what lets the panel compare what is on disk
// against what it would write and skip a pointless rewrite.
function luaSensitivity(sensitivity) {
  var value = clamp(isNumber(sensitivity) ? sensitivity : 0, -1, MAX_FACTOR - 1)
  var text = value.toFixed(SENS_DECIMALS)
  // toFixed(-0.0000001) is "-0.000000", which is a valid Lua number but an
  // ugly one to find in a generated file.
  return text === "-0." + new Array(SENS_DECIMALS + 1).join("0") ? "0." + new Array(SENS_DECIMALS + 1).join("0") : text
}

// ------------------------------------------------------------ config shape

function blank() {
  return { enabled: false, base: DEFAULT_BASE, active: 0, presets: [] }
}

function normalizeBase(base) {
  var value = Math.round(Number(base))
  if (!isFinite(value)) return DEFAULT_BASE
  return clamp(value, MIN_BASE, MAX_BASE)
}

function normalizeDpi(value, base) {
  var dpi = Math.round(Number(value) / STEP) * STEP
  if (!isFinite(dpi)) return normalizeBase(base)
  return clamp(dpi, STEP, ceilingFor(base))
}

// Strip a name down to something that can sit on a preset chip and in an
// OSD line. Control characters are dropped rather than escaped: a name is
// a label, and a label with a newline in it is a mistake, not a style.
function normalizeName(value, fallback) {
  var text = String(value === undefined || value === null ? "" : value)
  var out = ""
  for (var i = 0; i < text.length && out.length < MAX_NAME; i++) {
    var code = text.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) continue
    out += text.charAt(i)
  }
  out = out.replace(/\s+/g, " ").replace(/^ | $/g, "")
  return out === "" ? String(fallback || "Preset") : out
}

// Accept whatever is on disk and hand back something every caller can
// index into without checking. Presets that cannot be reached from the
// stored base are clamped rather than dropped, because dropping one
// silently renumbers every preset after it — and the index is what a
// button is bound to.
function normalize(raw) {
  var out = blank()
  if (!raw || typeof raw !== "object") return out

  out.base = normalizeBase(raw.base)

  var list = Array.isArray(raw.presets) ? raw.presets : []
  for (var i = 0; i < list.length && out.presets.length < MAX_PRESETS; i++) {
    var entry = list[i] || {}
    var dpi = normalizeDpi(entry.dpi, out.base)
    out.presets.push({ name: normalizeName(entry.name, dpi + " DPI"), dpi: dpi })
  }

  out.enabled = raw.enabled === true && out.presets.length > 0

  var active = parseInt(raw.active, 10)
  out.active = isFinite(active) && active >= 0 && active < out.presets.length ? active : 0
  return out
}

// Presets for a mouse that has none yet: the base itself, and the two
// halvings below it. Fractions of the base rather than fixed numbers, so
// the seeds are always reachable whatever the sensor is set to, and
// always land on the exact ratios a DPI-shift button is wanted for.
function seedPresets(base) {
  var top = normalizeBase(base)
  var made = [
    { name: "Sniper", dpi: normalizeDpi(top / 4, top) },
    { name: "Precise", dpi: normalizeDpi(top / 2, top) },
    { name: "Full", dpi: top }
  ]
  // A very low base collapses the quarter and half steps into the same
  // number, and two presets that do the same thing is worse than one.
  var out = []
  for (var i = 0; i < made.length; i++) {
    var duplicate = false
    for (var j = 0; j < out.length; j++) if (out[j].dpi === made[i].dpi) duplicate = true
    if (!duplicate) out.push(made[i])
  }
  return out
}

function enable(dpi) {
  var next = normalize(dpi)
  if (next.presets.length === 0) next.presets = seedPresets(next.base)
  next.active = next.presets.length - 1
  next.enabled = true
  return next
}

// Re-point every preset at a new base, keeping the DPI numbers where they
// still fit. Raising the base leaves them alone; lowering it past a
// preset's DPI clamps that preset to the new ceiling, because a preset
// that cannot be reached is a preset that silently does nothing.
function withBase(dpi, base) {
  var next = normalize(dpi)
  next.base = normalizeBase(base)
  for (var i = 0; i < next.presets.length; i++) {
    next.presets[i] = { name: next.presets[i].name, dpi: normalizeDpi(next.presets[i].dpi, next.base) }
  }
  return next
}

function setPreset(dpi, index, patch) {
  var next = normalize(dpi)
  if (index < 0 || index >= next.presets.length) return next
  var current = next.presets[index]
  next.presets[index] = {
    name: patch && patch.name !== undefined ? normalizeName(patch.name, current.name) : current.name,
    dpi: patch && patch.dpi !== undefined ? normalizeDpi(patch.dpi, next.base) : current.dpi
  }
  return next
}

// A new preset lands a step above the highest one, which is where someone
// adding one usually wants it, and never on top of an existing preset —
// two presets with the same DPI are indistinguishable once they are chips
// on a panel, and one of them can never be selected by feel.
//
// Once the top of the range is full it walks down instead of up, so
// adding still produces something usable on a mouse whose presets already
// reach the ceiling.
function addPreset(dpi) {
  var next = normalize(dpi)
  if (next.presets.length >= MAX_PRESETS) return next

  var taken = {}
  var highest = 0
  for (var i = 0; i < next.presets.length; i++) {
    taken[next.presets[i].dpi] = true
    highest = Math.max(highest, next.presets[i].dpi)
  }

  var ceiling = ceilingFor(next.base)
  var candidate = normalizeDpi(highest > 0 ? highest * 2 : next.base, next.base)
  if (taken[candidate]) {
    // Free slots below the ceiling, nearest the top first. STEP apart and
    // bounded by MAX_PRESETS, so this always terminates with room to spare.
    candidate = 0
    for (var value = ceiling; value >= STEP; value -= STEP) {
      if (!taken[value]) { candidate = value; break }
    }
    if (candidate === 0) return next
  }

  next.presets.push({ name: candidate + " DPI", dpi: candidate })
  next.active = next.presets.length - 1
  return next
}

// Removing a preset renumbers the ones after it, and a button bound to
// "preset 3" now points somewhere else. Callers get the index map back so
// they can move those bindings with it.
function removePreset(dpi, index) {
  var next = normalize(dpi)
  if (index < 0 || index >= next.presets.length) return { dpi: next, remap: null }
  var remap = {}
  var kept = []
  for (var i = 0; i < next.presets.length; i++) {
    if (i === index) { remap[i] = -1; continue }
    remap[i] = kept.length
    kept.push(next.presets[i])
  }
  next.presets = kept
  next.enabled = next.enabled && kept.length > 0
  next.active = clamp(next.active > index ? next.active - 1 : next.active, 0, Math.max(0, kept.length - 1))
  return { dpi: next, remap: remap }
}

function activePreset(dpi) {
  var current = normalize(dpi)
  if (current.presets.length === 0) return null
  return current.presets[clamp(current.active, 0, current.presets.length - 1)]
}

function presetLabel(preset) {
  if (!preset) return ""
  return preset.name + " · " + preset.dpi + " DPI"
}

// ------------------------------------------------------------ resolution

// Everything the generator and the runtime helper need for one device, or
// a reason there is nothing to generate. Both consumers read this rather
// than redoing the arithmetic, so the sensitivity a preset compiles to and
// the sensitivity the helper applies cannot drift apart.
function resolve(device, dpi) {
  var config = normalize(dpi)
  if (!config.enabled || config.presets.length === 0) return { ok: false, empty: true }
  if (!device || !device.hyprName) {
    return {
      ok: false, empty: false,
      error: "Hyprland does not report this device by name, so its pointer speed cannot be set for it alone."
    }
  }

  var presets = []
  for (var i = 0; i < config.presets.length; i++) {
    var preset = config.presets[i]
    var sens = sensitivityFor(preset.dpi, config.base)
    // normalize() clamps every preset into range, so this cannot be null
    // unless a caller hand-built the object. Treat it as a hard skip
    // rather than emitting a sensitivity Hyprland would reject.
    if (sens === null) continue
    presets.push({ name: preset.name, dpi: preset.dpi, sensitivity: sens })
  }
  if (presets.length === 0) return { ok: false, empty: true }

  return {
    ok: true, empty: false,
    name: device.hyprName,
    label: device.label || device.key || "Mouse",
    base: config.base,
    active: clamp(config.active, 0, presets.length - 1),
    presets: presets
  }
}

// Which preset each device is on, in the format the generated Lua reads
// back on load and the helper rewrites on every runtime switch.
//
// Apply writes this as well as the Lua, so choosing a preset in the panel
// wins over whatever a DPI button last left behind. Without it the panel
// would appear to do nothing: the generated file would set the preset the
// panel asked for and this file would immediately override it.
function activeFile(slots) {
  var lines = []
  // `slots` is the generator's slot list: every entry is a device that got
  // a slot, and its position *is* the slot number. Filtering here instead
  // of trusting that would renumber everything after a dropped entry, and
  // the generated Lua would then be reading another mouse's preset.
  for (var i = 0; i < slots.length; i++) {
    lines.push((i + 1) + "\t" + (slots[i].active + 1))
  }
  return lines.length === 0 ? "" : lines.join("\n") + "\n"
}

// The JSON the helper script reads to answer "what is preset 2 on device
// 1, and what does it say in the OSD". Written beside the generated Lua on
// every Apply. Indices here are the same ones the generated binds pass, so
// nothing but integers ever reaches a command line.
//
// Takes the generator's slot list, whose order is the slot numbering.
function sidecar(slots) {
  var devices = []
  // Same contract as activeFile: position is the slot number, so nothing
  // may be skipped here either.
  for (var i = 0; i < slots.length; i++) {
    var entry = slots[i]
    devices.push({
      name: entry.name,
      label: entry.label,
      base: entry.base,
      active: entry.active,
      presets: entry.presets
    })
  }
  return { version: 1, devices: devices }
}

if (typeof module !== "undefined") {
  module.exports = {
    MAX_FACTOR: MAX_FACTOR,
    DEFAULT_BASE: DEFAULT_BASE,
    MIN_BASE: MIN_BASE,
    MAX_BASE: MAX_BASE,
    STEP: STEP,
    MAX_PRESETS: MAX_PRESETS,
    MAX_NAME: MAX_NAME,
    blank: blank,
    normalize: normalize,
    normalizeBase: normalizeBase,
    normalizeDpi: normalizeDpi,
    normalizeName: normalizeName,
    sensitivityFor: sensitivityFor,
    effectiveDpi: effectiveDpi,
    ceilingFor: ceilingFor,
    reachable: reachable,
    luaSensitivity: luaSensitivity,
    seedPresets: seedPresets,
    enable: enable,
    withBase: withBase,
    setPreset: setPreset,
    addPreset: addPreset,
    removePreset: removePreset,
    activePreset: activePreset,
    presetLabel: presetLabel,
    resolve: resolve,
    sidecar: sidecar,
    activeFile: activeFile
  }
}
