import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const sourceText = readFileSync(new URL('../src/copy-videos.js', import.meta.url), 'utf8');
const SOURCE = 'PL_Source123';
const TARGET = 'PL_Destination123';
const OTHER = 'PL_Another123';
const VIDEO_A = 'abcdefghijk';
const VIDEO_B = '123456789ab';

function internals() {
  const entry = '  launchPlaylistCopier();';
  assert.equal(sourceText.split(entry).length, 2, 'one browser entry point');
  const context = { URL };
  vm.runInNewContext(
    sourceText.replace(
      entry,
      '  globalThis.api = { playlistId, preferenceOwner, destinationPreference, makePlaylistCopier };'
    ),
    context
  );
  return context.api;
}

class MemoryStorage {
  data = new Map();
  getItem(key) {
    return this.data.get(key) ?? null;
  }
  setItem(key, value) {
    this.data.set(key, value);
  }
  removeItem(key) {
    this.data.delete(key);
  }
}
function playlistPage(id, videos, editable = true) {
  return {
    contents: {
      playlistVideoListRenderer: {
        playlistId: id,
        isEditable: editable,
        contents: videos.map((videoId) => ({
          playlistVideoRenderer: { videoId, isPlayable: true, title: { simpleText: videoId } }
        }))
      }
    },
    metadata: { playlistMetadataRenderer: { title: id } }
  };
}

test('the destination accepts a playlist ID or a YouTube list URL and rejects ambiguous sites and Mixes', () => {
  const { playlistId } = internals();
  for (const value of [
    TARGET,
    '  ' + TARGET,
    'https://www.youtube.com/playlist?list=' + TARGET,
    'https://m.youtube.com/watch?v=' + VIDEO_A + '&list=' + TARGET
  ])
    assert.equal(playlistId(value), TARGET);
  for (const value of [
    '',
    'RD_mixed',
    'invalid id',
    'https://example.org/?list=' + TARGET,
    'https://www.youtube.com:444/?list=' + TARGET,
    'https://www.youtube.com/watch?v=' + VIDEO_A
  ]) {
    assert.throws(() => playlistId(value));
  }
});

test('saved destinations survive session-index changes and cannot cross accounts or channels', () => {
  const { preferenceOwner, destinationPreference } = internals();
  const owner = (data) => preferenceOwner((key) => data[key]);
  const a = { SESSION_INDEX: 0, DATASYNC_ID: 'account-a' };
  const b = { SESSION_INDEX: 0, DATASYNC_ID: 'account-b' };
  assert.equal(owner(a), owner({ ...a, SESSION_INDEX: 1 }));
  assert.notEqual(owner(a), owner(b));
  assert.notEqual(owner(a), owner({ ...a, DELEGATED_SESSION_ID: 'different-channel' }));
  assert.notEqual(
    owner({ ...a, DELEGATED_SESSION_ID: 'shared' }),
    owner({ ...b, DELEGATED_SESSION_ID: 'shared' })
  );
  const storage = new MemoryStorage();
  const preference = (data) => destinationPreference(storage, owner(data));
  assert.equal(preference(a).save(TARGET), true);
  assert.equal(preference(b).read(), '');
  assert.equal(preference(a).read(), TARGET);
  assert.equal(preference(b).save(OTHER), true);
  assert.equal(preference(a).read(), TARGET);
  assert.equal(preference({ SESSION_INDEX: 0 }).save(OTHER), false);
  assert.equal(preference({ SESSION_INDEX: 0 }).read(), '');
  assert.equal(storage.data.size, 2);
  storage.setItem(preference(a).key, 'unreadable saved setting!');
  assert.equal(preference(a).read(), '');
});

test('the chosen destination is the only write target; failed existing-video checks stay best effort', async () => {
  const { makePlaylistCopier } = internals();
  const writes = [];
  const core = makePlaylistCopier({
    account: 'example',
    destination: TARGET,
    post: async (endpoint, payload) => {
      if (endpoint === 'browse') {
        if (payload.browseId === 'VL' + TARGET) throw new Error('Unavailable destination scan');
        assert.equal(payload.browseId, 'VL' + SOURCE);
        return playlistPage(SOURCE, [VIDEO_A, VIDEO_A, VIDEO_B]);
      }
      assert.equal(endpoint, 'browse/edit_playlist');
      writes.push(payload);
      return { status: 'STATUS_SUCCEEDED' };
    }
  });
  await assert.rejects(core.run(TARGET), /destination playlist/);
  const report = await core.run(SOURCE);
  assert.equal(report.duplicateCheckIncomplete, true);
  assert.equal(report.repeated, 1);
  assert.equal(report.added, 2);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].playlistId, TARGET);
  assert.deepEqual(
    Array.from(writes[0].actions, (action) => [action.action, action.addedVideoId]),
    [
      ['ACTION_ADD_VIDEO', VIDEO_A],
      ['ACTION_ADD_VIDEO', VIDEO_B]
    ]
  );
});

