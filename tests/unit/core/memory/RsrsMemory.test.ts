import { describe, expect, it } from 'vitest';

import { buildTurnMemory, redactSecrets } from '@/core/memory/RsrsMemory';

const turn = {
  query: '请帮我检查 rsrs 同步失败的原因？',
  reply: '同步卡在 running 状态，已记录排查结论。',
  vaultPath: 'C:/vault',
};

describe('buildTurnMemory', () => {
  it('stores an automatic turn as a diary trajectory', () => {
    const record = buildTurnMemory(turn, 'trivial', new Date(2026, 10, 2, 9, 5));

    expect(record.importance).toBe('trivial');
    expect(record.title).toMatch(/^2026-11-02 09:05 Respire 回合 · /u);
    expect(record.content).toMatch(/^本回合 2026-11-02 09:05（C:\/vault）用户问：/u);
    expect(record.content).not.toContain('【前因】');
  });

  it('keeps the three required markers and a compact fact title for important turns', () => {
    const record = buildTurnMemory(turn, 'important', new Date(2026, 10, 2, 9, 5));

    expect(record.title.length).toBeLessThanOrEqual(24);
    expect(record.title).toContain('用户问');
    expect(record.title).not.toBe(turn.query);
    expect(record.content).toContain('【前因】');
    expect(record.content).toContain('【行为】');
    expect(record.content).toContain('【后果】');
  });

  it('redacts credentials before they reach the store', () => {
    const record = buildTurnMemory({
      query: 'deploy with sk-abcdefghijklmnopqrstuvwx',
      reply: 'Bearer abcdefghijklmnopqrstuvwxyz012345 accepted.',
    }, 'trivial', new Date(2026, 10, 2, 9, 5));

    expect(record.content).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(record.content).toContain('[redacted token]');
    expect(record.content).toContain('Bearer [redacted]');
  });
});

describe('redactSecrets', () => {
  it('removes private key blocks', () => {
    const text = 'before\n-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----\nafter';

    expect(redactSecrets(text)).toBe('before\n[redacted private key]\nafter');
  });
});
