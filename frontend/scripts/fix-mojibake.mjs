import fs from 'node:fs';
import path from 'node:path';

// Conservative repair for common UTF-8 text accidentally decoded as Windows-1252.
// This script only changes explicit known mojibake sequences; it never guesses at arbitrary Unicode.
const replacements = new Map([
  ['â€œ', '“'], ['â€', '”'], ['â€\u009d', '”'], ['â€', '”'],
  ['â€˜', '‘'], ['â€™', '’'], ['â€“', '–'], ['â€”', '—'], ['â€¦', '…'],
  ['â€¢', '•'], ['â„¢', '™'], ['â‚¬', '€'], ['Â ', '\u00a0'], ['Â ', ' '],
  ['Ã¡', 'á'], ['Ã ', 'à'], ['Ã¢', 'â'], ['Ã£', 'ã'], ['Ã¤', 'ä'], ['Ã¥', 'å'],
  ['Ã¦', 'æ'], ['Ã§', 'ç'], ['Ã¨', 'è'], ['Ã©', 'é'], ['Ãª', 'ê'], ['Ã«', 'ë'],
  ['Ã¬', 'ì'], ['Ã­', 'í'], ['Ã®', 'î'], ['Ã¯', 'ï'], ['Ã±', 'ñ'], ['Ã²', 'ò'],
  ['Ã³', 'ó'], ['Ã´', 'ô'], ['Ãµ', 'õ'], ['Ã¶', 'ö'], ['Ã¹', 'ù'], ['Ãº', 'ú'],
  ['Ã»', 'û'], ['Ã¼', 'ü'], ['Ã½', 'ý'], ['Ã¿', 'ÿ'], ['Ã‰', 'É'], ['Ã‘', 'Ñ'],
  ['Ãœ', 'Ü'], ['Ã„', 'Ä'], ['Ã–', 'Ö'], ['ÃŸ', 'ß'],
]);
const extensions = new Set(['.tsx','.ts','.jsx','.js','.css','.scss','.html','.json','.md','.svg','.txt']);
const excluded = new Set(['node_modules','.next','.git','dist','build']);
const root = path.resolve(process.cwd());
let scanned = 0, changed = 0;
function walk(dir) {
  for (const ent of fs.readdirSync(dir, {withFileTypes:true})) {
    if (ent.isDirectory()) { if (!excluded.has(ent.name)) walk(path.join(dir,ent.name)); continue; }
    if (!extensions.has(path.extname(ent.name).toLowerCase())) continue;
    const file = path.join(dir,ent.name);
    let text = fs.readFileSync(file,'utf8'); scanned++;
    let repaired = text;
    for (const [bad,good] of replacements) repaired = repaired.split(bad).join(good);
    if (repaired !== text) {
      fs.writeFileSync(file, repaired, {encoding:'utf8'});
      changed++;
      console.log(`Repaired: ${path.relative(root,file)}`);
    }
  }
}
walk(root);
console.log(`UTF-8 scan complete. Files scanned: ${scanned}; files repaired: ${changed}.`);
