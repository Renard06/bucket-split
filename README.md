# Bucket Split

Deterministic A/B bucket assignment by subject hash. Given a subject string (user id, session id, request id) and a bucket count, returns a stable bucket index in `[0, bucketCount)`. Ships a small convenience wrapper for declaring multi-variant experiments on top of that single bucket.

## Usage

```js
import { assignToBucket, createBucketSplitter } from 'bucket-split';

// One-off: place a subject into one of 100 buckets.
const bucket = assignToBucket('user-12345', 100);

// Repeatable: declare experiments whose variants are chosen from that bucket.
const splitter = createBucketSplitter(100, {
  homepage: ['control', 'redesign'],
  pricing:  ['monthly', 'annual', 'tiered'],
});

splitter.bucketOf('user-12345');                  // 23
splitter.variantOf('user-12345', 'homepage');    // 'redesign'
splitter.variantForBucket(23, 'pricing');        // 'annual'
```

## Why this exists

Feature-flag services ship buckets for you, but they also ship a network round-trip, a config cache, and a client SDK you did not ask for. When the only thing you need is "the same subject always lands in the same bucket," a pure function is enough. Bucket Split is the smallest correct version of that idea: no dependencies, no state, no clock, no telemetry.

The trade-off is that there is no salt and no per-experiment seed. A subject hashes to one bucket, and every experiment declared on a splitter reads from that same bucket. Two experiments with identical label sets will assign identically — useful when you want correlated rollouts, a footgun when you do not. If you need independence, salt the subject string per experiment before calling `assignToBucket`:

```js
assignToBucket(`homepage:${userId}`, 100);
assignToBucket(`pricing:${userId}`, 100);
```

## Edge cases worth knowing

- `bucketCount` must be a positive integer. Zero, negatives, and non-integers throw `RangeError`.
- The subject must be a string. Pass anything else and you get a `TypeError`, not a coerced bucket.
- `createBucketSplitter` snapshots its `assignments` argument at construction. Mutating the object you passed in afterwards has no effect — experiment definitions are meant to be immutable for the life of a rollout.
- `variantOf` throws `RangeError` for an experiment name that was not declared, rather than silently returning `undefined`.

## API

- `fnv1a32(input: string): number` — raw 32-bit FNV-1a hash, returned as an unsigned integer. Exported because it is occasionally useful to roll your own slicing.
- `assignToBucket(subject: string, bucketCount: number): number` — integer in `[0, bucketCount)`.
- `createBucketSplitter(bucketCount: number, assignments: Record<string, string[]>): { bucketOf, variantOf, variantForBucket }` — closes over a fixed bucket count and experiment definitions.

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

## Design notes

The window stores values eagerly rather than keeping running aggregates. Running
sums drift with floating point over long streams, and recomputing from a small
buffer is cheap enough that the drift is not worth the speed.

