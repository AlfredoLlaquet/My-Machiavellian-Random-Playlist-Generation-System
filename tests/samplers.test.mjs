import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';

const newPlaylist = 'PL_new_sample';
const videoIds = Array.from({length: 103}, (_, i) => 'v' + String(i).padStart(10, '0'));
const sourceA = {id: 'PL_source_a', title: "Alfredo's__I__"};
const sourceB = {id: 'PL_source_b', title: "Alfredo's__II__"};
const platforms = [
  {name: 'Random Sample', file: 'random-sample', factory: 'makeSamplerCore', music: false},
  {name: 'Random Songs', file: 'random-songs', factory: 'makeCollectionSamplerCore', music: true},
];

function loadFactory(platform) {
  const file = new URL('../src/' + platform.file + '.js', import.meta.url);
  // The normal launcher's origin guard exits before it touches the DOM. There
  // is deliberately no fetch, storage, or account in this context.
  return runInNewContext(readFileSync(file, 'utf8') + '\n;' + platform.factory, {
    URL, location: {origin: 'https://test.invalid'}, alert() {},
  }, {filename: file.pathname});
}

function playlistPage(music, playlistId, ids) {
  if (music) {
    const contents = ids.map(id => ({
      musicResponsiveListItemRenderer: {
        playlistItemData: {videoId: id},
        flexColumns: [
          {musicResponsiveListItemFlexColumnRenderer: {text: {simpleText: id}}},
          {musicResponsiveListItemFlexColumnRenderer: {text: {simpleText: 'Test artist'}}},
        ],
      },
    }));
    return {contents: {musicPlaylistShelfRenderer: {playlistId, contents}}};
  }
  const contents = ids.map(id => ({
    playlistVideoRenderer: {videoId: id, isPlayable: true, title: {simpleText: id}},
  }));
  return {contents: {playlistVideoListRenderer: {playlistId, contents}}};
}

// The server will edit *any* known playlist it is sent, including a source.
// The assertions therefore detect both attempted and actual source writes.
function makeHarness(platform) {
  const makeCore = loadFactory(platform);
  const sources = platform.music ? [sourceA, sourceB] : [sourceA];
  const playlists = new Map([[sourceA.id, [...videoIds, videoIds[0], 'bad-id']]]);
  if (platform.music) {
    playlists.set(sourceA.id, videoIds.slice(0, 60));
    playlists.set(sourceB.id, [...videoIds.slice(60), videoIds[0], 'bad-id']);
  }
  const originalSources = structuredClone(playlists);
  const requests = [];
  const state = {liveJob: null, storedJob: null};
  const server = {
    onCreate() { return {playlistId: newPlaylist}; },
    onEdit() { return {status: 'STATUS_SUCCEEDED'}; },
  };
  const deps = {
    account: 'test-account',
    randomInt: bound => bound - 1,
    async delay() {},
    save(job) {
      state.liveJob = job;
      state.storedJob = structuredClone(job);
    },
    async post(endpoint, payload, options = {}) {
      requests.push(structuredClone({endpoint, payload, options}));
      if (endpoint === 'browse' && payload.browseId === 'FEmusic_liked_playlists' && platform.music) {
        const items = sources.map(({id, title}) => ({
          gridPlaylistRenderer: {playlistId: id, title: {simpleText: title}},
        }));
        return {contents: {gridRenderer: {items}}};
      }
      if (endpoint === 'browse') {
        assert.ok(payload.browseId.startsWith('VL'));
        const id = payload.browseId.slice(2);
        assert.ok(playlists.has(id), 'unexpected read of ' + id);
        return playlistPage(platform.music, id, playlists.get(id));
      }
      if (endpoint === 'playlist/create') {
        assert.equal(options.write, true);
        assert.equal(payload.privacyStatus, 'PRIVATE');
        playlists.set(newPlaylist, Array.from(payload.videoIds));
        return server.onCreate();
      }
      if (endpoint === 'browse/edit_playlist') {
        assert.equal(options.write, true);
        for (const action of payload.actions) {
          assert.equal(action.action, 'ACTION_ADD_VIDEO');
          if (platform.music) assert.equal(action.dedupeOption, 'DEDUPE_OPTION_SKIP');
          playlists.get(payload.playlistId).push(action.addedVideoId);
        }
        return server.onEdit();
      }
      assert.fail('unexpected request: ' + endpoint);
    },
  };
  const core = makeCore(deps);
  return {
    playlists, server, state,
    async start(count = videoIds.length) {
      if (platform.music) await core.discover();
      return core.run({source: sourceA.id, title: 'New selection', count, artistPercent: 100, checkPlayback: false});
    },
    // A re-opened panel gets a new core and can only recover the persisted job.
    resume() { return makeCore(deps).finish(structuredClone(state.storedJob)); },
    creates() { return requests.filter(r => r.endpoint === 'playlist/create'); },
    edits() { return requests.filter(r => r.endpoint === 'browse/edit_playlist'); },
    assertSourceIntegrity() {
      for (const [id, original] of originalSources) assert.deepEqual(playlists.get(id), original);
      for (const {payload, options} of requests.filter(r => r.endpoint === 'browse/edit_playlist')) {
        assert.equal(payload.playlistId, newPlaylist);
        assert.equal(options.destination, newPlaylist);
      }
    },
  };
}

