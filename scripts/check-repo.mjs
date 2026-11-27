#!/usr/bin/env node
/**
 * @summary Verifies that the installed skill still matches its GitHub repository, before any work starts.
 *          Reads catalog/source.json (repo, branch, which files live only on this machine), asks GitHub for
 *          the branch head and its tree, computes the git blob sha1 of every local file and compares. The
 *          skill's own memory — catalog snapshots, hub addresses, client path, image API seam — is never
 *          compared and never rewritten. --update downloads only the files that drifted or went missing,
 *          each verified against the sha the tree gave; nothing is ever deleted. Zero dependencies and no
 *          git needed: the install is usually a plain copy, not a clone. Fail-closed — GitHub unreachable
 *          means the check does not pass, because an unverified install is what it guards against.
 * @route (без аргументов) — сверяет установленный скилл с репозиторием и печатает, что разошлось
 * @route --update — докачивает из репозитория разошедшиеся и пропавшие файлы; память скилла не трогает, ничего не удаляет
 * @route --selftest — самопроверка сравнения (офлайн, на синтетическом дереве)
 * @verdict "Done: …" exit 0 (сошлось) | "Rejected: defects_found — …" exit 1 (расхождение: что / почему / как исправить) |
 *          "Blocked: missing_input — …" exit 2 (GitHub недоступен, битый catalog/source.json)
 * @example node <workspace>/.claude/skills/aghanim-offer-building/scripts/check-repo.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const SKILL_DIR = path.dirname(path.dirname(SELF));
const CATALOG_DIR = path.join(SKILL_DIR, 'catalog');
const SOURCE_FILE = path.join(CATALOG_DIR, 'source.json');
const STATE_FILE = path.join(CATALOG_DIR, '.repo-check.json');
const SKIP = ['.git', '.DS_Store', '__pycache__', 'node_modules', '.repo-check.json'];
const TIMEOUT_MS = 20000;
const UA = 'aghanim-offer-building check-repo';
const CMD = 'node <workspace>/.claude/skills/aghanim-offer-building/scripts/check-repo.mjs';

class Blocked extends Error {}

// Every refusal the script can give: the text that judges is the text the operator reads.
const CHECKS = {
  file_changed: {
    what: 'файл расходится с репозиторием',
    why: 'скилл работает по коду и правилам из репозитория: местная правка значит, что команды делают не то, что описано, и её потеряет первое же обновление',
    fix: `вернуть эталон — \`${CMD} --update\`; если правка нужна всем — сначала влить её в репозиторий, потом обновляться`,
  },
  file_missing: {
    what: 'файла нет в установке',
    why: 'неполная установка падает не сразу, а на той команде, которой не хватило файла — посреди работы',
    fix: `докачать — \`${CMD} --update\``,
  },
  file_extra: {
    what: 'лишний файл в установке',
    why: 'его нет в репозитории: он не проверен, не обновляется и может оказаться старой версией того, что уже переехало',
    fix: 'удалить, если не нужен; если нужен — влить в репозиторий или записать в "local" в catalog/source.json',
  },
  source_shape: {
    what: 'catalog/source.json не той формы',
    why: 'без адреса репозитория и ветки сверять не с чем, а молча пропущенная сверка — ровно та дыра, которую она закрывает',
    fix: 'форма: {"repo": "владелец/репозиторий", "branch": "main", "local": ["catalog/live.json", …]}',
  },
};

/** @param {{code: string, subject: string, detail?: string}[]} defects @returns {string} */
function refusal(defects, head = 'работать по скиллу до зелёной сверки нельзя') {
  const lines = [`Rejected: defects_found — отказов: ${defects.length}, ${head}`];
  defects.forEach((d, i) => {
    const c = CHECKS[d.code];
    lines.push(`  ${i + 1}. [${d.code}] ${d.subject}: ${c.what}${d.detail ? ` — ${d.detail}` : ''}`, `     почему: ${c.why}`, `     как исправить: ${c.fix}`);
  });
  return lines.join('\n');
}

// ---------- reference ----------

/** @param {string} file @returns {{repo: string, branch: string, local: string[]}} */
function readSource(file = SOURCE_FILE) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { throw new Blocked(`нет файла ${file}: ${CHECKS.source_shape.fix}`); }
  let src;
  try { src = JSON.parse(raw); } catch (e) { throw new Blocked(`${file} не читается как JSON (${e.message}): ${CHECKS.source_shape.fix}`); }
  if (!src || !/^[\w.-]+\/[\w.-]+$/.test(String(src.repo || ''))) throw new Blocked(`${file}: "repo" ждёт «владелец/репозиторий»: ${CHECKS.source_shape.fix}`);
  return { repo: String(src.repo), branch: String(src.branch || 'main'), local: Array.isArray(src.local) ? src.local.map(String) : [] };
}

