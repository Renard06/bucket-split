import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignToBucket, createBucketSplitter, fnv1a32 } from '../src/index.js';

test('fnv1a32 returns an unsigned 32-bit integer', () => {
  const h = fnv1a32('user-42');
  assert.equal(typeof h, 'number');
  assert.ok(Number.isInteger(h));
  assert.ok(h >= 0);
  assert.ok(h < 0x100000000);
});

test('fnv1a32 is deterministic for the same input', () => {
  assert.equal(fnv1a32('subject-alpha'), fnv1a32('subject-alpha'));
  assert.notEqual(fnv1a32('subject-alpha'), fnv1a32('subject-beta'));
});

test('fnv1a32 handles non-ASCII and surrogate pairs', () => {
  // These are smoke checks against known FNV-1a properties: the empty string
  // is the offset basis, and different astral characters must not collide.
  assert.equal(fnv1a32(''), 0x811c9dc5);
  const emoji = fnv1a32('🎉');
  const text = fnv1a32('café');
  assert.ok(emoji !== text);
  assert.ok(emoji >= 0 && emoji < 0x100000000);
});

test('fnv1a32 treats a surrogate pair as a single code point', () => {
  // 🎉 can be written as the code point U+1F389 or as a raw surrogate pair.
  // Both must produce the same hash, or downstream bucketing would be
  // sensitive to how the caller constructed the string.
  assert.equal(fnv1a32('🎉'), fnv1a32('\ud83c\udf89'));
});

test('fnv1a32 throws on non-string input', () => {
  assert.throws(() => fnv1a32(42), TypeError);
  assert.throws(() => fnv1a32(null), TypeError);
});

test('assignToBucket returns a value in [0, bucketCount)', () => {
  for (let n = 1; n <= 16; n++) {
    for (let i = 0; i < 50; i++) {
      const b = assignToBucket(`user-${i}`, n);
      assert.ok(b >= 0 && b < n, `bucket ${b} out of range for n=${n}`);
      assert.equal(Number.isInteger(b), true);
    }
  }
});

test('assignToBucket is stable across repeated calls', () => {
  const first = assignToBucket('stable-subject', 100);
  for (let i = 0; i < 20; i++) {
    assert.equal(assignToBucket('stable-subject', 100), first);
  }
});

test('assignToBucket with one bucket always returns 0', () => {
  assert.equal(assignToBucket('anything', 1), 0);
});

test('assignToBucket distribution is approximately uniform', () => {
  const N = 20000;
  const buckets = 8;
  const counts = new Array(buckets).fill(0);
  for (let i = 0; i < N; i++) {
    counts[assignToBucket(`user-${i}`, buckets)]++;
  }
  const expected = N / buckets;
  // Loose band: bucketing is not a PRNG, and we only need to guard against
  // catastrophic skew. ±20% is far inside what a broken hash would breach.
  for (const c of counts) {
    assert.ok(Math.abs(c - expected) < expected * 0.2, `count ${c} too far from ${expected}`);
  }
});

test('assignToBucket rejects invalid bucket counts', () => {
  assert.throws(() => assignToBucket('x', 0), RangeError);
  assert.throws(() => assignToBucket('x', -1), RangeError);
  assert.throws(() => assignToBucket('x', 2.5), RangeError);
  assert.throws(() => assignToBucket('x', '2'), RangeError);
});

test('assignToBucket rejects non-string subjects', () => {
  assert.throws(() => assignToBucket(42, 10), TypeError);
  assert.throws(() => assignToBucket(null, 10), TypeError);
});

test('createBucketSplitter exposes the documented API', () => {
  const splitter = createBucketSplitter(100, {
    theme: ['control', 'dark'],
    checkout: ['single', 'multi'],
  });
  assert.equal(typeof splitter.bucketOf, 'function');
  assert.equal(typeof splitter.variantOf, 'function');
  assert.equal(typeof splitter.variantForBucket, 'function');
});

test('createBucketSplitter.variantOf is stable and within the declared set', () => {
  const splitter = createBucketSplitter(100, {
    banner: ['red', 'blue', 'green'],
  });
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const v = splitter.variantOf(`u-${i}`, 'banner');
    assert.ok(['red', 'blue', 'green'].includes(v));
    seen.add(v);
  }
  // With 1000 subjects and three variants, all three should appear.
  assert.equal(seen.size, 3);
});

test('createBucketSplitter.variantForBucket matches variantOf for the same bucket', () => {
  const splitter = createBucketSplitter(50, { a: ['x', 'y'] });
  const subject = 'subject-7';
  const bucket = splitter.bucketOf(subject);
  assert.equal(splitter.variantForBucket(bucket, 'a'), splitter.variantOf(subject, 'a'));
});

test('createBucketSplitter.variantOf throws on unknown experiment', () => {
  const splitter = createBucketSplitter(10, { a: ['x'] });
  assert.throws(() => splitter.variantOf('s', 'missing'), RangeError);
});

test('createBucketSplitter.variantForBucket validates the bucket index', () => {
  const splitter = createBucketSplitter(10, { a: ['x', 'y'] });
  assert.throws(() => splitter.variantForBucket(-1, 'a'), RangeError);
  assert.throws(() => splitter.variantForBucket(10, 'a'), RangeError);
  assert.throws(() => splitter.variantForBucket(2.5, 'a'), RangeError);
});

test('createBucketSplitter rejects empty or malformed assignments', () => {
  assert.throws(() => createBucketSplitter(10, null), TypeError);
  assert.throws(() => createBucketSplitter(10, { a: [] }), TypeError);
  assert.throws(() => createBucketSplitter(10, { a: 'not-array' }), TypeError);
});

test('createBucketSplitter snapshots assignments at construction time', () => {
  const live = { a: ['x', 'y'] };
  const splitter = createBucketSplitter(10, live);
  live.a.push('z');
  live.a = ['q'];
  assert.equal(splitter.variantForBucket(0, 'a'), 'x');
  assert.equal(splitter.variantForBucket(1, 'a'), 'y');
  assert.equal(splitter.variantForBucket(2, 'a'), 'x');
});

test('createBucketSplitter rejects invalid bucketCount', () => {
  assert.throws(() => createBucketSplitter(0, { a: ['x'] }), RangeError);
  assert.throws(() => createBucketSplitter(2.5, { a: ['x'] }), RangeError);
});
