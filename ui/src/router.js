/**
 * The seam a page uses to send the user somewhere else.
 *
 * A page cannot import main.js: main.js imports every page, and the cycle would
 * leave one side half-initialised depending on which module the bundler puts
 * first. So main.js pushes its navigate in here, and pages pull `goto` out.
 *
 * `params` are handed to the destination page's render(). They are a one-shot
 * handover, not a route — nothing reads them back, and revisiting the page
 * normally gets none.
 */

let navigator = null;

/** Called once, by the router. */
export function setNavigator(fn) {
  navigator = fn;
}

/** Go to a page, optionally handing it something to open with. */
export function goto(page, params) {
  if (!navigator) {
    console.error('goto() before the router was wired');
    return;
  }
  navigator(page, params);
}
