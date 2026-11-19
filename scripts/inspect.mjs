import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function readInputs(file = new URL('../data/inputs.json', import.meta.url)) {
  const text = await readFile(file, 'utf8');
  return JSON.parse(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await readInputs(process.argv[2]);
  const lines = Object.entries(data).map(([key, value]) =>
    Array.isArray(value) ? `${key}  ${value.length} 条` : `${key}  配置`);
  console.log(lines.join('\n'));
}
