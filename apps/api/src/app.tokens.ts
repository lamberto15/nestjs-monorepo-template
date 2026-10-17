/**
 * The features the app was built with (createAppModule, app.module.ts): a
 * provider of the root module. openapi.ts reads their Swagger tags, the
 * demo seed their demo data. Its own file: no import of the root module.
 */
export const APP_FEATURES = Symbol('APP_FEATURES');
