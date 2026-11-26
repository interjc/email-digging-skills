import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hmacLocalPart,
  maskEmail,
  maskName,
  maskPhone,
  maskValue,
} from './mask.ts';

// Build non-example addresses at runtime so this test file holds no literal real addresses.
const addr = (local: string, domain: string): string => `${local}@${domain}`;

describe('maskEmail', () => {
  it('masks local part and first domain label while keeping remaining labels', () => {
    assert.equal(maskEmail(addr('taro', 'gmail.com')), 't***@g***l.com');
    assert.equal(maskEmail(addr('taro', 'docomo.ne.jp')), 't***@d***o.ne.jp');
    assert.equal(maskEmail('alice@example.com'), 'a***@e***e.com');
    assert.equal(maskEmail('x@abc.example'), 'x***@a***c.example');
  });

  it('handles 1- and 2-character first domain labels', () => {
    assert.equal(maskEmail('taro@me.example'), 't***@m***.example');
    assert.equal(maskEmail('taro@x.example'), 't***@x***.example');
    assert.equal(maskEmail(addr('a', 'ab.co.jp')), 'a***@a***.co.jp');
  });

  it('returns *** for invalid inputs', () => {
    for (const bad of [
      '',
      '   ',
      'not-an-email',
      '@example.com',
      'user@',
      'a@b@example.com',
      'user@nodot',
      'user@.example',
      'user@example.',
      'user@a..example',
      'a b@example.com',
    ]) {
      assert.equal(maskEmail(bad), '***', `expected *** for ${JSON.stringify(bad)}`);
    }
  });
});

describe('maskName', () => {
  it('keeps first grapheme and masks remaining graphemes up to 3 stars', () => {
    assert.equal(maskName('山田太郎'), '山***');
    assert.equal(maskName('山田太'), '山**');
    assert.equal(maskName('山田'), '山*');
    assert.equal(maskName('山'), '山');
    assert.equal(maskName('Alexander Hamilton'), 'A***');
  });

  it('is grapheme-aware for astral plane characters and emoji clusters', () => {
    assert.equal(maskName('𠀀田'), '𠀀*');
    assert.equal(maskName('𠀀山田太郎'), '𠀀***');
    assert.equal(maskName('👨‍👩‍👧‍👦田'), '👨‍👩‍👧‍👦*');
  });

  it('returns empty string for empty or whitespace input', () => {
    assert.equal(maskName(''), '');
    assert.equal(maskName('   '), '');
  });
});

describe('maskPhone', () => {
  it('masks every digit except the last two and preserves separators', () => {
    assert.equal(maskPhone('090-1234-5678'), '***-****-**78');
    assert.equal(maskPhone('09012345634'), '*********34');
    assert.equal(maskPhone('+81 (03) 1234-5678'), '+** (**) ****-**78');
    assert.equal(maskPhone('０９０-１２３４-５６７８'), '***-****-**７８');
  });

  it('handles short and empty strings', () => {
    assert.equal(maskPhone('78'), '78');
    assert.equal(maskPhone('8'), '8');
    assert.equal(maskPhone(''), '');
    assert.equal(maskPhone('---'), '---');
  });
});

describe('maskValue', () => {
  it('dispatches by field name across English, Japanese, and Chinese keywords', () => {
    const sample = addr('taro', 'gmail.com');
    assert.equal(maskValue('email', sample), 't***@g***l.com');
    assert.equal(maskValue('email_address', sample), 't***@g***l.com');
    assert.equal(maskValue('メールアドレス', sample), 't***@g***l.com');
    assert.equal(maskValue('邮箱', sample), 't***@g***l.com');

    assert.equal(maskValue('name', '山田太郎'), '山***');
    assert.equal(maskValue('氏名', '山田'), '山*');
    assert.equal(maskValue('名前', '𠀀田'), '𠀀*');
    assert.equal(maskValue('姓名', '张伟'), '张*');

    assert.equal(maskValue('phone', '090-1234-5678'), '***-****-**78');
    assert.equal(maskValue('TEL', '03-1234-5678'), '**-****-**78');
    assert.equal(maskValue('電話番号', '09012345634'), '*********34');
    assert.equal(maskValue('电话', '138-0013-8000'), '***-****-**00');

    assert.equal(maskValue('address', '東京都渋谷区1-2-3'), '東京***');
    assert.equal(maskValue('住所', '𠀀東京都'), '𠀀東***');
    assert.equal(maskValue('地址', '北京市朝阳区'), '北京***');
    assert.equal(maskValue('address', ''), '');

    assert.equal(maskValue('locale', 'ja-JP'), 'ja-JP');
    assert.equal(maskValue('created_at', '2025-03-01'), '2025-03-01');
  });
});

describe('hmacLocalPart', () => {
  it('produces deterministic pseudonyms keeping domain by default', () => {
    const a = hmacLocalPart('taro@example.com', 'secret-key-1');
    const b = hmacLocalPart('Taro@Example.COM', 'secret-key-1');
    assert.equal(a, b);
    assert.match(a, /^u[0-9a-f]{16}@example\.com$/);
  });

  it('hashes domain to .invalid when keepDomain is false', () => {
    const masked = hmacLocalPart('taro@example.com', 'secret-key-1', { keepDomain: false });
    assert.match(masked, /^u[0-9a-f]{16}@d[0-9a-f]{8}\.invalid$/);
    const sameDomain = hmacLocalPart('hanako@example.com', 'secret-key-1', { keepDomain: false });
    assert.equal(masked.split('@')[1], sameDomain.split('@')[1]);
    assert.notEqual(masked.split('@')[0], sameDomain.split('@')[0]);
  });

  it('changes output when key or domain changes', () => {
    const k1 = hmacLocalPart('taro@example.com', 'key-a');
    const k2 = hmacLocalPart('taro@example.com', 'key-b');
    assert.notEqual(k1, k2);

    const d1 = hmacLocalPart('taro@example.com', 'key-a').split('@')[0];
    const d2 = hmacLocalPart('taro@example.jp', 'key-a').split('@')[0];
    assert.notEqual(d1, d2);
  });

  it('throws on empty key or invalid email without leaking raw email', () => {
    assert.throws(() => hmacLocalPart('taro@example.com', ''), /key/i);
    const secretLike = 'raw-invalid-value-12345';
    assert.throws(
      () => hmacLocalPart(secretLike, 'key-a'),
      (err: unknown) => err instanceof Error && !err.message.includes(secretLike),
    );
  });
});
