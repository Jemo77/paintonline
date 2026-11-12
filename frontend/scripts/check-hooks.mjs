/**
 * Detecta hooks de React dentro de `.map()`.
 *
 * Es una violación de las Rules of Hooks y no la agarra ni TypeScript ni el
 * typecheck: el `.map()` compila perfecto y falla sólo en runtime, cuando React
 * compara la cantidad de hooks de este render con la del anterior. Como el
 * número de iteraciones cambia según cuántos participantes hay, el monitor se
 * caía justo cuando alguien se sumaba, que es el momento en que más lo necesitás.
 *
 * El chequeo es heurístico (no parsea JS): busca un hook en el cuerpo de un
 * callback `.map`, que es la forma en que se manifiesta el error.
 *
 *   node scripts/check-hooks.mjs [dir]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const HOOKS = /\buse(?:Ref|State|Memo|Callback|Effect|Reducer|ImperativeHandle|LayoutEffect)\s*\(/;
const root = process.argv[2] ?? 'src';

/** Archivos de componente, donde el bug puede aparecer. */
const CANDIDATES = new Set(['.tsx', '.jsx']);

/** Hooks permitidos dentro de un callback: no abren un componente nuevo. */
const FALSE_POSITIVE = /^use(Canvas|Participants|Presence)\w*\(/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CANDIDATES.has(extname(full))) out.push(full);
  }
  return out;
}

/**
 * Devuelve el cuerpo de un callback `.map(`, contando paréntesis hasta que
 * cierra, y el offset donde termina.
 */
function mapBody(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { body: src.slice(openIndex + 1, i), end: i };
    }
  }
  return null;
}

const findings = [];
for (const file of walk(root)) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');

  // Todos los callbacks `.map(` del archivo.
  const re = /\.map\s*\(/g;
  let match;
  while ((match = re.exec(src)) !== null) {
    const openIndex = match.index + match[0].length - 1;
    const found = mapBody(src, openIndex);
    if (!found) continue;

    const before = src.slice(Math.max(0, openIndex - 40), openIndex);
    // Un `.map` dentro de otro hook (un useMemo) sí es legal: el hook está
    // fuera del callback, no adentro.
    if (HOOKS.test(before) && !FALSE_POSITIVE.test(before.trim() + '(')) {
      // el hook envuelve al map → correcto, se ignora
    } else {
      const line = src.slice(0, openIndex).split('\n').length;
      const hookMatch = found.body.match(HOOKS);
      if (hookMatch) {
        findings.push({
          file,
          line,
          hook: hookMatch[0].replace(/\s*\($/, ''),
          source: lines[line - 1]?.trim() ?? '',
        });
      }
    }
  }
}

if (findings.length === 0) {
  console.log(`PASS  ningún hook de React dentro de un .map() en ${root}/`);
  console.log('\nTODO OK');
} else {
  for (const f of findings) {
    console.log(`FAIL  ${f.file}:${f.line} — ${f.hook}() dentro de un .map()`);
    console.log(`      ${f.source}`);
  }
  console.log(
    `\n${findings.length} violation(es). Sacá el hook a un componente propio:`,
  );
  console.log('  function Item({ ... }) { const ref = useRef(null); return <.../>; }');
  console.log('  lista.map((x) => <Item key={x.id} {...x} />)');
  process.exitCode = 1;
}
