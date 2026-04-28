import { describe, it, expect } from 'vitest';
import { extractEnvVars, generateSecretValue } from './composeEnv';

describe('extractEnvVars', () => {
  it('1. ${POSTGRES_PASSWORD} → required, isSecret=true', () => {
    const result = extractEnvVars('password: ${POSTGRES_PASSWORD}');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'POSTGRES_PASSWORD',
      required: true,
      isSecret: true,
    });
    expect(result[0].defaultValue).toBeUndefined();
  });

  it('2. ${POSTGRES_USER:-postgres} → optional, default="postgres"', () => {
    const result = extractEnvVars('user: ${POSTGRES_USER:-postgres}');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'POSTGRES_USER',
      required: false,
      defaultValue: 'postgres',
      isSecret: false,
    });
  });

  it('3. ${PORT:?must set port} → required', () => {
    const result = extractEnvVars('port: ${PORT:?must set port}');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'PORT',
      required: true,
      isSecret: false,
    });
    expect(result[0].defaultValue).toBeUndefined();
  });

  it('4. ${API_KEY-fallback} → optional, default="fallback"', () => {
    const result = extractEnvVars('key: ${API_KEY-fallback}');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'API_KEY',
      required: false,
      defaultValue: 'fallback',
      isSecret: false,
    });
  });

  it('5. ${JWT_SECRET} → required, isSecret=true', () => {
    const result = extractEnvVars('secret: ${JWT_SECRET}');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'JWT_SECRET',
      required: true,
      isSecret: true,
    });
  });

  it('6. ${DB_HOST:-localhost} → optional, default="localhost", isSecret=false', () => {
    const result = extractEnvVars('host: ${DB_HOST:-localhost}');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'DB_HOST',
      required: false,
      defaultValue: 'localhost',
      isSecret: false,
    });
  });

  it('7. Mixed compose — all variables parsed and correctly classified', () => {
    const yaml = `
      password: \${POSTGRES_PASSWORD}
      user: \${POSTGRES_USER:-postgres}
      port: \${PORT:?must set port}
      key: \${API_KEY-fallback}
      secret: \${JWT_SECRET}
      host: \${DB_HOST:-localhost}
    `;
    const result = extractEnvVars(yaml);
    expect(result).toHaveLength(6);

    const byName = Object.fromEntries(result.map((v) => [v.name, v]));

    expect(byName['POSTGRES_PASSWORD']).toMatchObject({ required: true, isSecret: true });
    expect(byName['POSTGRES_USER']).toMatchObject({ required: false, defaultValue: 'postgres' });
    expect(byName['PORT']).toMatchObject({ required: true, isSecret: false });
    expect(byName['API_KEY']).toMatchObject({ required: false, defaultValue: 'fallback' });
    expect(byName['JWT_SECRET']).toMatchObject({ required: true, isSecret: true });
    expect(byName['DB_HOST']).toMatchObject({ required: false, defaultValue: 'localhost' });
  });

  it('8. Same var appears twice (${X} and ${X:-y}) → single entry, optional with default', () => {
    const yaml = 'a: ${X} b: ${X:-y}';
    const result = extractEnvVars(yaml);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'X',
      required: false,
      defaultValue: 'y',
      isSecret: false,
    });
  });

  it('9. Empty string input → returns []', () => {
    expect(extractEnvVars('')).toEqual([]);
  });

  it('10. Var name with lower-case → ignored', () => {
    const result = extractEnvVars('val: ${myvar}');
    expect(result).toHaveLength(0);
  });
});

describe('generateSecretValue', () => {
  it('11. generateSecretValue() returns 32-char hex string by default', () => {
    const val = generateSecretValue();
    expect(val).toMatch(/^[0-9a-f]{32}$/);
  });

  it('12. generateSecretValue(16) returns 16-char hex string', () => {
    const val = generateSecretValue(16);
    expect(val).toMatch(/^[0-9a-f]{16}$/);
  });

  it('13. Two consecutive calls return different values', () => {
    const a = generateSecretValue();
    const b = generateSecretValue();
    expect(a).not.toBe(b);
  });
});
