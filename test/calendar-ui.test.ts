// @tz Europe/London
import assert from 'node:assert/strict'
const { layout } = await import('../src/renderer/src/components/calendar/layout')
const { addDays, startOfWeek, step, viewDays, whenLabel, fromInput, toInput } = await import('../src/renderer/src/components/calendar/dates')

// Overlaps: A 14:00-15:00, B 14:30-15:30, C 14:30-15:00 -> three columns; D later stands alone
const h = (n: number) => n * 3_600_000
const out = layout([
  { id: 'A', s: h(14), t: h(15) },
  { id: 'B', s: h(14.5), t: h(15.5) },
  { id: 'C', s: h(14.5), t: h(15) },
  { id: 'D', s: h(16), t: h(17) }
])
const by = Object.fromEntries(out.map((o) => [o.id, [o.col, o.cols]]))
assert.deepEqual(by.A, [0, 3])
assert.deepEqual([by.B[1], by.C[1]], [3, 3])
assert.notEqual(by.B[0], by.C[0])
assert.deepEqual(by.D, [0, 1], 'a later event gets the full width back')
// Back-to-back events reuse a column
const seq = layout([{ id: 'x', s: h(9), t: h(10) }, { id: 'y', s: h(10), t: h(11) }])
assert.deepEqual(seq.map((o) => o.cols), [1, 1])

// Weeks start Monday; stepping across the DST change (29 March 2026) keeps midnight
const sat = new Date(2026, 2, 28, 15).getTime()
assert.equal(new Date(startOfWeek(sat)).getDay(), 1)
const nextWeek = step('week', startOfWeek(sat), 1)
assert.equal(new Date(nextWeek).getHours(), 0, 'still midnight after DST')
assert.equal(new Date(addDays(new Date(2026, 2, 28).getTime(), 1)).getDate(), 29)
assert.equal(viewDays('month', new Date(2026, 10, 13).getTime()).length, 42)
assert.deepEqual(viewDays('workweek', new Date(2026, 10, 13).getTime()).map((d) => new Date(d).getDate()), [9, 10, 11, 12, 13])
assert.equal(new Date(step('month', new Date(2026, 0, 31).getTime(), 1)).getMonth(), 1, '31 Jan + 1 month is February, not March')

// all-day labels use the last day, not the exclusive end
const d = new Date(2026, 11, 24).getTime()
assert.match(whenLabel(d, addDays(d, 1), true), /^\S+ 24 Dec · all day$|^\S+, Dec 24 · all day$/)
assert.equal(fromInput(toInput(d, true)), d)
assert.equal(fromInput(toInput(d + h(9.5), false)), d + h(9.5))
console.log('calendar ui tests passed')
