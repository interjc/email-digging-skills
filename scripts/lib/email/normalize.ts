import domainTypos from '../rules/domain-typos.json' with { type: 'json' };
import roleLocals from '../rules/role-locals.json' with { type: 'json' };
import type { EmailCandidate, Flag, NormalizeEmailCell, RejectReason } from '../types.ts';
import { suggestProvider } from './providers.ts';

const ROLE_LOCALS = new Set(roleLocals);
const EXACT_TYPOS = new Map(Object.entries(domainTypos.exact));
const SUFFIX_TYPOS = Object.entries(domainTypos.suffix);
const LOCAL_PART = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const TLD = /^[a-z]{2,}$/;

const SEPARATORS = String.raw`\p{White_Space},;、|`;
// Whitespace controls serve as separators. The remaining controls can occur inside addresses.
const INVISIBLE = String.raw`\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f\u200b-\u200d\u2060\ufeff\u00ad`;
const INVISIBLE_CHARACTERS = new RegExp(`[${INVISIBLE}]`, 'gu');
const HORIZONTAL_SPACE = String.raw`[\t\p{Zs}${INVISIBLE}]*`;
const QUOTED = String.raw`(?:"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')`;
const WRAPPED = String.raw`(?:${QUOTED}|\([^()]*\)|\[[^\[\]]*\])`;
const WRAPPED_NAME = `${WRAPPED}${HORIZONTAL_SPACE}`;
const UNQUOTED_NAME = String.raw`[^@<>",;、|\r\n\v\f\u0085\u2028\u2029]*`;
const TOKEN_END = `[${INVISIBLE}]*(?=$|[${SEPARATORS}])`;
const MAILTO_PREFIX = `(?:mailto:${HORIZONTAL_SPACE})?`;
const WRAPPED_ADDRESS = `[${INVISIBLE}]*${MAILTO_PREFIX}${WRAPPED}${TOKEN_END}`;
const BARE_ADDRESS = `${MAILTO_PREFIX}[^${SEPARATORS}]+`;
const WRAPPED_NAME_ADDRESS = `[${INVISIBLE}]*${WRAPPED_NAME}<[^<>]*>${TOKEN_END}`;
const UNQUOTED_NAME_ADDRESS = `(?=[^${SEPARATORS}])${UNQUOTED_NAME}<[^<>]*>${TOKEN_END}`;
const PARTS = new RegExp(`${WRAPPED_NAME_ADDRESS}|${WRAPPED_ADDRESS}|${UNQUOTED_NAME_ADDRESS}|${BARE_ADDRESS}`, 'giu');
const PARTS_WITHOUT_ANGLES = new RegExp(`${WRAPPED_ADDRESS}|${BARE_ADDRESS}`, 'giu');
const NAME_AND_ANGLE = new RegExp(`^(?:${WRAPPED_NAME}|${UNQUOTED_NAME})<(?<address>[^<>]*)>$`, 'du');

const WRAPPERS = new Map([
  ['<', '>'],
  ['"', '"'],
  ["'", "'"],
  ['(', ')'],
  ['[', ']'],
]);

function trimWhitespace(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}

function foldLexicalPunctuation(value: string): string {
  // Preserve character offsets so matches can be sliced out of the original text.
  return value.replace(/[\ufe10-\ufe6f\uff00-\uffef]/g, (character) => {
    const folded = character.normalize('NFKC');
    return folded.length === 1 ? folded : character;
  });
}

function unwrap(value: string): string {
  let address = trimWhitespace(value.replace(INVISIBLE_CHARACTERS, ''));
  while (address.length > 1) {
    if (address.slice(0, 7).normalize('NFKC').toLowerCase() === 'mailto:') {
      address = trimWhitespace(address.slice(7));
      continue;
    }
    const opening = address.charAt(0).normalize('NFKC');
    const closing = address.slice(-1).normalize('NFKC');
    if (WRAPPERS.get(opening) === closing) {
      address = trimWhitespace(address.slice(1, -1));
      continue;
    }
    const angle = NAME_AND_ANGLE.exec(foldLexicalPunctuation(address))?.indices?.groups?.address;
    if (angle === undefined) break;
    address = trimWhitespace(address.slice(angle[0], angle[1]));
  }
  return address;
}

function splitParts(cell: string): string[] {
  const syntax = foldLexicalPunctuation(cell);
  const pattern = syntax.includes('<') ? PARTS : PARTS_WITHOUT_ANGLES;
  const parts: string[] = [];
  for (const match of syntax.matchAll(pattern)) {
    const raw = cell.slice(match.index, match.index + match[0].length);
    if (raw.replace(INVISIBLE_CHARACTERS, '') !== '') parts.push(raw);
  }
  return parts;
}

function validateSyntax(email: string): { local: string; domain: string } | null {
  const [local, domain, ...rest] = email.split('@');
  if (!local || !domain || rest.length > 0 || email.length > 254 || !LOCAL_PART.test(local)) return null;

  const labels = domain.split('.');
  const tld = labels.pop();
  if (!tld || !TLD.test(tld) || labels.length === 0 || !labels.every((label) => DOMAIN_LABEL.test(label))) {
    return null;
  }
  return { local, domain };
}

function suggestTypo(local: string, domain: string): string | null {
  const exact = EXACT_TYPOS.get(domain);
  if (exact !== undefined) return `${local}@${exact}`;

  for (const [suffix, correction] of SUFFIX_TYPOS) {
    if (domain.endsWith(suffix)) return `${local}@${domain.slice(0, -suffix.length)}${correction}`;
  }

  const provider = suggestProvider(domain);
  if (provider !== null) return `${local}@${provider}`;

  return null;
}

function reject(raw: string, rejectReason: RejectReason, flags: Flag[] = []): EmailCandidate {
  return { raw, email: null, domain: null, status: null, flags, suggestion: null, rejectReason };
}

export const normalizeEmailCell: NormalizeEmailCell = (cell) => {
  const input = cell ?? '';
  if (/^[\p{White_Space}\ufeff]*$/u.test(input)) return [reject(input, 'empty')];

  const parts = splitParts(input);
  if (parts.length === 0) return [reject(input, 'invalid_syntax')];

  const seen = new Set<string>();
  const candidates: EmailCandidate[] = [];
  for (const raw of parts) {
    const address = unwrap(raw);
    const folded = address.normalize('NFKC');
    const email = folded.toLowerCase();
    const parsed = validateSyntax(email);
    const key = parsed === null ? raw : email;
    if (seen.has(key)) continue;
    seen.add(key);

    const flags: Flag[] = [];
    if (parts.length > 1) flags.push('split_from_multi');
    if (folded !== address) flags.push('width_normalized');
    if (parsed === null) {
      candidates.push(reject(raw, 'invalid_syntax', flags.sort()));
      continue;
    }

    const { local, domain } = parsed;
    if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) flags.push('legacy_mobile_dots');
    const role = ROLE_LOCALS.has(local.split('+', 1)[0] ?? '');
    if (role) flags.push('role_address');
    const suggestion = suggestTypo(local, domain);
    if (suggestion !== null) flags.push('typo_suspect');
    const status = suggestion !== null ? 'typo_suspect' : role ? 'role' : 'valid';
    candidates.push({ raw, email, domain, status, flags: flags.sort(), suggestion, rejectReason: null });
  }
  return candidates;
};
