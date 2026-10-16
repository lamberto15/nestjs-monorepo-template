import { HttpException } from '@nestjs/common';
import { WebhooksError } from '@nestjs/webhooks';
import { ProblemDetailsFilter } from '../../core/http/problem-details.filter.js';

/**
 * The webhooks package's errors carry an HTTP status (400 for an endpoint it
 * refuses, 404 for another client's endpoint or delivery): they become
 * problem details with it and the error's message.
 */
ProblemDetailsFilter.map(WebhooksError, (error) => {
  const status = (error as { status?: number }).status;
  return status
    ? new HttpException(
        {
          message: error.message,
          code: 'webhooks_' + (status === 404 ? 'not_found' : 'refused'),
        },
        status,
        { cause: error },
      )
    : undefined;
});
