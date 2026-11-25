import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';

const root = new URL('../', import.meta.url);
const music = 'music.youtube.com';
const video = 'www.youtube.com';
const tools = [
  ['add-songs', '+', music, 'YouTube-Music-Alfredo-Import.html'],
  ['random-songs', '⤨', music, 'YouTube-Music-Alfredo-Collection.html'],
  ['list-artists', '≡', music, 'YouTube-Music-Alfredo-Artists.html'],
  ['delete-duplicates', '⌫', music, 'YouTube-Music-Alfredo-Delete-Duplicates.html'],
  ['like-songs', '♥', music, 'YouTube-Music-Alfredo-Like-Songs.html'],
  ['random-sample', '⤨', video, 'YouTube-Random-Sample.html'],
  ['copy-videos', '+', video, 'YouTube-Playlist-Copier.html'],
];

// Only the entities emitted by the installer generator are needed here.
function htmlText(text) {
  const entities = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (_, key) => {
    if (key.startsWith('#x')) return String.fromCodePoint(parseInt(key.slice(2), 16));
    if (key.startsWith('#')) return String.fromCodePoint(Number(key.slice(1)));
    return entities[key];
  });
}

function element(html, tag, id) {
  const expression = new RegExp(`<${tag}\\b(?=[^>]*\\bid="${id}")([^>]*)>([\\s\\S]*?)</${tag}>`, 'i');
  const match = html.match(expression);
  assert.ok(match, `missing ${tag}#${id}`);
  return {attributes: match[1], text: htmlText(match[2])};
}

function href(attributes) {
  const match = attributes.match(/\bhref="([^"]*)"/i);
  assert.ok(match, 'bookmark anchor needs an href');
  return htmlText(match[1]);
}

// Execute the actual inline installer controls. The fixture supplies the DOM
// operations those controls use and captures the clipboard and downloaded files.
function openInstaller(html) {
  const anchor = element(html, 'a', 'bookmark');
  const source = element(html, 'pre', 'source-code');
  const field = element(html, 'textarea', 'bookmark-code');
  const elements = new Map();
  const downloads = [];
  const copied = [];
  const objectUrls = new Map();
  let nextUrl = 0;
  let selected = false;
  for (const id of [...html.matchAll(/\bid="([a-z][a-z0-9-]*)"/g)].map(match => match[1])) {
    elements.set(id, {
      textContent: '', value: '',
      addEventListener(event, handler) { this['on' + event] = handler; },
      focus() {},
      select() { selected = true; },
    });
  }
  Object.assign(elements.get('bookmark'), {
    textContent: anchor.text, href: href(anchor.attributes),
    getAttribute(name) { return name === 'href' ? this.href : undefined; },
  });
  elements.get('bookmark-code').value = field.text;
  elements.get('source-code').textContent = source.text;
  const document = {
    getElementById(id) {
      assert.ok(elements.has(id), `installer script refers to missing #${id}`);
      return elements.get(id);
    },
    createElement(tag) {
      assert.equal(tag, 'a');
      return {
        setAttribute(name, value) {
          assert.equal(name, 'href');
          this.href = value;
        },
        get outerHTML() {
          // The browser serializes the detached anchor into the exported file.
          const url = this.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
          return '<a href="' + url + '">' + this.textContent + '</a>';
        },
        click() {
          assert.ok(objectUrls.has(this.href), 'download URL must refer to a local file');
          downloads.push({name: this.download, blob: objectUrls.get(this.href)});
        },
        remove() {},
      };
    },
    body: {append() {}},
  };
  const clipboard = {async writeText(text) { copied.push(text); }};
  const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.equal(inline.length, 1, 'installer controls should be self-contained');
  assert.doesNotMatch(inline[0][1], /\bsrc\s*=/i);
  runInNewContext(inline[0][2], {
    document, navigator: {clipboard}, Blob,
    URL: {
      createObjectURL(blob) {
        const key = 'blob:installer-test/' + ++nextUrl;
        objectUrls.set(key, blob);
        return key;
      },
      revokeObjectURL(key) { objectUrls.delete(key); },
    },
    setTimeout(callback) { callback(); },
  }, {timeout: 1000});

  async function click(id) {
    const node = elements.get(id);
    assert.equal(typeof node?.onclick, 'function', `#${id} needs a click handler`);
    await node.onclick({preventDefault() {}});
  }
  return {anchor, elements, downloads, copied, clipboard, selected: () => selected, click};
}