/** @param {string} rel @param {string[]} local @returns {boolean} */
const isLocalOnly = (rel, local) => local.some((p) => rel === p || rel.startsWith(`${p.replace(/\/$/, '')}/`));

/** git hash-object: the id GitHub judges by. @param {Buffer} buf @returns {string} */
const blobSha = (buf) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');

/** @param {string} dir @param {string[]} local @returns {Map<string, {sha: string}>} */
function scanLocal(dir, local) {
  const out = new Map();
  const walk = (cur, prefix) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.includes(e.name)) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (isLocalOnly(rel, local)) continue;
      if (e.isDirectory()) walk(path.join(cur, e.name), rel);
      else if (e.isFile()) out.set(rel, { sha: blobSha(fs.readFileSync(path.join(cur, e.name))) });
    }
  };
  walk(dir, '');
  return out;
}

/** @param {Map<string, {sha: string}>} local @param {Map<string, {sha: string}>} remote @returns {{code: string, subject: string, detail?: string}[]} */
function compare(local, remote) {
  const defects = [];
  for (const rel of [...remote.keys()].sort()) {
    const mine = local.get(rel);
    if (!mine) defects.push({ code: 'file_missing', subject: rel });
    else if (mine.sha !== remote.get(rel).sha) defects.push({ code: 'file_changed', subject: rel, detail: `местный ${mine.sha.slice(0, 8)}, в репозитории ${remote.get(rel).sha.slice(0, 8)}` });
  }
  for (const rel of [...local.keys()].sort()) if (!remote.has(rel)) defects.push({ code: 'file_extra', subject: rel });
  return defects;
}

// ---------- github ----------

/** @param {string} url @param {'json'|'buffer'} as */
async function get(url, as = 'json') {
  const headers = { 'user-agent': UA, accept: as === 'json' ? 'application/vnd.github+json' : '*/*' };
  // Public repo: the token only lifts the anonymous rate limit, by name, never printed.
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let res;
  try { res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' }); } catch (e) {
    throw new Blocked(`GitHub недоступен (${url}): ${e.message || e.name}; сверка не прошла, скилл не стартует`);
  }
  if (!res.ok) throw new Blocked(`GitHub ответил ${res.status} ${res.statusText} на ${url}; сверка не прошла, скилл не стартует`);
  return as === 'json' ? res.json() : Buffer.from(await res.arrayBuffer());
}

/** @param {{repo: string, branch: string, local: string[]}} src */
async function fetchRemote(src) {
  const head = await get(`https://api.github.com/repos/${src.repo}/commits/${encodeURIComponent(src.branch)}`);
  const commit = {
    sha: String(head.sha),
    date: String(head.commit?.committer?.date || '').replace('T', ' ').replace('Z', ' UTC'),
    message: String(head.commit?.message || '').split('\n')[0],
  };
  const tree = await get(`https://api.github.com/repos/${src.repo}/git/trees/${commit.sha}?recursive=1`);
  if (tree.truncated) throw new Blocked(`дерево ${src.repo} не поместилось в один ответ GitHub — сверка неполная, скилл не стартует`);
  const files = new Map();
  for (const e of tree.tree || []) {
    if (e.type !== 'blob' || SKIP.includes(path.basename(String(e.path))) || isLocalOnly(String(e.path), src.local)) continue;
    files.set(String(e.path), { sha: String(e.sha), mode: String(e.mode) });
  }
  return { commit, files };
}

/** @param {object} rec */
function remember(rec) {
  try { fs.writeFileSync(STATE_FILE, `${JSON.stringify(rec, null, 1)}\n`); } catch { /* the check stands without its note */ }
}

// ---------- run ----------

