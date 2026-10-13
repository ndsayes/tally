// Automatic backup to a private GitHub repository, using a fine-grained access token
// that can only read and write that one repository. The whole diary is saved as one
// JSON file; every save is a commit, so GitHub also keeps the history.

const API = 'https://api.github.com';
const FILE = 'tally-data.json';
const DIRTY_KEY = 'tally-cloud-dirty';
const SAVED_KEY = 'tally-cloud-saved';
const DELAY = 8000; // wait for a pause in logging before saving

let cfg = null; // { repo: 'owner/name', token }
let getData = async () => ({});
let onStatus = () => {};
let sha = null; // current file version on GitHub (null = not looked up yet)
let timer = null;
let saving = null;
let again = false;

export const status = { lastSaved: Number(readLocal(SAVED_KEY)) || 0, error: '', busy: false };

function readLocal(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {
    // storage unavailable; the dirty flag is only a convenience
  }
}

export const isDirty = () => readLocal(DIRTY_KEY) === '1';

export function init(options) {
  getData = options.getData;
  onStatus = options.onStatus;
}

export function setConfig(next) {
  cfg = next?.repo && next?.token ? next : null;
  sha = null;
  status.error = '';
}

export const connected = () => !!cfg;

export function normaliseRepo(input) {
  return input
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
}

const headers = (token, accept = 'application/vnd.github+json') => ({
  Authorization: `Bearer ${token}`,
  Accept: accept,
  'X-GitHub-Api-Version': '2022-11-28',
});

async function ghError(res) {
  if (res.status === 401) return new Error('GitHub rejected the token (it may have expired). Tap "Replace token" in Settings.');
  if (res.status === 403) return new Error('The token is missing permission. It needs "Contents: Read and write" on this repository.');
  if (res.status === 404) return new Error('Repository not found. Check the name, and that the token was given access to it.');
  let detail = '';
  try {
    detail = (await res.json()).message || '';
  } catch {
    // ignore
  }
  return new Error(`GitHub error ${res.status}${detail ? `: ${detail}` : ''}`);
}

async function call(path, { token, method = 'GET', body, accept } = {}) {
  try {
    return await fetch(`${API}${path}`, {
      method,
      cache: 'no-store',
      headers: { ...headers(token, accept), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Couldn't reach GitHub. Check your internet connection.");
  }
}

const filePath = (repo) => `/repos/${repo}/contents/${FILE}`;

// Checks the token works and that the repository is private.
export async function testConnection({ repo, token }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Enter the repository as your-username/repository-name.');
  const res = await call(`/repos/${repo}`, { token });
  if (!res.ok) throw await ghError(res);
  const info = await res.json();
  if (!info.private) throw new Error('That repository is public, so anyone could read your diary. Make it private first.');
}

// Returns the backup stored on GitHub, or null if there isn't one yet.
export async function fetchRemote(conf = cfg) {
  const res = await call(filePath(conf.repo), { token: conf.token, accept: 'application/vnd.github.raw+json' });
  if (res.status === 404) return null;
  if (!res.ok) throw await ghError(res);
  try {
    return JSON.parse(await res.text());
  } catch {
    throw new Error('The backup file on GitHub is damaged.');
  }
}

async function currentSha() {
  const res = await call(filePath(cfg.repo), { token: cfg.token });
  if (res.status === 404) return undefined;
  if (!res.ok) throw await ghError(res);
  return (await res.json()).sha;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Call after any change to the diary: saves a few seconds later.
export function scheduleSave() {
  if (!cfg) return;
  writeLocal(DIRTY_KEY, '1');
  clearTimeout(timer);
  timer = setTimeout(saveNow, DELAY);
}

// Save straight away if there are unsaved changes (e.g. when the app goes to the background).
export function flush() {
  if (cfg && isDirty()) saveNow();
}

export function saveNow() {
  if (!cfg) return Promise.resolve();
  clearTimeout(timer);
  if (saving) {
    again = true;
    return saving;
  }
  writeLocal(DIRTY_KEY, '1');
  status.busy = true;
  onStatus();
  saving = (async () => {
    try {
      const content = toBase64(JSON.stringify(await getData()));
      const put = async () =>
        call(filePath(cfg.repo), {
          token: cfg.token,
          method: 'PUT',
          body: { message: `Tally backup ${stamp()}`, content, sha: sha || undefined },
        });
      if (sha === null) sha = await currentSha();
      let res = await put();
      if (res.status === 409 || res.status === 422) {
        // Our idea of the file version was stale; look it up and try once more.
        sha = await currentSha();
        res = await put();
      }
      if (!res.ok) throw await ghError(res);
      sha = (await res.json()).content.sha;
      status.lastSaved = Date.now();
      status.error = '';
      writeLocal(SAVED_KEY, status.lastSaved);
      if (!again) writeLocal(DIRTY_KEY, null);
    } catch (err) {
      status.error = err.message;
    } finally {
      saving = null;
      status.busy = false;
      onStatus();
      if (again) {
        again = false;
        scheduleSave();
      }
    }
  })();
  return saving;
}
