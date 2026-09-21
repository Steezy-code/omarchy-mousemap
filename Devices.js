// Mouse discovery.
//
// Two sources, joined on the device name:
//
//   /proc/bus/input/devices  world-readable, gives vendor:product and the
//                            evdev capability bitmaps. This is how we learn
//                            which buttons exist without needing to open
//                            /dev/input/event* (that needs the `input`
//                            group, which a desktop user normally lacks).
//
//   hyprctl devices -j       gives the name Hyprland knows the mouse by,
//                            which is the only string a device-scoped
//                            keybind will accept.
//
// The capability bitmap is authoritative for a mouse that enumerates as
// itself. It is NOT authoritative behind a Logitech unifying/Lightspeed
// receiver: that receiver is a HID multiplexer and advertises the union of
// everything it could ever carry (all 16 BTN_MOUSE codes plus a full
// keyboard) no matter what is actually paired. See looksMultiplexed().
// For those, the profile database or a learn pass supplies the truth.

var BTN_FIRST = 0x110 // BTN_LEFT
var BTN_LAST = 0x11f
var REL_X = 0x00
var REL_Y = 0x01

var BUTTON_NAMES = {
  0x110: "BTN_LEFT",
  0x111: "BTN_RIGHT",
  0x112: "BTN_MIDDLE",
  0x113: "BTN_SIDE",
  0x114: "BTN_EXTRA",
  0x115: "BTN_FORWARD",
  0x116: "BTN_BACK",
  0x117: "BTN_TASK"
}

// Human labels for what a code conventionally does before we remap it.
var BUTTON_DEFAULTS = {
  0x110: "Left click",
  0x111: "Right click",
  0x112: "Wheel click",
  0x113: "Back",
  0x114: "Forward",
  0x115: "Forward",
  0x116: "Back",
  0x117: "Task"
}

// ------------------------------------------------------------ triggers
//
// Not every button on a mouse sends a mouse button.
//
// A Logitech onboard profile can assign a button a keystroke or a G-shift
// macro, and then it arrives at the compositor as a *keyboard* key — from
// the receiver's keyboard interface, not its pointer one. Hyprland cannot
// bind that as mouse:<n> because by then it is not a mouse button.
//
// It can, however, bind the key scoped to that keyboard device, which is
// the mouse and nothing else. So a button is identified here by a trigger
// id rather than a raw button code:
//
//   272..287        a real mouse button, bound as mouse:<code>
//   KEY_BASE + kc   a keyboard key from the mouse, bound as code:<kc>
//
// Keeping both in one integer space means everything downstream — places,
// bindings, the diagram — keys off one id and needs no second code path.
var KEY_BASE = 0x1000

// xkb keycodes are evdev codes plus 8.
var XKB_OFFSET = 8

function isKeyTrigger(id) { return id >= KEY_BASE }
function keycodeOf(id) { return id - KEY_BASE }
function keyTrigger(xkbCode) { return KEY_BASE + xkbCode }
function evdevOf(id) { return keycodeOf(id) - XKB_OFFSET }

// What Hyprland's bind takes.
function triggerBind(id) {
  return isKeyTrigger(id) ? "code:" + keycodeOf(id) : "mouse:" + id
}

// Enough evdev key names to label a remapped mouse button usefully.
var KEY_NAMES = {
  1: "Esc", 14: "Backspace", 15: "Tab", 28: "Enter", 29: "Left Ctrl",
  42: "Left Shift", 54: "Right Shift", 56: "Left Alt", 57: "Space",
  97: "Right Ctrl", 100: "Right Alt", 125: "Left Meta", 126: "Right Meta",
  103: "Up", 105: "Left", 106: "Right", 108: "Down",
  104: "Page Up", 109: "Page Down", 102: "Home", 107: "End",
  110: "Insert", 111: "Delete", 1: "Esc"
}
var _digits = "1234567890"
for (var _d = 0; _d < _digits.length; _d++) KEY_NAMES[2 + _d] = _digits.charAt(_d)
var _rows = [
  [16, "qwertyuiop"],
  [30, "asdfghjkl"],
  [44, "zxcvbnm"]
]
for (var _r = 0; _r < _rows.length; _r++) {
  for (var _i = 0; _i < _rows[_r][1].length; _i++) {
    KEY_NAMES[_rows[_r][0] + _i] = _rows[_r][1].charAt(_i).toUpperCase()
  }
}
for (var _f = 0; _f < 12; _f++) KEY_NAMES[59 + _f] = "F" + (_f + 1)

