import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';

// Run the real bookmarklet's wrong-origin guard, then exercise its real core
// through the same dependency boundary used by the browser launcher.
function factory(file, name) {
  const path = new URL('../src/' + file + '.js', import.meta.url);
  return runInNewContext(readFileSync(path, 'utf8') + '\n;' + name, {
    URL, location: {origin: 'https://example.invalid'}, alert() {},
  }, {filename: path.pathname});
}

const importer = factory('add-songs', 'makeCollectionImporterCore');
const artists = factory('list-artists', 'makeCollectionArtistsCore');
const duplicates = factory('delete-duplicates', 'makeCollectionDuplicatesCore');
const likes = factory('like-songs', 'makeCollectionLikesCore');
const video = n => 'v' + String(n).padStart(10, '0');
const channel = char => 'UC' + char.repeat(22);
const artist = {name: 'The "Quartet"', id: channel('A')};
const artistInput = '"The ""Quartet"""';
const albumId = 'MPRE_quartet';

function library(playlists) {
  return {contents: {gridRenderer: {items: playlists.map(({id, title}) => ({
    gridPlaylistRenderer: {playlistId: id, title: {simpleText: title}},
  }))}}};
}

function track(id, setVideoId) {
  return {musicResponsiveListItemRenderer: {playlistItemData: {videoId: id, playlistSetVideoId: setVideoId}}};
}

function playlistPage({id, rows, owned = true, count = rows.length}) {
  return {
    header: {
      musicResponsiveHeaderRenderer: {secondSubtitle: {simpleText: count + ' songs'}},
      ...(owned && {musicEditablePlaylistDetailHeaderRenderer: {playlistId: id}}),
    },
    contents: {musicPlaylistShelfRenderer: {playlistId: id, contents: rows}},
  };
}

function browseLink(id) {
  return {navigationEndpoint: {browseEndpoint: {browseId: id}}};
}

function albumPage(owner, rows = []) {
  return {
    header: {musicResponsiveHeaderRenderer: {
      straplineTextOne: {runs: [{text: owner.name, ...browseLink(owner.id)}]},
    }},
    contents: {musicShelfRenderer: {contents: rows}},
  };
}

function importerFixture(editableCount, {loseAddReply = false} = {}) {
  const playlists = [
    {id: 'PLone', title: "Alfredo's__I__", owned: false, rows: [track(video(1))]},
    {id: 'PLtwo', title: "Alfredo's__II__", count: 4501, rows: []},
    {id: 'PLthree', title: "Alfredo's__III__", count: editableCount, rows: []},
  ];
  const writes = [];
  let pending = null;
  const core = importer({
    savePending(value) { pending = structuredClone(value); },
    loadPending() { return structuredClone(pending); },
    async post(endpoint, body, options = {}) {
      if (options.write) {
        assert.equal(options.permit.id, pending.id);
        assert.equal(options.permit.title, pending.title);
        writes.push([endpoint, structuredClone(body)]);
        if (endpoint === 'playlist/create') {
          playlists.push({id: 'PLnew', title: body.title, rows: [], count: 0});
          return {playlistId: 'PLnew'};
        }
        assert.equal(endpoint, 'browse/edit_playlist');
        const destination = playlists.find(p => p.id === body.playlistId);
        for (const action of body.actions) {
          assert.equal(action.action, 'ACTION_ADD_VIDEO');
          destination.rows.push(track(action.addedVideoId));
          destination.count++;
        }
        if (loseAddReply) {
          loseAddReply = false;
          throw new Error('The server committed the addition before the connection closed.');
        }
        return {status: 'STATUS_SUCCEEDED'};
      }
      if (endpoint === 'search') return {
        contents: {musicCardShelfRenderer: {title: {simpleText: artist.name}, ...browseLink(artist.id)}},
      };
      assert.equal(endpoint, 'browse');
      if (body.browseId === 'FEmusic_liked_playlists') return library(playlists);
      if (body.browseId === artist.id) return {contents: {musicCarouselShelfRenderer: {
        header: {musicCarouselShelfBasicHeaderRenderer: {title: {simpleText: 'Albums'}}},
        contents: [{musicTwoRowItemRenderer: {title: {simpleText: 'Album'}, ...browseLink(albumId)}}],
      }}};
      if (body.browseId === albumId)
        return albumPage(artist, [track(video(1)), track(video(2)), track(video(2))]);
      const list = playlists.find(p => body.browseId === 'VL' + p.id);
      assert.ok(list, 'Unexpected browse request: ' + body.browseId);
      return playlistPage(list);
    },
  });
  return {core, playlists, writes};
}