async function launch(code, origin, signedOut = false) {
  const alerts = [];
  const context = {location: Object.freeze({origin}), alert(text) {alerts.push(text);}, URL};
  if (signedOut) {
    context.window = {};
    context.document = {getElementById() {return null;}};
  }
  // Neither case has a network, mutable page, account credentials or storage.
  const value = runInNewContext(code, context, {timeout: 1500});
  await value;
  return {value, alerts};
}

test('the repository ships exactly seven canonical HTML installers', () => {
  const expected = tools.map(([, , , name]) => name).sort();
  const actual = readdirSync(new URL('installers/', root)).filter(name => name.endsWith('.html')).sort();
  assert.deepEqual(actual, expected);
});

for (const [slug, symbol, host, filename] of tools) {
  test(`${slug}: drag, copy, import and readable source agree`, async () => {
    const html = readFileSync(new URL('installers/' + filename, root), 'utf8');
    const source = readFileSync(new URL('src/' + slug + '.js', root), 'utf8');
    const {anchor, elements, downloads, copied, clipboard, selected, click} = openInstaller(html);
    const address = href(anchor.attributes);
    assert.equal(anchor.text, symbol);
    assert.match(anchor.attributes, /\bdraggable="true"/i);
    assert.equal(elements.get('bookmark-code').value, address);
    assert.equal(elements.get('source-code').textContent, source);
    assert.equal(new URL(address).protocol, 'javascript:');
    assert.equal(new URL(address).hash, '', 'a literal # would truncate the executable URL');
    assert.doesNotMatch(address, /[\r\n\t]/);
    const writeText = clipboard.writeText;
    clipboard.writeText = async () => { throw new Error('Clipboard blocked'); };
    await click('copy-code');
    assert.ok(selected(), 'the complete URL remains selected for a manual copy');
    assert.match(elements.get('install-status').textContent, /selected/i);
    clipboard.writeText = writeText;
    await click('copy-code');
    assert.deepEqual(copied, [address]);

    await click('export-bookmark');
    assert.equal(downloads.length, 1);
    assert.match(downloads[0].name, /\.html$/i);
    const imported = await downloads[0].blob.text();
    assert.match(imported, /<!DOCTYPE NETSCAPE-Bookmark-file-1>/i);
    const anchors = [...imported.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/gi)];
    assert.equal(anchors.length, 1);
    assert.equal(htmlText(anchors[0][2]), symbol);
    assert.equal(href(anchors[0][1]), address);

    await click('download-source');
    assert.equal(downloads.length, 2);
    assert.match(downloads[1].name, /\.js$/i);
    assert.equal(await downloads[1].blob.text(), source);

    const payload = decodeURIComponent(address.slice('javascript:'.length));
    for (const wrongSite of [
      'https://' + (host === music ? video : music),
      'https://' + host + '.example.invalid',
    ]) {
      const installed = await launch(payload, wrongSite);
      assert.equal(installed.value, undefined, 'a bookmark click must not replace the document');
      assert.equal(installed.alerts.length, 1);
      assert.ok(installed.alerts[0].includes(host));
      assert.deepEqual(installed.alerts, (await launch(source, wrongSite)).alerts);
    }
    const signedOut = await launch(payload, 'https://' + host, true);
    assert.equal(signedOut.value, undefined);
    assert.equal(signedOut.alerts.length, 1);
    assert.match(signedOut.alerts[0], /sign in/i);
    assert.deepEqual(signedOut.alerts, (await launch(source, 'https://' + host, true)).alerts);
  });
}
