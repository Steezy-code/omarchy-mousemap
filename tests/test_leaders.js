const assert = require("assert")
const L = require("../Leaders.js")
const P = require("../Profiles.js")

// ---------------------------------------------------------------- isotonic

// Already spaced: nothing should move.
assert.deepStrictEqual(L.isotonic([0, 50, 100], 20), [0, 50, 100])

// Perfectly coincident labels spread symmetrically about their shared
// desire, rather than all sliding one direction the way greedy placement
// would push them.
const tie = L.isotonic([100, 100, 100], 10)
assert.deepStrictEqual(tie, [90, 100, 110])
assert.strictEqual((tie[0] + tie[2]) / 2, 100)

// Monotonic and correctly spaced for a random mess.
function checkSpacing(desired, pitch) {
  const got = L.isotonic(desired, pitch)
  for (let i = 1; i < got.length; i++) {
    assert.ok(got[i] - got[i - 1] >= pitch - 1e-9,
      `spacing violated: ${got[i - 1]} -> ${got[i]} (pitch ${pitch})`)
  }
  return got
}
checkSpacing([10, 12, 14, 200, 201], 30)
checkSpacing([300, 10, 20], 25)   // out of order input still comes back sorted
checkSpacing([0, 0, 0, 0, 0, 0], 15)

// PAVA is the L2 optimum, so it must beat greedy on total displacement for
// a cluster that has slack above it.
const desired = [100, 102, 104, 106]
const pitch = 20
const pava = L.isotonic(desired, pitch)
let greedy = [], y = -Infinity
for (const d of desired) { y = Math.max(d, y + pitch); greedy.push(y) }
const cost = (a) => a.reduce((s, v, i) => s + (v - desired[i]) ** 2, 0)
assert.ok(cost(pava) < cost(greedy),
  `PAVA (${cost(pava)}) should beat greedy (${cost(greedy)})`)

// ---------------------------------------------------------------- bounds

const packed = L.fitToBounds(L.isotonic([0, 0, 0, 0], 40), 40, 0, 100, 10)
assert.ok(packed[0] >= 10 - 1e-9, "top clamp")
assert.ok(packed[packed.length - 1] <= 90 + 1e-9, "bottom clamp")

// ---------------------------------------------------------------- layout

// Build a device with n buttons the way the panel does, then assert the
// diagram invariants. This is the check that matters: the user plugs in
// anything from a 2-button travel mouse to a 16-button monster and the
// leaders still have to land correctly.
function runLayout(n, opts) {
  const codes = []
  for (let i = 0; i < n; i++) codes.push(0x110 + i)
  const shapeName = P.shapeFor("", n)
  const geo = P.buttonGeometry(codes, shapeName, null)

  // Scale box coords into a 360x560 canvas centred in a 900px-wide panel.
  const scale = 560 / P.BOX_H
  const mouseW = P.BOX_W * scale
  const originX = (900 - mouseW) / 2
  const buttons = geo.map(b => ({
    code: b.code, side: b.side,
    x: originX + b.x * scale, y: 20 + b.y * scale
  }))

  return L.layout(Object.assign({
    buttons,
    bounds: { top: 10, bottom: 600 },
    left: { x: 12, width: 210 },
    right: { x: 900 - 12 - 210, width: 210 },
    chipHeight: 34, chipGap: 8, stub: 14, radius: 10,
    widths: {}
  }, opts || {}))
}

for (let n = 2; n <= 16; n++) {
  const placed = runLayout(n)
  assert.strictEqual(placed.length, n, `${n} buttons -> ${n} leaders`)

  for (const side of ["left", "right"]) {
    const chips = placed.filter(p => p.side === side)
      .sort((a, b) => a.chip.y - b.chip.y)

    // No two chips overlap.
    for (let i = 1; i < chips.length; i++) {
      const above = chips[i - 1].chip, below = chips[i].chip
      assert.ok(below.y - above.y >= above.h - 1e-6,
        `n=${n} ${side}: chips overlap (${above.y} / ${below.y})`)
    }

    // Chips stay inside the vertical bounds.
    for (const c of chips) {
      assert.ok(c.chip.y - c.chip.h / 2 >= 10 - 1e-6, `n=${n} ${side}: chip above bounds`)
      assert.ok(c.chip.y + c.chip.h / 2 <= 600 + 1e-6, `n=${n} ${side}: chip below bounds`)
    }

    // Leaders must not cross: anchor order and chip order agree.
    const byAnchor = placed.filter(p => p.side === side)
      .sort((a, b) => a.anchor.y - b.anchor.y || a.code - b.code)
    const byChip = byAnchor.slice().sort((a, b) => a.chip.y - b.chip.y)
    assert.deepStrictEqual(byAnchor.map(p => p.code), byChip.map(p => p.code),
      `n=${n} ${side}: leaders cross`)
  }

  // Every leader path starts on its anchor and ends on its chip edge.
  for (const p of placed) {
    const pts = p.leader.points
    assert.strictEqual(pts[0].x, p.anchor.x)
    const end = pts[pts.length - 1]
    const expected = p.side === "left" ? p.chip.x + p.chip.w : p.chip.x
    assert.ok(Math.abs(end.x - expected) < 1e-6, "leader ends at chip edge")
    assert.ok(Math.abs(end.y - p.chip.y) < 1e-6, "leader ends at chip centre")
    assert.ok(p.leader.radius >= 0, "radius never negative")
  }
}

