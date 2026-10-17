/**
 * The globals the core uses beyond the language itself, declared only as far as it uses them. Each is one every
 * client's runtime has: the desktop's web view, Node for the tests, and the phone's JavaScript engine. Nothing a
 * browser alone provides is declared, so the core's own check refuses `window`, `document` and the rest.
 */

/** Only for reading a link's host name. React Native's own `URL` has left `hostname` unimplemented, so a phone polyfills it. */
declare class URL {
  constructor(url: string, base?: string);
  readonly hostname: string;
}
