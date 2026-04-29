const KNOWN_PREFIXES = ['SP-', 'TP-', 'LZ-', 'TT-', 'TKT-', 'TIK-', 'SHF-', 'SHO-', 'SO-', 'BL-', 'JD-', 'LB-'];

const uniq = (list) => Array.from(new Set(list.filter(Boolean)));
const hasKnownPrefix = (s) => KNOWN_PREFIXES.some((p) => s.startsWith(p));

function detectChannel(rawInput) {
  const s = String(rawInput || '').trim();
  if (!s) return empty();

  if (s.startsWith('SP-')) return build('shopee', s.slice(3), s);
  if (s.startsWith('TP-')) return build('tokopedia', s.slice(3), s);
  if (s.startsWith('LZ-') || s.startsWith('LB-')) return build('lazada', s.slice(3), s);
  if (s.startsWith('TT-')) return build('tiktok', s.slice(3), s);
  if (s.startsWith('TKT-') || s.startsWith('TIK-')) return build('tiktok', s.slice(s.indexOf('-') + 1), s);
  if (s.startsWith('SHF-') || s.startsWith('SHO-')) return build('shopify', s.slice(4), s);
  if (s.startsWith('SO-') || s.startsWith('BL-') || s.startsWith('JD-')) return build('internal', s, s);

  if (s.startsWith('#')) return build('shopify', s.slice(1), s);
  if (/^INV\/\d{8}\/MPL\//i.test(s)) return build('tokopedia', s, s);
  if (/^\d{6}[A-Z0-9]{6,10}$/.test(s)) return build('shopee', s, s);
  if (/^\d{14,}$/.test(s)) return build('tiktok', s, s);

  return build('unknown', s, s);
}

function empty() {
  return { channel: 'unknown', raw: '', normalized: '', candidates: [], stems: [], queries: [] };
}

function lastNumericChunk(s) {
  const m = String(s).match(/(\d{6,})(?!.*\d)/);
  return m ? m[1] : null;
}

function build(channel, core, raw) {
  const lastNum = lastNumericChunk(raw);
  const candidates = uniq(candidatesFor(channel, core, raw));
  const stems = uniq(stemsFor(channel, core, lastNum));
  const queries = uniq([
    core,
    lastNum,
    raw,
    raw.startsWith('#') ? raw.slice(1) : null,
  ].filter((v) => v && String(v).length >= 4));
  return { channel, raw, normalized: core, candidates, stems, queries };
}

function candidatesFor(channel, core, raw) {
  switch (channel) {
    case 'shopee':       return [`SP-${core}`, core, raw];
    case 'tokopedia':    return [`TP-${core}`, core, raw];
    case 'lazada':       return [`LZ-${core}`, `LB-${core}`, core, raw];
    case 'tiktok':       return [`TT-${core}`, `TKT-${core}`, `TIK-${core}`, `TIKTOK-${core}`, core, raw];
    case 'shopify':      return [`SHF-${core}`, `SHO-${core}`, `#${core}`, core, raw];
    case 'internal':     return [raw];
    default:
      if (hasKnownPrefix(raw)) return [raw];
      return [raw, `SP-${raw}`, `TP-${raw}`, `LZ-${raw}`, `TT-${raw}`, `TKT-${raw}`, `SHF-${raw}`, `SHO-${raw}`];
  }
}

function stemsFor(channel, core, lastNum) {
  switch (channel) {
    case 'shopee':    return [`SP-${core}-`];
    case 'tokopedia': return [`TP-${core}-`, lastNum && `TP-${lastNum}-`];
    case 'shopify':   return [`SHF-${core}-`, `SHO-${core}-`];
    case 'tiktok':    return [`TT-${core}-`, `TKT-${core}-`, `TIK-${core}-`, lastNum && `TT-${lastNum}-`];
    case 'lazada':    return [`LZ-${core}-`, `LB-${core}-`];
    default:          return [];
  }
}

module.exports = { detectChannel };