test('a known read-only destination stops before an edit, and uncertain writes are never sent twice', async () => {
  const { makePlaylistCopier } = internals();
  let editable = false;
  let writes = 0;
  const core = makePlaylistCopier({
    account: 'example',
    destination: TARGET,
    post: async (endpoint, payload) => {
      if (endpoint === 'browse')
        return payload.browseId === 'VL' + SOURCE
          ? playlistPage(SOURCE, [VIDEO_A])
          : playlistPage(TARGET, [], editable);
      writes++;
      throw new Error('Lost reply');
    }
  });
  await assert.rejects(core.run(SOURCE), /cannot edit/);
  assert.equal(writes, 0);
  editable = true;
  const report = await core.run(SOURCE);
  assert.equal(report.uncertain, 1);
  assert.equal(writes, 1);
});

class Events {
  listeners = new Map();
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }
  async fire(type, event = {}) {
    for (const callback of this.listeners.get(type) || []) {
      await callback({ type, preventDefault() {}, ...event });
    }
  }
}
class Element extends Events {
  constructor(tag) {
    super();
    this.tag = tag;
  }
  children = [];
  attributes = new Map();
  style = {};
  textContent = '';
  value = '';
  append(child) {
    this.children.push(child);
  }
  attachShadow() {
    this.shadowRoot = new Element('shadow');
    this.append(this.shadowRoot);
    return this.shadowRoot;
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  focus() {}
  remove() {}
  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const result = child.find(predicate);
      if (result) return result;
    }
  }
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function mockLocks() {
  const busy = new Set();
  return {
    async request(key, options, callback) {
      assert.equal(options.ifAvailable, true);
      if (busy.has(key)) return callback(null);
      busy.add(key);
      try {
        return await callback({ name: key });
      } finally {
        busy.delete(key);
      }
    }
  };
}
function tab({
  storage = new MemoryStorage(),
  locks = mockLocks(),
  account = 'account-a',
  post,
  index = 0,
  pageSource = SOURCE
} = {}) {
  const root = new Element('html');
  const window = new Events();
  const configuration = {
    SESSION_INDEX: index,
    DATASYNC_ID: account,
    LOGGED_IN: true,
    INNERTUBE_CONTEXT: { client: { clientVersion: 'synthetic' } }
  };
  const origin = 'https://www.youtube.com';
  const location = new URL(origin + '/playlist?list=' + pageSource);
  window.ytcfg = { get: (key) => configuration[key] };
  window.localStorage = storage;
  const requests = [];
  const fetch = async (url, options) => {
    const endpoint = new URL(url).pathname.replace('/youtubei/v1/', '');
    const payload = JSON.parse(options.body);
    requests.push({ endpoint, payload });
    const response = post
      ? await post(endpoint, payload)
      : endpoint === 'browse'
        ? playlistPage(
            payload.browseId.slice(2),
            payload.browseId === 'VL' + pageSource ? [VIDEO_A] : []
          )
        : { status: 'STATUS_SUCCEEDED' };
    return { ok: true, json: async () => response };
  };
  vm.runInNewContext(sourceText, {
    window,
    document: {
      cookie: 'SAPISID=synthetic',
      documentElement: root,
      getElementById: (id) => root.find((el) => el.id === id),
      createElement: (tag) => new Element(tag)
    },
    location,
    URL,
    navigator: { locks },
    crypto: webcrypto,
    fetch,
    AbortController,
    TextEncoder,
    Blob,
    clearTimeout,
    setTimeout,
    alert: (msg) => assert.fail(msg)
  });
  const find = (predicate) => {
    const found = root.find(predicate);
    assert.ok(found, 'expected panel element');
    return found;
  };
  const button = (name) => find((el) => el.tag === 'button' && el.textContent === name);
  const status = find((el) => el.getAttribute('role') === 'status');
  const form = find((el) => el.tag === 'form');
  const field = find((el) => el.tag === 'input');
  return {
    window,
    configuration,
    requests,
    status,
    form,
    field,
    button,
    async save(id) {
      field.value = id;
      await form.fire('submit');
    },
    add() {
      return button('Add videos').fire('click');
    }
  };
}