function buttonName(code) {
  if (isKeyTrigger(code)) {
    var evdev = evdevOf(code)
    return KEY_NAMES[evdev] ? "Key " + KEY_NAMES[evdev] : "Key " + evdev
  }
  return BUTTON_NAMES[code] || ("BTN_" + code)
}

function defaultRole(code) {
  if (isKeyTrigger(code)) return buttonName(code)
  return BUTTON_DEFAULTS[code] || "Extra button"
}

// Left and right click are load-bearing: unbinding them mid-session leaves
// the user unable to click the panel that did it. Callers refuse to bind
// these without an explicit override.
function isProtected(code) {
  return code === 0x110 || code === 0x111
}

// ------------------------------------------------------------ bitmaps

// evdev bitmaps in /proc are space-separated 64-bit words printed most
// significant first, so the last word holds bits 0..63.
function parseBitmap(text) {
  var bits = {}
  var words = String(text || "").trim().split(/\s+/)
  if (words.length === 1 && words[0] === "") return bits
  for (var i = 0; i < words.length; i++) {
    var base = (words.length - 1 - i) * 64
    var word = words[i]
    // Parse as two 32-bit halves: a 64-bit hex word exceeds the exact
    // integer range of a double once the top bits are set, and bitwise
    // operators in JS truncate to 32 bits regardless.
    var split = word.length > 8 ? word.length - 8 : 0
    var low = parseInt(word.substring(split), 16) || 0
    var high = split > 0 ? (parseInt(word.substring(0, split), 16) || 0) : 0
    for (var b = 0; b < 32; b++) {
      if ((low >>> b) & 1) bits[base + b] = true
      if ((high >>> b) & 1) bits[base + 32 + b] = true
    }
  }
  return bits
}

function bitsIn(bits, first, last) {
  var out = []
  for (var code = first; code <= last; code++) if (bits[code]) out.push(code)
  return out
}

function countBits(bits) {
  var n = 0
  for (var k in bits) if (bits[k]) n++
  return n
}

// ------------------------------------------------------------ /proc parse

// One record per stanza in /proc/bus/input/devices.
function parseProcDevices(text) {
  var out = []
  var stanzas = String(text || "").split(/\n\s*\n/)
  for (var i = 0; i < stanzas.length; i++) {
    var stanza = stanzas[i]
    if (!stanza || stanza.indexOf("N: Name=") === -1) continue

    var ident = stanza.match(/I: Bus=(\w+) Vendor=(\w+) Product=(\w+) Version=(\w+)/)
    var name = stanza.match(/N: Name="([^"]*)"/)
    var sysfs = stanza.match(/S: Sysfs=(.*)/)
    var uniq = stanza.match(/U: Uniq=(.*)/)
    var handlers = stanza.match(/H: Handlers=(.*)/)
    var keyBits = stanza.match(/B: KEY=([0-9a-fA-F ]+)/)
    var relBits = stanza.match(/B: REL=([0-9a-fA-F ]+)/)

    var key = keyBits ? parseBitmap(keyBits[1]) : {}
    var rel = relBits ? parseBitmap(relBits[1]) : {}

    out.push({
      name: name ? name[1] : "",
      vendor: ident ? ident[2].toLowerCase() : "",
      product: ident ? ident[3].toLowerCase() : "",
      bus: ident ? ident[1].toLowerCase() : "",
      sysfs: sysfs ? sysfs[1].trim() : "",
      uniq: uniq ? uniq[1].trim() : "",
      handlers: handlers ? handlers[1].trim().split(/\s+/) : [],
      buttons: bitsIn(key, BTN_FIRST, BTN_LAST),
      keyboardKeys: countBits(key) - bitsIn(key, BTN_FIRST, BTN_LAST).length,
      hasRelXY: !!(rel[REL_X] && rel[REL_Y])
    })
  }
  return out
}

