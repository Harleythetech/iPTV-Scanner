import test from 'node:test';
import assert from 'node:assert/strict';
import { parseM3U, buildM3U } from '../src/m3u.js';

test('parses common EXTINF metadata and relative URLs', () => {
  const parsed = parseM3U('#EXTM3U\n#EXTINF:-1 tvg-id="news" tvg-name="News" group-title="Local",News Channel\n/live/1.m3u8');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].name, 'News');
  assert.equal(parsed.entries[0].group, 'Local');
  assert.equal(parsed.entries[0].url, '/live/1.m3u8');
});

test('resolves relative URLs when a source URL is known', () => {
  const parsed = parseM3U('#EXTM3U\n#EXTINF:-1,Test\n/live/1.m3u8', { sourceUrl:'https://example.com/a/playlist.m3u' });
  assert.equal(parsed.entries[0].url, 'https://example.com/live/1.m3u8');
});

test('supports bare URL playlists', () => {
  const parsed = parseM3U('https://a.example/live.ts\n\nhttps://b.example/live.m3u8');
  assert.equal(parsed.entries.length, 2);
});

test('exports parsed entries as M3U', () => {
  const parsed = parseM3U('#EXTM3U\n#EXTINF:-1 group-title="News",Channel A\nhttps://a.example/a.m3u8');
  const out = buildM3U(parsed.entries);
  assert.match(out, /#EXTM3U/);
  assert.match(out, /group-title="News"/);
  assert.match(out, /https:\/\/a\.example\/a\.m3u8/);
});


test('preserves EXTGRP and VLC HTTP hint directives', () => {
  const parsed = parseM3U('#EXTM3U\n#EXTGRP:News\n#EXTINF:-1 tvg-id="news",News\n#EXTVLCOPT:http-referrer=https://portal.example/\n#EXTVLCOPT:http-user-agent=ExamplePlayer/1.0\nhttps://stream.example/live.ts');
  assert.equal(parsed.entries[0].group, 'News');
  assert.equal(parsed.entries[0].httpReferrer, 'https://portal.example/');
  assert.equal(parsed.entries[0].httpUserAgent, 'ExamplePlayer/1.0');
  const out = buildM3U(parsed.entries);
  assert.match(out, /#EXTVLCOPT:http-referrer=https:\/\/portal\.example\//);
  assert.match(out, /#EXTVLCOPT:http-user-agent=ExamplePlayer\/1\.0/);
});
