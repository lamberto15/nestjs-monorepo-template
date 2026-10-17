import { ParseUUIDPipe, RequestMethod } from '@nestjs/common';
import { tagRoutes } from '../tags/tag.routes.js';
import { watchRoutes } from '../subscriptions/subscription.routes.js';
import {
  aNounOf,
  namedController,
  operationIdOf,
  type RecordRouteSpec,
} from './record-routes.js';

// The metadata keys (@nestjs/common/constants, @nestjs/swagger's DECORATORS):
// neither package exports them from its entry point.
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const ROUTE_ARGS_METADATA = '__routeArguments__';
const DECORATORS = {
  API_OPERATION: 'swagger/apiOperation',
  API_TAGS: 'swagger/apiUseTags',
};

const spec: RecordRouteSpec = {
  subject: 'Invoice',
  path: 'invoices',
  apiTag: 'invoices',
  className: 'Invoice',
  noun: 'invoice',
};

/** The factories' controllers: what Nest routes and Swagger documents. */
describe('record routes', () => {
  it('names a controller after the feature, for its operationIds', () => {
    const controller = tagRoutes(spec);
    expect(controller.name).toBe('InvoiceTagsController');
    expect(Reflect.getMetadata(PATH_METADATA, controller)).toBe(
      'invoices/:id/tags',
    );
    expect(Reflect.getMetadata(DECORATORS.API_TAGS, controller)).toEqual([
      'invoices',
    ]);
    const set = controller.prototype.set;
    expect(Reflect.getMetadata(METHOD_METADATA, set)).toBe(RequestMethod.PUT);
    expect(Reflect.getMetadata(DECORATORS.API_OPERATION, set).summary).toBe(
      "Set an invoice's tags",
    );
  });

  it('checks the record id is a UUID', () => {
    const controller = tagRoutes({ ...spec, className: 'Receipt' });
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      controller,
      'set',
    ) as Record<string, { data?: string; pipes: unknown[] }>;
    const id = Object.values(args).find((arg) => arg.data === 'id');
    expect(id?.pipes).toContain(ParseUUIDPipe);
  });

  it('keeps the operationIds of routes moved out of the feature', () => {
    const controller = watchRoutes({ ...spec, className: 'Order' });
    const watch = Reflect.getMetadata(
      DECORATORS.API_OPERATION,
      controller.prototype.watch,
    );
    expect(watch.operationId).toBe('OrdersController_watch_v1');
    expect(operationIdOf({ ...spec, operationIdPrefix: 'Legacy' }, 'run')).toBe(
      'Legacy_run_v1',
    );
  });

  it('refuses two controllers with one name', () => {
    namedController(class {}, 'TwiceController');
    expect(() => namedController(class {}, 'TwiceController')).toThrow(
      /Two record controllers named TwiceController/,
    );
  });

  it('puts the right article before the noun', () => {
    expect(aNounOf(spec)).toBe('an invoice');
    expect(aNounOf({ ...spec, noun: 'note' })).toBe('a note');
    expect(aNounOf({ ...spec, aNoun: 'an hour' })).toBe('an hour');
  });
});
