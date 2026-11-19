import test from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../scripts/inspect.mjs';

const data = await readInputs();

test("俗名重复时仍各自关联合法河网节点", () => {
  const nodes = new Set(data.reaches.flatMap(reach => [reach.from, reach.to]));
  for (const landmark of data.landmarks) assert.ok(nodes.has(landmark.node));
  for (const entry of data.patrol.blockedEntries) assert.ok(nodes.has(entry));
  assert.deepEqual(data.landmarks.filter(x => x.aliases.includes('石桥')).map(x => x.node), ['b', 'c']);
});
