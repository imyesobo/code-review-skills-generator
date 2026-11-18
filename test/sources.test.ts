import { describe, expect, it } from 'vitest';
import { parseSource } from '../src/sources/spec.js';

describe('parseSource', () => {
  it.each([
    ['octo/app', { provider: 'github', owner: 'octo', repo: 'app' }],
    ['github:octo', { provider: 'github', owner: 'octo', repo: undefined }],
    ['https://github.com/octo/app.git', { provider: 'github', owner: 'octo', repo: 'app' }],
    ['ado:contoso', { provider: 'ado', org: 'contoso', project: undefined, repo: undefined }],
    ['ado:contoso/Web/api', { provider: 'ado', org: 'contoso', project: 'Web', repo: 'api' }],
    ['https://dev.azure.com/contoso/My%20Proj/_git/api', { provider: 'ado', org: 'contoso', project: 'My Proj', repo: 'api' }],
    ['https://dev.azure.com/contoso/Web', { provider: 'ado', org: 'contoso', project: 'Web', repo: undefined }],
    ['https://contoso.visualstudio.com/Web/_git/api', { provider: 'ado', org: 'contoso', project: 'Web', repo: 'api' }],
  ])('%s', (input, expected) => {
    expect(parseSource(input)).toEqual(expected);
  });

  it('rejects ambiguous bare owners', () => {
    expect(() => parseSource('octo')).toThrow(/Ambiguous/);
  });
});
