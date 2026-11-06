/**
 * Settings are FACEVISA_*; a legacy LIKENESS_<X> still works as the fallback for FACEVISA_<X> (a FACEVISA_ setting
 * always wins). Imported first by the
 * server and every script, before any module reads its settings.
 */
export function applyLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const used: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith("LIKENESS_") || v === undefined) continue;
    const name = `FACEVISA_${k.slice("LIKENESS_".length)}`;
    if (env[name] === undefined) {
      env[name] = v;
      used.push(k);
    }
  }
  return used;
}

applyLegacyEnv();
