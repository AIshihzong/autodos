#!/usr/bin/env node
// Try the import without DSH: read the Autodos board (read-only), write a ledger, print the status board.
//   node bin/import.js [--from ~/.autodos/db.json] [--out /tmp/autodos-ledger.db]
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Ledger } from '../lib/store.js';
import { importAutodosFile, autodosDataFile } from '../lib/import.js';
import { board, boardText } from '../lib/board.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const from = arg('--from', autodosDataFile());
const out = arg('--out', path.join(os.tmpdir(), `autodos-ledger-${Date.now()}.db`));
if (fs.existsSync(out)) {
  console.error(`${out} exists; pass a new --out`);
  process.exit(1);
}
const ledger = new Ledger(out);
const counts = importAutodosFile(ledger, from);
if (!counts) {
  console.error(`No Autodos board at ${from}`);
  process.exit(1);
}
console.log(`Imported ${from} into ${out}`);
console.log(JSON.stringify(counts));
console.log(JSON.stringify(ledger.counts()));
console.log('');
console.log(boardText(board(ledger)));
ledger.close();
