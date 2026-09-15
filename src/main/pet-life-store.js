// Loads and saves pet-life.json. A save file that couldn't be read, or couldn't be copied when damaged, is never
// replaced by a brand-new pet: one locked file at launch must not wipe out months of progress.
const petLife = require('./pet-life');
const { readJsonFile, writeJsonAtomic, keepBrokenCopy } = require('./json-file');

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const NOT_SAVED = "so the pet starts fresh for now and its progress won't be saved until Claude Pet is restarted";

// Returns { life, writable, notice, error, save(life) }; save does nothing when writable is false.
// readJson and keepCopy can be swapped out in tests to act like a locked file or a full disk.
function openLifeStore(file, { now = Date.now(), readJson = readJsonFile, keepCopy = keepBrokenCopy } = {}) {
  const read = readJson(file);
  let result;
  if (read.status === 'missing') {
    result = { life: petLife.newLife(now), writable: true, notice: null, error: null };
  } else if (read.status === 'ok' && isPlainObject(read.value)) {
    result = { life: petLife.sanitizeLife(read.value, now), writable: true, notice: null, error: null };
  } else if (read.status === 'unreadable') {
    result = {
      life: petLife.newLife(now),
      writable: false,
      notice: `Your pet's progress file could not be read (${read.error}), ${NOT_SAVED}.`,
      error: read.error,
    };
  } else {
    const error = read.status === 'invalid' ? read.error : 'it does not contain a saved pet';
    try {
      const copy = keepCopy(file, new Date(now));
      result = {
        life: petLife.newLife(now),
        writable: true,
        notice: `Your pet's progress file was damaged, so it starts fresh. The old file was kept as ${copy}.`,
        error,
      };
    } catch (err) {
      result = {
        life: petLife.newLife(now),
        writable: false,
        notice: `Your pet's progress file was damaged and a copy of it could not be saved (${err.message}), ${NOT_SAVED}.`,
        error: `${error}; copying it failed: ${err.message}`,
      };
    }
  }
  return {
    ...result,
    save(life) {
      if (result.writable) writeJsonAtomic(file, life);
    },
  };
}

module.exports = { openLifeStore };
