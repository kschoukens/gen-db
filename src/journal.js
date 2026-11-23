// The fact log on disk.
//
// The store is already an append-only log, so durability needs no second data structure: every
// state change becomes one line of JSON, and opening a database is replaying those lines. The API
// is synchronous because the store is; a write that returns has reached the operating system, and
// with { fsync: true } the disk.
//
// A crash can only ever cut off the last line, because nothing is written anywhere else. Such a
// torn line was never acknowledged, so it is dropped. Damage anywhere else is not something a crash
// does; it is reported instead of guessed around.

import fs from 'node:fs';
import { GenDBError } from './errors.js';

const VERSION = 1;
const HEADER = JSON.stringify({ t: 'gendb-journal', v: VERSION });
const NEWLINE = 0x0a;

/** A journal in a JSON Lines file. `read()` loads (and repairs a torn tail); `append()` adds one record. */
export function fileJournal(path, { fsync = false } = {}) {
  let fd = null;
  let size = 0;

  const corrupt = (line, why) => new GenDBError('JOURNAL_CORRUPT', `Line ${line} of journal ${path} ${why}.`, {
    path, line,
    repair: `Restore ${path} from a backup, or keep only its first ${line - 1} line(s) to recover the state up to that point; everything after it is lost.`,
  });

  function writeLine(text) {
    const buf = Buffer.from(text + '\n');
    try {
      for (let off = 0; off < buf.length;) off += fs.writeSync(fd, buf, off);
      if (fsync) fs.fsyncSync(fd);
    } catch (err) {
      // Do not leave half a line behind: the next append would glue onto it and corrupt the file.
      try { fs.ftruncateSync(fd, size); } catch { /* the original error is the one worth reporting */ }
      throw err;
    }
    size += buf.length;
  }

  function read() {
    fd ??= fs.openSync(path, 'a+');
    const buf = fs.readFileSync(path);
    const end = buf.lastIndexOf(NEWLINE) + 1;
    const lines = end ? buf.subarray(0, end - 1).toString('utf8').split('\n') : [];

    if (lines.length === 0) {
      // Never truncate a file that is not a (torn) GenDB journal; it may be someone else's data.
      if (!HEADER.startsWith(buf.toString('utf8'))) throw corrupt(1, 'is not a GenDB journal header');
      fs.ftruncateSync(fd, 0);
      size = 0;
      writeLine(HEADER);
      return [];
    }

    const records = lines.map((text, i) => {
      try {
        return JSON.parse(text);
      } catch {
        throw corrupt(i + 1, 'is not valid JSON');
      }
    });
    const [header] = records;
    if (header?.t !== 'gendb-journal') throw corrupt(1, 'is not a GenDB journal header');
    if (header.v !== VERSION) {
      throw new GenDBError('JOURNAL_VERSION', `Journal ${path} has format version ${JSON.stringify(header.v)}; this GenDB reads version ${VERSION}.`, {
        path, version: header.v,
        repair: 'Open it with the GenDB version that wrote it.',
      });
    }

    if (end < buf.length) fs.ftruncateSync(fd, end);
    size = end;
    return records.slice(1);
  }

  return {
    read,
    append(record) {
      if (fd === null) read();
      writeLine(JSON.stringify(record));
    },
    close() {
      if (fd !== null) fs.closeSync(fd);
      fd = null;
    },
  };
}
