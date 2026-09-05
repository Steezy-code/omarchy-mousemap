// Mouse shapes and known-device profiles.
//
// Geometry lives in a fixed 100 x 160 "mouse box", origin top-left, which
// the canvas scales to whatever room it has. Everything is generated from
// a handful of shape parameters rather than per-model artwork, so a mouse
// nobody has ever profiled still draws as a mouse and still puts its
// leaders in the right places.
//
// A profile supplies the button list and picks a shape. When no profile
// matches, genericButtons() lays out however many buttons were actually
// detected, which is what makes the diagram track a 2-button travel mouse
// and a 7-button gaming mouse without special-casing either.

var BOX_W = 100
var BOX_H = 160

// ------------------------------------------------------------ shapes
//
// A shape is a width profile down the length of the shell, plus the seam
// that reads as a mouse: the split between the click panels and the palm.
// The outline is sampled from that profile rather than drawn as beziers,
// so button anchors and the drawn edge can never disagree.
//
//   hip     half-width across the palm, as a fraction of the box
//   front   how much the nose half is pinched relative to the palm
//   bulge   how far the left flank swells for a thumb rest (ergo shells)
//   split   y of the line dividing click panels from palm

// Every shape must keep its widest point inside the box; the tests sweep
// the whole silhouette and enforce it.
var SHAPES = {
  ambi:    { hip: 0.46, front: 1.02, bulge: 0.00, split: 0.42 },
  ergo:    { hip: 0.44, front: 0.92, bulge: 0.06, split: 0.44 },
  compact: { hip: 0.41, front: 1.00, bulge: 0.02, split: 0.46 },
  generic: { hip: 0.45, front: 0.97, bulge: 0.03, split: 0.44 }
}

function shape(name) {
  return SHAPES[name] || SHAPES.generic
}

// Where the rounded nose and tail caps begin, as a fraction of box height.
//
// These bands are wide on purpose. A cap is a half-ellipse, so its band has
// to be roughly as tall as the shell is wide or the end reads as a point
// instead of a curve — the back of a mouse is a broad round dome, not a
// taper, and a narrow tail band is what makes a generated silhouette look
// like an egg.
var NOSE_T = 0.15
var TAIL_T = 0.74

// Width down the length of the shell, as a fraction of the hip, before the
// end caps are applied. Front narrower than back, widest across the palm.
var PROFILE = [
  [0.00, 0.60],
  [0.15, 0.73],
  [0.35, 0.81],
  [0.55, 0.92],
  [0.72, 1.00],
  [0.88, 0.98],
  [1.00, 0.93]
]

