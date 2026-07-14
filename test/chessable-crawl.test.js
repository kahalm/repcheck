const test = require('node:test');
const assert = require('node:assert');
const { classifyChessableApi, parseChapterLids, parseLineOids, buildIngestChapters, parseCourseVariations, progressCounts } =
  require('../extension/lib/chessable-crawl.js');

test('classifyChessableApi recognizes getCourse/getList/getGame with params', () => {
  assert.deepEqual(
    classifyChessableApi('https://www.chessable.com/api/v1/getCourse?uid=1&bid=71754'),
    { kind: 'course', bid: '71754' });
  assert.deepEqual(
    classifyChessableApi('https://www.chessable.com/api/v1/getList?uid=1&bid=71754&lid=42'),
    { kind: 'list', bid: '71754', lid: '42' });
  assert.deepEqual(
    classifyChessableApi('https://www.chessable.com/api/v1/getGame?lng=en&uid=1&oid=99'),
    { kind: 'game', oid: '99' });
});

test('classifyChessableApi ignores non-chessable / non-course URLs', () => {
  assert.equal(classifyChessableApi('https://evil.com/api/v1/getCourse?bid=1'), null);
  assert.equal(classifyChessableApi('https://www.chessable.com/api/v1/getHomeData?uid=1'), null);
  assert.equal(classifyChessableApi('not a url'), null);
  // relative URL resolves against chessable.com origin
  assert.deepEqual(classifyChessableApi('/api/v1/getGame?oid=5'), { kind: 'game', oid: '5' });
});

test('parseChapterLids / parseLineOids extract ordered ids, tolerate casing + bad input', () => {
  assert.deepEqual(parseChapterLids('{"course":{"data":[{"id":10},{"id":20}]}}'), ['10', '20']);
  assert.deepEqual(parseChapterLids('{"Course":{"Data":[{"Id":7}]}}'), ['7']);
  assert.deepEqual(parseChapterLids('garbage'), []);
  assert.deepEqual(parseLineOids('{"list":{"name":"Ch","data":[{"id":1,"name":"L1"},{"id":2}]}}'), ['1', '2']);
  assert.deepEqual(parseLineOids('{}'), []);
});

test('buildIngestChapters keeps getList order, drops missing/empty games and empty chapters', () => {
  const chapters = [
    {
      listText: '{"list":{"name":"Ch1","data":[{"id":1},{"id":2},{"id":3}]}}',
      games: { '1': '{"game":{"data":[]}}', '3': '{}', /* 2 missing, 3 empty "{}" */ }
    },
    {
      listText: '{"list":{"name":"Ch2","data":[{"id":9}]}}',
      games: {} // no captured lines → chapter dropped
    }
  ];
  const out = buildIngestChapters(chapters);
  assert.equal(out.length, 1);
  assert.match(out[0].chapterJson, /Ch1/);
  assert.deepEqual(out[0].lines, ['{"game":{"data":[]}}']); // only oid 1 (order preserved, 3 was "{}")
});

test('parseCourseVariations extracts chapter->oids from getCourse includeVariations', () => {
  const json = '{"course":{"data":[' +
    '{"id":10,"total":2,"variations":[{"oid":101,"type":"x"},{"oid":102}]},' +
    '{"id":20,"variations":[{"oid":201}]}]}}';
  const r = parseCourseVariations(json);
  assert.deepEqual(r.chapters, [{ lid: '10', oids: ['101','102'] }, { lid: '20', oids: ['201'] }]);
  assert.deepEqual(r.allOids, ['101','102','201']);
  assert.deepEqual(parseCourseVariations('garbage'), { chapters: [], allOids: [] });
});

test('progressCounts computes course + per-chapter done/total against imported set', () => {
  const chapters = [{ lid: '10', oids: ['101','102'] }, { lid: '20', oids: ['201'] }];
  const r = progressCounts(chapters, new Set(['101','201','999']));
  assert.equal(r.total, 3);
  assert.equal(r.done, 2);
  assert.deepEqual(r.perChapter, [
    { lid: '10', total: 2, done: 1 },
    { lid: '20', total: 1, done: 1 },
  ]);
});
