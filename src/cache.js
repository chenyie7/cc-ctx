// A tiny JSON-file key/value cache.
//
// Writes go through a temp file + rename so a reader never sees a half-written
// cache: the status line may run while another instance is updating it.

import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_DIR } from './config.js';

export function openCache(file = path.join(INSTALL_DIR, 'cache.json')) {
  let data = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch {
    /* missing or corrupt cache: start clean */
  }

  let dirty = false;

  return {
    get(key) {
      return data[key];
    },
    set(key, value) {
      data[key] = value;
      dirty = true;
    },
    save() {
      if (!dirty) return;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, file);
        dirty = false;
      } catch {
        /* a cache we cannot write is not worth failing over */
      }
    },
  };
}