// Catmull-Rom through the profile knots. Interpolating linearly leaves
// facets the renderer's smoothing cannot hide, and smoothstep between
// knots flattens the curve at every one of them; Catmull-Rom passes
// through each knot with a continuous tangent, which is what a moulded
// shell looks like.
function profileWidth(t) {
  var x = Math.max(0, Math.min(1, t))
  var i = 0
  while (i < PROFILE.length - 2 && x > PROFILE[i + 1][0]) i++

  var p0 = PROFILE[Math.max(0, i - 1)]
  var p1 = PROFILE[i]
  var p2 = PROFILE[i + 1]
  var p3 = PROFILE[Math.min(PROFILE.length - 1, i + 2)]

  var span = p2[0] - p1[0]
  var u = span > 0 ? (x - p1[0]) / span : 0
  var u2 = u * u
  var u3 = u2 * u

  return 0.5 * (
    (2 * p1[1]) +
    (-p0[1] + p2[1]) * u +
    (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * u2 +
    (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * u3
  )
}

// Half-width of the shell at a given y.
//
// This is the single source of truth for the silhouette: outlinePoints()
// samples it to draw the shell, and anchorFor() calls it to sit a flank
// button on the edge. Deriving both from one function is what keeps a
// side-button marker welded to the outline instead of floating a few
// pixels off it whenever a shape parameter changes.
function halfWidthAt(shapeName, y, side) {
  var s = shape(shapeName)
  var t = Math.max(0, Math.min(1, y / BOX_H))
  var hip = s.hip * BOX_W

  // Shared profile, scaled to this shell's palm width. `front` pinches or
  // relaxes the nose half only, which is the difference between a slim
  // ambidextrous shape and a fat-palmed ergo one.
  var front = t < 0.5 ? s.front + (1 - s.front) * (t / 0.5) : 1
  var width = hip * profileWidth(t) * front

  if (side === "left") width += s.bulge * BOX_W * bulgeFalloff(t)

  // Elliptical caps round the nose and tail off to a point, so the shell
  // reads as a mouse rather than a rounded rectangle.
  if (t < NOSE_T) width *= capScale((NOSE_T - t) / NOSE_T)
  else if (t > TAIL_T) width *= capScale((t - TAIL_T) / (1 - TAIL_T))

  return width
}

function capScale(k) {
  var x = Math.max(0, Math.min(1, k))
  return Math.sqrt(Math.max(0, 1 - x * x))
}

// The closed silhouette, sampled from halfWidthAt: down the right flank,
// around the tail, back up the left. The renderer smooths these into a
// curve, so `steps` only needs to be high enough that the caps don't
// facet — 48 a side is plenty at any panel size.
function outlinePoints(shapeName, steps) {
  var n = Math.max(8, steps || 48)
  var cx = BOX_W / 2
  var points = []
  var i, y
  for (i = 0; i <= n; i++) {
    y = (i / n) * BOX_H
    points.push({ x: cx + halfWidthAt(shapeName, y, "right"), y: y })
  }
  for (i = n; i >= 0; i--) {
    y = (i / n) * BOX_H
    points.push({ x: cx - halfWidthAt(shapeName, y, "left"), y: y })
  }
  return points
}

function smoothstep(k) {
  var x = Math.max(0, Math.min(1, k))
  return x * x * (3 - 2 * x)
}

// The thumb bulge is a local swell around the waist/hip, not a uniform
// offset, so it tapers to nothing at the nose and tail.
function bulgeFalloff(t) {
  if (t <= 0.30 || t >= 0.92) return 0
  var k = (t - 0.30) / 0.62
  return Math.sin(k * Math.PI)
}

function splitY(shapeName) {
  return shape(shapeName).split * BOX_H
}

// ------------------------------------------------------------ button layout

// Where a code sits on the shell, for a mouse we have no profile for.
// Codes are laid out by the role they conventionally carry: the three
// primaries on top, then side buttons stacked down the left flank, then
// the right flank, then the palm. Anchors are snapped onto the outline
// for flank buttons by anchorFor().
var GENERIC_SLOTS = [
  { code: 0x110, role: "Left click",  at: [0.27, 0.17], side: "left",  kind: "panel" },
  { code: 0x111, role: "Right click", at: [0.73, 0.17], side: "right", kind: "panel" },
  { code: 0x112, role: "Wheel click", at: [0.50, 0.26], side: "right", kind: "wheel" },
  // Thumb buttons sit in physical order, not code order: the one nearer
  // the front of the shell is Forward (BTN_EXTRA) and the one nearer the
  // palm is Back (BTN_SIDE). Laying these out by ascending code puts the
  // labels the wrong way up against the actual buttons.
  { code: 0x114, role: "Forward",     at: [0.00, 0.40], side: "left",  kind: "flank" },
  { code: 0x113, role: "Back",        at: [0.00, 0.52], side: "left",  kind: "flank" },
  { code: 0x115, role: "Side 3",      at: [0.00, 0.64], side: "left",  kind: "flank" },
  { code: 0x116, role: "Side 4",      at: [0.00, 0.76], side: "left",  kind: "flank" },
  { code: 0x117, role: "Right flank", at: [1.00, 0.44], side: "right", kind: "flank" },
  { code: 0x118, role: "Right flank", at: [1.00, 0.56], side: "right", kind: "flank" },
  { code: 0x119, role: "Palm",        at: [0.50, 0.60], side: "right", kind: "palm" },
  { code: 0x11a, role: "Palm",        at: [0.50, 0.70], side: "right", kind: "palm" },
  { code: 0x11b, role: "Palm",        at: [0.38, 0.80], side: "left",  kind: "palm" },
  { code: 0x11c, role: "Palm",        at: [0.62, 0.80], side: "right", kind: "palm" },
  { code: 0x11d, role: "Palm",        at: [0.38, 0.88], side: "left",  kind: "palm" },
  { code: 0x11e, role: "Palm",        at: [0.62, 0.88], side: "right", kind: "palm" },
  { code: 0x11f, role: "Palm",        at: [0.50, 0.94], side: "right", kind: "palm" }
]

function slotFor(code) {
  for (var i = 0; i < GENERIC_SLOTS.length; i++) if (GENERIC_SLOTS[i].code === code) return GENERIC_SLOTS[i]
  return { code: code, role: "Extra button", at: [0.50, 0.66], side: "right", kind: "palm" }
}

// Resolve a slot to a point in box coordinates. Flank buttons ride the
// silhouette so they stay on the edge for any shape.
function anchorFor(slot, shapeName) {
  var y = slot.at[1] * BOX_H
  if (slot.kind === "flank") {
    var side = slot.at[0] < 0.5 ? "left" : "right"
    var half = halfWidthAt(shapeName, y, side)
    var cx = BOX_W / 2
    return { x: side === "left" ? cx - half : cx + half, y: y, side: side, kind: slot.kind }
  }
  return { x: slot.at[0] * BOX_W, y: y, side: slot.side, kind: slot.kind }
}

// Build the drawable button list for a device. `codes` is whatever
// discovery settled on; profile overrides reposition individual codes.
function buttonGeometry(codes, shapeName, overrides) {
  var byCode = {}
  if (overrides) for (var o = 0; o < overrides.length; o++) byCode[overrides[o].code] = overrides[o]

  var out = []
  for (var i = 0; i < codes.length; i++) {
    var code = codes[i]
    var override = byCode[code]
    var slot = slotFor(code)
    if (override && override.at) slot = { code: code, role: override.role || slot.role, at: override.at, side: override.side || slot.side, kind: override.kind || slot.kind }
    else if (override) slot = { code: code, role: override.role || slot.role, at: slot.at, side: override.side || slot.side, kind: override.kind || slot.kind }

    var point = anchorFor(slot, shapeName)
    out.push({ code: code, role: slot.role, kind: point.kind, side: point.side, x: point.x, y: point.y })
  }
  return out
}

// ------------------------------------------------------------ device database
//
// The button lists here are a head start, not gospel: a shell can ship
// with different side panels, and a receiver hides which model is paired.
// The learn pass in the panel always outranks this table.

var PROFILES = [
  {
    id: "logitech-g-pro-wireless",
    name: "Logitech G Pro Wireless",
    shapeName: "ambi",
    match: { vendor: "046d", product: ["4079", "c088"] },
    buttons: [
      { code: 0x110, role: "Left click" },
      { code: 0x111, role: "Right click" },
      { code: 0x112, role: "Wheel click" },
      { code: 0x113, role: "Thumb back" },
      { code: 0x114, role: "Thumb forward" }
    ]
  },
  {
    id: "logitech-g-pro-x-superlight",
    name: "Logitech G Pro X Superlight",
    shapeName: "ambi",
    match: { vendor: "046d", product: ["4093", "c094", "c547"] },
    buttons: [
      { code: 0x110, role: "Left click" },
      { code: 0x111, role: "Right click" },
      { code: 0x112, role: "Wheel click" },
      { code: 0x113, role: "Thumb back" },
      { code: 0x114, role: "Thumb forward" }
    ]
  },
  {
    id: "logitech-mx-master",
    name: "Logitech MX Master",
    shapeName: "ergo",
    match: { vendor: "046d", product: ["4082", "4069", "b023", "b034", "4041"] },
    buttons: [
      { code: 0x110, role: "Left click" },
      { code: 0x111, role: "Right click" },
      { code: 0x112, role: "Wheel click" },
      { code: 0x113, role: "Thumb back" },
      { code: 0x114, role: "Thumb forward" },
      { code: 0x115, role: "Gesture button", at: [0.00, 0.66] }
    ]
  },
  {
    id: "logitech-generic",
    name: "Logitech Mouse",
    shapeName: "ergo",
    match: { vendor: "046d" },
    buttons: null
  }
]

function profiles() {
  return PROFILES
}

// Shape for a device once discovery has run: the profile's if it matched,
// otherwise inferred from how many buttons are in play. A mouse with side
// buttons is almost certainly a shaped shell rather than a flat puck.
function shapeFor(profileId, buttonCount) {
  for (var i = 0; i < PROFILES.length; i++) {
    if (PROFILES[i].id === profileId && PROFILES[i].shapeName) return PROFILES[i].shapeName
  }
  if (buttonCount <= 3) return "compact"
  if (buttonCount >= 7) return "ergo"
  return "generic"
}

if (typeof module !== "undefined") {
  module.exports = {
    BOX_W: BOX_W,
    BOX_H: BOX_H,
    SHAPES: SHAPES,
    shape: shape,
    outlinePoints: outlinePoints,
    halfWidthAt: halfWidthAt,
    splitY: splitY,
    slotFor: slotFor,
    anchorFor: anchorFor,
    buttonGeometry: buttonGeometry,
    profiles: profiles,
    shapeFor: shapeFor
  }
}