test('Add Songs counts duplicates across read-only sources and fills a destination with exactly 500 free slots', async () => {
  const {core, playlists, writes} = importerFixture(4500);
  const result = await core.run(artistInput);
  assert.equal(result.found, 2);
  assert.equal(result.existing, 1);
  assert.equal(result.added, 1);
  assert.deepEqual(writes, [['browse/edit_playlist', {
    playlistId: 'PLthree', actions: [{action: 'ACTION_ADD_VIDEO', addedVideoId: video(2)}],
  }]]);
  assert.equal(playlists[2].count, 4501);
  const repeated = await core.run(artistInput);
  assert.equal(repeated.existing, 2);
  assert.equal(repeated.added, 0);
  assert.equal(writes.length, 1);
});

test('Add Songs creates the next private numbered playlist when all eligible destinations lack room', async () => {
  const {core, writes} = importerFixture(4501);
  const result = await core.run(artistInput);
  assert.equal(result.created, 1);
  assert.equal(result.added, 1);
  assert.deepEqual(writes.map(([endpoint]) => endpoint), ['playlist/create', 'browse/edit_playlist']);
  assert.equal(writes[0][1].title, "Alfredo's __IV__");
  assert.equal(writes[0][1].privacyStatus, 'PRIVATE');
  assert.equal(writes[1][1].playlistId, 'PLnew');
});

test('Add Songs reconciles a committed addition after a lost reply without appending it twice', async () => {
  const {core, playlists, writes} = importerFixture(4500, {loseAddReply: true});
  const result = await core.run(artistInput);
  assert.equal(result.added, 1);
  assert.equal(playlists[2].rows.length, 1);
  assert.equal(writes.length, 1);
});

test('List Artists keeps same-name profiles distinct and subscribes only qualifying album owners', async () => {
  const other = {name: artist.name, id: channel('B')};
  const actualChannel = channel('C');
  const writes = [];
  const core = artists({
    async post(endpoint, body) {
      if (endpoint === 'subscription/subscribe') {
        writes.push(...body.channelIds);
        return {status: 'STATUS_SUCCEEDED'};
      }
      assert.equal(endpoint, 'browse');
      if (body.browseId === albumId) return albumPage(artist);
      if (body.browseId === 'MPRE_other') return albumPage(other);
      assert.equal(body.browseId, artist.id, 'Artist below the minimum was looked up for subscription');
      return {
        header: {subscribeButtonRenderer: {channelId: actualChannel, subscribed: false}},
        contents: {subscribeButtonRenderer: {channelId: other.id, subscribed: false}},
      };
    },
  });
  const albumTrack = (id, album) => ({id, album: {id: album}, artists: [other], available: true});
  const result = await core.countArtists([
    albumTrack(video(1), albumId), albumTrack(video(1), albumId),
    albumTrack(video(2), albumId), albumTrack(video(3), 'MPRE_other'),
  ], 2);
  assert.deepEqual(Array.from(result.counts, x => [x.id, x.count]).sort(), [[artist.id, 2], [other.id, 1]]);
  assert.equal(result.duplicates, 1);
  assert.equal(result.text, '"The ""Quartet""",2');
  const summary = await core.subscribeListed(result);
  assert.equal(summary.subscribed, 1);
  assert.deepEqual(writes, [actualChannel]);
  await core.subscribeListed(result);
  assert.deepEqual(writes, [actualChannel], 'A repeated pass must reuse the known subscription');
});

test('Delete Duplicates journals exact removals and preserves the selected occurrence', async () => {
  const id = video(1);
  const lists = [
    {id: 'PLone', title: "Alfredo's__I__", rows: [
      track(id, 'copy-1'), track(id, 'keeper'), track(id, 'copy-1'), track(video(2), 'other-track'),
    ]},
    {id: 'PLtwo', title: "Alfredo's__II__", rows: [track(id, 'copy-2'), track(id)]},
  ];
  let saved;
  const writes = [];
  const core = duplicates({
    newId: () => 'fixture-run',
    store: {
      async load() { return null; }, async create() {}, async append() { return []; },
      async saveGroup(_run, group) { saved = structuredClone(group); return []; },
    },
    async post(endpoint, body, options) {
      if (endpoint === 'browse') {
        if (body.browseId === 'FEmusic_liked_playlists') return library([...lists].reverse());
        return playlistPage(lists.find(p => body.browseId === 'VL' + p.id));
      }
      assert.equal(endpoint, 'browse/edit_playlist');
      assert.equal(options.write, true);
      assert.equal(core.authorize(body), true);
      const forbidden = {action: 'ACTION_REMOVE_VIDEO', removedVideoId: id, setVideoId: 'keeper'};
      assert.equal(core.authorize({playlistId: 'PLone', actions: [forbidden]}), false);
      for (const action of body.actions) {
        assert.equal(action.removedVideoId, id);
        assert.ok(saved.copies.some(c =>
          c.playlistId === body.playlistId && c.setVideoId === action.setVideoId && c.state === 'pending'
        ), 'The occurrence must be saved as pending before dispatch');
        writes.push([body.playlistId, action.setVideoId]);
      }
      return {status: 'STATUS_SUCCEEDED'};
    },
  });
  const run = await core.prepare();
  assert.equal(run.overlaps, 1);
  const group = core.next();
  const keeper = group.copies.find(c => c.setVideoId === 'keeper');
  assert.ok(keeper);
  await core.applyChoice(group, keeper.key);
  assert.equal(keeper.state, 'present');
  assert.equal(group.copies.find(c => !c.setVideoId).state, 'failed');
  assert.deepEqual(writes, [['PLone', 'copy-1'], ['PLtwo', 'copy-2']]);
  assert.equal(core.stats().removed, 2);
});

