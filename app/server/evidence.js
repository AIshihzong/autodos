// Proof an agent leaves behind (screenshots, test output, API responses), shown to the person at review.
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILES = 30;
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;

/** Make the folder and keep it out of git with its own .gitignore. */
export function prepareEvidence(cwd) {
  try {
    const dir = path.join(cwd, '.autodos');
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  } catch {}
}

/** Copy what's there into Autodos's own data (worktrees get removed after merging) and list it. */
export function collectEvidence(cwd, keepDir) {
  const src = path.join(cwd, '.autodos', 'evidence');
  let files = [];
  try {
    files = fs
      .readdirSync(src, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, st: fs.statSync(path.join(src, e.name)) }))
      .filter((f) => f.st.size <= MAX_FILE)
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
      .slice(0, MAX_FILES);
  } catch {
    return [];
  }
  fs.mkdirSync(keepDir, { recursive: true });
  let total = 0;
  const out = [];
  for (const f of files) {
    if ((total += f.st.size) > MAX_TOTAL) break;
    const safe = f.name.replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    fs.copyFileSync(path.join(src, f.name), path.join(keepDir, safe));
    out.push({ name: safe, size: f.st.size, at: f.st.mtime.toISOString(), kind: kindOf(safe) });
  }
  return out;
}

export function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return 'image';
  if (['.webm', '.mp4', '.mov'].includes(ext)) return 'video';
  if (['.txt', '.log', '.json', '.md', '.csv', '.xml', '.html', '.yaml', '.yml', '.out'].includes(ext)) return 'text';
  return 'file';
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime' };

/** What the engineer wrote about the proof (proof.md in the evidence), for the lead and the customer. */
export function proofNote(keepDir) {
  for (const name of ['proof.md', 'proof.txt', 'PROOF.md']) {
    try {
      return fs.readFileSync(path.join(keepDir, name), 'utf8').slice(0, 4000).trim();
    } catch {}
  }
  return '';
}

/** Serve one kept file. Anything not an image is plain text, and nothing can run (sandbox CSP). */
export function serveEvidence(res, keepDir, name) {
  const base = path.basename(String(name || ''));
  const file = path.join(keepDir, base);
  let ok = false;
  try {
    ok = !!base && fs.statSync(file).isFile();
  } catch {}
  if (!ok) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end('{"error":"Not found"}');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'text/plain; charset=utf-8',
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}