/** @param {string[]} argv */
async function run(argv) {
  const src = readSource();
  const { commit, files } = await fetchRemote(src);
  let defects = compare(scanLocal(SKILL_DIR, src.local), files);
  const out = [
    `репозиторий: ${src.repo}@${src.branch} — коммит ${commit.sha.slice(0, 8)} от ${commit.date}${commit.message ? ` «${commit.message}»` : ''}`,
    `установка: ${SKILL_DIR}`,
  ];
  const updated = [];
  if (argv.includes('--update')) {
    for (const d of defects.filter((x) => x.code !== 'file_extra')) {
      const want = files.get(d.subject);
      const url = `https://raw.githubusercontent.com/${src.repo}/${commit.sha}/${d.subject.split('/').map(encodeURIComponent).join('/')}`;
      const buf = await get(url, 'buffer');
      if (blobSha(buf) !== want.sha) throw new Blocked(`скачанный ${d.subject} не сошёлся с деревом репозитория — файл не записан`);
      const abs = path.join(SKILL_DIR, d.subject);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      if (want.mode === '100755') fs.chmodSync(abs, 0o755);
      updated.push(d.subject);
    }
    out.push(updated.length ? `обновлено из репозитория: ${updated.length} — ${updated.join(', ')}` : 'обновлять нечего');
    defects = compare(scanLocal(SKILL_DIR, src.local), files);
  }
  out.push(`сверено файлов: ${files.size}${src.local.length ? `; память скилла не сверяется: ${src.local.join(', ')}` : ''}`);
  const ok = !defects.length;
  remember({ at: new Date().toISOString(), repo: src.repo, branch: src.branch, commit: commit.sha, ok, defects: defects.length });
  out.push(ok ? `Done: установка сходится с репозиторием${updated.length ? ' после обновления' : ''} — можно работать` : refusal(defects));
  return { ok, text: out.join('\n') };
}

// ---------- selftest ----------

function selftest() {
  const fails = [];
  const expect = (name, cond) => { if (!cond) fails.push(name); };
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'check-repo-'));
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

  expect('blob sha matches git hash-object on an empty file', blobSha(Buffer.alloc(0)) === 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  expect('blob sha matches git hash-object on "hello\\n"', blobSha(Buffer.from('hello\n')) === 'ce013625030ba8dba906f756967f9e9ca394464a');

  write('SKILL.md', 'правила\n');
  write('scripts/a.mjs', 'код\n');
  write('catalog/live.json', '{"память": 1}\n');
  write('catalog/.repo-check.json', '{}\n');
  const local = ['catalog/live.json'];
  const seen = scanLocal(dir, local);
  expect('scan skips the skill memory and its own note', !seen.has('catalog/live.json') && !seen.has('catalog/.repo-check.json') && seen.size === 2);

  const remote = new Map([...seen].map(([rel, v]) => [rel, { sha: v.sha, mode: '100644' }]));
  expect('a copy of the repo gives no defects', compare(seen, remote).length === 0);

  remote.set('scripts/a.mjs', { sha: blobSha(Buffer.from('другой код\n')), mode: '100644' });
  expect('a drifted file is file_changed', compare(seen, remote).some((d) => d.code === 'file_changed' && d.subject === 'scripts/a.mjs'));

  remote.set('references/doc.md', { sha: blobSha(Buffer.from('описание\n')), mode: '100644' });
  expect('a file only in the repo is file_missing', compare(seen, remote).some((d) => d.code === 'file_missing' && d.subject === 'references/doc.md'));

  write('scripts/mine.mjs', 'моё\n');
  expect('a file only on disk is file_extra', compare(scanLocal(dir, local), remote).some((d) => d.code === 'file_extra' && d.subject === 'scripts/mine.mjs'));

  write('catalog/live.json', '{"память": 2}\n');
  expect('rewritten memory stays out of the verdict', !compare(scanLocal(dir, local), remote).some((d) => d.subject.startsWith('catalog/live')));

  write('source-bad.json', '{"repo": "нет-слэша"}\n');
  let blocked = false;
  try { readSource(path.join(dir, 'source-bad.json')); } catch (e) { blocked = e instanceof Blocked; }
  expect('a source.json without owner/repo is refused', blocked);

  write('source-ok.json', '{"repo": "pg3d-skill/aghanim-offer-build", "local": ["catalog/live.json"]}\n');
  const src = readSource(path.join(dir, 'source-ok.json'));
  expect('branch defaults to main', src.branch === 'main' && src.repo === 'pg3d-skill/aghanim-offer-build' && src.local.length === 1);

  fs.rmSync(dir, { recursive: true, force: true });
  return fails.length
    ? { ok: false, text: `Rejected: defects_found — selftest: ${fails.length} failed\n${fails.map((f) => `  - ${f}`).join('\n')}` }
    : { ok: true, text: 'Done: selftest passed' };
}

const argv = process.argv.slice(2);
try {
  const r = argv.includes('--selftest') ? selftest() : await run(argv);
  console.log(r.text);
  process.exit(r.ok ? 0 : 1);
} catch (e) {
  if (!(e instanceof Blocked)) throw e;
  console.log(`Blocked: missing_input — ${e.message}`);
  process.exit(2);
}
