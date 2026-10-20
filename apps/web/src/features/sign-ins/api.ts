import type { GetResponse } from '@nestjs-monorepo-template/api-client';

/**
 * An entry of the sign-in history, as GET /v1/access/sign-ins lists it (the
 * list page asks for it, with its filters and paging: GET /v1/lists/SignIn).
 */
export type SignInEntry = GetResponse<'/v1/access/sign-ins'>['items'][number];