test('the installed browser UI prompts once, remembers the destination per account and changes it on request', async () => {
  const storage = new MemoryStorage();
  const first = tab({ storage });
  assert.equal(first.form.hidden, false);
  assert.equal(first.button('Add videos').disabled, true);
  await first.save('https://www.youtube.com/playlist?list=' + TARGET);
  assert.equal(first.requests.length, 0);
  await first.add();
  assert.equal(
    first.requests.filter((r) => r.endpoint === 'browse/edit_playlist')[0].payload.playlistId,
    TARGET
  );
  const next = tab({ storage, index: 1 });
  assert.equal(next.form.hidden, true);
  await next.button('Change destination').fire('click');
  assert.equal(next.button('Add videos').disabled, true);
  await next.save(SOURCE);
  assert.equal(next.button('Add videos').disabled, true);
  await next.button('Change destination').fire('click');
  await next.save(OTHER);
  await next.add();
  assert.equal(
    next.requests.filter((r) => r.endpoint === 'browse/edit_playlist')[0].payload.playlistId,
    OTHER
  );
  const different = tab({ storage, account: 'account-b' });
  assert.equal(different.form.hidden, false);
  assert.equal(different.field.value, '');
});

test('browser copying refuses a switched account both at save and between source scan and edit', async () => {
  const storage = new MemoryStorage();
  const original = tab({ storage });
  original.configuration.DATASYNC_ID = 'other';
  await original.save(TARGET);
  assert.equal(storage.data.size, 0);
  assert.match(original.status.textContent, /account changed/);
  const current = tab({
    storage,
    post: async (endpoint, payload) => {
      assert.equal(endpoint, 'browse');
      current.configuration.DATASYNC_ID = 'other';
      return playlistPage(payload.browseId.slice(2), [VIDEO_A]);
    }
  });
  await current.save(TARGET);
  await current.add();
  assert.equal(
    current.requests.some((r) => r.endpoint === 'browse/edit_playlist'),
    false
  );
  assert.match(current.status.textContent, /account changed/);
});

test('cross-tab copies are locked by destination and cancellation stops later writes', async () => {
  const storage = new MemoryStorage();
  const locks = mockLocks();
  const entered = deferred();
  const finish = deferred();
  const first = tab({
    storage,
    locks,
    post: async (endpoint, payload) => {
      assert.equal(endpoint, 'browse');
      entered.resolve();
      await finish.promise;
      return playlistPage(payload.browseId.slice(2), [VIDEO_A]);
    }
  });
  await first.save(TARGET);
  const running = first.add();
  await entered.promise;
  const second = tab({ storage, locks });
  await second.add();
  assert.match(second.status.textContent, /Another copy/);
  assert.deepEqual(second.requests, []);
  await first.button('Cancel').fire('click');
  finish.resolve();
  await running;
  assert.match(first.status.textContent, /Canceled/);
  assert.equal(
    first.requests.some((r) => r.endpoint === 'browse/edit_playlist'),
    false
  );
});

test('changing a destination in another tab leaves an active copy bound to its original target', async () => {
  const storage = new MemoryStorage();
  const entered = deferred();
  const finish = deferred();
  const first = tab({
    storage,
    post: async (endpoint, payload) => {
      if (endpoint === 'browse') {
        if (payload.browseId === 'VL' + SOURCE) {
          entered.resolve();
          await finish.promise;
        }
        return playlistPage(
          payload.browseId.slice(2),
          payload.browseId === 'VL' + SOURCE ? [VIDEO_A] : []
        );
      }
      return { status: 'STATUS_SUCCEEDED' };
    }
  });
  await first.save(TARGET);
  const running = first.add();
  await entered.promise;
  const second = tab({ storage });
  await second.button('Change destination').fire('click');
  await second.save(OTHER);
  const key = Array.from(storage.data.keys()).find((k) => k.startsWith('mmrpgs:copy-videos:'));
  await first.window.fire('storage', { key, storageArea: storage });
  finish.resolve();
  await running;
  assert.equal(
    first.requests.filter((r) => r.endpoint === 'browse/edit_playlist')[0].payload.playlistId,
    TARGET
  );
  assert.equal(first.field.value, OTHER);
});

test('when account-specific storage is unavailable, a chosen destination applies only to that panel', async () => {
  const storage = new MemoryStorage();
  const first = tab({ storage, account: '' });
  await first.save(TARGET);
  assert.match(first.status.textContent, /panel only/);
  await first.add();
  assert.equal(
    first.requests.find((row) => row.endpoint === 'browse/edit_playlist').payload.playlistId,
    TARGET
  );
  assert.equal(storage.data.size, 0);
  assert.equal(tab({ storage, account: '' }).form.hidden, false);
});

test('the copier reports an unavailable cross-tab lock without sending playlist requests', async () => {
  const current = tab({ locks: {} });
  await current.save(TARGET);
  await current.add();
  assert.match(current.status.textContent, /Web Locks/);
  assert.deepEqual(current.requests, []);
});