function ratingRow(id, rating, {playable = true, withCommand = true} = {}) {
  const {musicResponsiveListItemRenderer: row} = track(id);
  row.isPlayable = playable;
  const command = {likeEndpoint: {status: 'LIKE', target: {videoId: id}}};
  row.menu = {menuRenderer: {topLevelButtons: [{likeButtonRenderer: {
    likeStatus: rating, target: {videoId: id}, serviceEndpoints: withCommand ? [command] : [],
  }}]}};
  return {musicResponsiveListItemRenderer: row};
}

test('Like Songs dispatches only usable neutral IDs once and refreshes the rating counters', async () => {
  const source = {id: 'PLone', title: "Alfredo's__I__"};
  const calls = [];
  let received = false;
  const core = likes({
    async post(endpoint, body) {
      assert.equal(endpoint, 'browse');
      if (body.browseId === 'FEmusic_liked_playlists') return library([source]);
      assert.equal(body.browseId, 'VL' + source.id);
      const rate = received ? 'LIKE' : 'INDIFFERENT';
      return playlistPage({...source, rows: [
        ratingRow(video(1), rate), ratingRow(video(1), rate),
        ratingRow(video(2), 'LIKE'), ratingRow(video(3), 'DISLIKE'),
        ratingRow(video(4), 'INDIFFERENT', {playable: false}),
        ratingRow(video(5), 'INDIFFERENT', {withCommand: false}), ratingRow(video(6), 'UNRECOGNIZED'),
        ratingRow(video(7), 'INDIFFERENT'), ratingRow(video(7), 'DISLIKE'),
      ]});
    },
    async like(id, command) {
      assert.equal(core.authorizeNative(id, command), true);
      assert.equal(core.authorizeNative(video(8), command), false);
      calls.push(id);
      received = true;
    },
  });
  const stats = await core.run();
  assert.deepEqual(calls, [video(1)]);
  assert.equal(stats.phase, 'done');
  assert.equal(stats.entries, 18);
  assert.equal(stats.sent, 1);
  assert.equal(stats.accepted, 1);
  assert.equal(stats.refreshed, 1);
  assert.equal(stats.liked, 2);
  assert.equal(stats.disliked, 2);
  assert.equal(stats.unrated, 1);
  assert.equal(stats.missingCommand, 1);
  assert.equal(stats.unavailable, 1);
  assert.equal(stats.unknown, 1);
  assert.equal(stats.eligible, 0);
});

test('Like Songs reports a rejected request separately from observed ratings', async () => {
  const source = {id: 'PLone', title: "Alfredo's__I__"};
  let requests = 0;
  const core = likes({
    async post(endpoint, body) {
      assert.equal(endpoint, 'browse');
      if (body.browseId === 'FEmusic_liked_playlists') return library([source]);
      assert.equal(body.browseId, 'VL' + source.id);
      return playlistPage({...source, rows: [ratingRow(video(1), 'INDIFFERENT')]});
    },
    async like(id) {
      assert.equal(id, video(1));
      requests++;
      throw Object.assign(new Error('Rejected'), {httpStatus: 400, definite: true});
    },
  });
  await assert.rejects(core.run(), /rejected requests/);
  const stats = core.stats();
  assert.equal(requests, 1);
  assert.equal(stats.sent, 1);
  assert.equal(stats.errors, 1);
  assert.equal(stats.accepted, 0);
  assert.equal(stats.liked, 0);
  assert.equal(stats.unrated, 1);
  assert.equal(stats.eligible, 1);
});