// A roomy mouse should place most chips exactly at their anchor height,
// which is what makes the diagram read as pointing at something.
{
  const placed = runLayout(5)
  const straight = placed.filter(p => p.leader.straight).length
  assert.ok(straight >= 3, `expected mostly straight leaders, got ${straight}/5`)
}

// Chips are aligned against the shell on both sides.
{
  const placed = runLayout(6, { widths: { 0x110: 120, 0x111: 200 } })
  for (const p of placed) {
    if (p.side === "left") assert.strictEqual(p.chip.x + p.chip.w, 12 + 210, "left chips right-aligned")
    else assert.strictEqual(p.chip.x, 900 - 12 - 210, "right chips left-aligned")
  }
}

// ---------------------------------------------------------------- geometry

// Flank buttons must sit on the silhouette, not at a guessed x.
for (const shapeName of ["ambi", "ergo", "compact", "generic"]) {
  const geo = P.buttonGeometry([0x110, 0x111, 0x112, 0x113, 0x114], shapeName, null)
  const side = geo.filter(g => g.kind === "flank")
  assert.ok(side.length === 2, "two flank buttons")
  for (const s of side) {
    const half = P.halfWidthAt(shapeName, s.y, "left")
    assert.ok(Math.abs((P.BOX_W / 2 - half) - s.x) < 1e-6,
      `${shapeName}: flank anchor off the outline`)
    assert.ok(s.x > 0 && s.x < P.BOX_W / 2, `${shapeName}: flank anchor outside box`)
  }
}

// The ergo shell must actually bulge on the thumb side and stay symmetric
// where it has no bulge.
assert.ok(P.halfWidthAt("ergo", 80, "left") > P.halfWidthAt("ergo", 80, "right"),
  "ergo shell bulges left at the thumb")
assert.strictEqual(P.halfWidthAt("ambi", 80, "left"), P.halfWidthAt("ambi", 80, "right"),
  "ambidextrous shell is symmetric")

// The silhouette must stay inside the box for every shape, or anchors
// derived from it land outside the canvas.
for (const shapeName of Object.keys(P.SHAPES)) {
  for (let y = 0; y <= P.BOX_H; y += 0.5) {
    for (const side of ["left", "right"]) {
      const half = P.halfWidthAt(shapeName, y, side)
      assert.ok(half >= 0, `${shapeName}: negative half-width`)
      assert.ok(half <= P.BOX_W / 2 + 1e-9,
        `${shapeName}: silhouette escapes the box at y=${y} (${half})`)
    }
  }
  // Nose and tail taper to a point.
  assert.ok(P.halfWidthAt(shapeName, 0, "right") < 1e-9, `${shapeName}: nose not closed`)
  assert.ok(P.halfWidthAt(shapeName, P.BOX_H, "right") < 1e-9, `${shapeName}: tail not closed`)
}

// The sampled outline is closed and matches the anchor math exactly.
{
  const pts = P.outlinePoints("ergo", 48)
  const first = pts[0], last = pts[pts.length - 1]
  assert.ok(Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9,
    "outline is closed")
  const probeY = 80
  const onEdge = pts.filter(p => Math.abs(p.y - probeY) < 1e-9 && p.x < P.BOX_W / 2)[0]
  assert.ok(onEdge, "sampled a left-flank point")
  assert.ok(Math.abs((P.BOX_W / 2 - P.halfWidthAt("ergo", probeY, "left")) - onEdge.x) < 1e-9,
    "outline and anchor math agree")
}

console.log("leaders + geometry: all assertions passed")
