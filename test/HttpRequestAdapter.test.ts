import { HttpRequestAdapter } from '../src/adapters/http-request/HttpRequestAdapter';

const adapter = new HttpRequestAdapter();

describe('needsFolderPick', () => {
  it('is false — http-request skips the wizard folder picker', () => {
    expect(adapter.needsFolderPick).toBe(false);
  });
});
