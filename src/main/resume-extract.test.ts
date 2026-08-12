import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractResume,
  looksLikeProse,
  isPdf,
  isZip,
  MAX_UPLOAD_BYTES
} from './resume-extract.ts'

const PROSE =
  'Ada Lovelace is a staff engineer in London who led the analytical engine ' +
  'programme and reduced batch failures by forty per cent over two years of work. '

test('looksLikeProse accepts real prose', () => {
  assert.equal(looksLikeProse(PROSE), true)
})

test('looksLikeProse rejects glyph-id soup, which would yield an invented profile', () => {
  assert.equal(looksLikeProse(''.repeat(40)), false)
})

test('looksLikeProse rejects consonant runs that pass the printable test', () => {
  assert.equal(looksLikeProse('bcdfghjklmnpqrstvwxz'.repeat(5)), false)
})

test('a file over the ceiling is refused as too-large before anything parses it', async () => {
  const result = await extractResume(Buffer.alloc(MAX_UPLOAD_BYTES + 1))
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'too-large')
})

test('plain text under the useful floor is refused as too-short, not passed on', async () => {
  const result = await extractResume(Buffer.from('Ada Lovelace', 'utf8'))
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'too-short')
})

test('adequate plain text is accepted and reported as text', async () => {
  const result = await extractResume(Buffer.from(PROSE.repeat(3), 'utf8'))
  assert.equal(result.ok, true)
  assert.equal(result.ok === true && result.format, 'text')
})

test('binary that is neither PDF nor ZIP is refused rather than decoded as mojibake', async () => {
  const result = await extractResume(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'unsupported-format')
})

test('a ZIP that is not a Word document is refused, not half-read', async () => {
  // Local file header signature, then nothing mammoth can use.
  const notDocx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)])
  const result = await extractResume(notDocx)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'unsupported-format')
})

test('magic bytes decide the format, never the caller', () => {
  assert.equal(isPdf(Buffer.from('%PDF-1.7\n')), true)
  assert.equal(isPdf(Buffer.from([0x50, 0x4b, 0x03, 0x04])), false)
  assert.equal(isZip(Buffer.from([0x50, 0x4b, 0x03, 0x04])), true)
})

test('every failure carries a message a user can act on', async () => {
  const result = await extractResume(Buffer.alloc(MAX_UPLOAD_BYTES + 1))
  assert.match(result.ok === false ? result.message : '', /10 MB/)
})
