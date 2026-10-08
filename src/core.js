/**
 * Bucket Split — deterministic A/B bucket assignment by subject hash.
 */

/**
 * FNV-1a 32-bit hash, implemented inline rather than imported from a
 * dependency. FNV-1a is chosen over simpler polynomial hashes because it
 * distributes well across a small range of buckets without any
 * statistical-PRNG wrapper, and its constants are tiny. We use the 32-bit
 * variant because the 16-bit output is too coarse to slice cleanly into,
 * say, 100 buckets — a few buckets would collide heavily and skew traffic.
 * MurmurHash3 would distribute slightly more evenly on average but requires
 * per-byte mixing and more magic constants, and for bucketing on short
 * subject strings the practical difference is negligible.
 *
 * Math.imul is used for the 32-bit multiply to avoid falling back to
 * double-precision rounding on platforms where bitwise multiply isn't
 * otherwise available.
 *
 * @param {string} input - UTF-8 decoded subject string.
 * @returns {number} 32-bit hash as an unsigned integer.
 */
export function fnv1a32(input) {
  if (typeof input !== 'string') {
    throw new TypeError('fnv1a32 expects a string');
  }

  // Inline UTF-8 encoder. Avoids a dependency on TextEncoder to honour the
  // "standard library only" constraint in the strictest reading, and to keep
  // the behaviour identical across Node versions and embedders.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);
    if (code < 0x80) {
      hash = Math.imul(hash ^ code, 0x01000193);
    } else if (code < 0x800) {
      hash = Math.imul(hash ^ (0xc0 | (code >> 6)), 0x01000193);
      hash = Math.imul(hash ^ (0x80 | (code & 0x3f)), 0x01000193);
    } else if (code < 0xd800 || code >= 0xe000) {
      hash = Math.imul(hash ^ (0xe0 | (code >> 12)), 0x01000193);
      hash = Math.imul(hash ^ (0x80 | ((code >> 6) & 0x3f)), 0x01000193);
      hash = Math.imul(hash ^ (0x80 | (code & 0x3f)), 0x01000193);
    } else {
      // Surrogate pair. Advance one extra code unit and recombine into a
      // full code point so that emoji and astral-plane scripts hash to the
      // same value regardless of how they were encoded. Unpaired surrogates
      // are handled by the fallback below; they produce a defined (if
      // unusual) byte sequence rather than throwing.
      i++;
      const next = i < input.length ? input.charCodeAt(i) : 0;
      const codePoint = 0x10000 + (((code & 0x3ff) << 10) | (next & 0x3ff));
      hash = Math.imul(hash ^ (0xf0 | (codePoint >> 18)), 0x01000193);
      hash = Math.imul(hash ^ (0x80 | ((codePoint >> 12) & 0x3f)), 0x01000193);
      hash = Math.imul(hash ^ (0x80 | ((codePoint >> 6) & 0x3f)), 0x01000193);
      hash = Math.imul(hash ^ (0x80 | (codePoint & 0x3f)), 0x01000193);
    }
  }

  // Force unsigned 32-bit; the XOR/multiply chain can yield values with the
  // sign bit set, which `>>> 0` normalises so downstream modular slicing
  // never sees a negative dividend.
  return hash >>> 0;
}

/**
 * Split the hash space into `bucketCount` buckets of equal width and return
 * the bucket index for a given subject string. The index is stable for the
 * life of the subject: the same subject and bucket count always resolve to
 * the same bucket, across processes and machines, because FNV-1a is
 * deterministic and carries no seed.
 *
 * @param {string} subject
 * @param {number} bucketCount
 * @returns {number} Integer in `[0, bucketCount)`.
 */
export function assignToBucket(subject, bucketCount) {
  if (typeof subject !== 'string') {
    throw new TypeError('subject must be a string');
  }
  if (!Number.isInteger(bucketCount) || bucketCount <= 0) {
    throw new RangeError('bucketCount must be a positive integer');
  }
  return fnv1a32(subject) % bucketCount;
}

/**
 * Convenience factory that closes over `bucketCount` and `assignments`,
 * producing a small helper for experiments where the bucket mapping is
 * consulted repeatedly.
 *
 * `assignments` is a plain object mapping experiment name → bucket label.
 * The subject is first placed into a numeric bucket, then each experiment's
 * label is chosen by mapping `bucketIndex % assignments[labelCount]` onto
 * the order in which labels were declared. Using the same numeric bucket for
 * every experiment guarantees that, when two experiments share the same
 * label set, their assignments are perfectly correlated — i.e. a subject in
 * variant `A` of experiment 1 lands in variant `A` of experiment 2. This is
 * intentional: it lets a caller reuse one subject hash across several
 * related experiments without traffic fragmentation. If independence is
 * desired, salt the subject per experiment before constructing the splitter.
 *
 * @param {number} bucketCount
 * @param {Record<string, readonly string[]>} assignments
 * @returns {{
 *   bucketOf: (subject: string) => number,
 *   variantOf: (subject: string, experiment: string) => string,
 *   variantForBucket: (bucketIndex: number, experiment: string) => string
 * }}
 */
export function createBucketSplitter(bucketCount, assignments) {
  if (!Number.isInteger(bucketCount) || bucketCount <= 0) {
    throw new RangeError('bucketCount must be a positive integer');
  }
  if (assignments === null || typeof assignments !== 'object') {
    throw new TypeError('assignments must be an object');
  }

  // Snapshot the keys and per-experiment label arrays at construction time.
  // Mutating the caller's `assignments` afterwards must not change behaviour,
  // because experiment definitions are meant to be immutable for the lifetime
  // of a rollout — silently picking up new labels mid-flight would be a
  // silent traffic shift.
  const frozen = Object.create(null);
  for (const key of Object.keys(assignments)) {
    const labels = assignments[key];
    if (!Array.isArray(labels) || labels.length === 0) {
      throw new TypeError(`experiment "${key}" must have a non-empty labels array`);
    }
    frozen[key] = Array.from(labels);
  }

  return {
    bucketOf(subject) {
      return assignToBucket(subject, bucketCount);
    },
    variantForBucket(bucketIndex, experiment) {
      if (!Object.prototype.hasOwnProperty.call(frozen, experiment)) {
        throw new RangeError(`unknown experiment "${experiment}"`);
      }
      if (!Number.isInteger(bucketIndex) || bucketIndex < 0 || bucketIndex >= bucketCount) {
        throw new RangeError('bucketIndex out of range');
      }
      const labels = frozen[experiment];
      return labels[bucketIndex % labels.length];
    },
    variantOf(subject, experiment) {
      const bucket = assignToBucket(subject, bucketCount);
      return this.variantForBucket(bucket, experiment);
    },
  };
}