for (const platform of platforms) {
  test(platform.name + ' samples distinct IDs and writes only to the new private playlist', async () => {
    const run = makeHarness(platform);
    const job = await run.start();
    assert.equal(job.destination, newPlaylist);
    assert.deepEqual(new Set(job.ids), new Set(videoIds));
    assert.equal(job.ids.length, videoIds.length);
    assert.deepEqual(run.playlists.get(newPlaylist), Array.from(job.ids));
    assert.deepEqual(run.creates().map(r => r.payload.videoIds.length), [50]);
    assert.deepEqual(run.edits().map(r => r.payload.actions.length), [50, 3]);
    assert.equal(run.state.storedJob, null);
    run.assertSourceIntegrity();
  });

  test(platform.name + ' rejects creation responses that echo any source or omit a usable ID', async () => {
    const sourceIds = platform.music ? [sourceA.id, sourceB.id] : [sourceA.id];
    for (const reply of [...sourceIds.map(playlistId => ({playlistId})), {}, {playlistId: 'bad/id'}]) {
      const run = makeHarness(platform);
      run.server.onCreate = () => reply;
      await assert.rejects(run.start(), /destination is invalid|did not return a new playlist/i);
      assert.equal(run.state.storedJob.destination, null);
      assert.equal(run.state.liveJob.destination, null);
      await assert.rejects(run.resume(), /creation result is unknown/i);
      assert.equal(run.creates().length, 1);
      assert.equal(run.edits().length, 0);
      run.assertSourceIntegrity();
    }
  });

  test(platform.name + ' resumes a committed batch whose reply was lost without duplicating it', async () => {
    const run = makeHarness(platform);
    run.server.onEdit = () => { throw new Error('connection lost after write'); };
    await assert.rejects(run.start(), /connection lost/);
    assert.equal(run.state.storedJob.phase, 'adding');
    assert.equal(run.playlists.get(newPlaylist).length, 100);
    run.server.onEdit = () => ({status: 'STATUS_SUCCEEDED'});

    const recovered = await run.resume();
    assert.deepEqual(run.playlists.get(newPlaylist), Array.from(recovered.ids));
    assert.equal(run.creates().length, 1);
    assert.deepEqual(run.edits().map(r => r.payload.actions.length), [50, 3]);
    assert.equal(run.state.storedJob, null);
    run.assertSourceIntegrity();
  });

  test(platform.name + ' rejects an overfilled creation response on first use and after reopening', async () => {
    const run = makeHarness(platform);
    run.server.onCreate = () => {
      // Only the initial 50 IDs were sent. Even an exact 51st match is an
      // unexpected destination and must not become eligible after a reload.
      run.playlists.get(newPlaylist).push(run.state.storedJob.ids[50]);
      return {playlistId: newPlaylist};
    };
    await assert.rejects(run.start(), /unexpected creation result/i);
    await assert.rejects(run.resume(), /unexpected creation result/i);
    assert.equal(run.creates().length, 1);
    assert.equal(run.edits().length, 0);
    run.assertSourceIntegrity();
  });

  test(platform.name + ' stops recovery when another edit changes the saved prefix', async () => {
    const run = makeHarness(platform);
    run.server.onEdit = () => { throw new Error('reply lost'); };
    await assert.rejects(run.start(), /reply lost/);
    const playlist = run.playlists.get(newPlaylist);
    [playlist[0], playlist[1]] = [playlist[1], playlist[0]];
    await assert.rejects(run.resume(), /differs from the saved selection/i);
    assert.equal(run.creates().length, 1);
    assert.equal(run.edits().length, 1);
    run.assertSourceIntegrity();
  });

  test(platform.name + ' refuses to create a playlist if too few distinct eligible IDs exist', async () => {
    const run = makeHarness(platform);
    await assert.rejects(run.start(videoIds.length + 1), /distinct eligible/i);
    assert.equal(run.creates().length, 0);
    assert.equal(run.edits().length, 0);
    run.assertSourceIntegrity();
  });
}