// A pointing device: relative X/Y plus at least a left button. Excludes
// touchpads, which report ABS and no REL, and keyboards.
function isMouse(record) {
  return !!record && record.hasRelXY && record.buttons.indexOf(0x110) !== -1
}

// A wireless receiver advertising the whole BTN_MOUSE range and a full
// keyboard is describing its own potential, not the mouse paired to it.
// Real mice stop well short of 16 buttons and carry few or no key codes.
function looksMultiplexed(record) {
  if (!record) return false
  return record.buttons.length >= 15 && record.keyboardKeys > 100
}

// The receiver's sysfs path nests the paired device's own HID id under the
// receiver's, e.g. .../0003:046D:C539.0003/0003:046D:4079.0008/input/input17
// The last such pair is the mouse itself, which is what we want to match a
// profile against — C539 is just the dongle.
function idFromSysfs(record) {
  var matches = String(record && record.sysfs || "").match(/[0-9a-fA-F]{4}:([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\./g)
  if (!matches || matches.length === 0) return null
  var last = matches[matches.length - 1].match(/[0-9a-fA-F]{4}:([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\./)
  return { vendor: last[1].toLowerCase(), product: last[2].toLowerCase() }
}

// ------------------------------------------------------------ name joining

// Hyprland lowercases the libinput name and replaces each run-breaking
// character with a dash, so "Logitech G Pro " becomes "logitech-g-pro-",
// then appends "-<n>" when several seats share a name. Normalizing both
// sides and comparing by prefix survives that suffix.
function normalizeName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

function namesMatch(procName, hyprName) {
  var a = normalizeName(procName)
  var b = normalizeName(hyprName)
  if (a === "" || b === "") return false
  if (a === b) return true
  // Hyprland's duplicate suffix only ever adds -<digits>.
  return b.indexOf(a) === 0 && /^-?\d+$/.test(b.substring(a.length))
}

function findHyprName(procName, hyprMice) {
  var list = hyprMice || []
  for (var i = 0; i < list.length; i++) {
    var candidate = typeof list[i] === "string" ? list[i] : list[i].name
    if (namesMatch(procName, candidate)) return candidate
  }
  return ""
}

// hyprctl devices -j
function parseHyprDevices(json) {
  return hyprNames(json, "mice")
}

// The same physical mouse shows up a second time as a keyboard when it can
// send keystrokes. That entry has its own name — "logitech-g-pro-" beside
// the pointer's "logitech-g-pro--1" — and it is the device a key bind has
// to be scoped to.
function parseHyprKeyboards(json) {
  return hyprNames(json, "keyboards")
}

function hyprNames(json, section) {
  var data = json
  if (typeof data === "string") {
    try { data = JSON.parse(data) } catch (e) { return [] }
  }
  var list = (data && data[section]) || []
  var out = []
  for (var i = 0; i < list.length; i++) if (list[i] && list[i].name) out.push(list[i].name)
  return out
}

// ------------------------------------------------------------ battery

// Match a power supply to a mouse.
//
// The kernel hangs a wireless peripheral's battery off the very HID node
// the input device sits under, so the battery's device path is a prefix of
// the input device's sysfs path. That is an exact identity, and it keeps
// working when two of the same model are paired to one receiver — which
// matching on model name would not.
//
// Serial is the fallback: HID++ reports the same value as the input
// device's Uniq, which covers a kernel that exposes the supply somewhere
// else in the tree.
function matchBattery(record, batteries) {
  var list = batteries || []
  var sysfs = String(record && record.sysfs || "")
  var uniq = String(record && record.uniq || "").trim()

  for (var i = 0; i < list.length; i++) {
    var path = String(list[i].path || "")
    if (path !== "" && sysfs.indexOf(path) === 0) return normalizeBattery(list[i])
  }
  if (uniq !== "") {
    for (var s = 0; s < list.length; s++) {
      if (String(list[s].serial || "").trim() === uniq) return normalizeBattery(list[s])
    }
  }
  return null
}

// capacity_level is the coarse fallback ("Full", "Low") some devices report
// instead of a percentage, so a mouse that only reports one of the two
// still shows something useful.
var LEVEL_PERCENT = { Full: 100, High: 80, Normal: 55, Low: 20, Critical: 5 }

function normalizeBattery(raw) {
  var percent = parseInt(raw.capacity, 10)
  if (!isFinite(percent) || percent < 0 || percent > 100) {
    percent = LEVEL_PERCENT[raw.level] !== undefined ? LEVEL_PERCENT[raw.level] : -1
  }
  var status = String(raw.status || "").trim()
  return {
    id: String(raw.id || ""),
    // Straight off sysfs, and it becomes the device label, so it is
    // flattened here rather than carried with whatever the device put in it.
    model: cleanName(raw.model),
    percent: percent,
    level: String(raw.level || "").trim(),
    status: status,
    charging: status === "Charging" || status === "Full",
    // Below this a wireless mouse is close enough to dying to say so.
    low: percent >= 0 && percent <= 20 && status !== "Charging"
  }
}

function batteryLabel(battery) {
  if (!battery) return ""
  var parts = []
  if (battery.percent >= 0) parts.push(battery.percent + "%")
  else if (battery.level !== "") parts.push(battery.level)
  if (battery.charging) parts.push("charging")
  return parts.join(" · ")
}

// ------------------------------------------------------------ discovery

// Join everything into the device list the UI renders. `learned` maps a
// device key to a button-code array recorded by the learn pass, which
// outranks both the profile and the capability bitmap because the user
// physically pressed those buttons.
//
// Returns one entry per mouse:
//   key           stable identity for config storage
//   label         display name
//   hyprName      device string for a scoped bind ("" if Hyprland can't see it)
//   buttons       [{ code, name, role, protected }]
//   source        where the button list came from
//   trusted       false when we are guessing and should prompt for a learn pass
function discover(procText, hyprJson, profiles, learned, batteries) {
  var records = parseProcDevices(procText)
  var hyprMice = parseHyprDevices(hyprJson)
  var hyprKeyboards = parseHyprKeyboards(hyprJson)
  var out = []

  for (var i = 0; i < records.length; i++) {
    var record = records[i]
    if (!isMouse(record)) continue

    var real = idFromSysfs(record) || { vendor: record.vendor, product: record.product }
    var key = deviceKey(record, real)
    var profile = profiles ? matchProfile(profiles, real, record.name) : null
    var multiplexed = looksMultiplexed(record)

    var codes = null
    var source = ""
    var trusted = true

    var pinned = learned ? learned[key] : null
    if (pinned && pinned.length > 0) {
      codes = pinned.slice()
      source = "learned"
    } else if (profile && profile.buttons && profile.buttons.length > 0) {
      codes = []
      for (var p = 0; p < profile.buttons.length; p++) codes.push(profile.buttons[p].code)
      source = "profile"
    } else if (multiplexed) {
      // The bitmap is the receiver's, not the mouse's. Assume the shape
      // every mouse has and let the user correct it by learning.
      codes = [0x110, 0x111, 0x112, 0x113, 0x114]
      source = "assumed"
      trusted = false
    } else {
      codes = record.buttons.slice()
      source = "capabilities"
    }

    var battery = matchBattery(record, batteries)

    out.push({
      key: key,
      // A HID++ battery reports the marketing model name, which beats
      // the terse string the input device enumerates with.
      label: (profile && profile.name) || (battery && battery.model) || cleanName(record.name),
      battery: battery,
      vendor: real.vendor,
      product: real.product,
      hyprName: findHyprName(record.name, hyprMice),
      // Empty for a mouse that sends no keystrokes; key triggers are
      // refused rather than bound globally when this is missing.
      hyprKbdName: findHyprName(record.name, hyprKeyboards),
      procName: record.name,
      profileId: profile ? profile.id : "",
      multiplexed: multiplexed,
      source: source,
      trusted: trusted,
      buttons: describeButtons(codes, profile)
    })
  }
  return out
}

// Vendor:product is the identity that survives a replug on a different
// port; the name disambiguates two of the same model.
function deviceKey(record, real) {
  var id = real || { vendor: record.vendor, product: record.product }
  return id.vendor + ":" + id.product + ":" + normalizeName(record.name)
}

function cleanName(name) {
  var flat = String(name || "").replace(/[\u0000-\u001f\u007f]/g, " ")
  return flat.replace(/\s+/g, " ").replace(/^ | $/g, "") || "Mouse"
}

function describeButtons(codes, profile) {
  var byCode = {}
  if (profile && profile.buttons) {
    for (var i = 0; i < profile.buttons.length; i++) byCode[profile.buttons[i].code] = profile.buttons[i]
  }
  var out = []
  for (var c = 0; c < codes.length; c++) {
    var code = codes[c]
    var spec = byCode[code]
    out.push({
      code: code,
      name: buttonName(code),
      role: (spec && spec.role) || defaultRole(code),
      protected: isProtected(code)
    })
  }
  out.sort(function (a, b) { return a.code - b.code })
  return out
}

// ------------------------------------------------------------ profiles

// First profile whose vendor matches and whose product list contains this
// product wins; a vendor-wide profile with no product list is the fallback.
function matchProfile(profiles, id, name) {
  var list = profiles || []
  var vendorWide = null
  for (var i = 0; i < list.length; i++) {
    var profile = list[i]
    var match = profile.match || {}
    if (match.vendor && match.vendor.toLowerCase() !== id.vendor) continue
    if (match.product && match.product.length > 0) {
      var hit = false
      for (var p = 0; p < match.product.length; p++) {
        if (String(match.product[p]).toLowerCase() === id.product) { hit = true; break }
      }
      if (hit) return profile
      continue
    }
    if (match.name && normalizeName(name).indexOf(normalizeName(match.name)) === -1) continue
    if (!vendorWide) vendorWide = profile
  }
  return vendorWide
}

if (typeof module !== "undefined") {
  module.exports = {
    BTN_FIRST: BTN_FIRST,
    BTN_LAST: BTN_LAST,
    buttonName: buttonName,
    defaultRole: defaultRole,
    isProtected: isProtected,
    parseBitmap: parseBitmap,
    parseProcDevices: parseProcDevices,
    isMouse: isMouse,
    looksMultiplexed: looksMultiplexed,
    idFromSysfs: idFromSysfs,
    normalizeName: normalizeName,
    namesMatch: namesMatch,
    findHyprName: findHyprName,
    parseHyprDevices: parseHyprDevices,
    parseHyprKeyboards: parseHyprKeyboards,
    KEY_BASE: KEY_BASE,
    isKeyTrigger: isKeyTrigger,
    keycodeOf: keycodeOf,
    keyTrigger: keyTrigger,
    evdevOf: evdevOf,
    triggerBind: triggerBind,
    discover: discover,
    deviceKey: deviceKey,
    describeButtons: describeButtons,
    matchProfile: matchProfile,
    matchBattery: matchBattery,
    normalizeBattery: normalizeBattery,
    batteryLabel: batteryLabel
  }
}
