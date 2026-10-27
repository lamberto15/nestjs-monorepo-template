import { Logger } from '@nestjs/common';
import { ClientErrorsService } from './client-errors.service.js';

describe('ClientErrorsService', () => {
  it('logs the report id, source, path and message, with the stack separate', () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    new ClientErrorsService().report({
      id: 'abc12345',
      source: 'window',
      message: 'TypeError: boom',
      stack: 'TypeError: boom\n  at x (app.js:1:1)',
      path: '/sign-in',
    });
    expect(error).toHaveBeenCalledWith(
      '[abc12345] window error on /sign-in: TypeError: boom',
      'TypeError: boom\n  at x (app.js:1:1)',
    );
  });
});
