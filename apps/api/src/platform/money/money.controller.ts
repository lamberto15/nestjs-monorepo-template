import { Controller, Get, NotFoundException, Query } from '@nestjs/common';
import { Can } from '@nestjs/authorization';
import { t } from '@nestjs/i18n';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Etag } from '../../core/http/etag.js';
import { Money } from './money.js';
import {
  type ConvertQuery,
  conversionResponseSchema,
  convertQuerySchema,
  type RatesQuery,
  ratesQuerySchema,
  ratesResponseSchema,
} from './money.schemas.js';
import { ExchangeRatesService } from './exchange-rates.service.js';
import type { RoundingMode } from './decimal.js';

/**
 * Exchange rates for clients: a day's rates and a conversion, so a
 * frontend shows a converted amount exactly as the server would compute
 * it (same day, same triangulation, same rounding) instead of redoing it
 * in floats. Read-only. The ECB's reference rates are public, so any
 * signed-in user or API client reads them (`@Can.Anyone()`); there is no
 * record to permit.
 */
@ApiTags('money')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiBearerAuth('api-key')
@ApiUnauthorizedResponse({ description: 'No valid credentials.' })
@Controller('money')
export class MoneyController {
  constructor(private readonly rates: ExchangeRatesService) {}

  @Get('rates')
  @Can.Anyone()
  @Etag()
  @ApiOperation({
    summary: 'The exchange rates of a day',
    description:
      'The ECB’s euro reference rates of the newest working day on or before `date` (default today, UTC): units of each currency per euro, as decimal strings.',
  })
  @ApiOkResponse({ standardSchema: ratesResponseSchema })
  @ApiBadRequestResponse({ description: 'A malformed date.' })
  @ApiNotFoundResponse({
    description: '`rates_unavailable`: no rates on or before that day.',
  })
  async ratesOn(@Query({ schema: ratesQuerySchema }) query: RatesQuery) {
    const snapshot = await this.rates.ratesOn(query.date);
    if (!snapshot) {
      throw new NotFoundException({
        code: 'rates_unavailable',
        message: t('money.ratesUnavailable'),
      });
    }
    return snapshot;
  }

  @Get('convert')
  @Can.Anyone()
  @ApiOperation({
    summary: 'Convert an amount',
    description:
      'Converts through the euro (triangulation) at the rates of the newest working day on or before `date` that has both currencies, rounded once to the target’s minor unit. The answer carries the rate, its day and its source.',
  })
  @ApiOkResponse({ standardSchema: conversionResponseSchema })
  @ApiBadRequestResponse({
    description:
      'An unknown currency, a malformed amount, or more decimals than the currency has.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`rate_unavailable`: no rate for a currency on or before that day (the ECB doesn’t publish it, or none was fetched yet).',
  })
  async convert(@Query({ schema: convertQuerySchema }) query: ConvertQuery) {
    const conversion = await this.rates.convert(
      Money.of(query.amount, query.currency),
      query.to,
      { day: query.date, rounding: query.rounding as RoundingMode },
    );
    return {
      ...conversion,
      from: conversion.from.toJSON(),
      amount: conversion.amount.toJSON(),
    };
  }
}
